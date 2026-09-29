// Terraria end to end (M5 phase 3), without Docker: the panel as main.ts
// builds it (the orchestrator client over its socket, each server's agent
// client and its files through that agent), the real orchestrator API in
// front of the fake orchestrator's backend (each "container" a local agent
// process), the Terraria adapter running the fake server, and installs from
// the fake download services. For each flavour: create, start (the world
// created), running with its version, a settings change (a managed key
// refused, a restart pending), moderation against the game (TShock through
// its REST API, vanilla's and tModLoader's IP bans on the console), a hot
// backup, a restore of the world, a world reset. TShock's plugins (uploaded
// and from a release link the agent downloads, loaded, disabled, gone) and
// tModLoader's Workshop mods (downloaded with the agent's steamcmd, loaded).
// Then a Terraria and a Project Zomboid server side by side, each with its
// own schedule.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import dgram from 'node:dgram';
import type http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkshopSource } from '@gsp/adapter-pz/panel/core';
import { createTmlWorkshopSource } from '@gsp/adapter-terraria/panel';
import { createOrchestratorServer, listenOnSocket, type Policy } from '@gsp/orchestrator';
import type { FastifyInstance } from 'fastify';
import { agentEnvFrom, FakeBackend } from '../../../tools/fake-orchestrator/backend';
import { fakeAssembly, fakePlugin, makeZip, startFakeDownloads, type FakeDownloads } from '../../../tools/fake-terraria/downloads.mjs';
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

/** Steam's Workshop API for tModLoader's items (the panel asks it for titles and update times; the agent downloads with steamcmd). */
const steamWorkshop = (async (_url: string, init?: { body?: URLSearchParams }) => {
  const ids = [...(init!.body as URLSearchParams).entries()].filter(([k]) => k.startsWith('publishedfileids')).map(([, v]) => v);
  return new Response(JSON.stringify({ response: { publishedfiledetails: ids.map((id) => ({ publishedfileid: id, result: 1, title: `Item ${id}`, consumer_app_id: 1281930, time_updated: 1788581217, file_size: 1356461, hcontent_file: 'x' })) } }));
}) as unknown as typeof fetch;

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

const socketPath = () => (process.platform === 'win32' ? `\\\\.\\pipe\\gsp-test-tr-e2e-${process.pid}-${randomBytes(4).toString('hex')}` : path.join(os.tmpdir(), `gsp-tr-e2e-${process.pid}-${randomBytes(4).toString('hex')}.sock`));

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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-tr-e2e-'));
  const downloads = await startFakeDownloads({ fail: '' });
  // The release host plugin links may point at is the fake too (MOD-06).
  const downloadEnv = { GAME_TERRARIA_ORG_URL: downloads.url, GAME_TERRARIA_GITHUB_URL: downloads.url, GAME_TERRARIA_RELEASES_URL: downloads.url };
  const policy: Policy = { hostPorts: [[1024, 65535]], maxMemMb: 16_384, maxServers: 5, allowFake: true };
  const backend = new FakeBackend({
    stateDir: path.join(dir, 'orch'),
    policy,
    agentPorts: await freeTcp(5),
    controlPorts: await freeTcp(10),
    // What the dev loop's fake orchestrator gives its agents (tools/fake-orchestrator/main.ts, scripts/dev.mjs):
    // the download services and the fakes' knobs; quick player polls on top.
    env: { ...agentEnvFrom({ ...downloadEnv, FAKE_TERRARIA_BOOT_MS: '200', FAKE_PZ_BOOT_MS: '200', FAKE_TML_MOD_NAMES: '2619954303=RecipeBrowser' }), GAME_PLAYERS_POLL_MS: '300', GAME_RESTART_DELAY_MS: '60000' },
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
  const deps = createPanelDeps({ env, db, agent: fakeAgent(feed), feed, fetch: noNetwork, mods: { pz: [createWorkshopSource({ fetch: noNetwork })], terraria: [createTmlWorkshopSource({ fetch: steamWorkshop })] }, downloads: { fetch, env: downloadEnv } });
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
/** Running, as the panel's mirror and the agent both say (the console is the only channel, so there is none to wait for). */
const running = (id: string) =>
  until(`${id} to run`, async () => {
    if (state(id) !== 'running') return false;
    return (await srv(id).agent.status().catch(() => null))?.state === 'running';
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

const online = async (id: string) => ((await rig.owner.get(url(id, '/players'))).json() as { online: { username: string }[] }).online.map((o) => o.username);
/** A player the fake server lets in (its test hook on the console). */
async function join(id: string, name: string): Promise<void> {
  await ok(await rig.owner.post(url(id, '/server/command'), { command: `fake-join ${name}` }), `${name} joins`);
  await until(`${name} to show up`, async () => (await online(id)).includes(name));
}

const FLAVOURS = [
  { flavour: 'vanilla', version: '1.4.5.8', parts: ['world', 'settings'], saved: 'Backing up world file' },
  { flavour: 'tshock', version: '1.4.5.8', parts: ['world', 'settings', 'database'], saved: 'Backing up world file' },
  { flavour: 'tmodloader', version: '1.4.4.9', parts: ['world', 'settings', 'mods'], saved: 'Saving modded world data' },
] as const;

describe('Terraria end to end, through the fake orchestrator and the fake server (M5)', () => {
  for (const f of FLAVOURS) {
    const id = `tr-${f.flavour}`;
    it(
      `${f.flavour}: created, started with a new world, configured, moderated, backed up, restored and reset (SRV-01, UPD-01, UPD-02, CFG-04, CFG-05, PLY-01, PLY-03, CON-04, BAK-02, BAK-03, BAK-04)`,
      async () => {
        const { owner } = rig;
        const [game] = await freeTcp(1);
        const launch = { version: '', channel: 'stable', worldSize: 1, maxPlayers: 8, password: 'join-us-2026', memoryMb: 1024 };
        await ok(await owner.post('/api/servers', { id, name: `Terraria ${f.flavour}`, adapter: 'terraria', flavour: f.flavour, launch, ports: { game } }), 'create');
        await agentUp(id);

        // ---- start: installed from the fake download services, a new world created, then running with its version.
        await ok(await owner.post(url(id, '/server/start')), 'start');
        expect(await opDone(id)).toEqual({ ok: true, error: null });
        await running(id);
        const listed = ((await owner.get('/api/servers')).json() as { id: string; version: string | null; state: string }[]).find((s) => s.id === id)!;
        expect(listed).toMatchObject({ state: 'running', version: f.version });
        expect(srv(id).feed.status_!.installedInfo).toMatchObject({ version: f.version, channel: f.flavour });
        expect(logs(id).some((l) => l.startsWith('Creating world - Seed:'))).toBe(true);
        expect(existsSync(path.join(dataDir(id), 'Worlds', `${id}.wld`))).toBe(true);
        // The agent wrote the managed keys and the password; the password shows in no log line.
        const cfg = readFileSync(path.join(dataDir(id), 'serverconfig.txt'), 'utf8');
        expect(cfg).toMatch(/^language=en-US$/m);
        expect(cfg).toMatch(/^password=join-us-2026$/m);
        expect(logs(id).join('\n')).not.toContain('join-us-2026');

        // ---- a settings change: a managed key is refused, the rest waits for a restart (CFG-04, CFG-05).
        expect((await formChange(id, 'serverconfig', { port: 1234 })).json()).toMatchObject({ error: 'invalid-options', fields: { port: 'managed' } });
        expect(((await owner.get(url(id, '/config/values?id=serverconfig'))).json() as { values: Record<string, string> }).values.password).toBe(MASK);
        const changed = (await formChange(id, 'serverconfig', { motd: `E2E ${f.flavour}`, difficulty: 1 })).json() as { applied: string; restartNeeded: boolean };
        expect(changed).toMatchObject({ applied: 'next-start', restartNeeded: true });
        expect((await owner.get(url(id, '/config/pending'))).json()).toMatchObject({ reasons: ['serverconfig'] });
        if (f.flavour === 'tshock') {
          // TShock's REST token stays hidden in its config (CON-04).
          const tshock = ((await owner.get(url(id, '/config/values?id=tshock-config'))).json() as { values: Record<string, unknown> }).values;
          expect(tshock).toMatchObject({ 'Settings.ApplicationRestTokens': MASK, 'Settings.RestApiEnabled': true });
          expect(JSON.stringify(tshock)).not.toMatch(/gameserver-panel/);
        }

        // ---- players against the fake game (PLY-01, PLY-03).
        const act = async (p: string, b: unknown) => {
          const r = await owner.post(url(id, p), b);
          return [r.statusCode, r.json()] as const;
        };
        await join(id, 'gspffbob');
        if (f.flavour === 'tshock') {
          // TShock through its REST API: kick with a reason, bans by name, address, UUID or account, listed and lifted.
          expect(await act('/players/kick', { username: 'gspffbob', reason: 'afk' })).toEqual([200, { output: 'Player gspffbob was kicked' }]);
          await until('gspffbob to leave', async () => !(await online(id)).includes('gspffbob'));
          expect(await act('/players/ban', { username: 'gspffcarol', reason: 'griefing' })).toEqual([200, { output: expect.stringMatching(/^Banned name:gspffcarol \(ticket \d+\)$/) }]);
          expect(await act('/players/ban', { ip: '203.0.113.7' })).toEqual([200, { output: expect.stringMatching(/^Banned ip:203\.0\.113\.7/) }]);
          expect((await act('/players/ban', { account: 'Rick' }))[0]).toBe(200);
          expect(((await owner.get(url(id, '/players'))).json() as { bans: unknown }).bans).toMatchObject({
            usernames: [{ username: 'gspffcarol', reason: 'griefing' }],
            ips: [{ ip: '203.0.113.7' }],
            accounts: [{ account: 'Rick' }],
          });
          expect(await act('/players/ban', { username: 'gspffcarol' })).toEqual([409, { error: 'already-banned', output: expect.stringMatching(/^\(no-change\) Already banned/) }]);
          expect(await act('/players/unban', { username: 'gspffcarol' })).toEqual([200, { output: expect.stringMatching(/^Lifted ticket \d+$/) }]);
          expect(await act('/players/kick', { username: 'nobody' })).toEqual([409, { error: 'player-not-online', output: expect.stringMatching(/was not found/) }]);
          // A banned address is turned away at the door.
          await ok(await owner.post(url(id, '/players/ban'), { ip: '192.0.2.1' }), 'ban the address everyone arrives from');
          await ok(await owner.post(url(id, '/server/command'), { command: 'fake-join gspffdave' }), 'gspffdave tries');
          await until('gspffdave to be turned away', () => logs(id).some((l) => /was booted: #\d+ - You are banned: Banned$/.test(l)));
          await ok(await owner.post(url(id, '/players/unban'), { ip: '192.0.2.1' }), 'lift it');
          // Messages go through the REST API too.
          await ok(await owner.post(url(id, '/server/broadcast'), { message: 'Hola a todos' }), 'broadcast');
          await until('the broadcast', () => logs(id).includes('(Server Broadcast) Hola a todos'));
        } else {
          // The console's kick and ban: a ban is the player's address (every player's, behind Docker Desktop).
          expect(await act('/players/kick', { username: 'gspffbob', reason: 'afk' })).toEqual([200, { output: 'Kicked gspffbob' }]);
          await join(id, 'gspffcarol');
          expect(await act('/players/ban', { username: 'gspffcarol' })).toEqual([200, { output: 'Banned gspffcarol (address 192.0.2.1)' }]);
          expect(await act('/players/kick', { username: 'nobody' })).toEqual([409, { error: 'player-not-online', output: '(player-not-online) nobody is not online' }]);
          expect(((await owner.get(url(id, '/players'))).json() as { bans: unknown }).bans).toEqual({ steamIds: [], ips: [{ ip: '192.0.2.1', username: 'gspffcarol', reason: null }] });
          // Everyone arrives from that address: the next player is turned away.
          await ok(await owner.post(url(id, '/server/command'), { command: 'fake-join gspffdave' }), 'gspffdave tries');
          await until('gspffdave to be turned away', () => logs(id).some((l) => /was booted: You are banned from this server\.$/.test(l)));
          // The ban list is the game's memory: lifted only once it is stopped (below).
          expect(await act('/players/unban', { ip: '192.0.2.1' })).toEqual([409, { error: 'server-running' }]);
          await ok(await owner.post(url(id, '/server/broadcast'), { message: 'Hola a todos' }), 'broadcast');
          await until('the broadcast', () => logs(id).includes('<Server> Hola a todos'));
        }

        // ---- a hot backup (BAK-02): save, then copy.
        const before = logs(id).length;
        await ok(await owner.post(url(id, '/backups')), 'backup');
        expect(await opDone(id)).toEqual({ ok: true, error: null });
        const backups = ((await owner.get(url(id, '/backups'))).json() as { backups: { name: string; manifest: { mode: string; parts: string[]; gameVersion: string | null } }[] }).backups;
        expect(backups).toHaveLength(1);
        expect(backups[0]!.manifest).toMatchObject({ mode: 'hot', parts: [...f.parts], gameVersion: f.version });
        expect(logs(id).slice(before)).toContain(f.saved);
        const worldFile = path.join(dataDir(id), 'Worlds', `${id}.wld`);
        const backedUp = readFileSync(worldFile, 'utf8');

        // ---- the world changes (another save), then the backup's world comes back (BAK-03); the server runs again.
        await new Promise((r) => setTimeout(r, 20));
        await ok(await owner.post(url(id, '/server/save')), 'save');
        expect(readFileSync(worldFile, 'utf8')).not.toBe(backedUp);
        await ok(await owner.post(url(id, `/backups/${encodeURIComponent(backups[0]!.name)}/restore`), { parts: ['world'] }), 'restore');
        expect(await opDone(id)).toEqual({ ok: true, error: null });
        await running(id);
        expect(readFileSync(worldFile, 'utf8')).toBe(backedUp);
        // The restart took the pending settings.
        expect((await owner.get(url(id, '/config/pending'))).json()).toBeNull();

        // ---- a new world (BAK-04): backed up first, deleted, a new random seed, created again at the start.
        const beforeReset = logs(id).length;
        await ok(await owner.post(url(id, '/reset'), { scope: 'world', confirm: id, newSeed: true }), 'reset');
        expect(await opDone(id)).toEqual({ ok: true, error: null });
        await running(id);
        const seed = /^seed=(\d+)$/m.exec(readFileSync(path.join(dataDir(id), 'serverconfig.txt'), 'utf8'))?.[1];
        expect(seed).toBeDefined();
        expect(logs(id).slice(beforeReset).some((l) => l.startsWith(`Creating world - Seed: ${seed},`) && l.endsWith(f.flavour === 'tmodloader' ? 'IsExpert: False' : 'Difficulty: 1'))).toBe(true);
        expect(((await owner.get(url(id, '/backups'))).json() as { backups: { manifest: { trigger: string } }[] }).backups.map((b) => b.manifest.trigger)).toEqual(expect.arrayContaining(['pre-restore', 'pre-reset', 'manual']));

        await ok(await owner.post(url(id, '/server/stop'), {}), 'stop');
        expect(await opDone(id)).toEqual({ ok: true, error: null });
        await until(`${id} to stop`, () => state(id) === 'stopped');
        if (f.flavour !== 'tshock') {
          // Stopped: the ban comes off the ban list, which the history keeps.
          expect(await act('/players/unban', { ip: '192.0.2.1' })).toEqual([200, { output: 'Lifted the ban on 192.0.2.1 (gspffcarol)' }]);
          expect(readFileSync(path.join(dataDir(id), 'banlist.txt'), 'utf8')).not.toContain('192.0.2.1');
        }
      },
      300_000 * SCALE,
    );
  }

  it(
    "TShock's plugins: uploaded and from a release link, downloaded by the server's agent, loaded at the start, disabled and gone after a restart (MOD-06, D11)",
    async () => {
      const id = 'tr-tshock';
      const { owner, app } = rig;
      const upload = (filename: string, data: Buffer) => {
        const boundary = '----gspe2e';
        return app.inject({
          method: 'POST',
          url: url(id, '/plugins/upload'),
          headers: { origin: ORIGIN, cookie: `__Host-gspsid=${owner.cookie}`, 'x-gsp-csrf': owner.csrf!, 'content-type': `multipart/form-data; boundary=${boundary}` },
          payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]),
        });
      };
      const release = `${rig.downloads.url}/gspff/HelloPlugin/releases/download/v1.0.0`;
      const listed = async () => ((await owner.get(url(id, '/plugins'))).json() as { plugins: { name: string; enabled: boolean; active: boolean }[] }).plugins.map((p) => [p.name, p.enabled, p.active]);

      // A zip upload (a plugin, an assembly that is none, a readme), then the plugin again from its release link.
      const zip = makeZip([{ name: 'ServerPlugins/HelloPlugin.dll', data: fakePlugin('HelloPlugin', '1.1.0') }, { name: 'ServerPlugins/HelloLib.dll', data: fakeAssembly('HelloLib') }, { name: 'README.md', data: '# hi' }]);
      const up = await upload('hello-1.1.zip', zip);
      expect(up.statusCode, up.body).toBe(200);
      expect(up.json()).toMatchObject({ skipped: ['README.md'], restartNeeded: false });
      const linked = await owner.post(url(id, '/plugins'), { url: `${release}/HelloPlugin.dll` });
      expect(linked.statusCode, linked.body).toBe(200);
      expect(linked.json()).toMatchObject({ added: [{ name: 'HelloPlugin.dll', origin: { from: { url: `${release}/HelloPlugin.dll` } } }], replaced: ['HelloPlugin.dll'] });
      // The agent refuses what the panel can't see: a redirect elsewhere, a zip with a path outside its folder.
      expect((await owner.post(url(id, '/plugins'), { url: `${release}/Elsewhere.dll` })).json()).toMatchObject({ error: 'plugin-refused', reason: 'redirect-refused' });
      expect((await owner.post(url(id, '/plugins'), { url: `${release}/Escape.zip` })).json()).toMatchObject({ error: 'plugin-refused', reason: 'bad-archive' });
      expect(existsSync(path.join(dataDir(id), '..', 'Escape.dll'))).toBe(false);
      expect(await listed()).toEqual([
        ['HelloLib.dll', true, false],
        ['HelloPlugin.dll', true, false],
      ]);

      // Loaded at the start: TShock says so for the plugin, nothing for the assembly that is none.
      const before = logs(id).length;
      await ok(await owner.post(url(id, '/server/start')), 'start');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      await running(id);
      const initiated = () => logs(id).filter((l) => l.startsWith('[Server API] Info Plugin '));
      expect(logs(id).slice(before).filter((l) => l.startsWith('[Server API] Info Plugin '))).toEqual(['[Server API] Info Plugin TShock v6.2.1.0 (by The TShock Team) initiated.', '[Server API] Info Plugin HelloPlugin v1.0.0 (by gspff) initiated.']);
      expect(await listed()).toEqual([
        ['HelloLib.dll', true, true],
        ['HelloPlugin.dll', true, true],
      ]);
      // A backup holds them.
      await ok(await owner.post(url(id, '/backups')), 'backup');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      const newest = ((await owner.get(url(id, '/backups'))).json() as { backups: { manifest: { parts: string[]; createdAt: string } }[] }).backups.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt))[0]!;
      expect(newest.manifest.parts).toContain('plugins');

      // Disabled: the badge until the restart, then TShock no longer loads it.
      expect((await owner.req('PUT', url(id, '/plugins/HelloPlugin.dll'), { enabled: false })).json()).toEqual({ changed: true, restartNeeded: true });
      expect((await owner.get(url(id, '/config/pending'))).json()).toMatchObject({ reasons: expect.arrayContaining(['Plugins']) });
      expect(await listed()).toContainEqual(['HelloPlugin.dll', false, true]);
      const beforeRestart = initiated().length;
      await ok(await owner.post(url(id, '/server/restart'), {}), 'restart');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      await running(id);
      expect(initiated().slice(beforeRestart)).toEqual(['[Server API] Info Plugin TShock v6.2.1.0 (by The TShock Team) initiated.']);
      expect(await listed()).toEqual([
        ['HelloLib.dll', true, true],
        ['HelloPlugin.dll', false, false],
      ]);
      expect((await owner.req('DELETE', url(id, '/plugins/HelloPlugin.dll'))).statusCode).toBe(200);
      expect(await listed()).toEqual([['HelloLib.dll', true, true]]);
      // Who added what, and what was refused.
      const added = rig.deps.audit.list({ action: 'plugins.add', serverId: id });
      expect(added.map((e) => [e.username, e.ok])).toEqual([
        [OWNER.username, false],
        [OWNER.username, false],
        [OWNER.username, true],
        [OWNER.username, true],
      ]);
      expect(JSON.parse(added[2]!.detail!)).toMatchObject({ from: { url: `${release}/HelloPlugin.dll` }, added: [{ name: 'HelloPlugin.dll', size: fakePlugin('HelloPlugin').length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }] });

      await ok(await owner.post(url(id, '/server/stop'), {}), 'stop');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
    },
    180_000 * SCALE,
  );

  it(
    "tModLoader's Workshop mods: added by link, downloaded with the agent's steamcmd, enabled, loaded at the start (MOD-03)",
    async () => {
      const id = 'tr-tmodloader';
      const { owner } = rig;
      const add = await owner.post(url(id, '/mods'), { refs: ['https://steamcommunity.com/sharedfiles/filedetails/?id=2619954303'] });
      expect(add.json()).toMatchObject({ added: ['2619954303'] });
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      const mods = (await owner.get(url(id, '/mods'))).json() as { items: { downloaded: boolean; mods: { modId: string; versionFolder: string; compatible: boolean }[] }[]; enabled: unknown[]; issues: unknown[] };
      expect(mods.items).toEqual([expect.objectContaining({ downloaded: true, mods: [expect.objectContaining({ modId: 'RecipeBrowser', versionFolder: '2026.7', compatible: true })] })]);
      expect(mods.enabled).toEqual([{ modId: 'RecipeBrowser', workshopId: '2619954303' }]);
      expect(mods.issues).toEqual([]);
      // Where steamcmd put it, and the list tModLoader reads.
      expect(existsSync(path.join(dataDir(id), '.workshop', 'steamapps', 'workshop', 'content', '1281930', '2619954303', '2026.7', 'RecipeBrowser.tmod'))).toBe(true);
      expect(readFileSync(path.join(dataDir(id), 'Mods', 'enabled.json'), 'utf8')).toBe('[\n  "RecipeBrowser"\n]');

      const before = logs(id).length;
      await ok(await owner.post(url(id, '/server/start')), 'start');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      await running(id);
      expect(logs(id).slice(before)).toContain('Sandboxing: RecipeBrowser v1.0');
      // Disabled: gone at the next start.
      await ok(await owner.req('PUT', url(id, '/mods/enabled'), { enabled: [] }), 'disable');
      expect(readFileSync(path.join(dataDir(id), 'Mods', 'enabled.json'), 'utf8')).toBe('[]');
      const beforeRestart = logs(id).length;
      await ok(await owner.post(url(id, '/server/restart'), {}), 'restart');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
      await running(id);
      expect(logs(id).slice(beforeRestart).some((l) => l.startsWith('Sandboxing:'))).toBe(false);
      await ok(await owner.post(url(id, '/server/stop'), {}), 'stop');
      expect(await opDone(id)).toEqual({ ok: true, error: null });
    },
    180_000 * SCALE,
  );

  it(
    'runs a Terraria and a Project Zomboid server side by side, each with its own schedule (G1, SCH-01)',
    async () => {
      const { owner } = rig;
      const [a, b] = await freeUdp(2);
      await ok(await owner.post('/api/servers', { id: 'pz-e2e', name: 'Zombies', adapter: 'pz', launch: { memoryMb: 2048, branch: 'public', updateOnStart: false }, ports: { game: a, udp: b } }), 'create PZ');
      await agentUp('pz-e2e');
      for (const id of ['pz-e2e', 'tr-vanilla']) await ok(await owner.post(url(id, '/server/start')), `start ${id}`);
      await Promise.all(['pz-e2e', 'tr-vanilla'].map((id) => opDone(id)));
      await Promise.all(['pz-e2e', 'tr-vanilla'].map((id) => running(id)));

      const schedule = async (id: string, time: string) => {
        const current = ((await owner.get(url(id, '/schedules'))).json() as { settings: { restarts: Record<string, unknown> } & Record<string, unknown> }).settings;
        const r = await owner.req('PUT', url(id, '/schedules'), { ...current, timezone: 'UTC', restarts: { ...current.restarts, enabled: true, times: [time], countdownSec: 0 } });
        await ok(r, `schedule ${id}`);
        return (r.json() as { next: { restart: string } }).next.restart;
      };
      const pzNext = await schedule('pz-e2e', '04:00');
      const trNext = await schedule('tr-vanilla', '06:15');
      expect(new Date(pzNext).toISOString()).toMatch(/T04:00:00/);
      expect(new Date(trNext).toISOString()).toMatch(/T06:15:00/);
      const list = (await owner.get('/api/servers')).json() as { id: string; adapter: string; state: string; nextRestart: string | null }[];
      expect(list.filter((s) => ['pz-e2e', 'tr-vanilla'].includes(s.id))).toEqual([
        expect.objectContaining({ id: 'tr-vanilla', adapter: 'terraria', state: 'running', nextRestart: trNext }),
        expect.objectContaining({ id: 'pz-e2e', adapter: 'pz', state: 'running', nextRestart: pzNext }),
      ]);
      // Each kept its own world and files.
      expect(existsSync(path.join(dataDir('pz-e2e'), 'Saves'))).toBe(true);
      expect(existsSync(path.join(dataDir('tr-vanilla'), 'Worlds', 'tr-vanilla.wld'))).toBe(true);
      expect(existsSync(path.join(dataDir('pz-e2e'), 'Worlds'))).toBe(false);

      for (const id of ['pz-e2e', 'tr-vanilla']) await ok(await owner.post(url(id, '/server/stop'), {}), `stop ${id}`);
      await Promise.all(['pz-e2e', 'tr-vanilla'].map((id) => opDone(id)));
    },
    180_000 * SCALE,
  );
});
