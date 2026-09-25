// Servers as the API addresses them (M2): the list, creating, renaming and
// removing servers, routes under /api/servers/:sid, per-server roles and
// their API (ACC-02), the audit log by server and by actor (ACC-03,
// AST-02), and the websocket's per-server messages.
import { describe, expect, it } from 'vitest';
import { panelAdapterEntries } from '@gsp/adapters/panel';
import { runCli } from '../src/cli/commands';
import { OrchestratorCallError } from '../src/servers/orchestrator';
import { Client, fakeStatus, friend, listenWs, makePanel, ownerReady, until, type TestPanel } from './harness';

/** Creates `pz-two` through the API as `c`. */
function createTwo(c: Client, over: Record<string, unknown> = {}) {
  return c.post('/api/servers', { id: 'pz-two', name: 'Second', adapter: 'pz', ...over });
}

async function userId(p: TestPanel, name: string): Promise<number> {
  return p.deps.users.byName(name)!.id;
}

describe('the server list (SRV-02)', () => {
  it('lists the servers a user may see, with their state, players, version, next restart and role there', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    const list = (await owner.get('/api/servers')).json() as { id: string; permissions: string[] }[];
    expect(list).toEqual([
      expect.objectContaining({
        id: 'default',
        name: 'zomboid',
        adapter: 'pz',
        adapterName: expect.objectContaining({ en: 'Project Zomboid' }),
        state: 'stopped',
        role: 'owner',
        players: null,
        version: '42.20.4',
        nextRestart: null,
        managed: false,
        ports: [
          { id: 'game', port: 16261, proto: 'udp' },
          { id: 'udp', port: 16262, proto: 'udp' },
        ],
        memLimitMb: 8192 + 3072,
      }),
    ]);
    expect(list[0]!.permissions).toContain('reset.factory');
    expect((await new Client(p.app).get('/api/servers')).statusCode).toBe(401);
    // Players while it runs, and the next scheduled restart once its timers run.
    p.feed.status_ = fakeStatus({ state: 'running', players: { count: 3, names: [], at: new Date().toISOString() } });
    p.srv.scheduler.reload();
    const running = (await owner.get('/api/servers')).json() as { players: number; nextRestart: string | null }[];
    p.srv.scheduler.stop();
    expect(running[0]).toMatchObject({ players: 3, nextRestart: expect.stringMatching(/^\d{4}-/) });
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

describe('creating, renaming and removing servers through the API (SRV-01, SRV-04)', () => {
  it('lets an admin of every server create one, and nobody else', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    const adapters = (await owner.get('/api/adapters')).json() as { host: { arch: string }; adapters: { id: string; supported: boolean; eula: boolean; ports: unknown[]; launch: { secrets: unknown[] } }[] };
    expect(adapters.host).toMatchObject({ arch: 'amd64', cpus: 8, hostPorts: null, maxMemMb: null });
    // What this install lets a server have, when the orchestrator says (SRV-01, SRV-05).
    p.orch.hostPorts = [{ from: 30150, to: 30199 }];
    p.orch.maxMemMb = 6144;
    expect(((await owner.get('/api/adapters')).json() as { host: unknown }).host).toMatchObject({ hostPorts: [{ from: 30150, to: 30199 }], maxMemMb: 6144 });
    p.orch.hostPorts = undefined;
    p.orch.maxMemMb = undefined;
    expect(adapters.adapters).toEqual([expect.objectContaining({ id: 'pz', supported: true, eula: false, launch: expect.objectContaining({ secrets: [expect.objectContaining({ key: 'adminPassword' })] }) })]);

    const granted = await friend(p, owner, 'granted-admin', 'admin', 'admin');
    const everywhere = await friend(p, owner, 'all-admin', 'admin');
    const op = await friend(p, owner, 'all-op', 'operator');
    // An admin of some servers only can't create one (servers.create needs scope all).
    expect((await createTwo(granted)).json()).toEqual({ error: 'forbidden' });
    expect((await granted.get('/api/adapters')).statusCode).toBe(403);
    expect((await createTwo(op)).statusCode).toBe(403);
    expect((await createTwo(everywhere, { id: 'Bad' })).json()).toMatchObject({ error: 'validation' });

    const r = await createTwo(everywhere, { ports: { game: 17000, udp: 17001 }, launch: { memoryMb: 4096 } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: 'pz-two', name: 'Second', managed: true, role: 'admin', ports: [{ id: 'game', port: 17000, proto: 'udp' }, { id: 'udp', port: 17001, proto: 'udp' }], memLimitMb: 7168 });
    expect((await owner.get('/api/servers')).json()).toEqual([expect.objectContaining({ id: 'default' }), expect.objectContaining({ id: 'pz-two', state: 'stopped' })]);
    // The one who created it and every scope-all account see it; the granted admin doesn't.
    expect(((await granted.get('/api/servers')).json() as { id: string }[]).map((s) => s.id)).toEqual(['default']);
    expect((await createTwo(owner)).json()).toEqual({ error: 'server-exists' });
    expect(p.deps.audit.list({ action: 'server.create' })[0]).toMatchObject({ serverId: 'pz-two', username: 'all-admin', ok: true, ip: expect.any(String) });
  });

  it('offers no adapter skeleton: they are registered, but neither listed nor creatable (D4, D5)', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    const skeletons = panelAdapterEntries.filter((e) => !e.enabled).map((e) => e.adapter.meta.id);
    expect(skeletons).toEqual(['minecraft', 'terraria', 'valheim', 'manifest']);
    const listed = ((await owner.get('/api/adapters')).json() as { adapters: { id: string }[] }).adapters.map((a) => a.id);
    expect(listed).toEqual(['pz']);
    p.orch.calls.length = 0;
    for (const adapter of skeletons) expect((await createTwo(owner, { id: `x-${adapter}`, name: adapter, adapter })).json(), adapter).toEqual({ error: 'unknown-adapter' });
    expect(p.orch.calls).toEqual([]);
    expect(((await owner.get('/api/servers')).json() as { id: string }[]).map((s) => s.id)).toEqual(['default']);
  });

  it('renames with server.update, and removes after typing the name; only the owner drops the backups', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    expect((await createTwo(owner)).statusCode).toBe(200);
    const admin = await friend(p, owner, 'two-admin', 'admin', { 'pz-two': 'admin' });
    const op = await friend(p, owner, 'two-op', 'operator', { 'pz-two': 'operator' });

    expect((await op.req('PATCH', '/api/servers/pz-two', { name: 'Nope' })).json()).toEqual({ error: 'forbidden' });
    expect((await admin.req('PATCH', '/api/servers/pz-two', { name: 'Renamed' })).json()).toMatchObject({ id: 'pz-two', name: 'Renamed' });
    expect((await admin.req('PATCH', '/api/servers/pz-two', {})).statusCode).toBe(400);

    expect((await op.req('DELETE', '/api/servers/pz-two', { confirm: 'Renamed' })).json()).toEqual({ error: 'forbidden' });
    expect((await admin.req('DELETE', '/api/servers/pz-two', {})).json()).toMatchObject({ error: 'validation' });
    expect((await admin.req('DELETE', '/api/servers/pz-two', { confirm: 'Second' })).json()).toEqual({ error: 'confirm-mismatch' });
    expect((await admin.req('DELETE', '/api/servers/pz-two', { confirm: 'Renamed', keepBackups: false })).json()).toEqual({ error: 'forbidden' });
    expect((await admin.req('DELETE', '/api/servers/pz-two', { confirm: 'Renamed', finalBackup: false })).json()).toEqual({ error: 'forbidden' });
    // default is the stack's own: never deleted from here.
    expect((await owner.req('DELETE', '/api/servers/default', { confirm: 'zomboid' })).json()).toEqual({ error: 'server-unmanaged' });

    // Forcing a server out is the owner's call alone too.
    expect((await admin.req('DELETE', '/api/servers/pz-two', { confirm: 'Renamed', force: true })).json()).toEqual({ error: 'forbidden' });

    const r = await admin.req('DELETE', '/api/servers/pz-two', { confirm: 'Renamed' });
    expect(r.json()).toEqual({ ok: true, finalBackup: expect.stringMatching(/\.tar\.zst$/), forced: false, finalBackupError: null });
    // Gone for everyone; its audit entries stay, for those who may read them.
    expect(((await owner.get('/api/servers')).json() as { id: string }[]).map((s) => s.id)).toEqual(['default']);
    expect((await admin.get('/api/servers/pz-two/meta')).json()).toEqual({ error: 'server-not-found' });
    const history = (await owner.get('/api/audit?server=pz-two')).json() as { action: string; username: string }[];
    expect(history.map((e) => e.action)).toEqual(['server.delete', 'server.update', 'server.create']);
    expect(history.find((e) => e.action === 'server.delete')).toMatchObject({ username: 'two-admin' });
  });
});

describe('forcing a server out through the API (SRV-04)', () => {
  it("lets the owner remove a server stuck stopping whose agent doesn't answer, and says the final backup was skipped", async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    expect((await createTwo(owner)).statusCode).toBe(200);
    // Its game hangs while stopping, then its agent stops answering: it can be neither stopped nor backed up.
    p.fakes('pz-two').feed.status_ = fakeStatus({ state: 'stopping' });
    p.fakes('pz-two').agent.lock = () => Promise.reject(new Error('agent unreachable'));
    expect((await owner.req('DELETE', '/api/servers/pz-two', { confirm: 'Second' })).json()).toEqual({ error: 'server-running' });
    const r = await owner.req('DELETE', '/api/servers/pz-two', { confirm: 'Second', force: true });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, finalBackup: null, forced: true, finalBackupError: expect.any(String) });
    expect(((await owner.get('/api/servers')).json() as { id: string }[]).map((s) => s.id)).toEqual(['default']);
    const [entry] = (await owner.get('/api/audit?server=pz-two')).json() as { action: string; detail: string }[];
    expect(entry).toMatchObject({ action: 'server.delete', detail: expect.stringContaining('"forced":true') });
  });
});

describe('memory and CPU limits through the API (SRV-05)', () => {
  it("changes a server's limits with server.update, and moves them with the game's memory", async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    p.orch.maxMemMb = 8192;
    expect((await createTwo(owner, { launch: { memoryMb: 2048 } })).json()).toMatchObject({ memLimitMb: 5120, cpus: null, containerPending: false });
    const admin = await friend(p, owner, 'two-admin', 'admin', { 'pz-two': 'admin' });
    const op = await friend(p, owner, 'two-op', 'operator', { 'pz-two': 'operator' });

    expect((await op.req('PATCH', '/api/servers/pz-two', { memLimitMb: 6144 })).json()).toEqual({ error: 'forbidden' });
    expect((await admin.req('PATCH', '/api/servers/pz-two', { memLimitMb: 6144, cpus: 1.5 })).json()).toMatchObject({ id: 'pz-two', memLimitMb: 6144, cpus: 1.5, containerPending: false });
    expect(p.orch.containers.get('pz-two')!.spec).toMatchObject({ memoryMb: 6144, cpus: 1.5 });
    expect((await admin.req('PATCH', '/api/servers/pz-two', { memLimitMb: 9000 })).json()).toMatchObject({ error: 'orchestrator-refused', field: 'memLimitMb', maxMb: 8192 });
    expect((await admin.req('PATCH', '/api/servers/pz-two', { memLimitMb: 100 })).json()).toMatchObject({ error: 'validation' });

    // While the game runs, the new limit waits for its next start, and the list says so.
    p.fakes('pz-two').feed.status_ = fakeStatus({ state: 'running' });
    expect((await admin.req('PATCH', '/api/servers/pz-two', { memLimitMb: 7168 })).json()).toMatchObject({ memLimitMb: 7168, containerPending: true });
    expect(((await owner.get('/api/servers')).json() as { id: string; containerPending: boolean }[]).find((s) => s.id === 'pz-two')).toMatchObject({ containerPending: true });
    p.fakes('pz-two').feed.status_ = fakeStatus();

    // More memory for the game: its container's limit follows, keeping the room it had (7168 - 5120).
    const launch = (await admin.get('/api/servers/pz-two/server/launch')).json() as Record<string, unknown>;
    expect((await admin.req('PUT', '/api/servers/pz-two/server/launch', { ...launch, memoryMb: 3072 })).statusCode).toBe(200);
    expect(p.deps.serverRows.get('pz-two')!.memLimitMb).toBe(8192);
    expect(p.orch.containers.get('pz-two')!.spec.memoryMb).toBe(8192);
    // Beyond what the host gives one server: refused, and the launch settings stay as they were.
    const refused = await admin.req('PUT', '/api/servers/pz-two/server/launch', { ...launch, memoryMb: 6144 });
    expect(refused.json()).toMatchObject({ error: 'orchestrator-refused', maxMb: 8192 });
    expect(((await admin.get('/api/servers/pz-two/server/launch')).json() as { memoryMb: number }).memoryMb).toBe(3072);
  });

  it('tells an admin of one server the most the host gives a server, before the API refuses more (SRV-05)', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    await createTwo(owner, { launch: { memoryMb: 2048 } });
    const admin = await friend(p, owner, 'two-admin', 'admin', { 'pz-two': 'admin' });
    const op = await friend(p, owner, 'two-op', 'operator', { 'pz-two': 'operator' });
    // It can't create servers, so the host's summary is not for it.
    expect((await admin.get('/api/adapters')).json()).toEqual({ error: 'forbidden' });

    p.orch.maxMemMb = 6144;
    expect((await admin.get('/api/servers/pz-two/limits')).json()).toEqual({ maxMemMb: 6144, cpus: 8 });
    expect((await admin.req('PATCH', '/api/servers/pz-two', { memLimitMb: 6144 + 1024 })).json()).toMatchObject({ error: 'orchestrator-refused', maxMb: 6144 });
    expect((await admin.req('PATCH', '/api/servers/pz-two', { cpus: 9 })).json()).toMatchObject({ error: 'invalid-cpus', max: 8 });
    // The same answer the host's summary gives those who create servers.
    const host = ((await owner.get('/api/adapters')).json() as { host: { maxMemMb: number; cpus: number } }).host;
    expect((await owner.get('/api/servers/pz-two/limits')).json()).toEqual({ maxMemMb: host.maxMemMb, cpus: host.cpus });

    // An orchestrator that doesn't say, or can't be asked: nothing to show, and its refusals still tell.
    p.orch.maxMemMb = undefined;
    expect((await admin.get('/api/servers/pz-two/limits')).json()).toEqual({ maxMemMb: null, cpus: 8 });
    p.orch.failNext.set('host', new OrchestratorCallError(0, 'unreachable', 'connect ECONNREFUSED'));
    expect((await admin.get('/api/servers/pz-two/limits')).json()).toEqual({ maxMemMb: null, cpus: null });

    // It needs server.update there; a server it has no role on doesn't exist.
    expect((await op.get('/api/servers/pz-two/limits')).json()).toEqual({ error: 'forbidden' });
    expect((await admin.get('/api/servers/default/limits')).json()).toEqual({ error: 'server-not-found' });
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
      // Access is checked before the body: a bad one doesn't tell the server exists either.
      ['POST', '/api/servers/default/reset', { bogus: true }],
      ['GET', '/api/servers/default/backups/not-a-backup/download'],
    ] as [string, string, unknown?][]) {
      const r = await outsider.req(method as 'GET' | 'POST', url, body);
      expect(r.json(), `${method} ${url}`).toEqual({ error: 'server-not-found' });
    }
    // Signed out comes first, whatever the body.
    expect((await new Client(p.app).req('POST', '/api/servers/default/reset', { bogus: true })).statusCode).toBe(401);
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

describe('grants and scope, through the owner’s API (ACC-02)', () => {
  it('sets and removes a user’s role per server, keeping the account role at the highest grant', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    await createTwo(owner);
    const created = (await owner.post('/api/users', { username: 'bob', password: 'Temporal-12345', role: 'admin', scope: 'granted' })).json() as { id: number; role: string; scope: string; grants: unknown[] };
    // Granted, with nothing granted yet: a viewer of nothing.
    expect(created).toMatchObject({ role: 'viewer', scope: 'granted', grants: [] });
    const bob = new Client(p.app);
    await bob.post('/api/auth/login', { username: 'bob', password: 'Temporal-12345' });
    await bob.post('/api/auth/password', { current: 'Temporal-12345', next: 'La-mia-propia-2026' });
    expect((await bob.get('/api/servers')).json()).toEqual([]);

    const put = await owner.req('PUT', `/api/users/${created.id}/grants/pz-two`, { role: 'operator' });
    expect(put.json()).toEqual({ userId: created.id, scope: 'granted', role: 'operator', grants: [{ serverId: 'pz-two', role: 'operator' }] });
    // No sign-out needed: the next request sees it.
    expect(((await bob.get('/api/servers')).json() as { id: string; role: string }[]).map((s) => [s.id, s.role])).toEqual([['pz-two', 'operator']]);
    // An admin grant makes the account an admin, so 2FA becomes mandatory before anything else.
    await owner.req('PUT', `/api/users/${created.id}/grants/default`, { role: 'admin' });
    expect((await owner.get(`/api/users/${created.id}/grants`)).json()).toMatchObject({ role: 'admin', grants: [{ serverId: 'default', role: 'admin' }, { serverId: 'pz-two', role: 'operator' }] });
    expect((await bob.get('/api/servers')).json()).toMatchObject({ error: 'pending', pending: 'enrol' });
    expect(((await owner.get('/api/users')).json() as { username: string; grants: unknown[] }[]).find((u) => u.username === 'bob')!.grants).toHaveLength(2);

    expect((await owner.req('DELETE', `/api/users/${created.id}/grants/default`)).json()).toMatchObject({ role: 'operator', grants: [{ serverId: 'pz-two', role: 'operator' }] });
    expect((await owner.req('DELETE', `/api/users/${created.id}/grants/default`)).json()).toEqual({ error: 'not-found' });
    expect((await owner.req('PUT', `/api/users/${created.id}/grants/nope`, { role: 'viewer' })).json()).toEqual({ error: 'server-not-found' });
    expect((await owner.req('PUT', `/api/users/${created.id}/grants/pz-two`, { role: 'owner' })).statusCode).toBe(400);
    const ownerId = await userId(p, 'alice');
    expect((await owner.req('PUT', `/api/users/${ownerId}/grants/pz-two`, { role: 'admin' })).json()).toEqual({ error: 'owner-immutable' });
    expect(p.deps.audit.list({ action: 'user.grant' })[0]).toMatchObject({ serverId: 'default', target: 'bob', username: 'alice' });
    expect(p.deps.audit.list({ action: 'user.revoke' })[0]).toMatchObject({ serverId: 'default', target: 'bob' });
  });

  it('switches scope: all takes a role, granted derives it; only the owner manages grants', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    const admin = await friend(p, owner, 'all-admin', 'admin');
    const id = (await owner.post('/api/users', { username: 'carol', password: 'Temporal-12345', role: 'operator' })).json().id as number;
    expect((await owner.req('PUT', `/api/users/${id}/grants/default`, { role: 'viewer' })).statusCode).toBe(200);
    expect((await owner.req('PATCH', `/api/users/${id}`, { scope: 'granted' })).json()).toMatchObject({ scope: 'granted', role: 'viewer' });
    expect((await owner.req('PATCH', `/api/users/${id}`, { role: 'admin' })).json()).toEqual({ error: 'role-follows-grants' });
    expect((await owner.req('PATCH', `/api/users/${id}`, { scope: 'all', role: 'operator' })).json()).toMatchObject({ scope: 'all', role: 'operator' });
    for (const [method, url, body] of [
      ['GET', `/api/users/${id}/grants`],
      ['PUT', `/api/users/${id}/grants/default`, { role: 'admin' }],
      ['DELETE', `/api/users/${id}/grants/default`],
    ] as ['GET' | 'PUT' | 'DELETE', string, unknown?][]) {
      expect((await admin.req(method, url, body)).json(), `${method} ${url}`).toEqual({ error: 'forbidden' });
    }
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
    await createTwo(owner);
    await p.orch.stop('pz-two');
    await p.deps.servers.reconcile();

    const all = (await owner.get('/api/audit')).json() as { action: string; serverId: string | null; actorType: string }[];
    expect(all.find((e) => e.action === 'server.start')).toMatchObject({ serverId: 'default', actorType: 'user' });
    expect(all.find((e) => e.action === 'schedule.backup')).toMatchObject({ serverId: 'default', actorType: 'schedule' });
    expect(all.find((e) => e.action === 'cli.backup-db')).toMatchObject({ serverId: null, actorType: 'recovery' });
    expect(all.find((e) => e.action === 'auth.login')).toMatchObject({ serverId: null, actorType: 'user' });
    expect(all.find((e) => e.action === 'server.create')).toMatchObject({ serverId: 'pz-two', actorType: 'user' });
    expect(all.find((e) => e.action === 'server.reconcile')).toMatchObject({ serverId: 'pz-two', actorType: 'system' });

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
    await createTwo(owner);
    const adm = await friend(p, owner, 'server-admin', 'admin', 'admin');
    const seen = (await adm.get('/api/audit')).json() as { serverId: string | null }[];
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.serverId === 'default')).toBe(true);
    expect((await adm.get('/api/audit?server=default')).statusCode).toBe(200);
    expect((await adm.get('/api/audit?server=pz-two')).json()).toEqual({ error: 'server-not-found' });
    expect((await adm.get('/api/audit?server=other')).json()).toEqual({ error: 'server-not-found' });
    const op = await friend(p, owner, 'server-op', 'operator', 'operator');
    expect((await op.get('/api/audit')).statusCode).toBe(403);
  });

  it('lists the host’s own entries alone with server=- (ACC-03), to those who see them', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    await owner.post('/api/servers/default/server/start');
    await p.srv.ops.idle();
    await createTwo(owner);
    const adm = await friend(p, owner, 'server-admin', 'admin', 'admin');
    const everywhere = await friend(p, owner, 'all-admin', 'admin');

    type Entry = { id: number; action: string; serverId: string | null };
    const host = (await owner.get('/api/audit?server=-')).json() as Entry[];
    expect(host.map((e) => e.action)).toEqual(expect.arrayContaining(['auth.login', 'user.create']));
    expect(host.every((e) => e.serverId === null)).toBe(true);
    // Exactly the host entries of the whole log, newest first, filtered and paged by the API.
    const all = (await owner.get('/api/audit?limit=500')).json() as Entry[];
    expect(host).toEqual(all.filter((e) => e.serverId === null));
    const logins = (await owner.get('/api/audit?server=-&action=auth.login')).json() as Entry[];
    expect(logins.length).toBeGreaterThan(1);
    expect(logins.every((e) => e.action === 'auth.login' && e.serverId === null)).toBe(true);
    const older = (await owner.get(`/api/audit?server=-&limit=1&before=${host[0]!.id}`)).json() as Entry[];
    expect(older).toEqual([host[1]]);
    expect((await everywhere.get('/api/audit?server=-')).json()).toEqual((await owner.get('/api/audit?server=-')).json());

    // An admin of some servers never sees host entries, with or without the filter.
    expect((await adm.get('/api/audit?server=-')).json()).toEqual([]);
    expect(((await adm.get('/api/audit')).json() as Entry[]).every((e) => e.serverId === 'default')).toBe(true);
    const op = await friend(p, owner, 'server-op', 'operator', 'operator');
    expect((await op.get('/api/audit?server=-')).statusCode).toBe(403);
    // Only "-" means the host; anything else still has to be a server id.
    for (const bad of ['--', '-x', '*', '']) expect((await owner.get(`/api/audit?server=${bad}`)).statusCode, bad).toBe(400);
  });
});

describe('the websocket (ACC-02)', () => {
  it('sends only the servers a user may see, each message naming its server', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    const outsider = await friend(p, owner, 'ws-outsider', 'operator', null);
    const a = await listenWs(p, owner);
    const b = await listenWs(p, outsider);
    p.feed.emit({ type: 'players', count: 1, names: ['rick'] });
    p.deps.bus.emit({ type: 'notice', serverId: 'default', kind: 'x', message: 'for default viewers', permission: 'server.view' });
    await until(() => a.messages.length >= 3);
    expect(a.messages[0]).toEqual(expect.objectContaining({ type: 'hello', servers: [expect.objectContaining({ serverId: 'default' })] }));
    expect(a.messages.slice(1).map((m) => [m.type, m.serverId])).toEqual([
      ['event', 'default'],
      ['notice', 'default'],
    ]);
    expect(b.messages).toEqual([{ type: 'hello', servers: [] }]);
    a.ws.terminate();
    b.ws.terminate();
  });

  it('follows grants, new servers, renames and removals at once, without waiting for the periodic check', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    const bob = await friend(p, owner, 'bob', 'viewer', null);
    const id = await userId(p, 'bob');
    const mine = await listenWs(p, bob);
    const theirs = await listenWs(p, owner);
    const types = () => mine.messages.map((m) => (m.type === 'hello' ? `hello:${(m.servers ?? []).map((s) => s.serverId).join(',')}` : m.serverId ? `${m.type}:${m.serverId}` : m.type));

    await owner.req('PUT', `/api/users/${id}/grants/default`, { role: 'viewer' });
    await until(() => types().includes('hello:default'));
    expect(types()).toEqual(['hello:', 'hello:default', 'servers']);

    // A new server shows up for those who may see it: the owner, not bob.
    await createTwo(owner);
    await until(() => theirs.messages.some((m) => m.type === 'hello' && m.servers?.some((s) => s.serverId === 'pz-two')));
    await until(() => types().length === 4);
    expect(types().at(-1)).toBe('servers');

    // A rename rebuilds default's context: bob follows the new one (events keep coming).
    await owner.req('PATCH', '/api/servers/default', { name: 'Main' });
    await until(() => types().filter((t) => t === 'hello:default').length === 2);
    p.feed.emit({ type: 'players', count: 2, names: [] });
    await until(() => types().includes('event:default'));
    expect(types().filter((t) => t === 'event:default')).toHaveLength(1);

    await owner.req('DELETE', `/api/users/${id}/grants/default`);
    await until(() => types().includes('gone:default'));
    p.feed.emit({ type: 'players', count: 3, names: [] });
    await new Promise((r) => setTimeout(r, 30));
    expect(types().filter((t) => t === 'event:default')).toHaveLength(1);

    // Removing a server says gone to those who saw it.
    await owner.req('DELETE', '/api/servers/pz-two', { confirm: 'Second' });
    await until(() => theirs.messages.some((m) => m.type === 'gone' && m.serverId === 'pz-two'));
    mine.ws.terminate();
    theirs.ws.terminate();
  });
});
