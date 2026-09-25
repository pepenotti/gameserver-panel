// Servers as the API addresses them (M2): the list, routes under
// /api/servers/:sid, per-server roles (ACC-02), the audit log by server and
// by actor (ACC-03, AST-02), and the websocket's per-server messages.
import { describe, expect, it } from 'vitest';
import type { GrantRole } from '@gsp/shared';
import { runCli } from '../src/cli/commands';
import { SESSION_COOKIE } from '../src/auth/sessions';
import { Client, makePanel, ORIGIN, ownerReady, totpCode, type TestPanel } from './harness';

type Role = 'viewer' | 'operator' | 'admin';

/**
 * A friend signed in and ready: with `grant`, an account of scope `granted`
 * holding that role on `default` (or on nothing, with `null`).
 */
async function friend(p: TestPanel, owner: Client, name: string, role: Role, grant?: GrantRole | null): Promise<Client> {
  const created = (await owner.post('/api/users', { username: name, password: 'Temporal-12345', role })).json() as { id: number };
  if (grant !== undefined) {
    p.deps.users.setScope(created.id, 'granted');
    if (grant) p.deps.grants.set(created.id, 'default', grant);
  }
  const c = new Client(p.app);
  await c.post('/api/auth/login', { username: name, password: 'Temporal-12345' });
  const after = (await c.post('/api/auth/password', { current: 'Temporal-12345', next: 'La-mia-propia-2026' })).json() as { pending: string | null };
  if (after.pending === 'enrol') {
    const { secret } = (await c.post('/api/auth/totp/setup')).json() as { secret: string };
    await c.post('/api/auth/totp/enable', { code: totpCode(secret, 0) });
  }
  return c;
}

describe('the server list (SRV-02)', () => {
  it('lists the servers a user may see, with their role and permissions there', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    const list = (await owner.get('/api/servers')).json() as { id: string; name: string; adapter: string; state: string; role: string; permissions: string[]; players: unknown; version: string }[];
    expect(list).toEqual([
      expect.objectContaining({ id: 'default', name: 'zomboid', adapter: 'pz', adapterName: expect.objectContaining({ en: 'Project Zomboid' }), state: 'stopped', role: 'owner', players: null, version: '42.20.4' }),
    ]);
    expect(list[0]!.permissions).toContain('reset.factory');
    expect((await new Client(p.app).get('/api/servers')).statusCode).toBe(401);
  });

  it('shows a granted account only its servers, with its grant role', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    const op = await friend(p, owner, 'granted-op', 'operator', 'operator');
    const none = await friend(p, owner, 'granted-none', 'viewer', null);
    expect((await op.get('/api/servers')).json()).toEqual([expect.objectContaining({ id: 'default', role: 'operator', permissions: expect.arrayContaining(['server.control']) })]);
    expect((await none.get('/api/servers')).json()).toEqual([]);
  });
});

describe('routes of one server (ACC-02)', () => {
  it('answers 401 signed out, and 404 for a server that is unknown or not yours, never 403', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    expect((await new Client(p.app).get('/api/servers/default/meta')).statusCode).toBe(401);
    for (const url of ['/api/servers/nope/meta', '/api/servers/BAD/meta', '/api/servers/a/status']) expect((await owner.get(url)).json(), url).toEqual({ error: 'server-not-found' });

    const outsider = await friend(p, owner, 'outsider', 'admin', null);
    // Whatever the route asks for, a server you have no role on doesn't exist.
    for (const [method, url, body] of [
      ['GET', '/api/servers/default/meta'],
      ['GET', '/api/servers/default/status'],
      ['POST', '/api/servers/default/server/start', {}],
      ['GET', '/api/servers/default/config/meta'],
      ['POST', '/api/servers/default/reset', { scope: 'world', confirm: 'zomboid' }],
    ] as [string, string, unknown?][]) {
      // Valid bodies: a bad one is refused (400) before anyone looks at the server.
      const r = await outsider.req(method as 'GET' | 'POST', url, body);
      expect(r.json(), `${method} ${url}`).toEqual({ error: 'server-not-found' });
    }
    expect(p.agent.calls).toEqual([]);
  });

  it('checks each route against the role on that server', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    // A scope-granted operator on default: an account role of viewer would not let them start it.
    const op = await friend(p, owner, 'shift-op', 'viewer', 'operator');
    expect((await op.post('/api/servers/default/server/start')).statusCode).toBe(200);
    await p.srv.ops.idle();
    expect((await op.get('/api/servers/default/config/meta')).json()).toEqual({ error: 'forbidden' });
    expect((await op.get('/api/servers/default/meta')).statusCode).toBe(200);
    // Host routes need scope all.
    expect((await op.get('/api/audit')).statusCode).toBe(403);
    expect(p.deps.audit.list({ action: 'server.start' })[0]).toMatchObject({ serverId: 'default', actorType: 'user', username: 'shift-op' });

    // An account role applies everywhere unless a grant raises it on one server.
    const viewer = await friend(p, owner, 'all-viewer', 'viewer');
    expect((await viewer.post('/api/servers/default/server/start')).statusCode).toBe(403);
    const me = ((await viewer.get('/api/session')).json() as { user: { id: number } }).user.id;
    p.deps.grants.set(me, 'default', 'operator');
    expect((await viewer.post('/api/servers/default/server/start')).statusCode).toBe(200);
  });
});

describe('the audit log by server and actor (ACC-03, AST-02)', () => {
  it('records the server and who acted, and filters by server', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    await owner.post('/api/servers/default/server/start');
    await p.srv.ops.idle();
    await p.srv.scheduler.runBackup();
    await p.srv.ops.idle();
    await runCli(['backup-db'], { db: p.deps.db, backupDir: p.deps.env.backupDir, out: () => undefined });

    const all = (await owner.get('/api/audit')).json() as { action: string; serverId: string | null; actorType: string }[];
    expect(all.find((e) => e.action === 'server.start')).toMatchObject({ serverId: 'default', actorType: 'user' });
    expect(all.find((e) => e.action === 'schedule.backup')).toMatchObject({ serverId: 'default', actorType: 'schedule' });
    expect(all.find((e) => e.action === 'cli.backup-db')).toMatchObject({ serverId: null, actorType: 'recovery' });
    expect(all.find((e) => e.action === 'auth.login')).toMatchObject({ serverId: null, actorType: 'user' });

    const one = (await owner.get('/api/audit?server=default')).json() as { serverId: string }[];
    expect(one.length).toBeGreaterThan(0);
    expect(one.every((e) => e.serverId === 'default')).toBe(true);
    expect((await owner.get('/api/audit?server=Not_An_Id')).statusCode).toBe(400);
  });

  it('shows an admin of some servers only those servers', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    await owner.post('/api/servers/default/server/start');
    await p.srv.ops.idle();
    const adm = await friend(p, owner, 'server-admin', 'admin', 'admin');
    const seen = (await adm.get('/api/audit')).json() as { serverId: string | null }[];
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.serverId === 'default')).toBe(true);
    expect((await adm.get('/api/audit?server=default')).statusCode).toBe(200);
    expect((await adm.get('/api/audit?server=other')).json()).toEqual({ error: 'server-not-found' });
    const op = await friend(p, owner, 'server-op', 'operator', 'operator');
    expect((await op.get('/api/audit')).statusCode).toBe(403);
  });
});

describe('the websocket (ACC-02)', () => {
  async function listen(p: TestPanel, c: Client) {
    await p.app.ready();
    const messages: { type: string; serverId?: string; servers?: { serverId: string }[] }[] = [];
    const ws = await p.app.injectWS('/api/ws', { headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${c.cookie}` } }, {
      onInit: (sock) => sock.on('message', (d) => messages.push(JSON.parse(d.toString()))),
    });
    await new Promise((r) => setTimeout(r, 50));
    return { ws, messages };
  }

  it('sends only the servers a user may see, each message naming its server', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    const outsider = await friend(p, owner, 'ws-outsider', 'operator', null);
    const a = await listen(p, owner);
    const b = await listen(p, outsider);
    p.feed.emit({ type: 'players', count: 1, names: ['rick'] });
    p.deps.bus.emit({ type: 'notice', serverId: 'default', kind: 'x', message: 'for default viewers', permission: 'server.view' });
    await new Promise((r) => setTimeout(r, 50));
    expect(a.messages[0]).toEqual(expect.objectContaining({ type: 'hello', servers: [expect.objectContaining({ serverId: 'default' })] }));
    expect(a.messages.slice(1).map((m) => [m.type, m.serverId])).toEqual([
      ['event', 'default'],
      ['notice', 'default'],
    ]);
    expect(b.messages).toEqual([{ type: 'hello', servers: [] }]);
    a.ws.terminate();
    b.ws.terminate();
  });
});
