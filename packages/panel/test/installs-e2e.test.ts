// Shared installs end to end (HST-09, D12, UPD-01, UPD-03), without Docker:
// the panel as main.ts builds it (the orchestrator client over its socket,
// each server's and each install job's agent client), the real orchestrator
// API in front of the fake orchestrator's backend (each "container" and each
// install job a local agent process), Project Zomboid's fake server and
// fake steamcmd. Two servers of one game share one install, made by one job;
// an update installs the new build once, from a copy of the old install, and
// moves each server at its next start (the stopped one at once); the old
// install, used by nobody, is removed by the owner.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { FakeBackend } from '../../../tools/fake-orchestrator/backend';
import type { AgentClient } from '../src/agent/client';
import { buildApp } from '../src/app';
import { bootstrapOwner } from '../src/auth/bootstrap';
import { openDb, type Db } from '../src/db/db';
import type { PanelEnv } from '../src/env';
import type { Deps } from '../src/http/deps';
import type { InstallsResponse } from '../src/routes/installs';
import type { ServerSummary } from '../src/routes/servers';
import type { ServerContext } from '../src/servers/context';
import { createPanelDeps } from '../src/wiring';
import { FakeFeed, fakeAgent, noNetwork, ORIGIN, OWNER, ownerReady, type Client, type TestPanel } from './harness';

const SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const WAIT_MS = 60_000 * SCALE;
const ORCH_TOKEN = `e2e-orch-${randomBytes(16).toString('hex')}`;
const OLD_BUILD = '24909800';
const NEW_BUILD = '24909900';

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

const socketPath = () => (process.platform === 'win32' ? `\\\\.\\pipe\\gsp-test-inst-e2e-${process.pid}-${randomBytes(4).toString('hex')}` : path.join(os.tmpdir(), `gsp-inst-e2e-${process.pid}-${randomBytes(4).toString('hex')}.sock`));

interface Rig {
  dir: string;
  /** What every agent (servers' and jobs') is started with: the fake steamcmd's build is set here. */
  agentEnv: Record<string, string>;
  backend: FakeBackend;
  orch: http.Server;
  db: Db;
  deps: Deps;
  app: FastifyInstance;
  owner: Client;
}

let rig: Rig;

beforeAll(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-inst-e2e-'));
  const policy: Policy = { hostPorts: [[1024, 65535]], maxServers: 5, maxMemMb: 16_384, allowFake: true };
  const agentEnv: Record<string, string> = { FAKE_PZ_BOOT_MS: '200', FAKE_BUILDID: OLD_BUILD, GAME_PLAYERS_POLL_MS: '300', GAME_RESTART_DELAY_MS: '60000' };
  const backend = new FakeBackend({ stateDir: path.join(dir, 'orch'), policy, agentPorts: await freeTcp(6), controlPorts: await freeTcp(6), env: agentEnv, restartDelayMs: 60_000 });
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
  const feed = new FakeFeed();
  const deps = createPanelDeps({ env, db, agent: fakeAgent(feed), feed, fetch: noNetwork, mods: { pz: [createWorkshopSource({ fetch: noNetwork })] }, installPollMs: 100 });
  await bootstrapOwner(deps);
  const app = await buildApp(deps);
  await deps.servers.start();
  const { client: owner } = await ownerReady({ app } as TestPanel);
  rig = { dir, agentEnv, backend, orch, db, deps, app, owner };
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

const srv = (id: string): ServerContext => rig.deps.servers.get(id)!;
const url = (id: string, p = '') => `/api/servers/${id}${p}`;

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = WAIT_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function ok(res: { statusCode: number; body: string }, what: string): Promise<void> {
  expect(res.statusCode, `${what}: ${res.body}`).toBe(200);
}

async function opDone(id: string): Promise<{ ok: boolean | null; error: string | null }> {
  await srv(id).ops.idle();
  const last = srv(id).ops.last();
  return { ok: last?.ok ?? null, error: last?.error ?? null };
}

/** The server's agent answers, and the panel follows its events. */
async function agentUp(id: string): Promise<void> {
  await until(`${id}'s agent`, async () => (await srv(id).agent.status().catch(() => null)) !== null);
  if (!srv(id).feed.connected) (srv(id).agent as AgentClient).startStream();
  await until(`${id}'s events`, () => srv(id).feed.connected);
}
const state = async (id: string) => (await srv(id).agent.status().catch(() => null))?.state ?? null;
const running = (id: string) => until(`${id} to run`, async () => (await state(id)) === 'running');
const summary = async (id: string) => ((await rig.owner.get('/api/servers')).json() as ServerSummary[]).find((s) => s.id === id)!;
const installsNow = async () => (await rig.owner.get('/api/host/installs')).json() as InstallsResponse;
/** What the backend's "containers" mount: the install a server's spec names. */
const mounted = async (id: string) => (await rig.backend.list()).find((c) => c.id === id) && rig.deps.serverRows.get(id)!.spec!.install;
const manifestBuild = (iid: string) => /"buildid"\s+"(\d+)"/.exec(readFileSync(path.join(rig.backend.installDir(iid), 'steamapps', 'appmanifest_380870.acf'), 'utf8'))?.[1];

describe('shared installs end to end, through the fake orchestrator (HST-09, D12)', () => {
  it(
    'two servers of one game share one install made by one job; an update installs the new build once and moves each at its next start (UPD-01, UPD-03, UPD-04, SRV-05)',
    async () => {
      const { owner } = rig;
      const launch = { memoryMb: 2048, branch: 'public', updateOnStart: false };
      const [a1, a2, b1, b2] = await freeUdp(4);
      // ---- two servers, created one after the other: the second waits for the first one's job.
      await ok(await owner.post('/api/servers', { id: 'pz-a', name: 'Zombies A', adapter: 'pz', launch, ports: { game: a1, udp: a2 } }), 'create pz-a');
      await ok(await owner.post('/api/servers', { id: 'pz-b', name: 'Zombies B', adapter: 'pz', launch, ports: { game: b1, udp: b2 } }), 'create pz-b');
      const first = (await summary('pz-a')).install!;
      expect(first).toMatchObject({ mode: 'shared' });
      const old = first.id!;
      expect((await summary('pz-b')).install!.id).toBe(old);
      await agentUp('pz-a');
      await agentUp('pz-b');
      // One install, one job, one download; neither server has an install of its own.
      let listed = await installsNow();
      expect(listed.installs).toEqual([expect.objectContaining({ id: old, state: 'ready', origin: 'download', key: { flavour: null, version: null, build: OLD_BUILD, branch: 'public' }, servers: [expect.objectContaining({ id: 'pz-a' }), expect.objectContaining({ id: 'pz-b' })] })]);
      expect(rig.deps.audit.list({ action: 'install.create' })).toHaveLength(1);
      expect(manifestBuild(old)).toBe(OLD_BUILD);
      for (const id of ['pz-a', 'pz-b']) {
        expect(await mounted(id)).toBe(old);
        expect(existsSync(path.join(rig.dir, 'orch', id, 'install'))).toBe(false);
        expect(srv(id).feed.status_!.install).toMatchObject({ mode: 'shared', marker: { key: { build: OLD_BUILD } } });
      }

      // ---- pz-a runs; pz-b stays stopped.
      await ok(await owner.post(url('pz-a', '/server/start')), 'start pz-a');
      expect(await opDone('pz-a')).toEqual({ ok: true, error: null });
      await running('pz-a');
      expect(srv('pz-a').feed.status_!.installedInfo).toMatchObject({ build: OLD_BUILD, channel: 'public' });

      // ---- Steam has a newer build: pz-b's update installs it once, from a copy of the old install.
      rig.agentEnv.FAKE_BUILDID = NEW_BUILD;
      await ok(await owner.post(url('pz-b', '/server/update'), {}), 'update pz-b');
      expect(await opDone('pz-b')).toEqual({ ok: true, error: null });
      const fresh = rig.deps.serverRows.get('pz-b')!.installId!;
      expect(fresh).not.toBe(old);
      expect(rig.deps.servers.installs.get(fresh)).toMatchObject({ state: 'ready', source: old, key: { build: NEW_BUILD } });
      expect(manifestBuild(fresh)).toBe(NEW_BUILD);
      // The old install is untouched: pz-a still runs from it.
      expect(manifestBuild(old)).toBe(OLD_BUILD);
      expect(rig.deps.audit.list({ action: 'install.create' })).toHaveLength(2);
      // pz-b was stopped: moved at once. pz-a runs: it waits for its next start.
      await until('pz-b on the new install', async () => (await mounted('pz-b')) === fresh);
      await agentUp('pz-b');
      expect(srv('pz-b').feed.status_!.install).toMatchObject({ marker: { key: { build: NEW_BUILD } } });
      expect(await mounted('pz-a')).toBe(old);
      expect((await summary('pz-a')).containerPendingReasons).toEqual(['install']);
      expect((await summary('pz-a')).install).toMatchObject({ id: old, next: { id: fresh, state: 'ready' } });
      expect(await state('pz-a')).toBe('running');

      // ---- pz-a's restart moves it, after a safety backup; it runs the new build.
      await ok(await owner.post(url('pz-a', '/server/restart'), {}), 'restart pz-a');
      expect(await opDone('pz-a')).toEqual({ ok: true, error: null });
      await agentUp('pz-a');
      await running('pz-a');
      expect(await mounted('pz-a')).toBe(fresh);
      expect((await summary('pz-a')).containerPendingReasons).toEqual([]);
      expect(srv('pz-a').feed.status_!.installedInfo).toMatchObject({ build: NEW_BUILD });
      expect(srv('pz-a').backups.list().map((b) => b.manifest.trigger)).toContain('pre-update');
      // Still one job for the update: two installs in all.
      expect(rig.deps.audit.list({ action: 'install.create' })).toHaveLength(2);

      // ---- the old install, used by nobody: the owner removes it.
      listed = await installsNow();
      expect(listed.installs.find((i) => i.id === old)).toMatchObject({ superseded: true, servers: [], removable: true });
      await ok(await owner.req('DELETE', `/api/host/installs/${old}`), 'remove the old install');
      expect(existsSync(rig.backend.installDir(old))).toBe(false);
      expect((await installsNow()).installs.map((i) => i.id)).toEqual([fresh]);

      await ok(await owner.post(url('pz-a', '/server/stop'), {}), 'stop pz-a');
      expect(await opDone('pz-a')).toEqual({ ok: true, error: null });
    },
    240_000 * SCALE,
  );
});
