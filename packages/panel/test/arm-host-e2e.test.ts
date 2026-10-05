// An ARM host end to end (M7 done-when, HST-05, HST-07, D10): the panel as
// main.ts builds it, its orchestrator client over the socket, the real
// orchestrator (API and Docker side) in front of a fake Docker that
// describes an Apple Silicon Mac with Docker Desktop. The create form marks
// the x86-only games, the API refuses them with the reason before anything
// reaches Docker, the game that runs on ARM stays on offer, and the host
// page lists this host's limitations.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrchestratorServer, DockerBackend, DockerClient, listenOnSocket, type Policy } from '@gsp/orchestrator';
import type { FastifyInstance } from 'fastify';
import { startFakeDocker, type FakeDocker } from '../../../tools/fake-docker/fake-docker';
import { buildApp } from '../src/app';
import { bootstrapOwner } from '../src/auth/bootstrap';
import { openDb, type Db } from '../src/db/db';
import type { PanelEnv } from '../src/env';
import type { HostOverview } from '../src/host/overview';
import type { Deps } from '../src/http/deps';
import type { AdapterSummary, HostSummary } from '../src/routes/servers';
import { createPanelDeps } from '../src/wiring';
import { FakeFeed, fakeAgent, noNetwork, ORIGIN, OWNER, ownerReady, type Client, type TestPanel } from './harness';

const ORCH_TOKEN = `arm-orch-${randomBytes(16).toString('hex')}`;
const STACK = 'gsp-arm';
const socketPath = () => (process.platform === 'win32' ? `\\\\.\\pipe\\gsp-test-arm-${process.pid}-${randomBytes(4).toString('hex')}` : path.join(os.tmpdir(), `gsp-arm-${process.pid}-${randomBytes(4).toString('hex')}.sock`));

let fd: FakeDocker;
let orch: http.Server;
let dir: string;
let db: Db;
let deps: Deps;
let app: FastifyInstance;
let owner: Client;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-arm-e2e-'));
  fd = await startFakeDocker();
  // An Apple Silicon Mac: arm64, Docker Desktop, its CLI socket in the owner's home.
  Object.assign(fd.info, {
    Architecture: 'aarch64',
    NCPU: 10,
    MemTotal: 8 * 1024 ** 3,
    OperatingSystem: 'Docker Desktop',
    KernelVersion: '6.10.14-linuxkit',
    Labels: ['com.docker.desktop.address=unix:///Users/you/Library/Containers/com.docker.docker/Data/docker-cli.sock'],
  });
  const policy: Policy = { hostPorts: [[30150, 30199]], maxMemMb: 6144, maxServers: 4, allowFake: true };
  const backend = new DockerBackend({ docker: new DockerClient({ url: fd.url }), ctx: { stack: STACK, imageTag: 'arm', publishAddr: '127.0.0.1', allowFake: true }, policy });
  const socket = socketPath();
  orch = createOrchestratorServer({ backend, token: ORCH_TOKEN, version: 'test', policy });
  await listenOnSocket(orch, socket);

  const env: PanelEnv = {
    version: 'test',
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    dataDir: ':memory:',
    publicDir: null,
    // No server of the environment's own: every server is the orchestrator's.
    agentUrl: '',
    agentToken: '',
    orchestrator: { socket, token: ORCH_TOKEN },
    serverImageVariant: 'fake',
    pzDataDir: path.join(dir, 'default', 'data'),
    pzInstallDir: path.join(dir, 'default', 'install'),
    backupDir: path.join(dir, 'backups'),
    serverName: 'zomboid',
    secrets: {},
    ports: {},
    origins: [ORIGIN],
    owner: OWNER,
    trustProxy: 'loopback',
    clientIpTrustworthy: false,
    secureCookies: true,
  };
  db = openDb(':memory:');
  const feed = new FakeFeed();
  deps = createPanelDepsFor(env, feed);
  await bootstrapOwner(deps);
  app = await buildApp(deps);
  ({ client: owner } = await ownerReady({ app } as TestPanel));
});

afterAll(async () => {
  await app?.close();
  await new Promise((r) => orch?.close(r));
  await fd?.close();
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The panel as main.ts builds it, with no server of the environment's. */
function createPanelDepsFor(env: PanelEnv, feed: FakeFeed): Deps {
  return createPanelDeps({ env, db, agent: fakeAgent(feed), feed, fetch: noNetwork, downloads: { fetch: noNetwork, env: {} } });
}

describe('an ARM host refuses an x86-only game with a clear reason (M7, HST-05, D10)', () => {
  it('marks every game the host can run and every one it can’t, from what Docker says', async () => {
    const r = (await owner.get('/api/adapters')).json() as { host: HostSummary; adapters: AdapterSummary[] };
    expect(r.host).toMatchObject({ arch: 'arm64', cpus: 10, memBytes: 8 * 1024 ** 3, maxMemMb: 6144 });
    expect(Object.fromEntries(r.adapters.map((a) => [a.id, [a.supported, a.arch]]))).toEqual({
      pz: [false, ['amd64']],
      minecraft: [true, ['amd64', 'arm64']],
      terraria: [false, ['amd64']],
      valheim: [false, ['amd64']],
      avorion: [false, ['amd64']],
    });
  });

  it('refuses to create one, naming the host’s architecture and the game’s, before anything reaches Docker', async () => {
    const before = fd.writes().length;
    for (const [adapter, flavour] of [
      ['pz', null],
      ['terraria', 'vanilla'],
      ['terraria', 'tshock'],
      ['valheim', null],
      ['avorion', null],
    ] as const) {
      const res = await owner.post('/api/servers', { id: `x-${adapter}`, name: 'X', adapter, ...(flavour ? { flavour } : {}) });
      expect(res.statusCode, `${adapter} ${flavour ?? ''}`).toBe(409);
      expect(res.json(), `${adapter} ${flavour ?? ''}`).toEqual({ error: 'arch-unsupported', arch: 'arm64', supported: ['amd64'] });
    }
    expect(fd.writes().length).toBe(before);
    expect(deps.serverRows.list()).toEqual([]);
    // Nothing was created, so the activity log names no new server either.
    expect(deps.audit.list({ limit: 50 }).filter((e) => e.action === 'server.create')).toEqual([]);
  });

  it('lists the ARM limitation, and Docker Desktop’s, on the host page; Docker’s own words never reach the panel', async () => {
    const res = await owner.get('/api/host/overview');
    expect(res.statusCode).toBe(200);
    const o = res.json() as HostOverview;
    expect(o.host).toMatchObject({ arch: 'arm64', docker: 'desktop', platform: 'macos', memBytes: 8 * 1024 ** 3 });
    expect(o.addresses).toBe('hidden');
    expect(o.limitations.map((l) => l.id)).toEqual(['hidden-addresses', 'desktop-memory', 'hidden-visitors', 'desktop-disk', 'desktop-ports', 'arm-games', 'macos-untested']);
    expect(o.measured.usage).toMatch(/^\d{4}-/);
    expect(res.body).not.toMatch(/Users|Library|linuxkit/);
    expect((await owner.get('/api/host/traits')).json()).toMatchObject({ addresses: 'hidden' });
  });
});
