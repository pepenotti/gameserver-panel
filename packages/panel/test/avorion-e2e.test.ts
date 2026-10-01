// Avorion end to end (M6: "a second Steam game is added with a manifest
// only, and it boots, stops and backs up"), without Docker: the panel as
// main.ts builds it, the real orchestrator API in front of the fake
// orchestrator's backend (each "container" a local agent process), the
// adapter the manifest engine made from manifests/avorion.json, and
// tools/fake-avorion with its fake steamcmd. Created, installed, started
// with its version, the galaxy's settings seeded and the agent's keys set,
// its console (with the slash Avorion wants), players and moderation,
// settings edited only while stopped, a save, a hot backup, a restore of
// the galaxy, a factory reset, a stop.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import type { AgentClient } from '../src/agent/client';
import { buildApp } from '../src/app';
import { bootstrapOwner } from '../src/auth/bootstrap';
import { MASK } from '../src/config/service';
import { openDb, type Db } from '../src/db/db';
import type { PanelEnv } from '../src/env';
import type { Deps } from '../src/http/deps';
import type { ServerContext } from '../src/servers/context';
import { createPanelDeps } from '../src/wiring';
import { FakeFeed, fakeAgent, noNetwork, ORIGIN, OWNER, ownerReady, type Client, type TestPanel } from './harness';

const SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const WAIT_MS = 60_000 * SCALE;
const ORCH_TOKEN = `e2e-orch-${randomBytes(16).toString('hex')}`;

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

const bindUdp = (port: number) =>
  new Promise<number | null>((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => {
      s.close();
      resolve(null);
    });
    s.bind(port, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const bindTcp = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(true)));
  });

/** A free UDP port whose TCP number is free too (Avorion's game port is published on both). */
async function freeBoth(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const p = await bindUdp(0);
    if (p && (await bindTcp(p))) return p;
  }
  throw new Error('no port free on both protocols');
}

const socketPath = () => (process.platform === 'win32' ? `\\\\.\\pipe\\gsp-test-av-e2e-${process.pid}-${randomBytes(4).toString('hex')}` : path.join(os.tmpdir(), `gsp-av-e2e-${process.pid}-${randomBytes(4).toString('hex')}.sock`));

interface Rig {
  dir: string;
  backend: FakeBackend;
  orch: http.Server;
  db: Db;
  deps: Deps;
  app: FastifyInstance;
  owner: Client;
}

let rig: Rig;

beforeAll(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-av-e2e-'));
  const policy: Policy = { hostPorts: [[1024, 65535]], maxMemMb: 16_384, maxServers: 5, allowFake: true };
  const backend = new FakeBackend({
    stateDir: path.join(dir, 'orch'),
    policy,
    agentPorts: await freeTcp(3),
    controlPorts: await freeTcp(6),
    // What the dev loop's fake orchestrator gives its agents: the fakes' knobs; quick player polls on top.
    env: { ...agentEnvFrom({ FAKE_AVORION_BOOT_MS: '150', FAKE_AVORION_SAVE_MS: '30' }), GAME_PLAYERS_POLL_MS: '300', GAME_RESTART_DELAY_MS: '60000' },
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
  // `default` (the environment's server) stays a fake; the created server is the orchestrator's, reached for real.
  const feed = new FakeFeed();
  const deps = createPanelDeps({ env, db, agent: fakeAgent(feed), feed, fetch: noNetwork, mods: { pz: [createWorkshopSource({ fetch: noNetwork })] }, downloads: { fetch: noNetwork, env: {} } });
  await bootstrapOwner(deps);
  const app = await buildApp(deps);
  await deps.servers.start();
  const { client: owner } = await ownerReady({ app } as TestPanel);
  rig = { dir, backend, orch, db, deps, app, owner };
}, 60_000 * SCALE);

afterAll(async () => {
  if (!rig) return;
  rig.deps.servers.stop();
  await rig.backend.shutdown();
  await new Promise((r) => rig.orch.close(r));
  await rig.app.close();
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

async function opDone(id: string): Promise<{ ok: boolean | null; error: string | null }> {
  await srv(id).ops.idle();
  const last = srv(id).ops.last();
  return { ok: last?.ok ?? null, error: last?.error ?? null };
}

const state = (id: string) => srv(id).feed.status_?.state;
const running = (id: string) =>
  until(`${id} to run`, async () => {
    if (state(id) !== 'running') return false;
    return (await srv(id).agent.status().catch(() => null))?.state === 'running';
  });
async function agentUp(id: string): Promise<void> {
  await until(`${id}'s agent`, async () => (await srv(id).agent.status().catch(() => null)) !== null);
  if (!srv(id).feed.connected) (srv(id).agent as AgentClient).startStream();
  await until(`${id}'s events`, () => srv(id).feed.connected);
}
const dataDir = (id: string) => path.join(rig.dir, 'orch', id, 'data');
const logs = (id: string) => srv(id).feed.recentLogs().map((e) => (e.event.type === 'log' ? e.event.line : ''));
const shown = (id: string, line: string) => logs(id).some((l) => l.trim() === line);

async function ok(res: { statusCode: number; body: string }, what: string): Promise<void> {
  expect(res.statusCode, `${what}: ${res.body}`).toBe(200);
}

/** A change to a file's text, the way the text editor makes it: a proposal, then its apply. */
async function edit(id: string, fileId: string, text: string) {
  const proposed = await rig.owner.post(url(id, '/config/proposals'), { fileId, text });
  if (proposed.statusCode !== 200) return proposed;
  const { id: pid } = proposed.json() as { id: string | null };
  return pid ? rig.owner.post(url(id, `/config/proposals/${pid}/apply`)) : proposed;
}

const online = async (id: string) => ((await rig.owner.get(url(id, '/players'))).json() as { online: { username: string }[] }).online.map((o) => o.username);

describe('Avorion end to end, from its manifest alone, through the fake orchestrator and the fake server (M6)', () => {
  const id = 'av-one';

  it(
    'is created, installed, started, played, configured, saved, backed up, restored, reset and stopped (SRV-01, SRV-03, UPD-01…03, CFG-04, CFG-05, CFG-08, PLY-01, PLY-03, CON-02, CON-03, BAK-01…04)',
    async () => {
      const { owner } = rig;
      // The ports a person may choose: the game port (its TCP twin follows it) and both query ports.
      const game = await freeBoth();
      const [query, steamquery] = await Promise.all([bindUdp(0), bindUdp(0)]);
      const launch = { branch: 'public', updateOnStart: false, memoryMb: 1024, serverName: 'E2E galaxy', maxPlayers: 4, listed: false, saveInterval: 600 };
      // The manifest's checks answer before anything is made (CFG-01).
      const refused = await owner.post('/api/servers', { id, name: 'Avorion', adapter: 'avorion', launch: { ...launch, serverName: '' }, ports: { game, query, steamquery } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ error: 'invalid-options', field: 'serverName', text: { en: "Server name can't be empty.", es: 'Nombre del servidor no puede quedar vacío.' } });
      expect((await owner.post('/api/servers', { id, name: 'Avorion', adapter: 'avorion', launch, ports: { game, gametcp: game } })).json()).toMatchObject({ error: 'unknown-port', port: 'gametcp' });

      const created = await owner.post('/api/servers', { id, name: 'Avorion', adapter: 'avorion', launch, ports: { game, query, steamquery } });
      await ok(created, 'create');
      expect(rig.deps.serverRows.get(id)!.ports).toEqual({ game, gametcp: game, query, steamquery });
      expect(rig.deps.serverRows.get(id)!.spec!.ports).toEqual([
        { container: game, host: game, proto: 'udp' },
        { container: game, host: game, proto: 'tcp' },
        { container: query, host: query, proto: 'udp' },
        { container: steamquery, host: steamquery, proto: 'udp' },
      ]);
      await agentUp(id);

      // ---- start: installed with steamcmd (the fake's), the galaxy made, running with the game's version.
      await ok(await owner.post(url(id, '/server/start')), 'start');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      await running(id);
      const listed = ((await owner.get('/api/servers')).json() as { id: string; version: string | null; state: string }[]).find((s) => s.id === id)!;
      expect(listed).toMatchObject({ state: 'running', version: '2.5.13' });
      expect(srv(id).feed.status_!.installedInfo).toMatchObject({ version: '2.5.13', channel: 'public', build: '22295362' });
      // The command line the manifest says, crash reports off; the game wrote its galaxy's server.ini itself.
      expect(logs(id).some((l) => l.startsWith('Starting: ') && l.includes(`--port ${game}`) && l.includes('--send-crash-reports false'))).toBe(true);
      expect(shown(id, 'send crash reports: no')).toBe(true);
      expect(existsSync(path.join(dataDir(id), 'avorion-backups'))).toBe(true);
      const ini = () => readFileSync(path.join(dataDir(id), id, 'server.ini'), 'utf8');
      expect(ini()).toMatch(/^sendCrashReports=false$/m);
      expect(ini()).toMatch(new RegExp(`^port=${game}$`, 'm'));
      // Its query port isn't Avorion's default and it isn't listed: the game's warning, said once by the panel too.
      expect(logs(id).filter((l) => l.startsWith('Warning: Avorion warns that players may not be able to join'))).toHaveLength(1);

      // ---- the console: a typed command gets the slash Avorion's console wants (CON-02).
      await ok(await owner.post(url(id, '/server/command'), { command: 'seed' }), 'seed');
      await until('the seed', () => shown(id, 'FakeSeed01'));
      await ok(await owner.post(url(id, '/server/command'), { command: '/version' }), 'version');
      await until('the version', () => shown(id, 'Server Version: 2.5.13 0417ab29738c'));

      // ---- players (PLY-01) and moderation (PLY-03), with what the game's strings say (no client joined in the measurements).
      await ok(await owner.post(url(id, '/server/command'), { command: 'fake-join Bob' }), 'Bob joins');
      await until('Bob online', async () => (await online(id)).includes('Bob'));
      const act = async (p: string, b: unknown) => {
        const r = await owner.post(url(id, p), b);
        return [r.statusCode, r.json()] as const;
      };
      expect(await act('/players/kick', { username: 'Bob', reason: 'afk' })).toEqual([200, { output: 'Bob has been kicked.' }]);
      await until('Bob gone', async () => !(await online(id)).includes('Bob'));
      expect(await act('/players/kick', { username: 'Nobody' })).toEqual([409, { error: 'player-not-online', output: 'Player Nobody is not online.' }]);
      expect(await act('/players/ban', { username: 'Ghost' })).toEqual([404, { error: 'player-not-found', output: 'Player Ghost not found.' }]);
      await ok(await owner.post(url(id, '/server/broadcast'), { message: 'Hola a todos' }), 'broadcast');
      await until('the broadcast', () => shown(id, '<Server> Hola a todos'));

      // ---- settings: the galaxy's files only while it is stopped (the game writes them back from memory).
      const whileRunning = await edit(id, 'server', ini().replace(/^motd=.*$/m, 'motd=Welcome'));
      expect(whileRunning.statusCode).toBe(409);
      expect(whileRunning.json()).toMatchObject({ error: 'config-stopped-only' });

      // ---- a save (SRV-03), then a hot backup (BAK-02): /save, then the galaxy copied.
      await ok(await owner.post(url(id, '/server/save')), 'save');
      const galaxy = path.join(dataDir(id), id);
      mkdirSync(path.join(galaxy, 'players'), { recursive: true });
      writeFileSync(path.join(galaxy, 'players', 'alice.dat'), 'v1');
      const before = logs(id).length;
      await ok(await owner.post(url(id, '/backups')), 'backup');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      const backups = ((await owner.get(url(id, '/backups'))).json() as { backups: { name: string; manifest: { mode: string; parts: string[]; gameVersion: string | null } }[] }).backups;
      expect(backups).toHaveLength(1);
      expect(backups[0]!.manifest).toMatchObject({ mode: 'hot', parts: ['galaxy'], gameVersion: '2.5.13' });
      expect(logs(id).slice(before)).toContain('All sectors saved successfully.');

      // ---- the galaxy changes, then the backup's comes back (BAK-03); the server runs again.
      writeFileSync(path.join(galaxy, 'players', 'alice.dat'), 'v2');
      writeFileSync(path.join(galaxy, 'players', 'mallory.dat'), 'new');
      await ok(await owner.post(url(id, `/backups/${encodeURIComponent(backups[0]!.name)}/restore`), { parts: ['galaxy'] }), 'restore');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      await running(id);
      expect(readFileSync(path.join(galaxy, 'players', 'alice.dat'), 'utf8')).toBe('v1');
      expect(existsSync(path.join(galaxy, 'players', 'mallory.dat'))).toBe(false);
      // From the galaxy's second start on, the game's own backups go to the data volume (never part of the panel's).
      expect(ini()).toMatch(/^backupsPath=.*avorion-backups$/m);
      expect(shown(id, `Backup creation enabled. Path: "${dataDir(id)}/avorion-backups"`)).toBe(true);
      expect(existsSync(path.join(dataDir(id), 'avorion-backups'))).toBe(true);

      // ---- a new galaxy (BAK-04): backed up first, removed, made again at the start with the panel's settings.
      await ok(await owner.post(url(id, '/reset'), { scope: 'factory', confirm: id }), 'reset');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      await running(id);
      expect(existsSync(path.join(galaxy, 'players', 'alice.dat'))).toBe(false);
      expect(ini()).toMatch(/^sendCrashReports=false$/m);
      expect(((await owner.get(url(id, '/backups'))).json() as { backups: { manifest: { trigger: string } }[] }).backups.map((b) => b.manifest.trigger)).toEqual(expect.arrayContaining(['pre-restore', 'pre-reset', 'manual']));

      // ---- stop (NFR-04): /stop, which saves; the shutdown line, then stopped.
      await ok(await owner.post(url(id, '/server/stop'), {}), 'stop');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      await until(`${id} to stop`, () => state(id) === 'stopped');
      expect(shown(id, 'Server shutdown successful.')).toBe(true);

      // ---- stopped: server.ini can be edited; the agent's keys are put back, the rest kept, the join password hidden (CFG-04, CFG-08).
      const edited = ini().replace(/^motd=.*$/m, 'motd=Welcome').replace(/^sendCrashReports=false$/m, 'sendCrashReports=true').replace(/^password=.*$/m, 'password=hunter22');
      await ok(await edit(id, 'server', edited), 'edit while stopped');
      expect(ini()).toMatch(/^motd=Welcome$/m);
      expect(ini()).toMatch(/^sendCrashReports=false$/m);
      expect(ini()).toMatch(/^password=hunter22$/m);
      const content = (await owner.get(url(id, '/config/files/content?id=server'))).json() as { text: string };
      expect(content.text).toMatch(new RegExp(`^password=${MASK}$`, 'm'));
      expect(content.text).not.toContain('hunter22');
    },
    300_000 * SCALE,
  );
});
