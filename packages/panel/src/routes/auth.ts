import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requiresTotp } from '@pz/shared';
import { burnPasswordCheck, verifyPassword } from '../auth/passwords';
import { SESSION_COOKIE } from '../auth/sessions';
import { otpauthUri } from '../auth/totp';
import { actor, HttpError, pendingFor, sessionView } from '../http/context';
import type { Deps } from '../http/deps';

const THIRTY_DAYS_S = 30 * 24 * 3600;

function setSessionCookie(reply: FastifyReply, deps: Deps, token: string, maxAgeS: number): void {
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, secure: deps.env.secureCookies, sameSite: 'strict', maxAge: maxAgeS });
}

function clearSessionCookie(reply: FastifyReply, deps: Deps): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: deps.env.secureCookies, sameSite: 'strict' });
}

const tooMany = (ms: number) => new HttpError(429, 'too-many-attempts', undefined, { retryAfterMs: ms });

export function authRoutes(app: FastifyInstance, deps: Deps): void {
  const { users, sessions, audit, breaker } = deps;
  const ua = (req: FastifyRequest) => (typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null);

  app.get('/api/session', { config: { allowPending: ['mfa', 'password', 'enrol'] } }, async (req) => sessionView(req.auth!));

  app.post<{ Body: { username: string; password: string } }>(
    '/api/auth/login',
    {
      config: { auth: 'public' },
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: { username: { type: 'string', minLength: 1, maxLength: 64 }, password: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      const { username, password } = req.body;
      const globalWait = breaker.blockedFor();
      if (globalWait) throw tooMany(globalWait);
      const user = users.byName(username);
      if (!user || user.disabled) {
        const wait = breaker.unknownUserBlockedFor(username);
        if (wait) throw tooMany(wait);
        await burnPasswordCheck(password);
        breaker.recordUnknownUser(username);
        breaker.recordFailure();
        audit.log({ action: 'auth.login', target: username.slice(0, 64), ip: req.ip, ok: false, detail: 'unknown or disabled user' });
        throw new HttpError(401, 'invalid-credentials');
      }
      if (user.locked_until > Date.now()) throw tooMany(user.locked_until - Date.now());
      if (!(await verifyPassword(password, user.password_hash))) {
        users.recordFailure(user.id);
        breaker.recordFailure();
        audit.log({ user: { id: user.id, username: user.username }, action: 'auth.login', ip: req.ip, ok: false, detail: 'wrong password' });
        throw new HttpError(401, 'invalid-credentials');
      }
      users.recordSuccess(user.id);
      // Rotate: any session cookie the browser had is replaced.
      if (req.auth) sessions.revoke(req.auth.session.id_hash);
      const mfaNeeded = user.totp_enabled === 1;
      const { token } = sessions.create(user.id, { mfaOk: !mfaNeeded, ip: req.ip, userAgent: ua(req) });
      setSessionCookie(reply, deps, token, mfaNeeded ? 600 : THIRTY_DAYS_S);
      audit.log({ user: { id: user.id, username: user.username }, action: 'auth.login', ip: req.ip, detail: mfaNeeded ? 'password ok, waiting for 2FA' : undefined });
      const session = sessions.get(token)!;
      return sessionView({ session, user, pending: pendingFor(session, user) });
    },
  );

  app.post<{ Body: { code: string } }>(
    '/api/auth/mfa',
    {
      config: { allowPending: ['mfa'] },
      schema: { body: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string', minLength: 6, maxLength: 20 } } } },
    },
    async (req, reply) => {
      const a = req.auth!;
      if (a.session.mfa_ok) throw new HttpError(400, 'mfa-not-needed');
      if (a.user.locked_until > Date.now()) throw tooMany(a.user.locked_until - Date.now());
      const how = users.checkSecondFactor(a.user.id, req.body.code);
      if (!how) {
        users.recordFailure(a.user.id);
        breaker.recordFailure();
        audit.log({ user: actor(req), action: 'auth.mfa', ip: req.ip, ok: false });
        throw new HttpError(401, 'invalid-code');
      }
      users.recordSuccess(a.user.id);
      // New token after the second factor, so a pending token can't be reused.
      sessions.revoke(a.session.id_hash);
      const { token } = sessions.create(a.user.id, { mfaOk: true, ip: req.ip, userAgent: ua(req) });
      setSessionCookie(reply, deps, token, THIRTY_DAYS_S);
      audit.log({ user: actor(req), action: 'auth.mfa', ip: req.ip, detail: how === 'recovery' ? `recovery code used, ${users.unusedRecoveryCodes(a.user.id)} left` : undefined });
      const session = sessions.get(token)!;
      const user = users.byId(a.user.id)!;
      return sessionView({ session, user, pending: pendingFor(session, user) });
    },
  );

  app.post('/api/auth/logout', { config: { allowPending: ['mfa', 'password', 'enrol'] } }, async (req, reply) => {
    sessions.revoke(req.auth!.session.id_hash);
    clearSessionCookie(reply, deps);
    audit.log({ user: actor(req), action: 'auth.logout', ip: req.ip });
    return { ok: true };
  });

  app.post<{ Body: { current: string; next: string } }>(
    '/api/auth/password',
    {
      config: { allowPending: ['password', 'enrol'] },
      schema: {
        body: {
          type: 'object',
          required: ['current', 'next'],
          additionalProperties: false,
          properties: { current: { type: 'string', maxLength: 200 }, next: { type: 'string', maxLength: 200 } },
        },
      },
    },
    async (req) => {
      const a = req.auth!;
      if (!(await verifyPassword(req.body.current, a.user.password_hash))) {
        users.recordFailure(a.user.id);
        throw new HttpError(400, 'wrong-current-password');
      }
      if (req.body.next === req.body.current) throw new HttpError(400, 'password-unchanged');
      await users.setPassword(a.user.id, req.body.next);
      // Everyone else signed in as this user is signed out.
      const revoked = sessions.revokeAllForUser(a.user.id, a.session.id_hash);
      audit.log({ user: actor(req), action: 'auth.password.change', ip: req.ip, detail: revoked ? `${revoked} other session(s) signed out` : undefined });
      const user = users.byId(a.user.id)!;
      return sessionView({ session: a.session, user, pending: pendingFor(a.session, user) });
    },
  );

  app.post('/api/auth/totp/setup', { config: { allowPending: ['enrol'] } }, async (req) => {
    const a = req.auth!;
    const secret = users.beginTotp(a.user.id);
    return { secret, uri: otpauthUri(secret, a.user.username) };
  });

  app.post<{ Body: { code: string } }>(
    '/api/auth/totp/enable',
    {
      config: { allowPending: ['enrol'] },
      schema: { body: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string', pattern: '^\\d{6}$' } } } },
    },
    async (req) => {
      const a = req.auth!;
      const recoveryCodes = users.enableTotp(a.user.id, req.body.code);
      audit.log({ user: actor(req), action: 'auth.totp.enable', ip: req.ip });
      const user = users.byId(a.user.id)!;
      return { ...sessionView({ session: a.session, user, pending: pendingFor(a.session, user) }), recoveryCodes };
    },
  );

  app.post<{ Body: { password: string } }>(
    '/api/auth/totp/disable',
    { schema: { body: { type: 'object', required: ['password'], additionalProperties: false, properties: { password: { type: 'string', maxLength: 200 } } } } },
    async (req) => {
      const a = req.auth!;
      if (requiresTotp(a.user.role)) throw new HttpError(400, 'totp-required-for-role');
      if (!(await verifyPassword(req.body.password, a.user.password_hash))) throw new HttpError(400, 'wrong-current-password');
      users.disableTotp(a.user.id);
      audit.log({ user: actor(req), action: 'auth.totp.disable', ip: req.ip });
      return { ok: true };
    },
  );
}
