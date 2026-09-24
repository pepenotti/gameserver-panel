import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/sessions';
import { Client, makePanel, ORIGIN, OWNER, ownerReady, totpCode } from './harness';

describe('first login of the bootstrapped owner', () => {
  it('forces a password change, then 2FA enrolment, then unlocks the panel', async () => {
    const p = await makePanel();
    const c = new Client(p.app);

    const login = await c.post('/api/auth/login', OWNER);
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ pending: 'password', permissions: [], user: { username: 'alice', role: 'owner' } });

    const cookie = login.cookies.find((x) => x.name === SESSION_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });

    expect((await c.get('/api/status')).json()).toMatchObject({ error: 'pending', pending: 'password' });

    const weak = await c.post('/api/auth/password', { current: OWNER.password, next: 'short' });
    expect(weak.json()).toEqual({ error: 'password-too-short' });
    const changed = await c.post('/api/auth/password', { current: OWNER.password, next: 'Nueva-clave-segura-2026' });
    expect(changed.json()).toMatchObject({ pending: 'enrol' });
    expect((await c.get('/api/status')).statusCode).toBe(403);

    const setup = (await c.post('/api/auth/totp/setup')).json() as { secret: string; uri: string };
    expect(setup.uri).toMatch(/^otpauth:\/\/totp\/Zomboid%20Panel%3Aalice\?secret=[A-Z2-7]+&issuer=Zomboid%20Panel/);
    expect((await c.post('/api/auth/totp/enable', { code: '000000' })).json()).toEqual({ error: 'totp-invalid' });
    const enabled = await c.post('/api/auth/totp/enable', { code: totpCode(setup.secret, 0) });
    expect(enabled.json()).toMatchObject({ pending: null, recoveryCodes: expect.arrayContaining([expect.stringMatching(/^[a-z2-9]{4}-[a-z2-9]{4}$/)]) });
    expect((enabled.json() as { permissions: string[] }).permissions).toContain('users.manage');

    const status = await c.get('/api/status');
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ serverName: 'zomboid', agentConnected: true, agent: { state: 'stopped' } });
  });
});

describe('signing in with 2FA', () => {
  it('needs a fresh code, refuses replays, and accepts a recovery code once', async () => {
    const p = await makePanel();
    const { secret, password, recoveryCodes } = await ownerReady(p);

    const c = new Client(p.app);
    expect((await c.post('/api/auth/login', { username: 'ALICE', password })).json()).toMatchObject({ pending: 'mfa' });
    const pendingCookie = c.cookie;
    expect((await c.get('/api/status')).statusCode).toBe(403);
    expect((await c.post('/api/auth/mfa', { code: '123456' })).statusCode).toBe(401);
    const code = totpCode(secret, 1);
    expect((await c.post('/api/auth/mfa', { code })).json()).toMatchObject({ pending: null });
    // The pending token was rotated away.
    expect(c.cookie).not.toBe(pendingCookie);
    expect((await c.get('/api/status')).statusCode).toBe(200);

    const replay = new Client(p.app);
    await replay.post('/api/auth/login', { username: 'alice', password });
    expect((await replay.post('/api/auth/mfa', { code })).statusCode).toBe(401);

    const rec = new Client(p.app);
    await rec.post('/api/auth/login', { username: 'alice', password });
    expect((await rec.post('/api/auth/mfa', { code: recoveryCodes[0]!.toUpperCase() })).statusCode).toBe(200);
    const again = new Client(p.app);
    await again.post('/api/auth/login', { username: 'alice', password });
    expect((await again.post('/api/auth/mfa', { code: recoveryCodes[0]! })).statusCode).toBe(401);
  });
});

describe('cross-site protection', () => {
  it('rejects state changes without our exact origin', async () => {
    const p = await makePanel();
    expect((await new Client(p.app, null).post('/api/auth/login', OWNER)).json()).toEqual({ error: 'bad-origin' });
    // Same host, different port (another site on :443) is a different origin.
    expect((await new Client(p.app, 'https://panel.test').post('/api/auth/login', OWNER)).statusCode).toBe(403);
    expect((await new Client(p.app, ORIGIN).post('/api/auth/login', OWNER)).statusCode).toBe(200);
  });

  it('requires the CSRF header on authenticated changes', async () => {
    const p = await makePanel();
    const { client } = await ownerReady(p);
    const noCsrf = await p.app.inject({
      method: 'PUT',
      url: '/api/me',
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${client.cookie}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ lang: 'en' }),
    });
    expect(noCsrf.json()).toEqual({ error: 'bad-csrf' });
    expect((await client.req('PUT', '/api/me', { lang: 'en' })).json()).toMatchObject({ lang: 'en' });
  });

  it('refuses text/plain bodies that a form on another site could send', async () => {
    const p = await makePanel();
    const r = await p.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN, 'content-type': 'text/plain' }, payload: 'x' });
    expect(r.statusCode).toBe(415);
  });

  it('sends strict security headers', async () => {
    const p = await makePanel();
    const r = await p.app.inject({ method: 'GET', url: '/api/health' });
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('throttling', () => {
  it('slows an account down after repeated failures instead of locking it', async () => {
    const p = await makePanel();
    const c = new Client(p.app);
    for (let i = 0; i < 3; i++) expect((await c.post('/api/auth/login', { username: 'alice', password: 'wrong-password' })).statusCode).toBe(401);
    const blocked = await c.post('/api/auth/login', OWNER);
    expect(blocked.statusCode).toBe(429);
    expect((blocked.json() as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await c.post('/api/auth/login', OWNER)).statusCode).toBe(200);
  });

  it('treats unknown usernames the same way', async () => {
    const p = await makePanel();
    const c = new Client(p.app);
    const first = await c.post('/api/auth/login', { username: 'nobody', password: 'x' });
    expect(first.json()).toEqual({ error: 'invalid-credentials' });
    for (let i = 0; i < 2; i++) await c.post('/api/auth/login', { username: 'nobody', password: 'x' });
    expect((await c.post('/api/auth/login', { username: 'nobody', password: 'x' })).statusCode).toBe(429);
  });

  it('records failures in the audit log', async () => {
    const p = await makePanel();
    await new Client(p.app).post('/api/auth/login', { username: 'alice', password: 'nope-nope-nope' });
    expect(p.deps.audit.list({ action: 'auth.login' })[0]).toMatchObject({ ok: false, username: 'alice', detail: 'wrong password' });
  });
});

describe('sessions', () => {
  it('signs other sessions out when the password changes', async () => {
    const p = await makePanel();
    const { client, secret, password } = await ownerReady(p);
    const other = new Client(p.app);
    await other.post('/api/auth/login', { username: 'alice', password });
    await other.post('/api/auth/mfa', { code: totpCode(secret, 1) });
    expect((await other.get('/api/status')).statusCode).toBe(200);

    await client.post('/api/auth/password', { current: password, next: 'Otra-clave-mas-segura' });
    expect((await other.get('/api/status')).statusCode).toBe(401);
    expect((await client.get('/api/status')).statusCode).toBe(200);
  });

  it('lists and revokes own sessions', async () => {
    const p = await makePanel();
    const { client } = await ownerReady(p);
    const list = (await client.get('/api/me/sessions')).json() as { id: string; current: boolean }[];
    expect(list).toHaveLength(1);
    expect(list[0]!.current).toBe(true);
    expect((await client.req('DELETE', `/api/me/sessions/${list[0]!.id}`)).statusCode).toBe(200);
    expect((await client.get('/api/status')).statusCode).toBe(401);
  });

  it('logs out', async () => {
    const p = await makePanel();
    const { client } = await ownerReady(p);
    expect((await client.post('/api/auth/logout')).statusCode).toBe(200);
    expect(client.cookie).toBeNull();
  });
});
