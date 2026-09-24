import { describe, expect, it } from 'vitest';
import { Client, makePanel, ORIGIN, ownerReady } from './harness';
import { SESSION_COOKIE } from '../src/auth/sessions';

async function friend(p: Awaited<ReturnType<typeof makePanel>>, owner: Client, role: 'viewer' | 'operator' | 'admin') {
  const created = await owner.post('/api/users', { username: `amigo-${role}`, password: 'Temporal-12345', role });
  expect(created.statusCode).toBe(200);
  const c = new Client(p.app);
  expect((await c.post('/api/auth/login', { username: `amigo-${role}`, password: 'Temporal-12345' })).json()).toMatchObject({ pending: 'password' });
  const next = await c.post('/api/auth/password', { current: 'Temporal-12345', next: 'La-mia-propia-2026' });
  return { client: c, body: next.json() as { pending: string | null; permissions: string[]; user: { id: number } } };
}

describe('user management', () => {
  it('lets the owner add friends who must pick their own password', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    const op = await friend(p, owner, 'operator');
    // Operators don't need 2FA, so they're in right after choosing a password.
    expect(op.body.pending).toBeNull();
    expect(op.body.permissions).toContain('server.control');
    expect(op.body.permissions).not.toContain('config.edit');

    const adm = await friend(p, owner, 'admin');
    // Admins must enrol 2FA before anything else.
    expect(adm.body.pending).toBe('enrol');
  });

  it('enforces the role matrix on the server', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    const { client: op } = await friend(p, owner, 'operator');
    expect((await op.get('/api/status')).statusCode).toBe(200);
    expect((await op.get('/api/users')).json()).toEqual({ error: 'forbidden' });
    expect((await op.get('/api/audit')).statusCode).toBe(403);
    expect((await op.post('/api/users', { username: 'x', password: 'y', role: 'viewer' })).statusCode).toBe(403);
    expect((await owner.get('/api/audit')).statusCode).toBe(200);
  });

  it('refuses a second owner and changes to the owner', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    expect((await owner.post('/api/users', { username: 'otro', password: 'Temporal-12345', role: 'owner' })).statusCode).toBe(400);
    const me = (await owner.get('/api/session')).json() as { user: { id: number } };
    expect((await owner.req('PATCH', `/api/users/${me.user.id}`, { disabled: true })).json()).toEqual({ error: 'owner-immutable' });
    expect((await owner.req('DELETE', `/api/users/${me.user.id}`)).json()).toEqual({ error: 'owner-immutable' });
  });

  it('kicks a demoted or disabled user out immediately', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    const { client: op, body } = await friend(p, owner, 'operator');
    expect((await owner.req('PATCH', `/api/users/${body.user.id}`, { role: 'viewer' })).statusCode).toBe(200);
    expect((await op.get('/api/status')).statusCode).toBe(401);

    const again = new Client(p.app);
    await again.post('/api/auth/login', { username: 'amigo-operator', password: 'La-mia-propia-2026' });
    expect(((await again.get('/api/session')).json() as { permissions: string[] }).permissions).not.toContain('server.control');

    await owner.req('PATCH', `/api/users/${body.user.id}`, { disabled: true });
    expect((await new Client(p.app).post('/api/auth/login', { username: 'amigo-operator', password: 'La-mia-propia-2026' })).statusCode).toBe(401);
  });

  it('resets a friend’s password and 2FA', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    const { body } = await friend(p, owner, 'operator');
    await owner.post(`/api/users/${body.user.id}/reset-password`, { password: 'Reinicio-temporal-1' });
    const c = new Client(p.app);
    expect((await c.post('/api/auth/login', { username: 'amigo-operator', password: 'Reinicio-temporal-1' })).json()).toMatchObject({ pending: 'password' });
    expect(p.deps.audit.list({ action: 'user.' }).map((e) => e.action)).toContain('user.reset-password');
  });
});

describe('websocket', () => {
  it('streams permitted events and refuses foreign origins', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    await p.app.ready();

    await expect(p.app.injectWS('/api/ws', { headers: { origin: 'https://evil.example', cookie: `${SESSION_COOKIE}=${owner.cookie}` } })).rejects.toThrow();
    await expect(p.app.injectWS('/api/ws', { headers: { origin: ORIGIN } })).rejects.toThrow();

    const messages: { type: string; event?: { type: string } }[] = [];
    const ws = await p.app.injectWS('/api/ws', { headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${owner.cookie}` } }, {
      onInit: (sock) => sock.on('message', (d) => messages.push(JSON.parse(d.toString()))),
    });
    await new Promise((r) => setTimeout(r, 50));
    p.feed.emit({ type: 'log', stream: 'out', line: 'hello from pz' });
    p.feed.emit({ type: 'players', count: 1, names: ['alice'] });
    await new Promise((r) => setTimeout(r, 50));
    expect(messages[0]).toMatchObject({ type: 'hello', agentConnected: true });
    expect(messages.slice(1).map((m) => m.event?.type)).toEqual(['log', 'players']);
    ws.terminate();
  });

  it('hides the log stream from viewers', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    await owner.post('/api/users', { username: 'mirón', password: 'Temporal-12345', role: 'viewer' });
    const v = new Client(p.app);
    await v.post('/api/auth/login', { username: 'mirón', password: 'Temporal-12345' });
    await v.post('/api/auth/password', { current: 'Temporal-12345', next: 'Solo-miro-2026' });
    await p.app.ready();
    const messages: { type: string; logs?: unknown[]; event?: { type: string } }[] = [];
    const ws = await p.app.injectWS('/api/ws', { headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${v.cookie}` } }, {
      onInit: (sock) => sock.on('message', (d) => messages.push(JSON.parse(d.toString()))),
    });
    await new Promise((r) => setTimeout(r, 50));
    p.feed.emit({ type: 'log', stream: 'out', line: 'secret-ish console line' });
    p.feed.emit({ type: 'state', status: p.feed.status_! });
    await new Promise((r) => setTimeout(r, 50));
    expect(messages[0]).toMatchObject({ type: 'hello', logs: [] });
    expect(messages.slice(1).map((m) => m.event?.type)).toEqual(['state']);
    ws.terminate();
  });
});
