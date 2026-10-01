// Valheim end to end (M6: "Valheim runs via manifest plus hooks"), without
// Docker: the panel as main.ts builds it, the real orchestrator API in front
// of the fake orchestrator's backend (each "container" a local agent
// process), the adapter made from packages/adapter-valheim/manifest plus its
// hooks, and tools/fake-valheim with its fake steamcmd. A public server's
// password rules refused before anything is made; created with its query
// port following the game port; banned, allowed and made admin by SteamID
// while stopped; installed, started, running with its version; players from
// the join and leave lines; a hot backup taken in the middle of an autosave
// holding exactly the newest complete save set; stopped; the world restored;
// the world reset, then everything.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import dgram from 'node:dgram';
import type http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTarZst, unpack } from '@gsp/archive';
import { createWorkshopSource } from '@gsp/adapter-pz/panel/core';
import { createOrchestratorServer, listenOnSocket, type Policy } from '@gsp/orchestrator';
import type { FastifyInstance } from 'fastify';
import { agentEnvFrom, FakeBackend } from '../../../tools/fake-orchestrator/backend';
import type { AgentClient } from '../src/agent/client';
import { buildApp } from '../src/app';
import { bootstrapOwner } from '../src/auth/bootstrap';
import { openDb, type Db } from '../src/db/db';
import type { PanelEnv } from '../src/env';
import type { Deps } from '../src/http/deps';
import type { ServerContext } from '../src/servers/context';
import { createPanelDeps } from '../src/wiring';
import { FakeFeed, fakeAgent, noNetwork, ORIGIN, OWNER, ownerReady, type Client, type TestPanel } from './harness';

const SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const WAIT_MS = 60_000 * SCALE;
const ORCH_TOKEN = `e2e-orch-${randomBytes(16).toString('hex')}`;
/** Windows can't deliver SIGINT to a child that handles it: there the fake is killed by the stop instead of saving. */
const SIGNALS = process.platform !== 'win32';

/** SteamIDs as the scrubber writes them (no real player's). */
const BANNED = '76561198000000002';
const ALLOWED = '76561198000000003';
const ADMIN = '76561198000000004';
const VISITOR = '76561198000000005';

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

/** A free UDP port whose next one is free too: Valheim's query port is its game port + 1. */
async function freePair(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const p = await bindUdp(0);
    if (p && p < 65535 && (await bindUdp(p + 1))) return p;
  }
  throw new Error('no free pair of UDP ports');
}

const socketPath = () => (process.platform === 'win32' ? `\\\\.\\pipe\\gsp-test-vh-e2e-${process.pid}-${randomBytes(4).toString('hex')}` : path.join(os.tmpdir(), `gsp-vh-e2e-${process.pid}-${randomBytes(4).toString('hex')}.sock`));

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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-vh-e2e-'));
  const policy: Policy = { hostPorts: [[1024, 65535]], maxMemMb: 16_384, maxServers: 5, allowFake: true };
  const backend = new FakeBackend({
    stateDir: path.join(dir, 'orch'),
    policy,
    agentPorts: await freeTcp(3),
    controlPorts: await freeTcp(6),
    // The fakes' knobs: a quick boot and stop, and an autosave every 1.2 s (the 60-second minimum, 20 ms a second).
    env: { ...agentEnvFrom({ FAKE_VALHEIM_BOOT_MS: '150', FAKE_VALHEIM_GEN_MS: '100', FAKE_VALHEIM_STOP_MS: '50', FAKE_VALHEIM_SAVE_MS_PER_S: '20' }), GAME_PLAYERS_POLL_MS: '300', GAME_RESTART_DELAY_MS: '60000' },
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
const worldFiles = (id: string) => readdirSync(path.join(dataDir(id), 'worlds_local', id)).sort();
const logs = (id: string) => srv(id).feed.recentLogs().map((e) => (e.event.type === 'log' ? e.event.line : ''));
/** The game's own lines since `from`, without Valheim's timestamp. */
const gameLines = (id: string, from = 0) => logs(id).slice(from).map((l) => l.trim());
/** A test hook of the fake on the game's stdin (the agent takes it; the panel has no console to send it with). */
const hook = (id: string, line: string) => srv(id).agent.command(line, 'stdin');

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
const listFile = (id: string, f: string) => readFileSync(path.join(dataDir(id), f), 'utf8');

/** Every file entry of a backup archive (`data/…` paths), its manifest left out. */
async function archiveFiles(id: string, name: string): Promise<string[]> {
  const out: string[] = [];
  await unpack(readTarZst(path.join(rig.dir, 'backups', id, name)), async (e) => {
    if (e.type === 'file' && e.name !== 'manifest.json') out.push(e.name);
    return null;
  });
  return out.sort();
}
const set = (world: string, n: number) => [`00_00__0_${n}.chunk`, `_main.${n}.chunks`, `_main.${n}.db2`, `_main.${n}.fwl2`, `_main.${n}.ok`].map((f) => `data/worlds_local/${world}/${f}`);
const LISTS = ['data/adminlist.txt', 'data/bannedlist.txt', 'data/permittedlist.txt'];

describe('Valheim end to end, a manifest plus hooks, through the fake orchestrator and the fake server (M6)', () => {
  const id = 'vh-one';

  it(
    'is refused, created, moderated, installed, started, backed up during an autosave, stopped, restored and reset (SRV-01, SRV-03, UPD-01…03, CFG-01, PLY-01, PLY-03, BAK-01…04, Q15)',
    async () => {
      const { owner } = rig;
      const game = await freePair();
      const launch = { branch: 'public', updateOnStart: false, memoryMb: 2048, serverName: 'E2E longship', password: 'hunter22', public: false, crossplay: false, saveInterval: 60 };
      const create = (l: Record<string, unknown>, ports: Record<string, number> = { game }) => owner.post('/api/servers', { id, name: 'Valheim', adapter: 'valheim', launch: l, ports });

      // ---- Q15: a server in the public list needs a password of at least 5 characters that isn't part of its name,
      // refused before anything is made (Valheim itself would exit 36 s into a start).
      const short = await create({ ...launch, public: true, password: 'abcd' });
      expect(short.statusCode).toBe(400);
      expect(short.json()).toMatchObject({
        error: 'invalid-options',
        field: 'password',
        text: { en: 'A server in the public list needs a password of at least 5 characters: Valheim refuses to start otherwise.', es: 'Un servidor de la lista pública necesita una contraseña de al menos 5 caracteres: si no, Valheim no arranca.' },
      });
      expect((await create({ ...launch, public: true, password: '' })).json()).toMatchObject({ error: 'invalid-options', field: 'password' });
      const inName = await create({ ...launch, public: true, password: 'Longship' });
      expect(inName.statusCode).toBe(400);
      expect(inName.json()).toMatchObject({ error: 'invalid-options', field: 'password', text: { en: expect.stringMatching(/part of its name/), es: expect.stringMatching(/forme parte de su nombre/) } });
      // The query port follows the game port: never asked for.
      expect((await create(launch, { game, query: game + 1 })).json()).toMatchObject({ error: 'unknown-port', port: 'query' });
      expect(rig.deps.serverRows.get(id)).toBeNull();

      await ok(await create(launch), 'create');
      expect(rig.deps.serverRows.get(id)!.ports).toEqual({ game, query: game + 1 });
      expect(rig.deps.serverRows.get(id)!.spec!.ports).toEqual([
        { container: game, host: game, proto: 'udp' },
        { container: game + 1, host: game + 1, proto: 'udp' },
      ]);
      await agentUp(id);

      // ---- PLY-03: banned, allowed and made admin by SteamID in the game's lists, while it is stopped.
      await ok(await owner.post(url(id, '/players/ban'), { steamId: BANNED }), 'ban');
      await ok(await owner.post(url(id, '/players/whitelist'), { username: ALLOWED }), 'allow');
      await ok(await owner.post(url(id, '/players/access'), { username: ADMIN, level: 'admin' }), 'admin');
      expect((await owner.post(url(id, '/players/ban'), { username: 'bob' })).statusCode).toBe(400);
      expect(listFile(id, 'bannedlist.txt')).toBe(`${BANNED}\n`);
      expect(listFile(id, 'permittedlist.txt')).toBe(`${ALLOWED}\n`);
      expect(listFile(id, 'adminlist.txt')).toBe(`${ADMIN}\n`);
      // The allowed list stops being everyone's: only ALLOWED may join now. Take it back off.
      await ok(await owner.req('DELETE', url(id, `/players/whitelist/${ALLOWED}`)), 'disallow');
      expect(listFile(id, 'permittedlist.txt').trim()).toBe('');
      expect(((await owner.get(url(id, '/players'))).json() as { whitelist: unknown }).whitelist).toEqual({ enabled: false, usernames: [] });

      // ---- start: installed with steamcmd (the fake's), a new world generated, running with the game's version.
      await ok(await owner.post(url(id, '/server/start')), 'start');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      await running(id);
      const listed = ((await owner.get('/api/servers')).json() as { id: string; version: string | null; state: string }[]).find((s) => s.id === id)!;
      expect(listed).toMatchObject({ state: 'running', version: '1.0.16' });
      expect(srv(id).feed.status_!.installedInfo).toMatchObject({ version: '1.0.16', channel: 'public', build: '25527701' });
      // The measured command line, the password never in the log.
      const starting = logs(id).find((l) => l.startsWith('Starting: '))!;
      expect(starting).toContain(`-port ${game}`);
      expect(starting).toContain(`-world ${id}`);
      expect(starting).toContain('-public 0');
      expect(starting).toContain('-saveinterval 60');
      expect(starting).not.toContain('-crossplay');
      expect(logs(id).some((l) => l.includes('hunter22'))).toBe(false);
      expect(gameLines(id)).toContain('Opened Steam server');
      expect(gameLines(id)).toContain('Generating the world: placing its locations');
      // The game kept the lists the panel wrote before its first start.
      expect(listFile(id, 'bannedlist.txt')).toBe(`${BANNED}\n`);

      // ---- running: the lists aren't changed, by moderation or the editor (stopped-only).
      expect((await owner.post(url(id, '/players/ban'), { steamId: VISITOR })).json()).toMatchObject({ error: 'server-running' });
      expect((await edit(id, 'banned', `${BANNED}\n${VISITOR}\n`)).json()).toMatchObject({ error: 'config-stopped-only' });

      // ---- PLY-01: a private server's players from the join and leave lines (the fake's test hooks; no client joined in the measurements).
      await hook(id, `fake-join ${VISITOR}`);
      await until('the visitor online', async () => (await online(id)).includes(VISITOR));
      await hook(id, `fake-join ${BANNED}`);
      await until('the banned player turned away', () => gameLines(id).includes(`Peer ${BANNED} is blacklisted or not in whitelist.`));
      expect(await online(id)).toEqual([VISITOR]);
      await hook(id, `fake-leave ${VISITOR}`);
      await until('the visitor gone', async () => (await online(id)).length === 0);

      // ---- BAK-02: a hot backup in the middle of an autosave holds exactly the newest complete save set.
      await until('a first autosave', () => gameLines(id).some((l) => /^World save \(5\/5\) done/.test(l)));
      await hook(id, 'fake-hold-save');
      const count = (re: RegExp) => gameLines(id).filter((l) => re.test(l)).length;
      await until('an autosave half written', () => count(/^World save \(2\/5\) /) > count(/^World save \(5\/5\) done/));
      const inProgress = Number(/=> Save number (\d+)$/.exec(gameLines(id).findLast((l) => /=> Save number \d+$/.test(l))!)![1]);
      const complete = inProgress - 1;
      // On disk: the complete set, and the new one's chunk files without its marker.
      expect(worldFiles(id)).toEqual([...set(id, complete), ...set(id, inProgress).slice(0, 2)].map((f) => f.split('/').pop()!).sort());
      await ok(await owner.post(url(id, '/backups')), 'backup');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      await hook(id, 'fake-release-save');
      const backups = ((await owner.get(url(id, '/backups'))).json() as { backups: { name: string; manifest: { mode: string; parts: string[]; gameVersion: string | null } }[] }).backups;
      expect(backups).toHaveLength(1);
      expect(backups[0]!.manifest).toMatchObject({ mode: 'hot', parts: ['world', 'lists'], gameVersion: '1.0.16' });
      expect(await archiveFiles(id, backups[0]!.name)).toEqual([...LISTS, ...set(id, complete)].sort());
      await until('the autosave finished', () => count(/^World save \(5\/5\) done/) >= inProgress);

      // ---- stop (SRV-03, NFR-04): SIGINT, which saves first (where signals reach the fake).
      const beforeStop = logs(id).length;
      await ok(await owner.post(url(id, '/server/stop'), {}), 'stop');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      await until(`${id} to stop`, () => state(id) === 'stopped');
      if (SIGNALS) {
        expect(gameLines(id, beforeStop)).toContain('Game - OnApplicationQuit');
        expect(gameLines(id, beforeStop).some((l) => /^World save \(5\/5\) done/.test(l))).toBe(true);
      }
      expect(worldFiles(id).filter((f) => f.endsWith('.ok'))).toHaveLength(1);

      // ---- restore (BAK-03): the world as the backup held it, the next start loads that save.
      await ok(await owner.post(url(id, `/backups/${encodeURIComponent(backups[0]!.name)}/restore`), { parts: ['world'] }), 'restore');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      expect(worldFiles(id)).toEqual(set(id, complete).map((f) => f.split('/').pop()!).sort());
      const beforeStart = logs(id).length;
      await ok(await owner.post(url(id, '/server/start')), 'start again');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      await running(id);
      expect(gameLines(id, beforeStart)).toContain(`ZNet.LoadWorld: ${id} (${id}), save number ${complete}`);

      // ---- a new world (BAK-04): backed up first, the world gone, made again at the start; the lists stay.
      const beforeReset = logs(id).length;
      await ok(await owner.post(url(id, '/reset'), { scope: 'world', confirm: id }), 'reset world');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      await running(id);
      expect(gameLines(id, beforeReset)).toContain(`Load world: ${id} (${id})`);
      expect(listFile(id, 'bannedlist.txt')).toBe(`${BANNED}\n`);
      // ---- and everything: the lists go too, and the game writes its own again.
      await ok(await owner.post(url(id, '/reset'), { scope: 'factory', confirm: id }), 'factory reset');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      await running(id);
      expect(listFile(id, 'bannedlist.txt')).toBe('// List banned players ID  ONE per line\n');
      expect(((await owner.get(url(id, '/backups'))).json() as { backups: { manifest: { trigger: string } }[] }).backups.map((b) => b.manifest.trigger)).toEqual(expect.arrayContaining(['pre-restore', 'pre-reset', 'manual']));

      // ---- stopped again; while stopped, the lists are the editor's.
      await ok(await owner.post(url(id, '/server/stop'), {}), 'stop again');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      await until(`${id} to stop again`, () => state(id) === 'stopped');
      await ok(await edit(id, 'banned', `// List banned players ID  ONE per line\n${VISITOR}\n`), 'edit while stopped');
      expect(((await owner.get(url(id, '/players'))).json() as { bans: { steamIds: { steamId: string }[] } }).bans.steamIds.map((b) => b.steamId)).toEqual([VISITOR]);
      expect(existsSync(path.join(dataDir(id), 'worlds_local', 'DevWorld'))).toBe(false);
    },
    300_000 * SCALE,
  );
});
