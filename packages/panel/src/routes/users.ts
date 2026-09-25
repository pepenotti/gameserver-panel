import type { FastifyInstance } from 'fastify';
import { canHost, GRANT_ROLES, ROLES, SCOPES, SERVER_ID_PATTERN, type GrantRole, type Role, type Scope, type ServerGrant } from '@gsp/shared';
import { syncRoleWithGrants } from '../auth/grants';
import { toPublic, type Lang, type PublicUser } from '../auth/users';
import { actor, HttpError, principal, serversAllowing } from '../http/context';
import type { Deps } from '../http/deps';

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } as const;

/** `GET /api/audit?server=-`: only the entries about no server (ACC-03). Never a server id (ids start with a letter). */
export const AUDIT_HOST_ENTRIES = '-';

/** An account in `GET /api/users`: its scope, account role and per-server grants. */
export type UserWithGrants = PublicUser & { grants: ServerGrant[] };

export function meRoutes(app: FastifyInstance, deps: Deps): void {
  const { users, sessions } = deps;

  app.put<{ Body: { lang: Lang } }>(
    '/api/me',
    {
      config: { auth: 'session', allowPending: ['mfa', 'password', 'enrol'] },
      schema: { body: { type: 'object', required: ['lang'], additionalProperties: false, properties: { lang: { enum: ['en', 'es'] } } } },
    },
    async (req) => {
      users.setLang(req.auth!.user.id, req.body.lang);
      return toPublic(users.byId(req.auth!.user.id)!);
    },
  );

  app.get('/api/me/sessions', { config: { auth: 'session' } }, async (req) => {
    const current = req.auth!.session.id_hash;
    return sessions.listForUser(req.auth!.user.id).map((s) => ({
      id: s.id_hash.slice(0, 16),
      current: s.id_hash === current,
      createdAt: new Date(s.created_at).toISOString(),
      lastSeenAt: new Date(s.last_seen_at).toISOString(),
      ip: s.ip,
      userAgent: s.user_agent,
    }));
  });

  app.delete<{ Params: { id: string } }>('/api/me/sessions/:id', { config: { auth: 'session' } }, async (req) => {
    const target = sessions.listForUser(req.auth!.user.id).find((s) => s.id_hash.startsWith(req.params.id) && req.params.id.length === 16);
    if (!target) throw new HttpError(404, 'not-found');
    sessions.revoke(target.id_hash);
    deps.audit.log({ actor: actor(req), action: 'auth.session.revoke', ip: req.ip });
    return { ok: true };
  });
}

export function userRoutes(app: FastifyInstance, deps: Deps): void {
  const { users, sessions, audit, grants, bus } = deps;
  const perm = { permission: 'users.manage' as const };
  /** An account with its per-server roles (ACC-02). */
  const withGrants = (u: PublicUser): UserWithGrants => ({ ...u, grants: grants.forUser(u.id) });
  /** Open websockets of that account re-check what it may see now. */
  const changed = (userId: number) => bus.emit({ type: 'access', userId });

  app.get('/api/users', { config: perm }, async () => users.list().map(withGrants));

  app.post<{ Body: { username: string; password: string; role: Role; scope?: Scope; lang?: Lang } }>(
    '/api/users',
    {
      config: perm,
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password', 'role'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', maxLength: 32 },
            password: { type: 'string', maxLength: 200 },
            // With scope `granted` the role follows the account's grants (viewer until it has one).
            role: { enum: ROLES.filter((r) => r !== 'owner') },
            scope: { enum: [...SCOPES] },
            lang: { enum: ['en', 'es'] },
          },
        },
      },
    },
    async (req) => {
      const { scope, ...input } = req.body;
      // New accounts pick their own password at first login.
      const u = await users.create({ ...input, mustChangePassword: true });
      if (scope === 'granted') {
        users.setScope(u.id, 'granted');
        syncRoleWithGrants(users, grants, u.id);
      }
      const now = users.byId(u.id)!;
      audit.log({ actor: actor(req), action: 'user.create', target: now.username, detail: { role: now.role, scope: now.scope }, ip: req.ip });
      return withGrants(toPublic(now));
    },
  );

  app.patch<{ Params: { id: number }; Body: { role?: Role; scope?: Scope; disabled?: boolean } }>(
    '/api/users/:id',
    {
      config: perm,
      schema: {
        params: idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { role: { enum: ROLES.filter((r) => r !== 'owner') }, scope: { enum: [...SCOPES] }, disabled: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const target = users.byId(req.params.id);
      if (!target) throw new HttpError(404, 'not-found');
      const scope = req.body.scope ?? target.scope;
      // A scope-granted account's role is its highest grant, kept by the panel.
      if (req.body.role && scope === 'granted') throw new HttpError(400, 'role-follows-grants');
      if (req.body.scope) users.setScope(target.id, req.body.scope);
      if (req.body.role) users.setRole(target.id, req.body.role);
      if (req.body.disabled !== undefined) users.setDisabled(target.id, req.body.disabled);
      syncRoleWithGrants(users, grants, target.id);
      // A role, scope or disable change takes effect everywhere now.
      sessions.revokeAllForUser(target.id);
      changed(target.id);
      audit.log({ actor: actor(req), action: 'user.update', target: target.username, detail: req.body, ip: req.ip });
      return withGrants(toPublic(users.byId(target.id)!));
    },
  );

  // ------------------------------------------------ per-server roles (ACC-02)

  /** A user's scope, account role and grants: what they may do where. */
  app.get<{ Params: { id: number } }>('/api/users/:id/grants', { config: perm, schema: { params: idParam } }, async (req) => {
    const target = users.byId(req.params.id);
    if (!target) throw new HttpError(404, 'not-found');
    return grantsView(toPublic(target));
  });

  const grantParams = { type: 'object', required: ['id', 'sid'], properties: { id: { type: 'integer', minimum: 1 }, sid: { type: 'string', pattern: SERVER_ID_PATTERN.source } } } as const;
  const grantTarget = (id: number, sid: string) => {
    const target = users.byId(id);
    if (!target) throw new HttpError(404, 'not-found');
    // The owner acts everywhere already.
    if (target.role === 'owner') throw new HttpError(400, 'owner-immutable');
    if (!deps.servers.get(sid)) throw new HttpError(404, 'server-not-found');
    return target;
  };
  const grantsView = (u: PublicUser) => ({ userId: u.id, scope: u.scope, role: u.role, grants: grants.forUser(u.id) });

  /**
   * Give (or change) a user's role on one server. Takes effect on their next
   * request and at once on their open websockets; no sign-out needed.
   */
  app.put<{ Params: { id: number; sid: string }; Body: { role: GrantRole } }>(
    '/api/users/:id/grants/:sid',
    {
      config: perm,
      schema: { params: grantParams, body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: { enum: [...GRANT_ROLES] } } } },
    },
    async (req) => {
      const target = grantTarget(req.params.id, req.params.sid);
      grants.set(target.id, req.params.sid, req.body.role);
      syncRoleWithGrants(users, grants, target.id);
      changed(target.id);
      audit.log({ actor: actor(req), serverId: req.params.sid, action: 'user.grant', target: target.username, detail: { role: req.body.role }, ip: req.ip });
      return grantsView(toPublic(users.byId(target.id)!));
    },
  );

  app.delete<{ Params: { id: number; sid: string } }>('/api/users/:id/grants/:sid', { config: perm, schema: { params: grantParams } }, async (req) => {
    const target = grantTarget(req.params.id, req.params.sid);
    if (!grants.remove(target.id, req.params.sid)) throw new HttpError(404, 'not-found');
    syncRoleWithGrants(users, grants, target.id);
    changed(target.id);
    audit.log({ actor: actor(req), serverId: req.params.sid, action: 'user.revoke', target: target.username, ip: req.ip });
    return grantsView(toPublic(users.byId(target.id)!));
  });

  app.post<{ Params: { id: number }; Body: { password: string } }>(
    '/api/users/:id/reset-password',
    {
      config: perm,
      schema: { params: idParam, body: { type: 'object', required: ['password'], additionalProperties: false, properties: { password: { type: 'string', maxLength: 200 } } } },
    },
    async (req) => {
      const target = users.byId(req.params.id);
      if (!target) throw new HttpError(404, 'not-found');
      if (target.id === req.auth!.user.id) throw new HttpError(400, 'use-own-password-change');
      await users.setPassword(target.id, req.body.password, { mustChange: true });
      sessions.revokeAllForUser(target.id);
      changed(target.id);
      audit.log({ actor: actor(req), action: 'user.reset-password', target: target.username, ip: req.ip });
      return toPublic(users.byId(target.id)!);
    },
  );

  app.post<{ Params: { id: number } }>('/api/users/:id/reset-2fa', { config: perm, schema: { params: idParam } }, async (req) => {
    const target = users.byId(req.params.id);
    if (!target) throw new HttpError(404, 'not-found');
    if (target.id === req.auth!.user.id) throw new HttpError(400, 'cannot-reset-own-2fa');
    users.disableTotp(target.id);
    sessions.revokeAllForUser(target.id);
    changed(target.id);
    audit.log({ actor: actor(req), action: 'user.reset-2fa', target: target.username, ip: req.ip });
    return toPublic(users.byId(target.id)!);
  });

  app.delete<{ Params: { id: number } }>('/api/users/:id', { config: perm, schema: { params: idParam } }, async (req) => {
    const target = users.byId(req.params.id);
    if (!target) throw new HttpError(404, 'not-found');
    users.delete(target.id);
    changed(target.id);
    audit.log({ actor: actor(req), action: 'user.delete', target: target.username, ip: req.ip });
    return { ok: true };
  });

  /**
   * The audit log (ACC-03), filterable by server. Admins on every server see
   * all of it; an admin on some servers sees only those servers' entries,
   * and a server they can't see is "not found". `server=-` asks for the
   * host's own entries (sign-ins, accounts, host settings: about no server),
   * which only an admin on every server sees; anyone else gets none.
   */
  app.get<{ Querystring: { before?: number; action?: string; limit?: number; server?: string } }>(
    '/api/audit',
    {
      config: { permission: 'audit.view', perServer: true },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            before: { type: 'integer', minimum: 1 },
            action: { type: 'string', maxLength: 40, pattern: '^[a-z0-9.-]*$' },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
            server: { type: 'string', anyOf: [{ const: AUDIT_HOST_ENTRIES }, { pattern: SERVER_ID_PATTERN.source }] },
          },
        },
      },
    },
    async (req) => {
      const user = req.auth!.user;
      const q = { beforeId: req.query.before, action: req.query.action, limit: req.query.limit };
      const everywhere = canHost(principal(user), 'audit.view');
      const mine = everywhere ? null : serversAllowing(deps, user, 'audit.view');
      if (req.query.server === AUDIT_HOST_ENTRIES) return mine ? [] : audit.list({ ...q, serverId: null });
      if (req.query.server !== undefined) {
        // Entries outlive deleted servers, so an admin on every server may ask for any id.
        if (mine && !mine.includes(req.query.server)) throw new HttpError(404, 'server-not-found');
        return audit.list({ ...q, serverId: req.query.server });
      }
      return audit.list(mine ? { ...q, serverIds: mine } : q);
    },
  );
}
