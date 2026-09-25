// The server registry over the `servers` table (M2, G1) against a fake
// orchestrator: creating a server (SRV-01, HST-05), renaming it, removing it
// after a final backup (SRV-04), and bringing containers back in line with
// the table (SRV-06).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PanelAdapter } from '@gsp/adapter-api';
import { pzPanelAdapter } from '@gsp/adapter-pz/panel';
import { SYSTEM, userActor, type Actor } from '../src/audit';
import { OrchestratorCallError } from '../src/servers/orchestrator';
import type { CreateServerInput } from '../src/servers/registry';
import { fakeStatus, makePanel, type TestPanel } from './harness';

const OWNER_ACTOR: Actor = userActor({ id: 1, username: 'alice' });

function create(p: TestPanel, over: Partial<CreateServerInput> = {}) {
  return p.deps.servers.create({ id: 'pz-two', name: 'Second', adapter: 'pz', by: OWNER_ACTOR, ...over });
}

/** A game with flavours, an EULA, a TCP port and ARM builds: what PZ lacks, to exercise every rule. */
const other: PanelAdapter = {
  ...pzPanelAdapter,
  meta: {
    ...pzPanelAdapter.meta,
    id: 'other',
    arch: ['amd64', 'arm64'],
    flavours: [
      { id: 'vanilla', name: { en: 'Vanilla', es: 'Vanilla' } },
      { id: 'modded', name: { en: 'Modded', es: 'Con mods' } },
    ],
    ports: [{ id: 'game', proto: 'tcp', default: 25565, publish: true, sameInsideOut: false, label: { en: 'Game', es: 'Juego' } }],
    capabilities: [...pzPanelAdapter.meta.capabilities, 'eula'],
  },
};

/** An HttpError's status and code. */
async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string; extra?: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    const err = e as { statusCode: number; code: string; extra?: Record<string, unknown> };
    return { status: err.statusCode, code: err.code, extra: err.extra };
  }
  throw new Error('expected a refusal');
}

describe('creating a server (SRV-01)', () => {
  it('writes the row and secrets, asks the orchestrator for a running container, and builds the context', async () => {
    const p = await makePanel();
    const ctx = await create(p, { launch: { memoryMb: 4096, branch: 'unstable', updateOnStart: false } });
    const row = p.deps.serverRows.get('pz-two')!;
    const secrets = p.deps.serverRows.secrets('pz-two');
    // Its own token and a generated admin password, in the row's secrets only.
    expect(secrets.agentToken).toMatch(/^[\w-]{43}$/);
    expect(secrets.adminPassword).toMatch(/^[\w-]{24}$/);
    expect(JSON.stringify(row)).not.toContain(secrets.agentToken);
    // Ports next to default's (16261/16262), as a pair; memory = heap + the adapter's overhead.
    expect(row).toMatchObject({ name: 'Second', adapter: 'pz', flavour: null, gameName: 'pz-two', ports: { game: 16263, udp: 16264 }, memLimitMb: 4096 + 3072, createdBy: 1 });
    expect(p.orch.calls).toEqual(['host', 'list', 'apply pz-two', 'start pz-two']);
    const sent = p.orch.containers.get('pz-two')!;
    expect(sent.state).toBe('running');
    expect(sent.spec).toEqual({
      id: 'pz-two',
      runtime: 'steam',
      env: { AGENT_TOKEN: secrets.agentToken, GAME_ADAPTER: 'pz', TZ: expect.any(String), GAME_PORT_GAME: '16263', GAME_PORT_UDP: '16264' },
      ports: [
        { container: 16263, host: 16263, proto: 'udp' },
        { container: 16264, host: 16264, proto: 'udp' },
      ],
      memoryMb: 7168,
    });
    expect(row.spec).toEqual({ ...sent.spec, env: { ...sent.spec.env, AGENT_TOKEN: expect.not.stringContaining(secrets.agentToken!) } });

    expect(p.deps.servers.get('pz-two')).toBe(ctx);
    expect(p.deps.servers.list().map((s) => s.id)).toEqual(['default', 'pz-two']);
    expect(ctx.handle.ref).toEqual({ id: 'pz-two', gameName: 'pz-two', flavour: null });
    expect(ctx.handle.secrets()).toEqual({ adminPassword: secrets.adminPassword });
    expect(ctx.handle.launchSettings()).toEqual({ memoryMb: 4096, branch: 'unstable', updateOnStart: false });
    // Its own backup folder; default's stays the root.
    expect(ctx.backups.dir).toBe(path.join(p.deps.env.backupDir, 'pz-two'));
    expect(p.deps.audit.list({ action: 'server.create' })[0]).toMatchObject({ serverId: 'pz-two', actorType: 'user', username: 'alice', ok: true });
  });

  it('shifts the automatic ports past every server, and keeps ports asked for', async () => {
    const p = await makePanel();
    await create(p);
    await create(p, { id: 'pz-three', name: 'Third' });
    await create(p, { id: 'pz-four', name: 'Fourth', ports: { game: 17000 } });
    expect(p.deps.serverRows.get('pz-three')!.ports).toEqual({ game: 16265, udp: 16266 });
    expect(p.deps.serverRows.get('pz-four')!.ports).toEqual({ game: 17000, udp: 16267 });
  });

  it('refuses what it can tell is wrong before asking the orchestrator for anything', async () => {
    const p = await makePanel({}, {});
    await create(p);
    const cases: [Partial<CreateServerInput>, number, string, Record<string, unknown>?][] = [
      [{ id: 'Bad_Id' }, 400, 'invalid-server-id'],
      [{ id: 'default' }, 409, 'reserved-server-id'],
      [{ id: 'panel' }, 409, 'reserved-server-id'],
      [{ id: 'pz-two', name: 'Other name' }, 409, 'server-exists'],
      [{ id: 'pz-x', name: 'ZOMBOID' }, 409, 'server-name-taken'],
      [{ id: 'pz-x', name: '   ' }, 400, 'invalid-server-name'],
      [{ id: 'pz-x', name: 'x'.repeat(65) }, 400, 'invalid-server-name'],
      [{ id: 'pz-x', name: 'x', adapter: 'nope' }, 400, 'unknown-adapter'],
      [{ id: 'pz-x', name: 'x', flavour: 'vanilla' }, 400, 'unknown-flavour'],
      [{ id: 'pz-x', name: 'x', launch: { memoryMb: 1000 } }, 400, 'invalid-options'],
      [{ id: 'pz-x', name: 'x', launch: { bogus: true } }, 400, 'invalid-options'],
      [{ id: 'pz-x', name: 'x', memLimitMb: 4096 }, 400, 'memory-too-low', { minMb: 8192 + 3072 }],
    ];
    p.orch.calls.length = 0;
    for (const [over, status, code, extra] of cases) {
      const r = await refusal(create(p, over));
      expect(r, JSON.stringify(over)).toMatchObject({ status, code, ...(extra ? { extra: expect.objectContaining(extra) } : {}) });
    }
    expect(p.orch.calls).toEqual([]);
    expect(p.deps.serverRows.list().map((r) => r.id)).toEqual(['default', 'pz-two']);
  });

  it('refuses ports that are taken, not the game’s, or out of range', async () => {
    const p = await makePanel({}, {});
    await create(p);
    for (const [ports, status, code, extra] of [
      [{ game: 16261 }, 409, 'port-conflict', { port: 16261, with: 'default' }],
      [{ udp: 16264 }, 409, 'port-conflict', { port: 16264, with: 'pz-two' }],
      [{ game: 17000, udp: 17000 }, 409, 'port-conflict', { port: 17000, with: 'self' }],
      [{ rcon: 27015 }, 400, 'unknown-port', { port: 'rcon' }],
      [{ game: 80 }, 400, 'invalid-port'],
      [{ game: 70000 }, 400, 'invalid-port'],
    ] as [Record<string, number>, number, string, Record<string, unknown>?][]) {
      expect(await refusal(create(p, { id: 'pz-x', name: 'x', ports })), JSON.stringify(ports)).toMatchObject({ status, code, ...(extra ? { extra: expect.objectContaining(extra) } : {}) });
    }
  });

  it("refuses the panel's own port, an EULA not accepted, a flavour the game lacks, and more cores than the host has", async () => {
    const p = await makePanel({}, { adapters: [pzPanelAdapter, other] });
    const base = { id: 'mc-one', name: 'Blocks', adapter: 'other', flavour: 'vanilla', eulaAccepted: true };
    // The panel is reached on TCP 8443 (its origin): never a game's port.
    expect(await refusal(create(p, { ...base, ports: { game: 8443 } }))).toMatchObject({ status: 409, code: 'port-conflict', extra: { port: 8443, proto: 'tcp', with: 'panel' } });
    expect(await refusal(create(p, { ...base, eulaAccepted: false }))).toMatchObject({ status: 400, code: 'eula-required' });
    expect(await refusal(create(p, { ...base, flavour: null }))).toMatchObject({ status: 400, code: 'unknown-flavour', extra: { flavours: ['vanilla', 'modded'] } });
    expect(await refusal(create(p, { ...base, cpus: 64 }))).toMatchObject({ status: 400, code: 'invalid-cpus', extra: { max: 8 } });
    // An ARM host runs it (it lists arm64); a TCP port isn't the same inside and out.
    p.orch.arch = 'arm64';
    const ok = await create(p, { ...base, cpus: 2, ports: { game: 25570 } });
    expect(ok.row).toMatchObject({ flavour: 'vanilla', ports: { game: 25570 }, cpus: 2, eulaAcceptedBy: 1 });
    expect(ok.row.eulaAcceptedAt).not.toBeNull();
    expect(p.orch.containers.get('mc-one')!.spec).toMatchObject({ cpus: 2, env: { GAME_ADAPTER: 'other', GAME_FLAVOUR: 'vanilla', GAME_PORT_GAME: '25565' }, ports: [{ container: 25565, host: 25570, proto: 'tcp' }] });
  });

  it('refuses a game the host cannot run natively, saying why (HST-05)', async () => {
    const p = await makePanel();
    p.orch.arch = 'arm64';
    expect(await refusal(create(p))).toEqual({ status: 409, code: 'arch-unsupported', extra: { arch: 'arm64', supported: ['amd64'] } });
    expect(p.deps.serverRows.get('pz-two')).toBeNull();
  });

  it('refuses an id a container of this stack already has (its volumes would come back)', async () => {
    const p = await makePanel();
    await p.orch.apply({ id: 'pz-two', runtime: 'steam', env: { AGENT_TOKEN: 't', GAME_ADAPTER: 'pz', TZ: 'UTC' }, ports: [], memoryMb: 1 });
    expect(await refusal(create(p))).toMatchObject({ status: 409, code: 'server-exists' });
  });

  it('leaves nothing behind when the orchestrator refuses or is down', async () => {
    const p = await makePanel();
    p.orch.failNext.set('apply', new OrchestratorCallError(409, 'conflict', 'port 16263/udp is taken', 'ports[0].host'));
    expect(await refusal(create(p))).toMatchObject({ status: 409, code: 'port-conflict', extra: { field: 'ports[0].host' } });
    p.orch.failNext.set('apply', new OrchestratorCallError(422, 'refused', 'not on the allowlist', 'runtime'));
    expect(await refusal(create(p))).toMatchObject({ status: 409, code: 'orchestrator-refused', extra: { field: 'runtime' } });
    // Created, but it wouldn't start: the container goes too.
    p.orch.failNext.set('start', new OrchestratorCallError(503, 'unavailable', 'Docker is not reachable'));
    expect(await refusal(create(p))).toMatchObject({ status: 503, code: 'orchestrator-unavailable' });
    expect(p.orch.calls).toContain('remove pz-two volumes=true');
    p.orch.down = new OrchestratorCallError(503, 'unreachable', 'connect ENOENT');
    expect(await refusal(create(p))).toMatchObject({ status: 503, code: 'orchestrator-unavailable' });

    expect(p.deps.serverRows.get('pz-two')).toBeNull();
    expect(p.deps.servers.get('pz-two')).toBeNull();
    expect(p.orch.containers.size).toBe(0);
    expect(p.deps.db.prepare("SELECT COUNT(*) AS n FROM server_settings WHERE server_id = 'pz-two'").get()).toEqual({ n: 0 });
    expect(p.deps.audit.list({ action: 'server.create' }).map((e) => e.ok)).toEqual([false, false, false]);
  });
});

describe('renaming a server', () => {
  it('updates the row and rebuilds its context around it', async () => {
    const p = await makePanel();
    const before = await create(p);
    const after = await p.deps.servers.update('pz-two', { name: '  Renamed  ' }, OWNER_ACTOR);
    expect(after).not.toBe(before);
    expect(after.row.name).toBe('Renamed');
    expect(p.deps.servers.get('pz-two')).toBe(after);
    expect(after.handle.ref).toEqual(before.handle.ref);
    // The same agent client: its live status, log backlog and stream carry over.
    expect(after.agent).toBe(before.agent);
    expect(after.feed).toBe(before.feed);
    expect(p.fakes('pz-two').made).toBe(1);
    expect(await refusal(p.deps.servers.update('pz-two', { name: 'zomboid' }, OWNER_ACTOR))).toMatchObject({ status: 409, code: 'server-name-taken' });
    expect(await refusal(p.deps.servers.update('nope', { name: 'x' }, OWNER_ACTOR))).toMatchObject({ status: 404, code: 'server-not-found' });
    // default can be renamed too: its name is the panel's, not the game's.
    expect((await p.deps.servers.update('default', { name: 'Main' }, OWNER_ACTOR)).handle.ref.gameName).toBe('zomboid');
    expect(p.deps.audit.list({ action: 'server.update' })[1]).toMatchObject({ serverId: 'pz-two', target: 'Renamed' });
  });

  it('waits for the running operation', async () => {
    const p = await makePanel();
    const ctx = await create(p);
    let release!: () => void;
    ctx.ops.start('backup', 'alice', () => new Promise<void>((r) => (release = r)));
    expect(await refusal(p.deps.servers.update('pz-two', { name: 'Later' }, OWNER_ACTOR))).toMatchObject({ status: 409, code: 'busy' });
    release();
    await ctx.ops.idle();
    expect((await p.deps.servers.update('pz-two', { name: 'Later' }, OWNER_ACTOR)).row.name).toBe('Later');
  });
});

describe('removing a server (SRV-04)', () => {
  /** A server with a world, settings, history, a grant and a player session. */
  async function populated() {
    const p = await makePanel();
    const ctx = await create(p);
    const world = path.join(p.fakes('pz-two').dataDir, 'Saves', 'Multiplayer', 'pz-two');
    mkdirSync(world, { recursive: true });
    writeFileSync(path.join(world, 'map_0_0.bin'), 'terrain');
    const friend = await p.deps.users.create({ username: 'bob', password: 'Temporal-12345', role: 'viewer' });
    p.deps.users.setScope(friend.id, 'granted');
    p.deps.grants.set(friend.id, 'pz-two', 'admin');
    p.deps.users.setRole(friend.id, 'admin');
    ctx.settings.setRaw('schedules', { timezone: 'UTC' });
    p.deps.db.prepare("INSERT INTO config_versions (file, at, username, note, content, server_id) VALUES ('ini', '2026-01-01', 'alice', null, 'x', 'pz-two')").run();
    p.deps.db.prepare("INSERT INTO player_sessions (username, joined_at, server_id) VALUES ('rick', '2026-01-01', 'pz-two')").run();
    p.deps.audit.log({ actor: OWNER_ACTOR, serverId: 'pz-two', action: 'server.start' });
    return { p, ctx, friend };
  }

  const count = (p: TestPanel, table: string) => (p.deps.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE server_id = 'pz-two'`).get() as { n: number }).n;

  it('takes a final backup, removes the container and its volumes, then every row but the audit log', async () => {
    const { p, friend } = await populated();
    const r = await p.deps.servers.remove('pz-two', { confirm: 'Second', keepBackups: true, by: OWNER_ACTOR });
    // The final backup is in the server's own folder, and stays.
    const dir = path.join(p.deps.env.backupDir, 'pz-two');
    expect(r.finalBackup).toMatch(/^pz-pz-two-.*\.tar\.zst$/);
    expect(readdirSync(dir)).toContain(r.finalBackup);
    expect(p.orch.calls.at(-1)).toBe('remove pz-two volumes=true');
    expect(p.orch.containers.has('pz-two')).toBe(false);
    expect(p.deps.servers.get('pz-two')).toBeNull();
    expect(p.deps.serverRows.get('pz-two')).toBeNull();
    for (const t of ['server_grants', 'server_settings', 'server_mods', 'config_versions', 'player_sessions', 'proposals']) expect(count(p, t), t).toBe(0);
    // The audit log outlives the server, and says who removed it.
    expect(count(p, 'audit')).toBeGreaterThan(2);
    expect(p.deps.audit.list({ action: 'server.delete' })[0]).toMatchObject({ serverId: 'pz-two', actorType: 'user', username: 'alice', ok: true });
    // A granted admin of that server only is back to viewer (2FA rules follow the highest grant).
    expect(p.deps.users.byId(friend.id)!.role).toBe('viewer');
  });

  it("deletes the server's backups too when the owner says so, and never another folder", async () => {
    const { p } = await populated();
    mkdirSync(path.join(p.deps.env.backupDir, 'pz-two'), { recursive: true });
    writeFileSync(path.join(p.deps.env.backupDir, 'pz-two', 'old.tar.zst'), 'x');
    writeFileSync(path.join(p.deps.env.backupDir, 'default-archive.tar.zst'), 'x');
    const r = await p.deps.servers.remove('pz-two', { confirm: 'Second', keepBackups: false, by: OWNER_ACTOR });
    expect(r.finalBackup).toBeNull();
    expect(existsSync(path.join(p.deps.env.backupDir, 'pz-two'))).toBe(false);
    expect(existsSync(path.join(p.deps.env.backupDir, 'default-archive.tar.zst'))).toBe(true);
  });

  it('refuses without the typed name, while running or busy, and for the server Compose runs', async () => {
    const { p, ctx } = await populated();
    const opts = { confirm: 'Second', keepBackups: true, by: OWNER_ACTOR };
    expect(await refusal(p.deps.servers.remove('pz-two', { ...opts, confirm: 'second' }))).toMatchObject({ status: 400, code: 'confirm-mismatch' });
    expect(await refusal(p.deps.servers.remove('default', { ...opts, confirm: 'zomboid' }))).toMatchObject({ status: 409, code: 'server-unmanaged' });
    expect(await refusal(p.deps.servers.remove('nope', opts))).toMatchObject({ status: 404, code: 'server-not-found' });
    p.fakes('pz-two').feed.status_ = fakeStatus({ state: 'running' });
    expect(await refusal(p.deps.servers.remove('pz-two', opts))).toMatchObject({ status: 409, code: 'server-running' });
    p.fakes('pz-two').feed.status_ = fakeStatus();
    let release!: () => void;
    ctx.ops.start('restore', 'alice', () => new Promise<void>((r) => (release = r)));
    expect(await refusal(p.deps.servers.remove('pz-two', opts))).toMatchObject({ status: 409, code: 'busy' });
    release();
    await ctx.ops.idle();
    expect(p.orch.containers.has('pz-two')).toBe(true);
  });

  it('keeps everything when the final backup fails, or the container cannot be removed', async () => {
    const { p } = await populated();
    const opts = { confirm: 'Second', keepBackups: true, by: OWNER_ACTOR };
    p.fakes('pz-two').agent.lock = () => Promise.reject(new Error('agent unreachable'));
    expect(await refusal(p.deps.servers.remove('pz-two', opts))).toMatchObject({ status: 409, code: 'final-backup-failed', extra: { message: 'agent unreachable' } });
    expect(p.orch.containers.has('pz-two')).toBe(true);
    expect(p.deps.serverRows.get('pz-two')).not.toBeNull();
    // Only the owner may skip it (the route checks who); the registry takes the word.
    p.orch.failNext.set('remove', new OrchestratorCallError(503, 'unavailable', 'Docker is not reachable'));
    expect(await refusal(p.deps.servers.remove('pz-two', { ...opts, finalBackup: false }))).toMatchObject({ status: 503, code: 'orchestrator-unavailable' });
    expect(p.deps.serverRows.get('pz-two')).not.toBeNull();
    // A container already gone is what we wanted.
    p.orch.containers.delete('pz-two');
    await p.deps.servers.remove('pz-two', { ...opts, finalBackup: false });
    expect(p.deps.serverRows.get('pz-two')).toBeNull();
    expect(p.deps.audit.list({ action: 'server.delete' }).map((e) => e.ok)).toEqual([true, false, false]);
  });
});

describe('reconcile (SRV-06)', () => {
  it('rebuilds every server from the table on boot, and leaves a matching container alone', async () => {
    const p = await makePanel();
    await create(p);
    // The panel restarts: a new panel over the same database and the same containers.
    const again = await makePanel({}, { db: p.deps.db, orch: p.orch });
    expect(again.deps.servers.list().map((s) => s.id)).toEqual(['default', 'pz-two']);
    again.orch.calls.length = 0;
    expect(await again.deps.servers.reconcile()).toEqual({ applied: [], started: [], orphans: [], failed: [] });
    // default is Compose's: never applied, started or removed by the panel.
    expect(again.orch.calls).toEqual(['list', 'apply pz-two']);
  });

  it('recreates a missing container, starts a stopped one, and reports what it cannot fix', async () => {
    const p = await makePanel();
    await create(p);
    await create(p, { id: 'pz-three', name: 'Third' });
    p.orch.containers.delete('pz-two');
    await p.orch.stop('pz-three');
    await p.orch.apply({ id: 'ghost', runtime: 'steam', env: { AGENT_TOKEN: 't', GAME_ADAPTER: 'pz', TZ: 'UTC' }, ports: [], memoryMb: 1 });
    expect(await p.deps.servers.reconcile()).toEqual({ applied: ['pz-two'], started: ['pz-two', 'pz-three'], orphans: ['ghost'], failed: [] });
    expect(p.orch.containers.get('pz-two')!.state).toBe('running');
    expect(p.deps.audit.list({ action: 'server.reconcile' }).map((e) => [e.serverId, e.actorType])).toEqual([
      ['pz-three', 'system'],
      ['pz-two', 'system'],
    ]);

    p.orch.failNext.set('apply', new OrchestratorCallError(409, 'refused', 'image not allowed', 'runtime'));
    const r = await p.deps.servers.reconcile();
    expect(r.failed).toEqual([{ id: 'pz-two', error: 'image not allowed' }]);
    p.orch.down = new OrchestratorCallError(503, 'unreachable', 'connect ENOENT');
    expect((await p.deps.servers.reconcile()).failed.map((f) => f.id)).toEqual(['pz-two', 'pz-three']);
    expect(p.deps.audit.list({ action: 'server.reconcile' })[0]).toMatchObject({ actorType: SYSTEM.type, ok: false });
  });

  it("asks for the install's image variant, and recreates containers when it changes", async () => {
    const p = await makePanel({ serverImageVariant: 'fake' });
    await create(p);
    expect(p.orch.containers.get('pz-two')!.spec.variant).toBe('fake');
    // The same database under a production environment: the spec changes, the container is recreated and started.
    const prod = await makePanel({}, { db: p.deps.db, orch: p.orch });
    expect(await prod.deps.servers.reconcile()).toMatchObject({ applied: ['pz-two'], started: ['pz-two'] });
    expect(p.orch.containers.get('pz-two')!.spec).not.toHaveProperty('variant');
    expect(prod.deps.serverRows.get('pz-two')!.spec).not.toHaveProperty('variant');
  });

  it("reaches an orchestrator-run server's agent where its container says, once the orchestrator told", async () => {
    const p = await makePanel();
    await create(p);
    expect(p.fakes('pz-two').target).toEqual({ baseUrl: 'http://gsp-pz-two:8081', token: p.deps.serverRows.secrets('pz-two').agentToken });
    // After a restart the address is unknown (calls fail as unreachable) until reconcile hears from the orchestrator.
    const again = await makePanel({}, { db: p.deps.db, orch: p.orch });
    expect(again.fakes('pz-two').target!.baseUrl).toBe('');
    await again.deps.servers.reconcile();
    expect(again.fakes('pz-two').target!.baseUrl).toBe('http://gsp-pz-two:8081');
    // default is where the environment says.
    expect(again.deps.servers.get('default')!.row.spec).toBeNull();
  });

  it('starts every server once running, and retries what the orchestrator could not bring up', async () => {
    const p = await makePanel();
    await create(p);
    const again = await makePanel({}, { db: p.deps.db, orch: p.orch });
    const started: string[] = [];
    for (const s of again.deps.servers.list()) {
      const start = s.start;
      s.start = () => (started.push(s.id), start());
    }
    p.orch.down = new OrchestratorCallError(503, 'unreachable', 'connect ENOENT');
    const r = await again.deps.servers.start();
    expect(r.failed.map((f) => f.id)).toEqual(['pz-two']);
    // Every server runs its timers even so; the retry comes later.
    expect(started.sort()).toEqual(['default', 'pz-two']);
    again.deps.servers.stop();
  });
});
