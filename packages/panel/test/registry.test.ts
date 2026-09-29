// The server registry over the `servers` table (M2, G1) against a fake
// orchestrator: creating a server (SRV-01, HST-05), renaming it, removing it
// after a final backup (SRV-04), and bringing containers back in line with
// the table (SRV-06).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
    eula: { name: { en: 'Test EULA', es: 'EULA de prueba' }, url: 'https://eula.example/terms' },
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

  it('picks free ports only where the orchestrator lets servers publish (a development slot)', async () => {
    const p = await makePanel();
    p.orch.hostPorts = [{ from: 30150, to: 30199 }];
    // The defaults (16261/16262, default's anyway) are outside: as low as they fit inside, still a pair.
    await create(p);
    expect(p.deps.serverRows.get('pz-two')!.ports).toEqual({ game: 30150, udp: 30151 });
    expect(p.orch.containers.get('pz-two')!.spec).toMatchObject({
      env: { GAME_PORT_GAME: '30150', GAME_PORT_UDP: '30151' },
      ports: [
        { container: 30150, host: 30150, proto: 'udp' },
        { container: 30151, host: 30151, proto: 'udp' },
      ],
    });
    await create(p, { id: 'pz-three', name: 'Third' });
    expect(p.deps.serverRows.get('pz-three')!.ports).toEqual({ game: 30152, udp: 30153 });
    // One asked for, the other picked around it.
    await create(p, { id: 'pz-four', name: 'Fourth', ports: { game: 30160 } });
    expect(p.deps.serverRows.get('pz-four')!.ports).toEqual({ game: 30160, udp: 30154 });
    // A port outside is refused before anything is created, saying where ports may go.
    p.orch.calls.length = 0;
    expect(await refusal(create(p, { id: 'pz-x', name: 'x', ports: { game: 16300 } }))).toEqual({
      status: 400,
      code: 'invalid-port',
      extra: { port: 'game', min: 30150, max: 30199, ranges: '30150-30199' },
    });
    expect(p.orch.calls).toEqual(['host', 'list']);
    // Full: no pair fits any more.
    p.orch.hostPorts = [{ from: 30150, to: 30155 }];
    expect(await refusal(create(p, { id: 'pz-x', name: 'x' }))).toMatchObject({ status: 409, code: 'no-free-port' });
  });

  it("keeps new servers near the game's defaults when the install allows them, and moves on to its other ranges", async () => {
    const p = await makePanel();
    // The shipped ranges: PZ's block is allowed, so ports shift past default's as before.
    p.orch.hostPorts = [
      { from: 2456, to: 2499 },
      { from: 16261, to: 16265 },
      { from: 25565, to: 25599 },
    ];
    await create(p);
    await create(p, { id: 'pz-three', name: 'Third' });
    expect(p.deps.serverRows.get('pz-two')!.ports).toEqual({ game: 16263, udp: 16264 });
    // 16265 alone can't hold the pair: the lowest other range.
    expect(p.deps.serverRows.get('pz-three')!.ports).toEqual({ game: 2456, udp: 2457 });
  });

  it("never gives a port that is the same inside and out the number of the agent or of another of the server's ports", async () => {
    // A TCP game port that must be the same inside and out, next to a TCP port only the agent uses.
    const tcpGame: PanelAdapter = {
      ...pzPanelAdapter,
      meta: {
        ...pzPanelAdapter.meta,
        id: 'tcp-game',
        ports: [
          { id: 'game', proto: 'tcp', default: 8080, publish: true, sameInsideOut: true, label: { en: 'Game', es: 'Juego' } },
          { id: 'query', proto: 'tcp', default: 8082, publish: false, sameInsideOut: false, label: { en: 'Query', es: 'Consulta' } },
        ],
      },
    };
    const p = await makePanel({}, { adapters: [pzPanelAdapter, tcpGame] });
    p.orch.hostPorts = [{ from: 8080, to: 8083 }];
    const base = { adapter: 'tcp-game' };
    await create(p, { ...base, id: 'tcp-one', name: 'One' });
    await create(p, { ...base, id: 'tcp-two', name: 'Two' });
    expect(p.deps.serverRows.get('tcp-one')!.ports).toEqual({ game: 8080 });
    // 8081 is the agent's inside every container, 8082 the query port's.
    expect(p.deps.serverRows.get('tcp-two')!.ports).toEqual({ game: 8083 });
    expect(await refusal(create(p, { ...base, id: 'tcp-x', name: 'x', ports: { game: 8081 } }))).toMatchObject({ status: 409, code: 'port-conflict', extra: { port: 8081, proto: 'tcp', with: 'agent' } });
    expect(await refusal(create(p, { ...base, id: 'tcp-x', name: 'x', ports: { game: 8082 } }))).toMatchObject({ status: 409, code: 'port-conflict', extra: { port: 8082, proto: 'tcp', with: 'self' } });
    expect(await refusal(create(p, { ...base, id: 'tcp-x', name: 'x' }))).toMatchObject({ status: 409, code: 'no-free-port' });
  });

  it("refuses more memory than the orchestrator gives one server, saying how much it gives (SRV-05)", async () => {
    const p = await makePanel();
    p.orch.maxMemMb = 5120;
    // PZ's default heap (8 GiB) plus its overhead doesn't fit.
    expect(await refusal(create(p))).toMatchObject({ status: 409, code: 'orchestrator-refused', extra: { field: 'memLimitMb', maxMb: 5120, message: expect.stringContaining('5120 MiB') } });
    expect(await refusal(create(p, { launch: { memoryMb: 2048 }, memLimitMb: 6000 }))).toMatchObject({ code: 'orchestrator-refused', extra: { maxMb: 5120 } });
    expect(p.orch.calls.filter((c) => c.startsWith('apply'))).toEqual([]);
    // The smallest heap (2 GiB) and 3 GiB for the rest is exactly the most it gives.
    expect((await create(p, { launch: { memoryMb: 2048 } })).row.memLimitMb).toBe(5120);
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

  it('lets the owner force out a server that runs or is busy, still taking the final backup when it can', async () => {
    const opts = { confirm: 'Second', keepBackups: true, by: OWNER_ACTOR, force: true };
    // Running: a hot final backup, then the game is not waited for.
    const running = await populated();
    running.p.fakes('pz-two').feed.status_ = fakeStatus({ state: 'running' });
    running.p.orch.calls.length = 0;
    const r = await running.p.deps.servers.remove('pz-two', opts);
    expect(r).toEqual({ finalBackup: expect.stringMatching(/^pz-pz-two-.*\.tar\.zst$/), forced: true, finalBackupError: null });
    expect(running.p.orch.calls).toEqual(['stop pz-two', 'remove pz-two volumes=true']);
    expect(running.p.deps.serverRows.get('pz-two')).toBeNull();
    const entry = running.p.deps.audit.list({ action: 'server.delete' })[0]!;
    expect(entry).toMatchObject({ ok: true, username: 'alice' });
    expect(JSON.parse(entry.detail!)).toEqual({ keepBackups: true, finalBackup: r.finalBackup, forced: true, finalBackupError: null });

    // Held by an operation that never ends: no backup can be taken, and the answer says why.
    const busy = await populated();
    busy.ctx.ops.start('restore', 'alice', () => new Promise<void>(() => undefined));
    expect(await busy.p.deps.servers.remove('pz-two', opts)).toEqual({ finalBackup: null, forced: true, finalBackupError: expect.stringContaining('restore') });
    expect(busy.p.orch.containers.has('pz-two')).toBe(false);
  });

  it("forces out a server whose agent can't be reached, saying the final backup couldn't be taken", async () => {
    const { p } = await populated();
    const fake = p.fakes('pz-two');
    fake.feed.status_ = null;
    fake.feed.connected = false;
    fake.agent.lock = () => Promise.reject(new Error('agent unreachable'));
    const opts = { confirm: 'Second', keepBackups: true, by: OWNER_ACTOR };
    // Not forced: nothing is removed without its final backup.
    expect(await refusal(p.deps.servers.remove('pz-two', opts))).toMatchObject({ status: 409, code: 'final-backup-failed' });
    expect(p.deps.serverRows.get('pz-two')).not.toBeNull();
    // Forced: removed anyway; a container that is already gone (stop and remove both answer not-found) is fine too.
    p.orch.containers.delete('pz-two');
    expect(await p.deps.servers.remove('pz-two', { ...opts, force: true })).toEqual({ finalBackup: null, forced: true, finalBackupError: 'agent unreachable' });
    expect(p.deps.serverRows.get('pz-two')).toBeNull();
    const [done, refused] = p.deps.audit.list({ action: 'server.delete' });
    expect(JSON.parse(done!.detail!)).toMatchObject({ forced: true, finalBackup: null, finalBackupError: 'agent unreachable' });
    expect(refused).toMatchObject({ ok: false });
  });

  it('marks the final backup as the final one, not a manual one (SRV-04, BAK-01)', async () => {
    const { p } = await populated();
    const r = await p.deps.servers.remove('pz-two', { confirm: 'Second', keepBackups: true, by: OWNER_ACTOR });
    expect(r.finalBackup).toMatch(/^pz-pz-two-\d{8}T\d{6}Z-final\.tar\.zst$/);
    const sidecar = JSON.parse(readFileSync(path.join(p.deps.env.backupDir, 'pz-two', `${r.finalBackup}.json`), 'utf8')) as { manifest: { trigger: string } };
    expect(sidecar.manifest.trigger).toBe('final');
  });

  it("says when the server's agent can't be reached, instead of calling it running, and lets only force go on (SRV-04)", async () => {
    const { p } = await populated();
    const fake = p.fakes('pz-two');
    // The last thing the panel heard: it was running. Now its agent doesn't answer.
    fake.feed.status_ = fakeStatus({ state: 'running' });
    fake.feed.connected = false;
    fake.agent.status = () => Promise.reject(new Error('agent unreachable'));
    fake.agent.lock = () => Promise.reject(new Error('agent unreachable'));
    const opts = { confirm: 'Second', keepBackups: true, by: OWNER_ACTOR };
    expect(await refusal(p.deps.servers.remove('pz-two', opts))).toMatchObject({ status: 409, code: 'server-unreachable', extra: { force: true } });
    expect(await refusal(p.deps.servers.remove('pz-two', { ...opts, finalBackup: false }))).toMatchObject({ status: 409, code: 'server-unreachable' });
    expect(p.orch.containers.has('pz-two')).toBe(true);
    expect(p.deps.serverRows.get('pz-two')).not.toBeNull();
    // Forced, it goes on (here the test's files are still at hand, so even the final backup is taken).
    expect(await p.deps.servers.remove('pz-two', { ...opts, force: true })).toMatchObject({ forced: true });
    expect(p.deps.serverRows.get('pz-two')).toBeNull();
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

describe('changing memory and CPU limits (SRV-05)', () => {
  const detail = (p: TestPanel, action: string) => JSON.parse(p.deps.audit.list({ action })[0]!.detail!) as Record<string, unknown>;

  it("recreates a stopped server's container with its new limits at once", async () => {
    const p = await makePanel();
    await create(p, { launch: { memoryMb: 2048 } });
    expect(p.deps.serverRows.get('pz-two')!.memLimitMb).toBe(5120);
    p.orch.calls.length = 0;
    const ctx = await p.deps.servers.update('pz-two', { memLimitMb: 6144, cpus: 2 }, OWNER_ACTOR);
    expect(ctx.row).toMatchObject({ memLimitMb: 6144, cpus: 2 });
    expect(p.orch.calls).toEqual(['host', 'apply pz-two', 'start pz-two']);
    expect(p.orch.containers.get('pz-two')).toMatchObject({ state: 'running', spec: expect.objectContaining({ memoryMb: 6144, cpus: 2 }) });
    expect(p.deps.serverRows.get('pz-two')!.spec).toMatchObject({ memoryMb: 6144, cpus: 2 });
    expect(p.deps.servers.containerPending('pz-two')).toBe(false);
    expect(detail(p, 'server.update')).toEqual({ before: { name: 'Second', sort: 1, memLimitMb: 5120, cpus: null }, after: { memLimitMb: 6144, cpus: 2 }, container: 'recreated' });
    // No CPU limit any more.
    await p.deps.servers.update('pz-two', { cpus: null }, OWNER_ACTOR);
    expect(p.orch.containers.get('pz-two')!.spec).not.toHaveProperty('cpus');
    // The same limits again change nothing.
    p.orch.calls.length = 0;
    await p.deps.servers.update('pz-two', { memLimitMb: 6144 }, OWNER_ACTOR);
    expect(p.orch.calls).toEqual(['host']);
  });

  it('refuses limits the game or the host cannot take, and changes nothing when the orchestrator fails', async () => {
    const p = await makePanel();
    const ctx = await create(p, { launch: { memoryMb: 2048 } });
    p.orch.maxMemMb = 6144;
    p.orch.calls.length = 0;
    const update = (patch: Parameters<typeof p.deps.servers.update>[1], id = 'pz-two') => p.deps.servers.update(id, patch, OWNER_ACTOR);
    expect(await refusal(update({ memLimitMb: 4096 }))).toMatchObject({ status: 400, code: 'memory-too-low', extra: { minMb: 5120 } });
    expect(await refusal(update({ memLimitMb: 7000 }))).toMatchObject({ status: 409, code: 'orchestrator-refused', extra: { field: 'memLimitMb', maxMb: 6144 } });
    expect(await refusal(update({ cpus: 64 }))).toMatchObject({ status: 400, code: 'invalid-cpus', extra: { max: 8 } });
    // The stack's own server: its container's limits are Compose's.
    expect(await refusal(update({ memLimitMb: 12000 }, 'default'))).toMatchObject({ status: 409, code: 'server-unmanaged' });
    let release!: () => void;
    ctx.ops.start('backup', 'alice', () => new Promise<void>((r) => (release = r)));
    expect(await refusal(update({ memLimitMb: 6144 }))).toMatchObject({ status: 409, code: 'busy' });
    release();
    await ctx.ops.idle();
    expect(p.orch.calls.filter((c) => !c.startsWith('host'))).toEqual([]);
    p.orch.failNext.set('apply', new OrchestratorCallError(503, 'unavailable', 'Docker is not reachable'));
    expect(await refusal(update({ memLimitMb: 6144 }))).toMatchObject({ status: 503, code: 'orchestrator-unavailable' });
    expect(p.deps.serverRows.get('pz-two')!.memLimitMb).toBe(5120);
    expect(p.orch.containers.get('pz-two')!.spec.memoryMb).toBe(5120);
  });

  it('waits for the next start while the game runs, then recreates the container before the game starts', async () => {
    const p = await makePanel();
    await create(p, { launch: { memoryMb: 2048 } });
    const fake = p.fakes('pz-two');
    fake.feed.status_ = fakeStatus({ state: 'running' });
    p.orch.calls.length = 0;
    await p.deps.servers.update('pz-two', { memLimitMb: 6144 }, OWNER_ACTOR);
    // Nobody's game is stopped for a limit: the row has it, the container not yet.
    expect(p.orch.calls).toEqual(['host']);
    expect(p.deps.serverRows.get('pz-two')!.memLimitMb).toBe(6144);
    expect(p.orch.containers.get('pz-two')!.spec.memoryMb).toBe(5120);
    expect(p.deps.servers.containerPending('pz-two')).toBe(true);
    expect(p.deps.servers.containerPendingReasons('pz-two')).toEqual(['settings']);
    expect(detail(p, 'server.update')).toMatchObject({ container: 'at-next-start' });

    // A panel restart meanwhile keeps the container it has (and joins the new panel to its network).
    const again = await makePanel({}, { db: p.deps.db, orch: p.orch });
    again.fakes('pz-two').feed.status_ = fakeStatus({ state: 'running' });
    expect(await again.deps.servers.reconcile()).toEqual({ applied: [], started: [], orphans: [], failed: [] });
    expect(p.orch.containers.get('pz-two')!.spec.memoryMb).toBe(5120);
    expect(again.deps.servers.containerPending('pz-two')).toBe(true);

    // Start pressed while it still runs: the agent says so, and the change keeps waiting.
    const ctx = p.deps.servers.get('pz-two')!;
    ctx.control.start('alice');
    await ctx.ops.idle();
    expect(p.orch.containers.get('pz-two')!.spec.memoryMb).toBe(5120);

    // Stopped, then started: the container is recreated (and its agent answers) before the game starts.
    fake.feed.status_ = fakeStatus({ state: 'stopped' });
    const atStart: number[] = [];
    fake.agent.start = async () => {
      atStart.push(p.orch.containers.get('pz-two')!.spec.memoryMb);
      return fakeStatus({ state: 'starting' });
    };
    ctx.control.start('alice');
    await ctx.ops.idle();
    expect(ctx.ops.last()).toMatchObject({ ok: true });
    expect(atStart).toEqual([6144]);
    expect(p.orch.containers.get('pz-two')!.state).toBe('running');
    expect(p.deps.servers.containerPending('pz-two')).toBe(false);
    expect(p.deps.audit.list({ action: 'server.reconcile' })[0]).toMatchObject({ serverId: 'pz-two', actorType: 'system', detail: expect.stringContaining('changed settings') });
  });

  it("starts a game with nothing waiting at once, even while another server's removal holds the registry", async () => {
    const p = await makePanel();
    await create(p, { launch: { memoryMb: 2048 } });
    await create(p, { id: 'pz-three', name: 'Third', launch: { memoryMb: 2048 } });
    // pz-three's final backup never gets its agent's lock: its removal hangs.
    p.fakes('pz-three').agent.lock = () => new Promise(() => undefined);
    void p.deps.servers.remove('pz-three', { confirm: 'Third', keepBackups: true, by: OWNER_ACTOR }).catch(() => undefined);
    const ctx = p.deps.servers.get('pz-two')!;
    ctx.control.start('alice');
    await ctx.ops.idle();
    expect(ctx.ops.last()).toMatchObject({ kind: 'start', ok: true });
    expect(p.fakes('pz-two').agent.calls).toContain('start');
  });

  it("moves the container's limit with the game's memory, keeping its room above it, within the host's limit", async () => {
    const p = await makePanel();
    p.orch.maxMemMb = 7168;
    // 2 GiB of heap needs 5120 MiB; this one has 880 MiB more.
    await create(p, { launch: { memoryMb: 2048 }, memLimitMb: 6000 });
    const ctx = p.deps.servers.get('pz-two')!;
    const launch = (memoryMb: number) => ({ ...(ctx.handle.launchSettings() as Record<string, unknown>), memoryMb });
    await p.deps.servers.followLaunch('pz-two', launch(3072), OWNER_ACTOR);
    expect(p.deps.serverRows.get('pz-two')!.memLimitMb).toBe(6144 + 880);
    expect(p.orch.containers.get('pz-two')!.spec.memoryMb).toBe(7024);
    // More heap: the room shrinks to what the host gives one server.
    await p.deps.servers.followLaunch('pz-two', launch(4096), OWNER_ACTOR);
    expect(p.deps.serverRows.get('pz-two')!.memLimitMb).toBe(7168);
    // More than the host gives: refused, nothing changes.
    expect(await refusal(p.deps.servers.followLaunch('pz-two', launch(4608), OWNER_ACTOR))).toMatchObject({ status: 409, code: 'orchestrator-refused', extra: { maxMb: 7168 } });
    expect(p.deps.serverRows.get('pz-two')!.memLimitMb).toBe(7168);
    // The same memory, or the stack's own server: nothing to do.
    p.orch.calls.length = 0;
    await p.deps.servers.followLaunch('pz-two', ctx.handle.launchSettings() as Record<string, unknown>, OWNER_ACTOR);
    await p.deps.servers.followLaunch('default', { ...(p.srv.handle.launchSettings() as Record<string, unknown>), memoryMb: 16384 }, OWNER_ACTOR);
    expect(p.orch.calls).toEqual([]);
    expect(p.deps.serverRows.get('default')!.memLimitMb).toBe(8192 + 3072);
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
    // default is Compose's: never applied, started or removed by the panel. pz-two keeps the image it runs.
    expect(again.orch.calls).toEqual(['list', 'apply pz-two keepImage keepDerivation']);
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

  it('says in the audit log when a retry finds a failed server in line again (SRV-06)', async () => {
    const p = await makePanel();
    await create(p);
    const again = await makePanel({}, { db: p.deps.db, orch: p.orch });
    const reconciles = () =>
      again.deps.audit.list({ serverId: 'pz-two', action: 'server.reconcile' }).map((e) => [e.ok, e.detail]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // After a host restart the panel can boot before the orchestrator's socket exists.
      p.orch.down = new OrchestratorCallError(503, 'unreachable', 'connect ENOENT');
      await again.deps.servers.start();
      expect(reconciles()).toEqual([[false, expect.stringContaining('ENOENT')]]);
      p.orch.down = null;
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(reconciles()).toHaveLength(2));
      expect(reconciles()[0]).toEqual([true, 'in line with its settings again on retry']);
      // Nothing more to say, and no more retries.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconciles()).toHaveLength(2);
    } finally {
      again.deps.servers.stop();
      vi.useRealTimers();
    }
  });
});

describe('a newer runtime image (HST-01, SRV-05, SRV-06)', () => {
  const IMAGE = 'gsp/steam:fake';
  const reconciled = (p: TestPanel) => p.deps.audit.list({ serverId: 'pz-two', action: 'server.reconcile' }).map((e) => e.detail);

  it('changes nothing while the image is the same one', async () => {
    const p = await makePanel();
    await create(p);
    const again = await makePanel({}, { db: p.deps.db, orch: p.orch });
    again.orch.calls.length = 0;
    expect(await again.deps.servers.reconcile()).toEqual({ applied: [], started: [], orphans: [], failed: [] });
    expect(again.orch.calls).toEqual(['list', 'apply pz-two keepImage keepDerivation']);
    expect(again.deps.servers.containerPendingReasons('pz-two')).toEqual([]);
  });

  it("is taken at once by a stopped game's container when the panel boots: recreated, started, its agent left alone", async () => {
    const p = await makePanel();
    await create(p);
    const old = p.orch.containers.get('pz-two')!;
    const newer = p.orch.rebuildImage(IMAGE);
    expect(old.imageId).not.toBe(newer);
    // A product upgrade: new images, a new panel over the same database and containers.
    const again = await makePanel({}, { db: p.deps.db, orch: p.orch });
    again.orch.calls.length = 0;
    expect(await again.deps.servers.reconcile()).toEqual({ applied: ['pz-two'], started: ['pz-two'], orphans: [], failed: [] });
    // Applied as it was first (to reach its agent, which says the game is stopped), then on the newer image;
    // recreated by the orchestrator, never removed: its volumes stay.
    expect(again.orch.calls).toEqual(['list', 'apply pz-two keepImage keepDerivation', 'apply pz-two keepDerivation', 'start pz-two']);
    expect(p.orch.containers.get('pz-two')).toMatchObject({ state: 'running', imageId: newer, spec: old.spec });
    expect(again.deps.servers.containerPending('pz-two')).toBe(false);
    // The agent keeps its own desired state: the panel neither stopped nor started the game.
    expect(again.fakes('pz-two').agent.calls).toEqual([]);
    expect(reconciled(again)[0]).toBe('container recreated on a newer runtime image');
  });

  it('waits while the game runs, the container and game untouched, and is taken at the next start through the panel', async () => {
    const p = await makePanel();
    await create(p);
    const old = p.orch.containers.get('pz-two')!;
    const newer = p.orch.rebuildImage(IMAGE);
    const again = await makePanel({}, { db: p.deps.db, orch: p.orch });
    const fake = again.fakes('pz-two');
    fake.feed.status_ = fakeStatus({ state: 'running' });
    again.orch.calls.length = 0;
    expect(await again.deps.servers.reconcile()).toEqual({ applied: [], started: [], orphans: [], failed: [] });
    expect(again.orch.calls).toEqual(['list', 'apply pz-two keepImage keepDerivation']);
    expect(p.orch.containers.get('pz-two')).toBe(old);
    expect(old).toMatchObject({ state: 'running', imageId: expect.not.stringMatching(newer) });
    expect(fake.agent.calls).toEqual([]);
    expect(again.deps.servers.containerPending('pz-two')).toBe(true);
    expect(again.deps.servers.containerPendingReasons('pz-two')).toEqual(['image']);
    // A retry or another boot while it still runs: still kept.
    await again.deps.servers.reconcile();
    expect(p.orch.containers.get('pz-two')).toBe(old);

    // Start pressed while it runs: the agent says so, and the image keeps waiting.
    const ctx = again.deps.servers.get('pz-two')!;
    ctx.control.start('alice');
    await ctx.ops.idle();
    expect(p.orch.containers.get('pz-two')).toBe(old);

    // Stopped, then started through the panel: recreated on the newer image before the game starts.
    fake.feed.status_ = fakeStatus({ state: 'stopped' });
    const atStart: string[] = [];
    fake.agent.start = async () => {
      atStart.push(p.orch.containers.get('pz-two')!.imageId);
      return fakeStatus({ state: 'starting' });
    };
    ctx.control.start('alice');
    await ctx.ops.idle();
    expect(ctx.ops.last()).toMatchObject({ kind: 'start', ok: true });
    expect(atStart).toEqual([newer]);
    expect(p.orch.containers.get('pz-two')).toMatchObject({ state: 'running', imageId: newer, spec: old.spec });
    expect(again.deps.servers.containerPendingReasons('pz-two')).toEqual([]);
    expect(reconciled(again)[0]).toBe('container recreated on a newer runtime image before the game started');
  });

  it("asks a running game's agent only once the new panel can reach it (it joins the server's network by the kept apply)", async () => {
    const p = await makePanel();
    await create(p);
    const old = p.orch.containers.get('pz-two')!;
    p.orch.rebuildImage(IMAGE);
    const again = await makePanel({}, { db: p.deps.db, orch: p.orch });
    // A recreated panel container is on none of the servers' networks until the orchestrator joins it to one.
    again.fakes('pz-two').agent.status = async () => {
      if (!again.orch.calls.includes('apply pz-two keepImage keepDerivation')) throw new Error('getaddrinfo ENOTFOUND');
      return fakeStatus({ state: 'running' });
    };
    expect(await again.deps.servers.reconcile()).toMatchObject({ applied: [], failed: [] });
    expect(p.orch.containers.get('pz-two')).toBe(old);
    expect(again.deps.servers.containerPendingReasons('pz-two')).toEqual(['image']);
  });

  it("is learnt at the game's next start when the image was rebuilt while the panel ran", async () => {
    const p = await makePanel();
    await create(p);
    const newer = p.orch.rebuildImage(IMAGE);
    // Nobody asked the orchestrator since: the panel doesn't know yet.
    expect(p.deps.servers.containerPending('pz-two')).toBe(false);
    const ctx = p.deps.servers.get('pz-two')!;
    p.orch.calls.length = 0;
    ctx.control.start('alice');
    await ctx.ops.idle();
    expect(ctx.ops.last()).toMatchObject({ ok: true });
    expect(p.orch.calls).toEqual(['list', 'apply pz-two', 'start pz-two']);
    expect(p.orch.containers.get('pz-two')!.imageId).toBe(newer);
    expect(p.fakes('pz-two').agent.calls).toContain('start');
    // In line: the next start only asks.
    p.orch.calls.length = 0;
    ctx.control.start('alice');
    await ctx.ops.idle();
    expect(p.orch.calls).toEqual(['list']);
  });

  it('takes new limits and a newer image in one recreation at the next start', async () => {
    const p = await makePanel();
    await create(p, { launch: { memoryMb: 2048 } });
    const fake = p.fakes('pz-two');
    fake.feed.status_ = fakeStatus({ state: 'running' });
    await p.deps.servers.update('pz-two', { memLimitMb: 6144 }, OWNER_ACTOR);
    const newer = p.orch.rebuildImage(IMAGE);
    const ctx = p.deps.servers.get('pz-two')!;
    // The start pressed while it runs learns of the image, and both wait.
    ctx.control.start('alice');
    await ctx.ops.idle();
    expect(p.deps.servers.containerPendingReasons('pz-two')).toEqual(['settings', 'image']);
    fake.feed.status_ = fakeStatus({ state: 'stopped' });
    p.orch.calls.length = 0;
    ctx.control.start('alice');
    await ctx.ops.idle();
    expect(p.orch.calls.filter((c) => c.startsWith('apply'))).toEqual(['apply pz-two']);
    expect(p.orch.containers.get('pz-two')).toMatchObject({ imageId: newer, spec: expect.objectContaining({ memoryMb: 6144 }) });
    expect(p.deps.servers.containerPendingReasons('pz-two')).toEqual([]);
    expect(reconciled(p)[0]).toBe('container recreated with its changed settings and on a newer runtime image before the game started');
  });

  it("doesn't start the game when the orchestrator refuses the recreation (an image that isn't built), and keeps it waiting", async () => {
    const p = await makePanel();
    await create(p);
    const old = p.orch.containers.get('pz-two')!;
    p.orch.rebuildImage(IMAGE);
    const ctx = p.deps.servers.get('pz-two')!;
    p.orch.failNext.set('apply', new OrchestratorCallError(503, 'unavailable', `The image ${IMAGE} is not built on this host`));
    ctx.control.start('alice');
    await ctx.ops.idle();
    expect(ctx.ops.last()).toMatchObject({ kind: 'start', ok: false });
    expect(p.fakes('pz-two').agent.calls).not.toContain('start');
    expect(p.orch.containers.get('pz-two')).toBe(old);
    expect(p.deps.servers.containerPendingReasons('pz-two')).toEqual(['image']);
  });
});

describe('an orchestrator that builds containers another way (SRV-05, SRV-06, NFR-02)', () => {
  const reconciled = (p: TestPanel) => p.deps.audit.list({ serverId: 'pz-two', action: 'server.reconcile' }).map((e) => e.detail);
  /** How the fake orchestrator would describe pz-two's container now (without recording a call). */
  const derivedNow = (p: TestPanel) => {
    const c = p.orch.containers.get('pz-two')!;
    return c.derivedBy === p.orch.derivation.version ? 'current' : 'older';
  };

  it("is taken at once by a stopped game's container when the panel boots: recreated, started, its agent left alone", async () => {
    const p = await makePanel();
    await create(p);
    const old = p.orch.containers.get('pz-two')!;
    // A product upgrade whose orchestrator derives containers differently, and a new panel over the same database.
    p.orch.rederive();
    const again = await makePanel({}, { db: p.deps.db, orch: p.orch });
    again.orch.calls.length = 0;
    expect(await again.deps.servers.reconcile()).toEqual({ applied: ['pz-two'], started: ['pz-two'], orphans: [], failed: [] });
    // Applied as it was first (to reach its agent, which says the game is stopped), then derived anew; volumes kept.
    expect(again.orch.calls).toEqual(['list', 'apply pz-two keepImage keepDerivation', 'apply pz-two keepImage', 'start pz-two']);
    expect(p.orch.containers.get('pz-two')).toMatchObject({ state: 'running', spec: old.spec, volumes: true });
    expect(derivedNow(again)).toBe('current');
    expect(again.deps.servers.containerPending('pz-two')).toBe(false);
    expect(again.fakes('pz-two').agent.calls).toEqual([]);
    expect(reconciled(again)[0]).toBe('container recreated the way this panel version builds containers');
  });

  it('waits while the game runs, the container and game untouched, and is taken at the next start through the panel', async () => {
    const p = await makePanel();
    await create(p);
    const old = p.orch.containers.get('pz-two')!;
    p.orch.rederive();
    const again = await makePanel({}, { db: p.deps.db, orch: p.orch });
    const fake = again.fakes('pz-two');
    fake.feed.status_ = fakeStatus({ state: 'running' });
    again.orch.calls.length = 0;
    expect(await again.deps.servers.reconcile()).toEqual({ applied: [], started: [], orphans: [], failed: [] });
    expect(again.orch.calls).toEqual(['list', 'apply pz-two keepImage keepDerivation']);
    expect(p.orch.containers.get('pz-two')).toBe(old);
    expect(old.state).toBe('running');
    expect(fake.agent.calls).toEqual([]);
    expect(again.deps.servers.containerPendingReasons('pz-two')).toEqual(['derivation']);
    // A retry or another boot while it still runs: still kept.
    await again.deps.servers.reconcile();
    expect(p.orch.containers.get('pz-two')).toBe(old);

    // Start pressed while it runs: the agent says so, and the change keeps waiting.
    const ctx = again.deps.servers.get('pz-two')!;
    ctx.control.start('alice');
    await ctx.ops.idle();
    expect(p.orch.containers.get('pz-two')).toBe(old);

    // Stopped, then started through the panel: recreated, derived anew, before the game starts.
    fake.feed.status_ = fakeStatus({ state: 'stopped' });
    const atStart: string[] = [];
    fake.agent.start = async () => {
      atStart.push(derivedNow(again));
      return fakeStatus({ state: 'starting' });
    };
    ctx.control.start('alice');
    await ctx.ops.idle();
    expect(ctx.ops.last()).toMatchObject({ kind: 'start', ok: true });
    expect(atStart).toEqual(['current']);
    expect(p.orch.containers.get('pz-two')).toMatchObject({ state: 'running', spec: old.spec });
    expect(again.deps.servers.containerPendingReasons('pz-two')).toEqual([]);
    expect(reconciled(again)[0]).toBe('container recreated the way this panel version builds containers before the game started');
  });

  it("is learnt at the game's next start when the orchestrator was upgraded while the panel ran", async () => {
    const p = await makePanel();
    await create(p);
    p.orch.rederive();
    expect(p.deps.servers.containerPending('pz-two')).toBe(false);
    const ctx = p.deps.servers.get('pz-two')!;
    p.orch.calls.length = 0;
    ctx.control.start('alice');
    await ctx.ops.idle();
    expect(ctx.ops.last()).toMatchObject({ ok: true });
    expect(p.orch.calls).toEqual(['list', 'apply pz-two', 'start pz-two']);
    expect(derivedNow(p)).toBe('current');
    expect(p.fakes('pz-two').agent.calls).toContain('start');
  });

  it('recreates a container built before a security fix at once, even while its game runs, with whatever else waited, and says so (NFR-02)', async () => {
    const p = await makePanel();
    await create(p, { launch: { memoryMb: 2048 } });
    // New limits wait for the running game's next start…
    p.fakes('pz-two').feed.status_ = fakeStatus({ state: 'running' });
    await p.deps.servers.update('pz-two', { memLimitMb: 6144 }, OWNER_ACTOR);
    expect(p.deps.servers.containerPendingReasons('pz-two')).toEqual(['settings']);
    // …until an upgrade fixes a security gap in how containers are built.
    p.orch.rederive({ security: true });
    const again = await makePanel({}, { db: p.deps.db, orch: p.orch });
    again.fakes('pz-two').feed.status_ = fakeStatus({ state: 'running' });
    again.orch.calls.length = 0;
    expect(await again.deps.servers.reconcile()).toEqual({ applied: ['pz-two'], started: ['pz-two'], orphans: [], failed: [] });
    // Nothing is asked to be kept: one recreation with the new limits, derived anew.
    expect(again.orch.calls).toEqual(['list', 'apply pz-two', 'start pz-two']);
    expect(p.orch.containers.get('pz-two')).toMatchObject({ state: 'running', spec: expect.objectContaining({ memoryMb: 6144 }) });
    expect(derivedNow(again)).toBe('current');
    expect(again.deps.serverRows.get('pz-two')!.spec).toMatchObject({ memoryMb: 6144 });
    expect(again.deps.servers.containerPendingReasons('pz-two')).toEqual([]);
    expect(reconciled(again)[0]).toBe('container recreated at once for a security fix in how containers are built, without waiting for its game to stop (a running game starts again in it)');
  });

  it('takes new limits, a newer image and a changed derivation in one recreation at the next start', async () => {
    const p = await makePanel();
    await create(p, { launch: { memoryMb: 2048 } });
    const fake = p.fakes('pz-two');
    fake.feed.status_ = fakeStatus({ state: 'running' });
    await p.deps.servers.update('pz-two', { memLimitMb: 6144 }, OWNER_ACTOR);
    const newer = p.orch.rebuildImage();
    p.orch.rederive();
    const ctx = p.deps.servers.get('pz-two')!;
    // The start pressed while it runs learns of both, and all three wait.
    ctx.control.start('alice');
    await ctx.ops.idle();
    expect(p.deps.servers.containerPendingReasons('pz-two')).toEqual(['settings', 'image', 'derivation']);
    fake.feed.status_ = fakeStatus({ state: 'stopped' });
    p.orch.calls.length = 0;
    ctx.control.start('alice');
    await ctx.ops.idle();
    expect(p.orch.calls.filter((c) => c.startsWith('apply'))).toEqual(['apply pz-two']);
    expect(p.orch.containers.get('pz-two')).toMatchObject({ imageId: newer, spec: expect.objectContaining({ memoryMb: 6144 }) });
    expect(derivedNow(p)).toBe('current');
    expect(p.deps.servers.containerPendingReasons('pz-two')).toEqual([]);
    expect(reconciled(p)[0]).toBe('container recreated with its changed settings and on a newer runtime image and the way this panel version builds containers before the game started');
  });
});
