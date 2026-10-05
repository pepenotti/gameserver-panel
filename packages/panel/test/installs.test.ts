// Shared installs, panel side (HST-09, D12), against the fake orchestrator
// and fake install jobs: a server's install found, waited for or made (one
// job per install, never two), updates made once from a copy of the old
// install and taken by each server at its next start (UPD-03, UPD-04,
// SRV-05), the `install` pending reason with the others, a changed version,
// failures and retries, the move of a server off its own install (adopted by
// a local copy) and its left-over, removal only of what nobody uses, and a
// panel restart in the middle of a job.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYSTEM, userActor, type Actor } from '../src/audit';
import type { CreateServerInput } from '../src/servers/registry';
import { fakeStatus, makePanel, until, type TestPanel } from './harness';

const OWNER: Actor = userActor({ id: 1, username: 'alice' });

/** A panel whose orchestrator has shared installs. */
async function panel(): Promise<TestPanel> {
  const p = await makePanel();
  p.orch.sharedInstalls = true;
  return p;
}

function create(p: TestPanel, id: string, over: Partial<CreateServerInput> = {}) {
  return p.deps.servers.create({ id, name: id.toUpperCase(), adapter: 'pz', by: OWNER, launch: { memoryMb: 2048, branch: 'public', updateOnStart: false }, ...over });
}

const installs = (p: TestPanel) => p.deps.servers.installs;
const row = (p: TestPanel, id: string) => p.deps.serverRows.get(id)!;
const mounted = (p: TestPanel, id: string) => p.orch.containers.get(id)?.spec.install;
/** Until a server runs from install `iid` (its container mounts it). */
const on = (p: TestPanel, id: string, iid: string) => until(() => mounted(p, id) === iid);
const ready = (p: TestPanel, iid: string) => until(() => installs(p).get(iid)?.state === 'ready');
const actions = (p: TestPanel, prefix: string) => p.deps.audit.list({ action: prefix }).map((e) => `${e.action}${e.serverId ? ` ${e.serverId}` : ''}${e.ok ? '' : ' (failed)'}`);

/** The fake agent's game: stops when asked, as the real one does. */
function stoppable(p: TestPanel, id: string, state: 'running' | 'stopped' = 'running'): void {
  const f = p.fakes(id);
  f.feed.status_ = fakeStatus({ state });
  f.agent.stop = async () => {
    f.agent.calls.push('stop');
    f.feed.status_ = fakeStatus({ state: 'stopped' });
    return f.feed.status_;
  };
  f.agent.start = async () => {
    f.agent.calls.push('start');
    f.feed.status_ = fakeStatus({ state: 'running' });
    return f.feed.status_;
  };
}

/** Runs an operation of a server to its end; its last state. */
async function opOf(p: TestPanel, id: string, start: () => unknown) {
  start();
  const ctx = p.deps.servers.get(id)!;
  await ctx.ops.idle();
  return ctx.ops.last()!;
}

describe('a server and its install (HST-09, D12, SRV-01, UPD-01)', () => {
  it('installs a game once: the first server waits for the install job, a second one of the same version uses its install', async () => {
    const p = await panel();
    const a = await create(p, 'pz-a');
    const iid = row(p, 'pz-a').installId!;
    expect(iid).toMatch(/^i[0-9a-f]{16}$/);
    // Created at once; its container comes when its install is ready.
    expect(p.deps.servers.awaitingInstall('pz-a')).toBe(true);
    await on(p, 'pz-a', iid);
    expect(p.deps.servers.awaitingInstall('pz-a')).toBe(false);
    expect(installs(p).get(iid)).toMatchObject({ state: 'ready', adapter: 'pz', flavour: null, runtime: 'steam', key: { branch: 'public', build: 'b1' }, bytes: 1_000_000, files: 10, wanted: [{ branch: 'public', build: null, channel: null }] });
    // The job: its own token, the game, the server's launch; removed once done.
    expect(p.orch.calls.filter((c) => /Install|^installs/.test(c))).toEqual(expect.arrayContaining([`putInstall ${iid}`, `removeInstallJob ${iid}`]));
    expect(p.orch.installsById.get(iid)!.job).toBeNull();
    expect(p.orch.jobsRun).toEqual([iid]);
    expect(a.row.installId).toBe(iid);

    // The second server: the same install, no job, its container at once.
    await create(p, 'pz-b');
    expect(row(p, 'pz-b').installId).toBe(iid);
    expect(mounted(p, 'pz-b')).toBe(iid);
    expect(p.orch.jobsRun).toEqual([iid]);
    expect(p.orch.downloads).toEqual([iid]);
    // Another branch is another install.
    await create(p, 'pz-c', { launch: { memoryMb: 2048, branch: 'unstable', updateOnStart: false } });
    const other = row(p, 'pz-c').installId!;
    expect(other).not.toBe(iid);
    await on(p, 'pz-c', other);
    expect(installs(p).get(other)!.key).toMatchObject({ branch: 'unstable' });
    expect(actions(p, 'install.')).toEqual(['install.ready pz-c', 'install.create pz-c', 'install.ready pz-a', 'install.create pz-a']);
    expect(p.deps.audit.list({ action: 'server.create' }).map((e) => JSON.parse(e.detail!).install)).toEqual([
      { id: other, ready: false },
      { id: iid, ready: true },
      { id: iid, ready: false },
    ]);
  });

  it('runs one job per install: servers created meanwhile wait for it', async () => {
    const p = await panel();
    let release!: () => void;
    p.orch.hold = new Promise<void>((r) => (release = r));
    await create(p, 'pz-a');
    await create(p, 'pz-b');
    await create(p, 'pz-c');
    const iid = row(p, 'pz-a').installId!;
    expect([row(p, 'pz-b').installId, row(p, 'pz-c').installId]).toEqual([iid, iid]);
    expect(installs(p).list()).toHaveLength(1);
    expect(['pz-a', 'pz-b', 'pz-c'].map((id) => p.deps.servers.awaitingInstall(id))).toEqual([true, true, true]);
    // A start meanwhile waits for the same job.
    stoppable(p, 'pz-b', 'stopped');
    const started = opOf(p, 'pz-b', () => p.deps.servers.get('pz-b')!.control.start('alice'));
    await until(() => installs(p).progress(iid) !== null);
    release();
    expect(await started).toMatchObject({ ok: true });
    for (const id of ['pz-a', 'pz-b', 'pz-c']) await on(p, id, iid);
    expect(p.orch.jobsRun).toEqual([iid]);
    expect(p.fakes('pz-b').agent.calls).toContain('start');
  });

  it('a failed install leaves the server without a container and says why; its next start runs the job again', async () => {
    const p = await panel();
    p.orch.failJobs = 'Disk full while installing';
    await create(p, 'pz-a');
    const iid = row(p, 'pz-a').installId!;
    await until(() => installs(p).get(iid)?.state === 'failed');
    expect(installs(p).get(iid)!.error).toBe('Disk full while installing');
    expect(p.orch.containers.has('pz-a')).toBe(false);
    expect(p.orch.installsById.get(iid)!.job).toBeNull();
    expect(actions(p, 'install.failed')).toEqual(['install.failed pz-a (failed)']);
    stoppable(p, 'pz-a', 'stopped');
    // Started: the job again, and it fails again with its reason; the game isn't started.
    const failed = await opOf(p, 'pz-a', () => p.deps.servers.get('pz-a')!.control.start('alice'));
    expect(failed).toMatchObject({ ok: false, error: 'Disk full while installing' });
    expect(p.fakes('pz-a').agent.calls).not.toContain('start');
    // Fixed: the next start installs it, creates the container and starts the game.
    p.orch.failJobs = null;
    expect(await opOf(p, 'pz-a', () => p.deps.servers.get('pz-a')!.control.start('alice'))).toMatchObject({ ok: true });
    expect(mounted(p, 'pz-a')).toBe(iid);
    expect(installs(p).get(iid)).toMatchObject({ state: 'ready', error: null });
    expect(p.fakes('pz-a').agent.calls).toContain('start');
    expect(p.orch.jobsRun).toEqual([iid, iid, iid]);
  });

  it('stops waiting for a job whose container stopped before its agent answered, and says so', async () => {
    const p = await panel();
    p.orch.deadJobs = true;
    await create(p, 'pz-a');
    const iid = row(p, 'pz-a').installId!;
    // At once, not after the two minutes an agent that is starting gets.
    await until(() => installs(p).get(iid)?.state === 'failed');
    expect(installs(p).get(iid)!.error).toBe('The install job stopped before its agent answered (exit 1)');
    expect(p.orch.installsById.get(iid)!.job).toBeNull();
  });

  it('removes a server that still waits for its install without asking its agent; the install stays for others', async () => {
    const p = await panel();
    let release!: () => void;
    p.orch.hold = new Promise<void>((r) => (release = r));
    await create(p, 'pz-a');
    const iid = row(p, 'pz-a').installId!;
    await p.deps.servers.remove('pz-a', { confirm: 'PZ-A', keepBackups: true, by: OWNER });
    expect(p.deps.serverRows.get('pz-a')).toBeNull();
    release();
    await ready(p, iid);
    expect(p.orch.containers.has('pz-a')).toBe(false);
    // Nobody uses it: the owner may remove it.
    await p.deps.servers.removeInstall(iid, OWNER);
    expect(installs(p).get(iid)).toBeNull();
    expect(p.orch.installsById.has(iid)).toBe(false);
  });
});

describe('updates through new installs (UPD-03, UPD-04, SRV-05, HST-09)', () => {
  /** Two servers on one install, `pz-a` running, `pz-b` stopped, both with a world to protect. */
  async function twoOnOne() {
    const p = await panel();
    await create(p, 'pz-a');
    const old = row(p, 'pz-a').installId!;
    await on(p, 'pz-a', old);
    await create(p, 'pz-b');
    stoppable(p, 'pz-a', 'running');
    stoppable(p, 'pz-b', 'stopped');
    for (const id of ['pz-a', 'pz-b']) {
      // A world where the game keeps it (the server's game name is its id).
      const dir = path.join(p.fakes(id).dataDir, 'Saves', 'Multiplayer', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'map.bin'), id);
    }
    return { p, old };
  }

  it('installs the new build once, from a copy of the old install, and moves each server on it: at once when stopped, at its next start when running', async () => {
    const { p, old } = await twoOnOne();
    p.orch.jobKey = () => ({ flavour: null, version: null, build: 'b2', branch: 'public' });
    const a = p.deps.servers.get('pz-a')!;
    // pz-a's update (its own policy, or someone pressing "Update now").
    const op = await opOf(p, 'pz-a', () => a.control.update('alice', { countdownSec: 0, validate: false }, 'en'));
    expect(op).toMatchObject({ ok: true });
    const fresh = row(p, 'pz-a').installId!;
    expect(fresh).not.toBe(old);
    // Made once: a local copy of the old install, then the job on it; never a second download.
    expect(p.orch.copies).toEqual([`${fresh} ${old}`]);
    expect(p.orch.jobsRun).toEqual([old, fresh]);
    expect(p.orch.downloads).toEqual([old]);
    expect(installs(p).get(fresh)).toMatchObject({ state: 'ready', source: old, key: { build: 'b2' } });
    expect(installs(p).get(old)!.supersededBy).toBe(fresh);
    // pz-a: stopped, backed up, moved, started again.
    expect(mounted(p, 'pz-a')).toBe(fresh);
    expect(p.fakes('pz-a').agent.calls.filter((c) => c === 'stop' || c === 'start')).toEqual(['stop', 'start']);
    expect(a.backups.list().map((b) => b.manifest.trigger)).toEqual(['pre-update']);
    // pz-b, stopped: moved at once, after its own safety backup.
    await on(p, 'pz-b', fresh);
    const b = p.deps.servers.get('pz-b')!;
    await b.ops.idle();
    expect(b.backups.list().map((x) => x.manifest.trigger)).toEqual(['pre-update']);
    expect(p.fakes('pz-b').agent.calls).not.toContain('start');
    expect(p.deps.servers.containerPendingReasons('pz-a')).toEqual([]);
    expect(p.deps.servers.containerPendingReasons('pz-b')).toEqual([]);
    expect(actions(p, 'server.install.move').sort()).toEqual(['server.install.move pz-a', 'server.install.move pz-b']);
    // The old one is used by nobody now: listed, kept until the owner removes it.
    await p.deps.servers.removeInstall(old, OWNER);
    expect(p.orch.installsById.has(old)).toBe(false);
    // A new server gets the new install.
    await create(p, 'pz-c');
    expect(row(p, 'pz-c').installId).toBe(fresh);
  });

  it('a running server waits for its next start, and moves then with every other change in one recreation', async () => {
    const { p, old } = await twoOnOne();
    p.orch.jobKey = () => ({ flavour: null, version: null, build: 'b2', branch: 'public' });
    // pz-b's update makes the new install; pz-a runs, so it waits.
    await opOf(p, 'pz-b', () => p.deps.servers.get('pz-b')!.control.update('alice', { countdownSec: 0, validate: false }, 'en'));
    const fresh = row(p, 'pz-b').installId!;
    expect(row(p, 'pz-a').installId).toBe(fresh);
    expect(mounted(p, 'pz-a')).toBe(old);
    expect(p.deps.servers.containerPendingReasons('pz-a')).toEqual(['install']);
    // New limits and a newer runtime image wait too.
    await p.deps.servers.update('pz-a', { memLimitMb: 6144 }, OWNER);
    p.orch.rebuildImage('gsp/steam:fake');
    await p.deps.servers.prepareStart('pz-a');
    expect(p.deps.servers.containerPendingReasons('pz-a')).toEqual(['settings', 'image', 'install']);
    p.orch.calls.length = 0;
    // A restart: one recreation with all of it, after one safety backup.
    expect(await opOf(p, 'pz-a', () => p.deps.servers.get('pz-a')!.control.restart('alice', 0, 'en'))).toMatchObject({ ok: true });
    expect(p.orch.calls.filter((c) => c.startsWith('apply pz-a'))).toEqual(['apply pz-a']);
    expect(p.orch.containers.get('pz-a')!.spec).toMatchObject({ install: fresh, memoryMb: 6144 });
    expect(p.deps.servers.containerPendingReasons('pz-a')).toEqual([]);
    expect(p.deps.servers.get('pz-a')!.backups.list().map((b) => b.manifest.trigger)).toEqual(['pre-update']);
    const reconciled = p.deps.audit.list({ action: 'server.reconcile' }).find((e) => e.serverId === 'pz-a')!;
    expect(reconciled.detail).toBe('container recreated with its changed settings and on a newer runtime image and on another install before the game started');
  });

  it('an update that finds nothing new changes nothing: the copy goes, nobody moves or stops', async () => {
    const { p, old } = await twoOnOne();
    const op = await opOf(p, 'pz-a', () => p.deps.servers.get('pz-a')!.control.update('alice', { countdownSec: 0, validate: false }, 'en'));
    expect(op).toMatchObject({ ok: true, step: 'done' });
    expect(p.orch.copies).toHaveLength(1);
    expect(installs(p).list().map((i) => i.id)).toEqual([old]);
    expect(p.orch.installsById.size).toBe(1);
    expect([row(p, 'pz-a').installId, row(p, 'pz-b').installId]).toEqual([old, old]);
    expect(p.fakes('pz-a').agent.calls).not.toContain('stop');
    expect(installs(p).get(old)!.supersededBy).toBeNull();
  });

  it('two updates of one install at once make one new install', async () => {
    const { p, old } = await twoOnOne();
    p.orch.jobKey = () => ({ flavour: null, version: null, build: 'b2', branch: 'public' });
    let release!: () => void;
    p.orch.hold = new Promise<void>((r) => (release = r));
    const first = opOf(p, 'pz-a', () => p.deps.servers.get('pz-a')!.control.update('alice', { countdownSec: 0, validate: false }, 'en'));
    await until(() => p.orch.copies.length === 1);
    const second = opOf(p, 'pz-b', () => p.deps.servers.get('pz-b')!.control.update('alice', { countdownSec: 0, validate: false }, 'en'));
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(p.orch.copies).toHaveLength(1);
    expect(p.orch.jobsRun).toHaveLength(2);
    const fresh = row(p, 'pz-a').installId!;
    expect(fresh).not.toBe(old);
    await on(p, 'pz-b', fresh);
  });

  it('a file check makes a checked copy that replaces the install, even when it holds the same build', async () => {
    const { p, old } = await twoOnOne();
    const op = await opOf(p, 'pz-b', () => p.deps.servers.get('pz-b')!.control.update('alice', { countdownSec: 0, validate: true }, 'en'));
    expect(op).toMatchObject({ ok: true });
    const checked = row(p, 'pz-b').installId!;
    expect(checked).not.toBe(old);
    expect(installs(p).get(checked)!.key).toEqual(installs(p).get(old)!.key);
    expect(installs(p).get(old)!.supersededBy).toBe(checked);
    expect(row(p, 'pz-a').installId).toBe(checked);
    expect(p.deps.servers.containerPendingReasons('pz-a')).toEqual(['install']);
  });

  it('a failed update leaves every server where it was, saying why', async () => {
    const { p, old } = await twoOnOne();
    p.orch.failJobs = 'No connection to Steam';
    const op = await opOf(p, 'pz-a', () => p.deps.servers.get('pz-a')!.control.update('alice', { countdownSec: 0, validate: false }, 'en'));
    expect(op).toMatchObject({ ok: false, error: 'No connection to Steam' });
    expect([row(p, 'pz-a').installId, row(p, 'pz-b').installId]).toEqual([old, old]);
    expect(p.fakes('pz-a').agent.calls).not.toContain('stop');
    expect(installs(p).list().filter((i) => i.state === 'failed')).toHaveLength(1);
  });

  it('a changed version gets the install it wants, made beside the one the server runs, and moves the stopped server to it', async () => {
    const { p, old } = await twoOnOne();
    const b = p.deps.servers.get('pz-b')!;
    b.handle.setLaunchSettings({ memoryMb: 2048, branch: 'unstable', updateOnStart: false });
    p.deps.servers.launchChanged('pz-b', OWNER);
    const next = row(p, 'pz-b').installId!;
    expect(next).not.toBe(old);
    await on(p, 'pz-b', next);
    expect(installs(p).get(next)!.key).toMatchObject({ branch: 'unstable' });
    // pz-a keeps the branch it asks for.
    expect(row(p, 'pz-a').installId).toBe(old);
    // Asked again with the same version: nothing new.
    p.deps.servers.launchChanged('pz-b', OWNER);
    expect(installs(p).list()).toHaveLength(2);
  });
});

describe('moving servers off their own installs (HST-09 migration)', () => {
  /** Servers from before shared installs: created by an orchestrator without them, then the upgrade. */
  async function legacy(ids: string[]) {
    const p = await makePanel();
    for (const id of ids) await create(p, id);
    for (const id of ids) {
      expect(mounted(p, id)).toBeUndefined();
      expect(p.orch.ownInstalls.has(id)).toBe(true);
      stoppable(p, id, 'stopped');
    }
    p.orch.sharedInstalls = true;
    await p.deps.servers.installs.available();
    return p;
  }

  it('adopts a server’s own install by a local copy at its next start, without a download; its own volume stays until the owner removes it', async () => {
    const p = await legacy(['pz-old', 'pz-old2']);
    expect(p.deps.servers.containerPendingReasons('pz-old')).toEqual(['install']);
    expect(await opOf(p, 'pz-old', () => p.deps.servers.get('pz-old')!.control.start('alice'))).toMatchObject({ ok: true });
    const iid = row(p, 'pz-old').installId!;
    expect(mounted(p, 'pz-old')).toBe(iid);
    // Its container stopped for the copy; copied, the job's finishing steps on it, never a download.
    expect(p.orch.calls).toEqual(expect.arrayContaining(['stop pz-old', `putInstall ${iid} fromServer=pz-old`, `putInstall ${iid}`]));
    expect(p.orch.copies).toEqual([`${iid} server:pz-old`]);
    expect(p.orch.downloads).toEqual([]);
    expect(installs(p).get(iid)).toMatchObject({ state: 'ready', source: 'server:pz-old' });
    expect(p.fakes('pz-old').agent.calls).toContain('start');
    // Its own install is a left-over, still there.
    expect(installs(p).store.leftovers()).toEqual([{ serverId: 'pz-old', bytes: 1_000_000, files: 10, since: expect.any(String) }]);
    expect(p.orch.ownInstalls.has('pz-old')).toBe(true);
    expect(actions(p, 'server.install.move')).toEqual(['server.install.move pz-old']);

    // The second one holds the same thing: its copy goes, and it runs from the first one's install.
    await p.deps.servers.moveInstall('pz-old2');
    expect(row(p, 'pz-old2').installId).toBe(iid);
    expect(mounted(p, 'pz-old2')).toBe(iid);
    expect(installs(p).list().map((i) => i.id)).toEqual([iid]);
    expect(p.fakes('pz-old2').agent.calls).not.toContain('start');

    // The owner removes the left-overs; never while a server still runs from its own.
    await p.deps.servers.removeLeftover('pz-old', OWNER);
    expect(p.orch.ownInstalls.has('pz-old')).toBe(false);
    expect(installs(p).store.leftovers().map((l) => l.serverId)).toEqual(['pz-old2']);
    expect(p.deps.audit.list({ action: 'install.remove' })[0]).toMatchObject({ serverId: 'pz-old', target: 'server:pz-old', username: 'alice' });
    await expect(p.deps.servers.removeLeftover('pz-old', OWNER)).rejects.toMatchObject({ code: 'leftover-not-found' });
  });

  it('a move that fails keeps the server on its own install: it starts as before, and tries again at its next start', async () => {
    const p = await legacy(['pz-old']);
    p.orch.failJobs = 'The copy was cut short';
    expect(await opOf(p, 'pz-old', () => p.deps.servers.get('pz-old')!.control.start('alice'))).toMatchObject({ ok: true });
    expect(row(p, 'pz-old').installId).toBeNull();
    expect(mounted(p, 'pz-old')).toBeUndefined();
    expect(p.orch.containers.get('pz-old')!.state).toBe('running');
    expect(p.fakes('pz-old').agent.calls).toContain('start');
    expect(installs(p).list()).toEqual([]);
    expect(p.orch.installsById.size).toBe(0);
    expect(actions(p, 'server.install.move')).toEqual(['server.install.move pz-old (failed)']);
    expect(p.deps.servers.containerPendingReasons('pz-old')).toEqual(['install']);
    // Asked for, the move's failure is the answer.
    p.fakes('pz-old').feed.status_ = fakeStatus({ state: 'stopped' });
    await expect(p.deps.servers.moveInstall('pz-old')).rejects.toMatchObject({ code: 'install-failed' });
    // Never while its game runs.
    p.fakes('pz-old').feed.status_ = fakeStatus({ state: 'running' });
    await expect(p.deps.servers.moveInstall('pz-old')).rejects.toMatchObject({ code: 'server-running' });
  });

  it('keeps installs of their own where the orchestrator has no shared installs', async () => {
    const p = await makePanel();
    await create(p, 'pz-a');
    expect(row(p, 'pz-a').installId).toBeNull();
    expect(mounted(p, 'pz-a')).toBeUndefined();
    expect(p.deps.servers.containerPendingReasons('pz-a')).toEqual([]);
    expect(installs(p).list()).toEqual([]);
  });
});

describe('removing installs (HST-09)', () => {
  it('removes only an install no server uses or mounts', async () => {
    const p = await panel();
    await create(p, 'pz-a');
    const iid = row(p, 'pz-a').installId!;
    await on(p, 'pz-a', iid);
    await expect(p.deps.servers.removeInstall(iid, OWNER)).rejects.toMatchObject({ statusCode: 409, code: 'install-in-use', extra: { servers: ['pz-a'] } });
    await expect(p.deps.servers.removeInstall('i0000000000000000', OWNER)).rejects.toMatchObject({ statusCode: 404, code: 'install-not-found' });
    // A server the panel doesn't know any more still mounts it: the orchestrator refuses.
    p.deps.serverRows.setInstall('pz-a', null);
    p.deps.serverRows.setSpec('pz-a', { ...row(p, 'pz-a').spec!, install: undefined });
    await expect(p.deps.servers.removeInstall(iid, OWNER)).rejects.toMatchObject({ statusCode: 409, code: 'install-in-use' });
    expect(installs(p).get(iid)!.state).toBe('ready');
    expect(actions(p, 'install.remove')).toEqual([]);
  });

  it('refuses one being installed', async () => {
    const p = await panel();
    let release!: () => void;
    p.orch.hold = new Promise<void>((r) => (release = r));
    await create(p, 'pz-a');
    const iid = row(p, 'pz-a').installId!;
    await p.deps.servers.remove('pz-a', { confirm: 'PZ-A', keepBackups: true, by: OWNER });
    await expect(p.deps.servers.removeInstall(iid, OWNER)).rejects.toMatchObject({ code: 'install-busy' });
    release();
    await ready(p, iid);
    await p.deps.servers.removeInstall(iid, OWNER);
    expect(p.deps.audit.list({ action: 'install.remove' })[0]).toMatchObject({ target: iid, serverId: null, username: 'alice' });
  });
});

describe('a panel restart in the middle of a job (HST-09, SRV-06)', () => {
  it('runs the job again for the server that waits for it, then creates its container', async () => {
    const p = await panel();
    // The panel goes away mid-job (its job never answers it): the job is left in the orchestrator, the install unfinished.
    p.orch.hold = new Promise<void>(() => undefined);
    await create(p, 'pz-a');
    const iid = row(p, 'pz-a').installId!;
    await until(() => p.orch.installsById.get(iid)?.job?.launch != null);
    p.deps.servers.stop();
    p.orch.hold = null;
    const again = await makePanel({}, { db: p.deps.db, orch: p.orch });
    await again.deps.servers.start();
    await until(() => again.orch.containers.get('pz-a')?.spec.install === iid);
    expect(again.deps.servers.installs.get(iid)!.state).toBe('ready');
    again.deps.servers.stop();
  });

  it('drops an interrupted move off a server’s own install (it moves again at its next start) and finishes removing an install', async () => {
    const p = await panel();
    const half = installs(p).begin({ adapter: 'pz', flavour: null, runtime: 'steam', variant: null }, { flavour: null, version: null, build: null, branch: 'public', channel: null }, SYSTEM, null, 'server:pz-gone');
    await p.orch.putInstall({ id: half.id, runtime: 'steam', env: { AGENT_TOKEN: 'x'.repeat(40), GAME_ADAPTER: 'pz', TZ: 'UTC' } });
    await p.orch.removeInstallJob(half.id);
    const going = installs(p).begin({ adapter: 'pz', flavour: null, runtime: 'steam', variant: null }, { flavour: null, version: null, build: null, branch: 'x', channel: null }, SYSTEM, null);
    installs(p).store.set(going.id, { state: 'removing' });
    await p.deps.servers.start();
    await until(() => installs(p).list().length === 0);
    expect(p.orch.installsById.size).toBe(0);
    p.deps.servers.stop();
  });
});
