import type { FastifyInstance } from 'fastify';
import { canHost, ROLES, SERVER_ID_PATTERN, type Role } from '@gsp/shared';
import { toPublic, type Lang } from '../auth/users';
import { actor, HttpError, principal, serversAllowing } from '../http/context';
import type { Deps } from '../http/deps';

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } as const;

export function meRoutes(app: FastifyInstance, deps: Deps): void {
  const { users, sessions } = deps;

  app.put<{ Body: { lang: Lang } }>(
    '/api/me',
    {
      config: { allowPending: ['mfa', 'password', 'enrol'] },
      schema: { body: { type: 'object', required: ['lang'], additionalProperties: false, properties: { lang: { enum: ['en', 'es'] } } } },
    },
    async (req) => {
      users.setLang(req.auth!.user.id, req.body.lang);
      return toPublic(users.byId(req.auth!.user.id)!);
    },
  );

  app.get('/api/me/sessions', async (req) => {
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

  app.delete<{ Params: { id: string } }>('/api/me/sessions/:id', async (req) => {
    const target = sessions.listForUser(req.auth!.user.id).find((s) => s.id_hash.startsWith(req.params.id) && req.params.id.length === 16);
    if (!target) throw new HttpError(404, 'not-found');
    sessions.revoke(target.id_hash);
    deps.audit.log({ actor: actor(req), action: 'auth.session.revoke', ip: req.ip });
    return { ok: true };
  });
}

export function userRoutes(app: FastifyInstance, deps: Deps): void {
  const { users, sessions, audit } = deps;
  const perm = { permission: 'users.manage' as const };

  app.get('/api/users', { config: perm }, async () => users.list());

  app.post<{ Body: { username: string; password: string; role: Role; lang?: Lang } }>(
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
            role: { enum: ROLES.filter((r) => r !== 'owner') },
            lang: { enum: ['en', 'es'] },
          },
        },
      },
    },
    async (req) => {
      // New accounts pick their own password at first login.
      const u = await users.create({ ...req.body, mustChangePassword: true });
      audit.log({ actor: actor(req), action: 'user.create', target: u.username, detail: { role: u.role }, ip: req.ip });
      return toPublic(u);
    },
  );

  app.patch<{ Params: { id: number }; Body: { role?: Role; disabled?: boolean } }>(
    '/api/users/:id',
    {
      config: perm,
      schema: {
        params: idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { role: { enum: ROLES.filter((r) => r !== 'owner') }, disabled: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const target = users.byId(req.params.id);
      if (!target) throw new HttpError(404, 'not-found');
      if (req.body.role) users.setRole(target.id, req.body.role);
      if (req.body.disabled !== undefined) users.setDisabled(target.id, req.body.disabled);
      // A role change or disable takes effect everywhere now.
      sessions.revokeAllForUser(target.id);
      audit.log({ actor: actor(req), action: 'user.update', target: target.username, detail: req.body, ip: req.ip });
      return toPublic(users.byId(target.id)!);
    },
  );

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
    audit.log({ actor: actor(req), action: 'user.reset-2fa', target: target.username, ip: req.ip });
    return toPublic(users.byId(target.id)!);
  });

  app.delete<{ Params: { id: number } }>('/api/users/:id', { config: perm, schema: { params: idParam } }, async (req) => {
    const target = users.byId(req.params.id);
    if (!target) throw new HttpError(404, 'not-found');
    users.delete(target.id);
    audit.log({ actor: actor(req), action: 'user.delete', target: target.username, ip: req.ip });
    return { ok: true };
  });

  /**
   * The audit log (ACC-03), filterable by server. Admins on every server see
   * all of it; an admin on some servers sees only those servers' entries,
   * and a server they can't see is "not found".
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
            server: { type: 'string', pattern: SERVER_ID_PATTERN.source },
          },
        },
      },
    },
    async (req) => {
      const user = req.auth!.user;
      const q = { beforeId: req.query.before, action: req.query.action, limit: req.query.limit };
      const everywhere = canHost(principal(user), 'audit.view');
      const mine = everywhere ? null : serversAllowing(deps, user, 'audit.view');
      if (req.query.server !== undefined) {
        // Entries outlive deleted servers, so an admin on every server may ask for any id.
        if (mine && !mine.includes(req.query.server)) throw new HttpError(404, 'server-not-found');
        return audit.list({ ...q, serverId: req.query.server });
      }
      return audit.list(mine ? { ...q, serverIds: mine } : q);
    },
  );
}
