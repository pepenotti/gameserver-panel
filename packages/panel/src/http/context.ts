import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { can, permissionsFor, requiresTotp, type Permission } from '@pz/shared';
import type { SessionRow } from '../auth/sessions';
import { SESSION_COOKIE } from '../auth/sessions';
import { toPublic, type PublicUser, type UserRow } from '../auth/users';
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
    /** `public`: no session. Otherwise a session is required. */
    auth?: 'public';
    permission?: Permission;
    /** Pending states this route is still reachable in (default: none). */
    allowPending?: Pending[];
  }
  interface FastifyRequest {
    auth: AuthContext | null;
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

export function sessionView(a: AuthContext): { user: PublicUser; csrf: string; pending: Pending | null; permissions: Permission[] } {
  return { user: toPublic(a.user), csrf: a.session.csrf, pending: a.pending, permissions: a.pending ? [] : permissionsFor(a.user.role) };
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function installGuards(app: FastifyInstance, deps: Deps): void {
  app.decorateRequest('auth', null);

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

  app.addHook('preHandler', async (req: FastifyRequest) => {
    // The static web app (and its SPA fallback) is public; everything private lives under /api/.
    if (!req.url.startsWith('/api/')) return;
    const cfg = req.routeOptions.config;
    if (cfg.auth === 'public' || !req.routeOptions.url) return;
    const a = req.auth;
    if (!a) throw new HttpError(401, 'unauthenticated');
    if (a.pending && !(cfg.allowPending ?? []).includes(a.pending)) throw new HttpError(403, 'pending', undefined, { pending: a.pending });
    if (UNSAFE.has(req.method) && req.headers['x-pz-csrf'] !== a.session.csrf) throw new HttpError(403, 'bad-csrf');
    if (cfg.permission && (a.pending || !can(a.user.role, cfg.permission))) throw new HttpError(403, 'forbidden');
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

export function actor(req: FastifyRequest): { id: number; username: string } | null {
  return req.auth ? { id: req.auth.user.id, username: req.auth.user.username } : null;
}
