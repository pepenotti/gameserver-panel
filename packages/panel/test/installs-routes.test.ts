// Shared installs through the API (HST-09, D12, AST-01, ACC-02): the host's
// list of installs and left-overs for those who see the host overview, their
// removal by the owner alone, a server's install on its summary and its own
// route, the "move to a shared install" action for its admins, and what the
// create form says about a new server's game files.
import { describe, expect, it } from 'vitest';
import type { OpState } from '../src/ops/bus';
import type { InstallPlan, InstallsResponse, ServerInstallView } from '../src/routes/installs';
import type { ServerSummary } from '../src/routes/servers';
import { fakeStatus, friend, makePanel, ownerReady, until, type Client, type TestPanel } from './harness';

const LAUNCH = { memoryMb: 2048, branch: 'public', updateOnStart: false };

async function created(p: TestPanel, owner: Client, id: string, launch: Record<string, unknown> = LAUNCH): Promise<ServerSummary> {
  const res = await owner.post('/api/servers', { id, name: id.toUpperCase(), adapter: 'pz', launch });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServerSummary;
}

const listed = async (c: Client) => (await c.get('/api/host/installs')).json() as InstallsResponse;
const summaryOf = async (c: Client, id: string) => ((await c.get('/api/servers')).json() as ServerSummary[]).find((s) => s.id === id)!;

describe('shared installs through the API (HST-09, D12)', () => {
  it('shows a new server waiting for its install, then on it, shared with the next one', async () => {
    const p = await makePanel();
    p.orch.sharedInstalls = true;
    const { client: owner } = await ownerReady(p);
    let release!: () => void;
    p.orch.hold = new Promise<void>((r) => (release = r));
    const first = await created(p, owner, 'pz-a');
    expect(first.install).toMatchObject({ mode: 'shared', state: 'installing', waiting: true, sharedWith: 0, key: null, next: null });
    const iid = first.install!.id!;
    // Its own route says the same, with the job's progress once it runs.
    await until(() => p.deps.servers.installs.progress(iid) !== null);
    expect(((await owner.get('/api/servers/pz-a/install')).json() as ServerInstallView).job).toMatchObject({ phase: 'install' });
    release();
    await until(() => p.orch.containers.get('pz-a')?.spec.install === iid);
    expect((await summaryOf(owner, 'pz-a')).install).toMatchObject({ mode: 'shared', id: iid, state: 'ready', waiting: false, key: { branch: 'public', build: 'b1' }, bytes: 1_000_000, files: 10, job: null });
    await created(p, owner, 'pz-b');
    expect((await summaryOf(owner, 'pz-a')).install!.sharedWith).toBe(1);
    expect((await summaryOf(owner, 'pz-b')).install).toMatchObject({ id: iid, sharedWith: 1, waiting: false });
    // The stack's own server has no install view.
    expect((await summaryOf(owner, 'default')).install).toBeNull();
  });

  it('lists installs and left-overs for those who see the host, and only the owner removes one nobody uses', async () => {
    const p = await makePanel();
    p.orch.sharedInstalls = true;
    const { client: owner } = await ownerReady(p);
    const admin = await friend(p, owner, 'all-admin', 'admin');
    const granted = await friend(p, owner, 'one-admin', 'admin', {});
    const op = await friend(p, owner, 'all-op', 'operator');
    await created(p, owner, 'pz-a');
    const iid = (await summaryOf(owner, 'pz-a')).install!.id!;
    await until(() => p.orch.containers.get('pz-a')?.spec.install === iid);
    await created(p, owner, 'pz-b', { ...LAUNCH, branch: 'unstable' });
    const other = (await summaryOf(owner, 'pz-b')).install!.id!;
    await until(() => p.orch.containers.get('pz-b')?.spec.install === other);

    const seen = await listed(admin);
    expect(seen.installs.map((i) => [i.id, i.adapter, i.state, i.origin, i.servers.map((s) => s.name), i.removable])).toEqual([
      [iid, 'pz', 'ready', 'download', ['PZ-A'], false],
      [other, 'pz', 'ready', 'download', ['PZ-B'], false],
    ]);
    expect(seen.installs[0]).toMatchObject({ adapterName: { en: expect.any(String), es: expect.any(String) }, key: { branch: 'public' }, bytes: 1_000_000, files: 10, superseded: false, job: null });
    expect(seen).toMatchObject({ leftovers: [], totalBytes: 2_000_000 });
    for (const c of [op, granted]) expect((await c.get('/api/host/installs')).statusCode).toBe(403);

    // pz-b goes: its install is used by nobody.
    expect((await owner.req('DELETE', '/api/servers/pz-b', { confirm: 'PZ-B' })).statusCode).toBe(200);
    expect((await listed(owner)).installs.find((i) => i.id === other)!.removable).toBe(true);
    // Only the owner removes it; one in use never.
    expect((await admin.req('DELETE', `/api/host/installs/${other}`)).statusCode).toBe(403);
    expect((await owner.req('DELETE', `/api/host/installs/${iid}`)).json()).toMatchObject({ error: 'install-in-use', servers: ['pz-a'] });
    expect((await owner.req('DELETE', '/api/host/installs/not-an-id')).statusCode).toBe(400);
    expect((await owner.req('DELETE', '/api/host/installs/i0000000000000000')).json()).toMatchObject({ error: 'install-not-found' });
    expect((await owner.req('DELETE', `/api/host/installs/${other}`)).json()).toEqual({ ok: true });
    expect((await listed(owner)).installs.map((i) => i.id)).toEqual([iid]);
    expect(p.deps.audit.list({ action: 'install.remove' })[0]).toMatchObject({ target: other, username: 'alice', serverId: null, ok: true });
  });

  it('moves a server off its own install on request, lists its left-over, and lets only the owner remove it', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    await created(p, owner, 'pz-old');
    const admin = await friend(p, owner, 'one-admin', 'admin', { 'pz-old': 'admin' });
    const op = await friend(p, owner, 'one-op', 'operator', { 'pz-old': 'operator' });
    expect((await summaryOf(owner, 'pz-old')).install).toMatchObject({ mode: 'own', id: null, next: null });
    // The upgrade: the orchestrator has shared installs now.
    p.orch.sharedInstalls = true;
    await p.deps.servers.installs.available();
    expect((await summaryOf(owner, 'pz-old')).containerPendingReasons).toEqual(['install']);
    expect((await summaryOf(owner, 'pz-old')).install).toMatchObject({ mode: 'own', next: { id: null } });
    // An operator may not; never while it runs; an admin of the server may.
    expect((await op.post('/api/servers/pz-old/install')).statusCode).toBe(403);
    p.fakes('pz-old').feed.status_ = fakeStatus({ state: 'running' });
    await admin.post('/api/servers/pz-old/install');
    await p.deps.servers.get('pz-old')!.ops.idle();
    expect(p.deps.servers.get('pz-old')!.ops.last()).toMatchObject({ ok: false, error: 'server-running' });
    p.fakes('pz-old').feed.status_ = fakeStatus({ state: 'stopped' });
    const moving = (await admin.post('/api/servers/pz-old/install')).json() as OpState;
    expect(moving).toMatchObject({ kind: 'update', startedBy: 'one-admin' });
    await p.deps.servers.get('pz-old')!.ops.idle();
    expect(p.deps.servers.get('pz-old')!.ops.last()).toMatchObject({ ok: true });
    const view = (await summaryOf(owner, 'pz-old')).install!;
    expect(view).toMatchObject({ mode: 'shared', state: 'ready', next: null });
    expect(p.deps.audit.list({ action: 'server.install.move' }).map((e) => [e.username, e.actorType])).toEqual([
      [null, 'system'],
      ['one-admin', 'user'],
      ['one-admin', 'user'],
    ]);

    // Its left-over: listed with its size; the owner alone removes it.
    expect((await listed(owner)).leftovers).toEqual([{ serverId: 'pz-old', serverName: 'PZ-OLD', bytes: 1_000_000, files: 10, since: expect.any(String) }]);
    expect((await listed(owner)).installs[0]).toMatchObject({ origin: 'adopted', servers: [{ id: 'pz-old', name: 'PZ-OLD' }] });
    const all = await friend(p, owner, 'all-admin', 'admin');
    expect((await all.req('DELETE', '/api/host/own-installs/pz-old')).statusCode).toBe(403);
    expect((await owner.req('DELETE', '/api/host/own-installs/pz-old')).json()).toEqual({ ok: true });
    expect(p.orch.ownInstalls.has('pz-old')).toBe(false);
    expect((await listed(owner)).leftovers).toEqual([]);
    expect((await owner.req('DELETE', '/api/host/own-installs/pz-old')).json()).toMatchObject({ error: 'leftover-not-found' });
    expect((await owner.req('DELETE', '/api/host/own-installs/Bad_Id')).statusCode).toBe(400);
  });

  it('tells the create form whether a new server downloads its game or uses an install already there', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    const plan = async (body: unknown) => (await owner.post('/api/adapters/pz/install-plan', body)).json() as InstallPlan;
    // An orchestrator without shared installs: an install per server.
    expect(await plan({ launch: LAUNCH })).toEqual({ mode: 'own', bytes: null, servers: 0 });
    p.orch.sharedInstalls = true;
    expect(await plan({ launch: LAUNCH })).toEqual({ mode: 'download', bytes: null, servers: 0 });
    let release!: () => void;
    p.orch.hold = new Promise<void>((r) => (release = r));
    await created(p, owner, 'pz-a');
    expect(await plan({ launch: LAUNCH })).toEqual({ mode: 'installing', bytes: null, servers: 1 });
    release();
    await until(() => p.orch.containers.get('pz-a')?.spec.install !== undefined);
    expect(await plan({ launch: LAUNCH })).toEqual({ mode: 'existing', bytes: 1_000_000, servers: 1 });
    // The defaults stand for what isn't sent; another branch is a download about the size of the one there.
    expect(await plan({})).toMatchObject({ mode: 'existing' });
    expect(await plan({ launch: { ...LAUNCH, branch: 'unstable' } })).toEqual({ mode: 'download', bytes: 1_000_000, servers: 0 });
    expect((await owner.post('/api/adapters/pz/install-plan', { launch: { ...LAUNCH, branch: 'no spaces' } })).json()).toMatchObject({ error: 'invalid-options' });
    expect((await owner.post('/api/adapters/pz/install-plan', { flavour: 'paper' })).json()).toMatchObject({ error: 'unknown-flavour' });
    expect((await owner.post('/api/adapters/nope/install-plan', {})).statusCode).toBe(404);
    const op = await friend(p, owner, 'all-op', 'operator');
    expect((await op.post('/api/adapters/pz/install-plan', {})).statusCode).toBe(403);
  });

  it('makes the install a changed version wants as soon as the launch settings are saved', async () => {
    const p = await makePanel();
    p.orch.sharedInstalls = true;
    const { client: owner } = await ownerReady(p);
    await created(p, owner, 'pz-a');
    const iid = (await summaryOf(owner, 'pz-a')).install!.id!;
    await until(() => p.orch.containers.get('pz-a')?.spec.install === iid);
    p.fakes('pz-a').feed.status_ = fakeStatus({ state: 'running' });
    expect((await owner.req('PUT', '/api/servers/pz-a/server/launch', { ...LAUNCH, branch: 'unstable' })).statusCode).toBe(200);
    const next = p.deps.serverRows.get('pz-a')!.installId!;
    expect(next).not.toBe(iid);
    await until(() => p.deps.servers.installs.get(next)?.state === 'ready');
    // It runs: the move waits for its next start.
    expect((await summaryOf(owner, 'pz-a')).install).toMatchObject({ id: iid, next: { id: next, state: 'ready', key: { branch: 'unstable' } } });
    expect((await summaryOf(owner, 'pz-a')).containerPendingReasons).toEqual(['install']);
  });
});
