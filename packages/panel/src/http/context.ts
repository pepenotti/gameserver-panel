import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Capability } from '@gsp/adapter-api';
import { can, canHost, canOn, hostPermissionsFor, isServerId, isServerPermission, requiresTotp, roleOn, type Permission, type Principal, type Role, type ServerPermission } from '@gsp/shared';
import { userActor, type Actor, type AuditInput } from '../audit';
import type { SessionRow } from '../auth/sessions';
import { SESSION_COOKIE } from '../auth/sessions';
import { toPublic, type PublicUser, type UserRow } from '../auth/users';
import type { ServerContext } from '../servers/context';
import type { Deps } from './deps';

/** What a signed-in session still has to do before it is fully usable. */
export type Pending = 'mfa' | 'password' | 'enrol';

export interface AuthContext {
  session: SessionRow;
  user: UserRow;
  pending: Pending | null;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * `public`: no session. `session`: any signed-in user, no permission
     * (the route is about the session itself, or filters its answer to what
     * the user may see). Otherwise the route declares a `permission`; every
     * /api/ route does one of the three (AST-01, checked by a test).
     */
    auth?: 'public' | 'session';
    permission?: Permission;
    /** What the server's game must support; otherwise 409 `capability-unsupported` (after the permission check). */
    capability?: Capability;
    /** Pending states this route is still reachable in (default: none). */
    allowPending?: Pending[];
    /**
     * A route of one server (set on every route registered through
     * `serverScope`): the guard resolves `:sid` to `req.srv`, answers 404
     * `server-not-found` when the user has no role there, and checks
     * `permission` and `capability` on that server.
     */
    serverScoped?: boolean;
    /**
     * A host route whose (server) `permission` may also be held on some
     * servers only: the guard lets those users in, and the handler narrows
     * what it returns to those servers (the audit log, ACC-03).
     */
    perServer?: boolean;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
    /** The server of a `serverScoped` route. */
    srv: ServerContext | null;
    /** The user's role on `srv`. */
    srvRole: Role | null;
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

export function pendingFor(session: SessionRow, user: UserRow): Pending | null {
  if (!session.mfa_ok) return 'mfa';
  if (user.must_change_password) return 'password';
  if (requiresTotp(user.role) && !user.totp_enabled) return 'enrol';
  return null;
}

/** An account as the permission matrix sees it. */
export function principal(user: UserRow): Principal {
  return { role: user.role, scope: user.scope };
}

/** `permissions`: what the user holds on the host (host permissions, and server permissions on every server). */
export function sessionView(a: AuthContext): { user: PublicUser; csrf: string; pending: Pending | null; permissions: Permission[] } {
  return { user: toPublic(a.user), csrf: a.session.csrf, pending: a.pending, permissions: a.pending ? [] : hostPermissionsFor(principal(a.user)) };
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function installGuards(app: FastifyInstance, deps: Deps): void {
  app.decorateRequest('auth', null);
  app.decorateRequest('srv', null);
  app.decorateRequest('srvRole', null);

  app.addHook('onRequest', async (req) => {
    const isWs = req.headers.upgrade?.toLowerCase() === 'websocket';
    // Cross-site protection: every state change (and every websocket) must come
    // from one of our own origins — exact scheme, host AND port, since another
    // site on :443 can share this hostname and SameSite does not separate ports.
    if (UNSAFE.has(req.method) || isWs) {
      const origin = req.headers.origin;
      if (!origin || !deps.env.origins.includes(origin)) throw new HttpError(403, 'bad-origin');
    }
    const token = req.cookies[SESSION_COOKIE];
    const session = token ? deps.sessions.get(token) : null;
    if (session) {
      const user = deps.users.byId(session.user_id);
      if (user && !user.disabled) req.auth = { session, user, pending: pendingFor(session, user) };
      else deps.sessions.revoke(session.id_hash);
    }
  });

  // Before the body, query and params are validated: who may ask comes
  // first, so nobody learns anything from a 400 about a server they can't
  // see (only a body that isn't JSON at all is refused earlier, by the parser).
  app.addHook('preValidation', async (req: FastifyRequest) => {
    // The static web app (and its SPA fallback) is public; everything private lives under /api/.
    if (!req.url.startsWith('/api/')) return;
    const cfg = req.routeOptions.config;
    if (cfg.auth === 'public' || !req.routeOptions.url) return;
    const a = req.auth;
    if (!a) throw new HttpError(401, 'unauthenticated');
    if (a.pending && !(cfg.allowPending ?? []).includes(a.pending)) throw new HttpError(403, 'pending', undefined, { pending: a.pending });
    if (UNSAFE.has(req.method) && req.headers['x-gsp-csrf'] !== a.session.csrf) throw new HttpError(403, 'bad-csrf');
    if (cfg.serverScoped) {
      // A server the user has no role on doesn't exist for them: 404 whether or not it does.
      const sid = (req.params as { sid?: string } | undefined)?.sid;
      const srv = isServerId(sid) ? deps.servers.get(sid) : null;
      const role = srv && !a.pending ? roleOn(principal(a.user), deps.grants.forUser(a.user.id), srv.id) : null;
      if (!srv || role === null) throw new HttpError(404, 'server-not-found');
      req.srv = srv;
      req.srvRole = role;
      if (cfg.permission && !can(role, cfg.permission)) throw new HttpError(403, 'forbidden');
      if (cfg.capability && !srv.capabilities().has(cfg.capability)) throw new HttpError(409, 'capability-unsupported', undefined, { capability: cfg.capability });
      return;
    }
    if (cfg.permission && (a.pending || !canHost(principal(a.user), cfg.permission))) {
      const perm = cfg.permission;
      const somewhere = cfg.perServer && !a.pending && isServerPermission(perm) && serversAllowing(deps, a.user, perm).length > 0;
      if (!somewhere) throw new HttpError(403, 'forbidden');
    }
  });

  app.addHook('onSend', async (req, reply: FastifyReply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header(
      'content-security-policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        // Mantine sets inline style attributes.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https://steamuserimages-a.akamaihd.net https://images.steamusercontent.com https://shared.steamstatic.com",
        "connect-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    reply.removeHeader('x-powered-by');
    return payload;
  });
}

/** The ids of the servers where `user` holds `permission`. */
export function serversAllowing(deps: Pick<Deps, 'servers' | 'grants'>, user: UserRow, permission: ServerPermission): string[] {
  const who = principal(user);
  const grants = deps.grants.forUser(user.id);
  return deps.servers
    .list()
    .filter((s) => canOn(who, grants, s.id, permission))
    .map((s) => s.id);
}

/** The signed-in person, as the audit log records who acted (AST-02). */
export function actor(req: FastifyRequest): Actor {
  return userActor(req.auth ? req.auth.user : null);
}

/** Who acted, on which server (for routes of one) and from where: the start of every audit entry a route writes (AST-02, ACC-03). */
export function by(req: FastifyRequest): Pick<AuditInput, 'actor' | 'serverId' | 'ip'> {
  return { actor: actor(req), serverId: req.srv?.id ?? null, ip: req.ip };
}

/** The request's server: routes of one (`serverScoped`) always have it. */
export function srvOf(req: FastifyRequest): ServerContext {
  if (!req.srv) throw new HttpError(500, 'internal', 'No server on this route');
  return req.srv;
}

/** Whether the signed-in user holds `permission` where this request acts: on its server, or on the host. */
export function allowed(req: FastifyRequest, permission: Permission): boolean {
  if (!req.auth || req.auth.pending) return false;
  return req.srvRole ? can(req.srvRole, permission) : canHost(principal(req.auth.user), permission);
}
