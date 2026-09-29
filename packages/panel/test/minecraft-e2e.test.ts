// Minecraft end to end (M3), without Docker: the panel as main.ts builds it
// (the orchestrator client over its socket, each server's agent client and
// its files through that agent), the real orchestrator API in front of the
// fake orchestrator's backend (each "container" a local agent process), the
// Minecraft adapter running the fake server, and installs from the fake
// download services. For each loader: create, the owner's EULA, start,
// running with its version, a settings change (managed keys refused, a
// restart pending), moderation against the game, a hot backup, a restore
// of the world, a world reset. Then a Project Zomboid and a Minecraft
// server side by side, each with its own schedule.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import dgram from 'node:dgram';
import type http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkshopSource } from '@gsp/adapter-pz/panel/core';
import { createOrchestratorServer, listenOnSocket, type Policy } from '@gsp/orchestrator';
import type { FastifyInstance } from 'fastify';
import { agentEnvFrom, FakeBackend } from '../../../tools/fake-orchestrator/backend';
import { startFakeDownloads, type FakeDownloads } from '../../../tools/fake-minecraft/downloads.mjs';
import type { AgentClient } from '../src/agent/client';
import { buildApp } from '../src/app';
import { bootstrapOwner } from '../src/auth/bootstrap';
import { openDb, type Db } from '../src/db/db';
import type { PanelEnv } from '../src/env';
import type { Deps } from '../src/http/deps';
import type { ServerContext } from '../src/servers/context';
import { createPanelDeps } from '../src/wiring';
import { FakeFeed, fakeAgent, friend, noNetwork, ORIGIN, OWNER, ownerReady, type Client, type TestPanel } from './harness';

const SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const WAIT_MS = 60_000 * SCALE;
const ORCH_TOKEN = `e2e-orch-${randomBytes(16).toString('hex')}`;
/** An account the fake server's name lookups find (it is offline-mode's UUID of the name). */
const BOB = 'gspffBob';
const BOB_UUID = 'dc6418c1-65ab-357a-98d4-eacecaaf26ba';

function freeTcp(n: number): Promise<number[]> {
  return Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise<number>((resolve, reject) => {
          const s = net.createServer();
          s.once('error', reject);
          s.listen(0, '127.0.0.1', () => {
            const port = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(port));
          });
        }),
    ),
  );
}

/** Free UDP ports, found by binding UDP (Windows reserves some ranges for one protocol only). */
function freeUdp(n: number): Promise<number[]> {
  return Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise<number>((resolve, reject) => {
          const s = dgram.createSocket('udp4');
          s.once('error', reject);
          s.bind(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
          });
        }),
    ),
  );
}

const socketPath = () => (process.platform === 'win32' ? `\\\\.\\pipe\\gsp-test-mc-e2e-${process.pid}-${randomBytes(4).toString('hex')}` : path.join(os.tmpdir(), `gsp-mc-e2e-${process.pid}-${randomBytes(4).toString('hex')}.sock`));

interface Rig {
  dir: string;
  downloads: FakeDownloads;
  backend: FakeBackend;
  orch: http.Server;
  db: Db;
  deps: Deps;
  app: FastifyInstance;
  owner: Client;
}

let rig: Rig;

beforeAll(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-mc-e2e-'));
  const downloads = await startFakeDownloads({ fail: '' });
  const downloadEnv = { GAME_MC_MOJANG_URL: downloads.url, GAME_MC_PAPER_URL: downloads.url, GAME_MC_FABRIC_URL: downloads.url };
  const policy: Policy = { hostPorts: [[1024, 65535]], maxMemMb: 16_384, maxServers: 5, allowFake: true };
  const backend = new FakeBackend({
    stateDir: path.join(dir, 'orch'),
    policy,
    agentPorts: await freeTcp(5),
    controlPorts: await freeTcp(10),
    // What the dev loop's fake orchestrator gives its agents (tools/fake-orchestrator/main.ts, scripts/dev.mjs):
    // the download services and the fakes' knobs; quick player polls on top.
    env: { ...agentEnvFrom({ ...downloadEnv, FAKE_MC_BOOT_MS: '200', FAKE_PZ_BOOT_MS: '200', FAKE_MC_PROFILES: `${BOB}=${BOB_UUID}` }), GAME_PLAYERS_POLL_MS: '300', GAME_RESTART_DELAY_MS: '60000' },
    restartDelayMs: 60_000,
  });
  const socket = socketPath();
  const orch = createOrchestratorServer({ backend, token: ORCH_TOKEN, version: 'fake', policy });
  await listenOnSocket(orch, socket);
  await backend.init();

  const env: PanelEnv = {
    version: 'test',
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    dataDir: ':memory:',
    publicDir: null,
    agentUrl: 'http://agent.invalid',
    agentToken: 'x'.repeat(40),
    orchestrator: { socket, token: ORCH_TOKEN },
    serverImageVariant: 'fake',
    pzDataDir: path.join(dir, 'default', 'data'),
    pzInstallDir: path.join(dir, 'default', 'install'),
    backupDir: path.join(dir, 'backups'),
    serverName: 'zomboid',
    secrets: { adminPassword: 'AdminPw-123456' },
    ports: {},
    origins: [ORIGIN],
    owner: OWNER,
    trustProxy: 'loopback',
    clientIpTrustworthy: false,
    secureCookies: true,
  };
  const db = openDb(':memory:');
  // `default` (the environment's server) stays a fake; every created server is the orchestrator's, reached for real.
  const feed = new FakeFeed();
  const deps = createPanelDeps({ env, db, agent: fakeAgent(feed), feed, fetch: noNetwork, mods: [createWorkshopSource({ fetch: noNetwork })], downloads: { fetch, env: downloadEnv } });
  await bootstrapOwner(deps);
  const app = await buildApp(deps);
  await deps.servers.start();
  const { client: owner } = await ownerReady({ app } as TestPanel);
  rig = { dir, downloads, backend, orch, db, deps, app, owner };
}, 60_000 * SCALE);

afterAll(async () => {
  if (!rig) return;
  rig.deps.servers.stop();
  await rig.backend.shutdown();
  await new Promise((r) => rig.orch.close(r));
  await rig.app.close();
  await rig.downloads.close();
  rig.db.close();
  rmSync(rig.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 60_000 * SCALE);

// ------------------------------------------------------------------ helpers

const srv = (id: string): ServerContext => rig.deps.servers.get(id)!;
const url = (id: string, p = '') => `/api/servers/${id}${p}`;

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = WAIT_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Waits for the server's current operation (start, backup, restore, reset) and says how it ended. */
async function opDone(id: string): Promise<{ ok: boolean | null; error: string | null }> {
  await srv(id).ops.idle();
  const last = srv(id).ops.last();
  return { ok: last?.ok ?? null, error: last?.error ?? null };
}

const state = (id: string) => srv(id).feed.status_?.state;
/** Running, as the panel's mirror says, with its control channel up, as the agent says (the mirror follows state changes). */
const running = (id: string) =>
  until(`${id} to run`, async () => {
    if (state(id) !== 'running') return false;
    const live = await srv(id).agent.status().catch(() => null);
    return live?.state === 'running' && live.control.connected;
  });
/**
 * The server's agent answers, and the panel follows its events. Its client retries with a growing
 * delay while the new "container" starts; once the agent answers, the stream is started again at once.
 */
async function agentUp(id: string): Promise<void> {
  await until(`${id}'s agent`, async () => (await srv(id).agent.status().catch(() => null)) !== null);
  if (!srv(id).feed.connected) (srv(id).agent as AgentClient).startStream();
  await until(`${id}'s events`, () => srv(id).feed.connected);
}
const dataDir = (id: string) => path.join(rig.dir, 'orch', id, 'data');
const logs = (id: string) => srv(id).feed.recentLogs().map((e) => (e.event.type === 'log' ? e.event.line : ''));

async function ok(res: { statusCode: number; body: string }, what: string): Promise<void> {
  expect(res.statusCode, `${what}: ${res.body}`).toBe(200);
}

/** A form change, the way the web makes it: a proposal, then its apply. */
async function formChange(id: string, fileId: string, changes: Record<string, unknown>) {
  const proposed = await rig.owner.post(url(id, '/config/proposals'), { fileId, changes });
  if (proposed.statusCode !== 200) return proposed;
  const { id: pid } = proposed.json() as { id: string | null };
  return pid ? rig.owner.post(url(id, `/config/proposals/${pid}/apply`)) : proposed;
}

const LOADERS = [
  { flavour: 'vanilla', launch: { version: '26.3', channel: 'STABLE', loaderVersion: '', memoryMb: 1024 }, parts: ['world', 'config'] },
  // 26.3 has only ALPHA builds (Q13): the form brings that channel along with the version.
  { flavour: 'paper', launch: { version: '26.3', channel: 'ALPHA', loaderVersion: '', memoryMb: 1024 }, parts: ['world', 'config', 'plugins'] },
  { flavour: 'fabric', launch: { version: '26.3', channel: 'STABLE', loaderVersion: '', memoryMb: 1024 }, parts: ['world', 'config', 'mods'] },
] as const;

describe('Minecraft end to end, through the fake orchestrator and the fake server (M3)', () => {
  for (const [i, l] of LOADERS.entries()) {
    const id = `mc-${l.flavour}`;
    it(
      `${l.flavour}: created with the owner's EULA, started, configured, moderated, backed up, restored and reset (SRV-01, D6, UPD-01, UPD-06, CFG-04, CFG-05, PLY-03, BAK-02, BAK-03, BAK-04)`,
      async () => {
        const { owner } = rig;
        const [game] = await freeTcp(1);
        const body = { id, name: `Blocks ${l.flavour}`, adapter: 'minecraft', flavour: l.flavour, launch: l.launch, ports: { game } };

        // ---- create, and the EULA gate (M3.0): the first one is made by an admin, so it waits for the owner.
        if (i === 0) {
          const admin = await friend({ app: rig.app, deps: rig.deps } as TestPanel, owner, 'all-admin', 'admin');
          await ok(await admin.post('/api/servers', body), 'create by an admin');
          expect((await admin.post(url(id, '/server/start'))).json()).toEqual({ error: 'eula-required' });
          await ok(await owner.post(url(id, '/eula'), { accept: true }), 'the owner accepts');
        } else {
          expect((await owner.post('/api/servers', { ...body, eulaAccepted: true })).json()).toMatchObject({ id, adapter: 'minecraft', flavour: l.flavour, eula: { acceptedBy: 'alice' } });
        }
        await agentUp(id);

        // ---- start: installed from the fake download services, then running with its version.
        await ok(await owner.post(url(id, '/server/start')), 'start');
        expect(await opDone(id)).toEqual({ ok: true, error: null });
        await running(id);
        const listed = ((await owner.get('/api/servers')).json() as { id: string; version: string | null; state: string }[]).find((s) => s.id === id)!;
        expect(listed).toMatchObject({ state: 'running', version: '26.3' });
        expect(srv(id).feed.status_!.installedInfo).toMatchObject({ version: '26.3', channel: l.flavour });
        const props = readFileSync(path.join(dataDir(id), 'server.properties'), 'utf8');
        // The agent wrote the managed keys and the owner's acceptance; the game completed the rest.
        expect(props).toMatch(/^enable-rcon=true$/m);
        expect(readFileSync(path.join(dataDir(id), 'eula.txt'), 'utf8')).toMatch(/^eula=true$/m);

        // ---- a settings change: the managed keys are refused, the rest waits for a restart (CFG-04, CFG-05).
        expect((await formChange(id, 'properties', { 'server-port': 1234 })).json()).toMatchObject({ error: 'invalid-options', fields: { 'server-port': 'managed' } });
        const changed = (await formChange(id, 'properties', { motd: `E2E ${l.flavour}`, difficulty: 'hard' })).json() as { applied: string; restartNeeded: boolean };
        expect(changed).toMatchObject({ applied: 'next-start', restartNeeded: true });
        expect((await owner.get(url(id, '/config/pending'))).json()).toMatchObject({ reasons: ['properties'] });

        // ---- players against the fake game (PLY-01, PLY-03).
        await ok(await owner.post(url(id, '/server/command'), { command: 'fake-join gspffAlice' }), 'a player joins');
        await until('the player to show up', async () => ((await owner.get(url(id, '/players'))).json() as { online: { username: string }[] }).online.some((o) => o.username === 'gspffAlice'));
        const act = async (p: string, b: unknown) => ((await owner.post(url(id, p), b)).json() as { output: string }).output;
        expect(await act('/players/kick', { username: 'gspffAlice', reason: 'e2e' })).toBe('Kicked gspffAlice: e2e');
        expect(await act('/players/ban', { username: BOB, reason: 'griefing' })).toBe(`Banned ${BOB}: griefing`);
        expect(await act('/players/ban', { ip: '203.0.113.7' })).toMatch(/^Banned IP 203\.0\.113\.7/);
        expect(await act('/players/whitelist', { username: BOB })).toBe(`Added ${BOB} to the whitelist`);
        expect(await act('/players/access', { username: BOB, level: 'operator' })).toBe(`Made ${BOB} a server operator`);
        const lists = (await owner.get(url(id, '/players'))).json() as Record<string, unknown>;
        expect(lists).toMatchObject({
          whitelist: { enabled: true, usernames: [BOB] },
          levelHolders: [{ username: BOB, level: 'operator' }],
          bans: { usernames: [{ username: BOB, id: BOB_UUID, reason: 'griefing' }], ips: [{ ip: '203.0.113.7' }] },
        });
        expect(await act('/players/unban', { username: BOB })).toBe(`Unbanned ${BOB}`);
        expect(await act('/players/unban', { ip: '203.0.113.7' })).toBe('Unbanned IP 203.0.113.7');
        // What the game refuses is an error, not a 200 with its reply (PLY-03).
        const refused = async (p: string, b: unknown) => {
          const r = await owner.post(url(id, p), b);
          return [r.statusCode, (r.json() as { error: string }).error];
        };
        expect(await refused('/players/whitelist', { username: 'gspffNoSuchPlr7' })).toEqual([404, 'player-not-found']);
        expect(await refused('/players/kick', { username: 'gspffAlice' })).toEqual([409, 'player-not-online']);
        expect(await refused('/players/access', { username: BOB, level: 'operator' })).toEqual([409, 'level-unchanged']);
        // The console shows replies without the game's colour codes (CON-02): Paper's help comes with § codes.
        const help = (await owner.post(url(id, '/server/command'), { command: 'help' })).json() as { output: string | null };
        expect(help.output).toMatch(l.flavour === 'paper' ? /^--------- Help: Index \(1\/23\) -+\nUse \/help \[n\]/ : /ban/);
        expect(help.output).not.toContain('§');
        // Switching the whitelist makes the game rewrite server.properties from memory; the panel's pending change survives.
        expect(await act('/players/whitelist/enabled', { enabled: false })).toBe('Whitelist is now turned off');
        const values = ((await owner.get(url(id, `/config/values?id=properties`))).json() as { values: Record<string, string> }).values;
        expect(values).toMatchObject({ 'white-list': 'false', motd: `E2E ${l.flavour}`, difficulty: 'hard' });

        // ---- a hot backup (BAK-02): saving off, a flush, the copy, saving on.
        await ok(await owner.post(url(id, '/backups')), 'backup');
        expect(await opDone(id)).toEqual({ ok: true, error: null });
        const backups = ((await owner.get(url(id, '/backups'))).json() as { backups: { name: string; manifest: { mode: string; parts: string[]; gameVersion: string | null } }[] }).backups;
        expect(backups).toHaveLength(1);
        expect(backups[0]!.manifest).toMatchObject({ mode: 'hot', parts: [...l.parts], gameVersion: '26.3' });
        const order = ['Automatic saving is now disabled', 'Saved the game', 'Automatic saving is now enabled'].map((m) => logs(id).findIndex((x) => x.includes(`[Rcon: ${m}]`)));
        expect(order[0]).toBeGreaterThanOrEqual(0);
        expect(order).toEqual([...order].sort((a, b) => a - b));

        // ---- the world changes, then the backup's world comes back (BAK-03); the server runs again.
        writeFileSync(path.join(dataDir(id), 'world', 'built-after-the-backup.txt'), 'x');
        await ok(await owner.post(url(id, `/backups/${encodeURIComponent(backups[0]!.name)}/restore`), { parts: ['world'] }), 'restore');
        expect(await opDone(id)).toEqual({ ok: true, error: null });
        await running(id);
        expect(existsSync(path.join(dataDir(id), 'world', 'built-after-the-backup.txt'))).toBe(false);
        expect(existsSync(path.join(dataDir(id), 'world', 'level.dat'))).toBe(true);
        // The restart took the pending settings.
        expect((await owner.get(url(id, '/config/pending'))).json()).toBeNull();

        // ---- a new world (BAK-04): backed up first, deleted, a random seed, started again.
        const before = logs(id).length;
        await ok(await owner.post(url(id, '/reset'), { scope: 'world', confirm: id, newSeed: true }), 'reset');
        expect(await opDone(id)).toEqual({ ok: true, error: null });
        await running(id);
        expect(logs(id).slice(before).some((x) => x.includes('No existing world data, creating new world'))).toBe(true);
        expect(((await owner.get(url(id, '/backups'))).json() as { backups: { manifest: { trigger: string } }[] }).backups.map((b) => b.manifest.trigger)).toEqual(expect.arrayContaining(['pre-restore', 'pre-reset', 'manual']));

        await ok(await owner.post(url(id, '/server/stop'), {}), 'stop');
        expect(await opDone(id)).toEqual({ ok: true, error: null });
        await until(`${id} to stop`, () => state(id) === 'stopped');
      },
      300_000 * SCALE,
    );
  }

  it(
    'runs a Project Zomboid and a Minecraft server side by side, each with its own schedule (G1, SCH-01)',
    async () => {
      const { owner } = rig;
      const [a, b] = await freeUdp(2);
      await ok(await owner.post('/api/servers', { id: 'pz-e2e', name: 'Zombies', adapter: 'pz', launch: { memoryMb: 2048, branch: 'public', updateOnStart: false }, ports: { game: a, udp: b } }), 'create PZ');
      await agentUp('pz-e2e');
      for (const id of ['pz-e2e', 'mc-vanilla']) await ok(await owner.post(url(id, '/server/start')), `start ${id}`);
      await Promise.all(['pz-e2e', 'mc-vanilla'].map((id) => opDone(id)));
      await Promise.all(['pz-e2e', 'mc-vanilla'].map((id) => running(id)));

      const schedule = async (id: string, time: string) => {
        const current = ((await owner.get(url(id, '/schedules'))).json() as { settings: { restarts: Record<string, unknown> } & Record<string, unknown> }).settings;
        const r = await owner.req('PUT', url(id, '/schedules'), { ...current, timezone: 'UTC', restarts: { ...current.restarts, enabled: true, times: [time], countdownSec: 0 } });
        await ok(r, `schedule ${id}`);
        return (r.json() as { next: { restart: string } }).next.restart;
      };
      const pzNext = await schedule('pz-e2e', '04:00');
      const mcNext = await schedule('mc-vanilla', '05:30');
      expect(new Date(pzNext).toISOString()).toMatch(/T04:00:00/);
      expect(new Date(mcNext).toISOString()).toMatch(/T05:30:00/);
      const list = (await owner.get('/api/servers')).json() as { id: string; adapter: string; state: string; nextRestart: string | null }[];
      expect(list.filter((s) => ['pz-e2e', 'mc-vanilla'].includes(s.id))).toEqual([
        expect.objectContaining({ id: 'mc-vanilla', adapter: 'minecraft', state: 'running', nextRestart: mcNext }),
        expect.objectContaining({ id: 'pz-e2e', adapter: 'pz', state: 'running', nextRestart: pzNext }),
      ]);
      // Each kept its own world and files.
      expect(existsSync(path.join(dataDir('pz-e2e'), 'Saves'))).toBe(true);
      expect(existsSync(path.join(dataDir('mc-vanilla'), 'world', 'level.dat'))).toBe(true);
      expect(existsSync(path.join(dataDir('pz-e2e'), 'world'))).toBe(false);

      for (const id of ['pz-e2e', 'mc-vanilla']) await ok(await owner.post(url(id, '/server/stop'), {}), `stop ${id}`);
      await Promise.all(['pz-e2e', 'mc-vanilla'].map((id) => opDone(id)));
    },
    180_000 * SCALE,
  );
});

