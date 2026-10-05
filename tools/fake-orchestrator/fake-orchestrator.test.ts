import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrchestratorServer, listenOnSocket, type Policy } from '@gsp/orchestrator';
import type { AgentStatus, InstallInfo, ServerContainer, ServerSpec } from '@gsp/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { request, socketPath, TOKEN } from '../../packages/orchestrator/test/helpers';
import { agentEnvFrom, FakeBackend } from './backend';

const SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const AGENT_TOKEN = 'fake-orch-agent-token-0123456789abcdef0123';
const policy: Policy = { hostPorts: [[1024, 65535]], maxMemMb: 4096, maxServers: 2, allowFake: false };

function freePorts(n: number): Promise<number[]> {
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

/**
 * Free UDP ports, picked by binding UDP: a free TCP port may sit in a range
 * the OS reserves for UDP only (Windows does this), so game ports can't come
 * from `freePorts`.
 */
function freeUdpPorts(n: number): Promise<number[]> {
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

const canListen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });

interface Rig {
  dir: string;
  socket: string;
  backend: FakeBackend;
  server: http.Server;
  agentPorts: number[];
  controlPorts: number[];
  logs: string[];
}
const rigs: Rig[] = [];

async function rig(o: { dir?: string; agentPorts?: number[]; controlPorts?: number[] } = {}): Promise<Rig> {
  const dir = o.dir ?? mkdtempSync(path.join(os.tmpdir(), 'gsp-fake-orch-'));
  const agentPorts = o.agentPorts ?? (await freePorts(2));
  const controlPorts = o.controlPorts ?? (await freePorts(6));
  const logs: string[] = [];
  const backend = new FakeBackend({ stateDir: dir, policy, agentPorts, controlPorts, env: { FAKE_PZ_BOOT_MS: '200' }, log: (l) => logs.push(l), restartDelayMs: 200 });
  const server = createOrchestratorServer({ backend, token: TOKEN, version: 'fake', policy });
  const socket = socketPath('fake-orch');
  await listenOnSocket(server, socket);
  const r = { dir, socket, backend, server, agentPorts, controlPorts, logs };
  rigs.push(r);
  await backend.init();
  return r;
}

async function close(r: Rig): Promise<void> {
  await r.backend.shutdown();
  await new Promise((res) => r.server.close(res));
  rigs.splice(rigs.indexOf(r), 1);
}

afterEach(async () => {
  for (const r of [...rigs]) {
    await close(r);
    rmSync(r.dir, { recursive: true, force: true });
  }
});

/** A server publishing its game port (the direct-connection one stays inside, as far as this test cares). */
function spec(id: string, gamePort: number): ServerSpec {
  return {
    id,
    runtime: 'steam',
    env: { AGENT_TOKEN, GAME_ADAPTER: 'pz', TZ: 'UTC', GAME_PORT_GAME: String(gamePort) },
    ports: [{ container: gamePort, host: gamePort, proto: 'udp' }],
    memoryMb: 2048,
  };
}

async function agent(url: string, method: string, p: string, body?: unknown): Promise<unknown> {
  const r = await fetch(`${url}${p}`, { method, headers: { authorization: `Bearer ${AGENT_TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json();
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000 * SCALE): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ''}`);
}

const launch = { adapter: 'pz', params: { serverName: 'devsrv', adminUsername: 'admin', adminPassword: 'Adm1nPassw0rd!', memoryMb: 2048, branch: 'public', updateOnStart: false } };

describe('the fake orchestrator (dev loop, M2)', () => {
  it('runs each server as a local agent with its fake game, and brings it back like unless-stopped (SRV-06)', { timeout: 180_000 * SCALE }, async () => {
    const r = await rig();
    const [game] = await freeUdpPorts(1);
    const put = await request(r.socket, 'PUT', '/v1/servers/pz', { body: spec('pz', game!) });
    expect(put).toMatchObject({ status: 200, body: { id: 'pz', state: 'created', image: 'gsp/steam:dev', agentUrl: `http://127.0.0.1:${r.agentPorts[0]}` } });
    const url = (put.body as ServerContainer).agentUrl;
    expect(await request(r.socket, 'POST', '/v1/servers/pz/start')).toMatchObject({ status: 200, body: { state: 'running' } });

    // The agent answers, and runs its game with RCON on a port of the pool (it would stay inside a container).
    await waitFor('the agent', async () => ((await agent(url, 'GET', '/v1/health')) as { ok?: boolean }).ok);
    await agent(url, 'POST', '/v1/start', { launch });
    await waitFor('the game', async () => {
      const s = (await agent(url, 'GET', '/v1/status')) as AgentStatus;
      return s.state === 'running' && s.control.connected;
    });
    expect(await Promise.all(r.controlPorts.map(canListen))).toContain(false);

    // Docker's stop: the agent stops its game and keeps wanting it, so the next start brings it back.
    expect(await request(r.socket, 'POST', '/v1/servers/pz/stop', { body: { timeoutSec: 60 } })).toMatchObject({ status: 200, body: { state: 'exited' } });
    await request(r.socket, 'POST', '/v1/servers/pz/start');
    await waitFor('the game again', async () => ((await agent(url, 'GET', '/v1/status')) as AgentStatus).state === 'running');

    // The fake orchestrator goes away and comes back: running servers come back with it.
    await close(r);
    const again = await rig({ dir: r.dir, agentPorts: r.agentPorts, controlPorts: r.controlPorts });
    expect(await request(again.socket, 'GET', '/v1/servers')).toMatchObject({ status: 200, body: [{ id: 'pz', state: 'running' }] });
    await waitFor('the game after a restart', async () => ((await agent(url, 'GET', '/v1/status')) as AgentStatus).state === 'running');

    expect(await request(again.socket, 'DELETE', '/v1/servers/pz?removeVolumes=true')).toEqual({ status: 200, body: { removed: true, volumesRemoved: true } });
    expect(existsSync(path.join(r.dir, 'pz'))).toBe(false);
    await expect(fetch(`${url}/v1/health`)).rejects.toThrow();
  });

  it('refuses what the real orchestrator refuses, and ports that are taken', async () => {
    const r = await rig();
    const [a, b] = await freeUdpPorts(2);
    const [taken] = await freePorts(1);
    expect(await request(r.socket, 'PUT', '/v1/servers/pz', { body: { ...spec('pz', a!), env: { ...spec('pz', a!).env, LD_PRELOAD: 'x' } } })).toMatchObject({ status: 403, body: { code: 'refused', field: 'env.LD_PRELOAD' } });
    expect(await request(r.socket, 'PUT', '/v1/servers/pz', { body: { ...spec('pz', a!), variant: 'fake' } })).toMatchObject({ status: 403, body: { field: 'variant' } });
    expect(await request(r.socket, 'PUT', '/v1/servers/pz', { body: spec('pz', a!) })).toMatchObject({ status: 200 });
    expect(await request(r.socket, 'PUT', '/v1/servers/pz-2', { body: spec('pz-2', a!) })).toMatchObject({ status: 409, body: { code: 'conflict', field: 'ports[0].host' } });

    const holder = net.createServer();
    await new Promise<void>((res) => holder.listen(taken!, '127.0.0.1', res));
    try {
      const body = { ...spec('pz-2', b!), ports: [{ container: taken!, host: taken!, proto: 'tcp' }] };
      expect(await request(r.socket, 'PUT', '/v1/servers/pz-2', { body })).toMatchObject({ status: 409, body: { field: 'ports[0].host' } });
    } finally {
      await new Promise((res) => holder.close(res));
    }
    expect(await request(r.socket, 'PUT', '/v1/servers/pz-2', { body: spec('pz-2', b!) })).toMatchObject({ status: 200 });
    expect(await request(r.socket, 'PUT', '/v1/servers/pz-3', { body: spec('pz-3', b! + 2) })).toMatchObject({ status: 403, body: { code: 'refused', field: 'id' } });
    expect(await request(r.socket, 'POST', '/v1/servers/nope/start')).toMatchObject({ status: 404 });
    expect(await request(r.socket, 'GET', '/v1/servers/pz/stats')).toMatchObject({ status: 200, body: { id: 'pz', memLimitBytes: 2048 * 1024 * 1024 } });
  });
});

describe('shared installs in the fake orchestrator (HST-09, D12)', () => {
  it('runs an install job, then a server on its install; copies it; refuses what the real one refuses', { timeout: 120_000 * SCALE }, async () => {
    const r = await rig();
    const IID = 'i0123456789abcdef';
    const COPY = 'ifedcba9876543210';
    const job = { id: IID, runtime: 'steam', env: { AGENT_TOKEN, GAME_ADAPTER: 'pz', TZ: 'UTC' } };
    const put = await request(r.socket, 'PUT', `/v1/installs/${IID}`, { body: job });
    expect(put).toMatchObject({ status: 200, body: { id: IID, adapter: 'pz', flavour: null, runtime: 'steam', mountedBy: [], job: { kind: 'install', state: 'running', from: null } } });
    const jobUrl = (put.body as InstallInfo).job!.agentUrl!;
    await waitFor('the job agent', async () => ((await agent(jobUrl, 'GET', '/v1/health')) as { ok?: boolean }).ok);
    const [game] = await freeUdpPorts(1);
    const onInstall = { ...spec('pz', game!), install: IID };
    // Never mounted while its job runs, nor once a job ended without finishing it.
    expect(await request(r.socket, 'PUT', '/v1/servers/pz', { body: onInstall })).toMatchObject({ status: 409, body: { reason: 'install-busy', field: 'install' } });
    expect(await agent(jobUrl, 'POST', '/v1/start', { launch })).toMatchObject({ install: 'install-job' });
    await agent(jobUrl, 'PUT', '/v1/launch', launch);
    expect(await agent(jobUrl, 'POST', '/v1/install', {})).toEqual({ ok: true });
    expect(((await agent(jobUrl, 'GET', '/v1/status')) as AgentStatus).install).toMatchObject({ mode: 'job', marker: { adapter: 'pz', key: { branch: 'public' } } });
    expect(await request(r.socket, 'DELETE', `/v1/installs/${IID}/job`)).toEqual({ status: 200, body: { removed: true } });
    await expect(fetch(`${jobUrl}/v1/health`)).rejects.toThrow();

    // A server on it: told it is shared, runs.
    const srv = await request(r.socket, 'PUT', '/v1/servers/pz', { body: onInstall });
    expect(srv).toMatchObject({ status: 200 });
    const url = (srv.body as ServerContainer).agentUrl;
    await request(r.socket, 'POST', '/v1/servers/pz/start');
    await waitFor('the agent', async () => ((await agent(url, 'GET', '/v1/health')) as { ok?: boolean }).ok);
    await agent(url, 'POST', '/v1/start', { launch });
    const running = await waitFor('the game', async () => {
      const s = (await agent(url, 'GET', '/v1/status')) as AgentStatus;
      return s.state === 'running' ? s : null;
    });
    expect(running.install).toMatchObject({ mode: 'shared', marker: { adapter: 'pz' } });
    expect(await agent(url, 'POST', '/v1/install', {})).toMatchObject({ install: 'shared-install' });
    expect(await request(r.socket, 'GET', '/v1/installs')).toMatchObject({ status: 200, body: [{ id: IID, mountedBy: ['pz'], job: null }] });
    expect(await request(r.socket, 'DELETE', `/v1/installs/${IID}`)).toMatchObject({ status: 409, body: { reason: 'install-in-use' } });
    expect(await request(r.socket, 'PUT', `/v1/installs/${IID}`, { body: job })).toMatchObject({ status: 409, body: { reason: 'install-in-use' } });
    expect(await request(r.socket, 'PUT', '/v1/servers/pz', { body: { ...onInstall, env: { ...onInstall.env, GAME_ADAPTER: 'minecraft' } } })).toMatchObject({ status: 403, body: { field: 'install' } });

    // A copy of it (an update starts there), finished at once here; the next job runs on the copy.
    const copy = await request(r.socket, 'PUT', `/v1/installs/${COPY}?from=${IID}`, { body: { ...job, id: COPY } });
    expect(copy).toMatchObject({ status: 200, body: { id: COPY, job: { kind: 'copy', state: 'exited', exitCode: 0, agentUrl: null, from: IID } } });
    expect(existsSync(path.join(r.dir, 'installs', COPY, 'install', 'steamapps', 'appmanifest_380870.acf'))).toBe(true);
    expect(await request(r.socket, 'DELETE', `/v1/installs/${COPY}/job`)).toEqual({ status: 200, body: { removed: true } });

    // It never had an install of its own here; one of a server that runs from it is refused.
    expect(await request(r.socket, 'DELETE', '/v1/servers/pz/install')).toEqual({ status: 200, body: { removed: false } });
    // The server goes; its install stays until it is removed itself.
    expect(await request(r.socket, 'DELETE', '/v1/servers/pz?removeVolumes=true')).toEqual({ status: 200, body: { removed: true, volumesRemoved: true } });
    expect(existsSync(path.join(r.dir, 'installs', IID, 'install'))).toBe(true);
    for (const id of [IID, COPY]) expect(await request(r.socket, 'DELETE', `/v1/installs/${id}`)).toEqual({ status: 200, body: { removed: true } });
    expect(existsSync(path.join(r.dir, 'installs', IID))).toBe(false);
    expect(await request(r.socket, 'GET', '/v1/installs')).toEqual({ status: 200, body: [] });
  });

  it("gives an install job's agent a port of the pool it can listen on, skipping one another program took", { timeout: 60_000 * SCALE }, async () => {
    const r = await rig();
    const IID = 'i0123456789abcdef';
    const holder = net.createServer();
    await new Promise<void>((res) => holder.listen(r.agentPorts[0]!, '127.0.0.1', res));
    try {
      const put = await request(r.socket, 'PUT', `/v1/installs/${IID}`, { body: { id: IID, runtime: 'steam', env: { AGENT_TOKEN, GAME_ADAPTER: 'pz', TZ: 'UTC' } } });
      expect(put).toMatchObject({ status: 200, body: { job: { agentUrl: `http://127.0.0.1:${r.agentPorts[1]}` } } });
      await waitFor('the job agent', async () => ((await agent(`http://127.0.0.1:${r.agentPorts[1]}`, 'GET', '/v1/health')) as { ok?: boolean }).ok);
      // With every port of the pool taken, the job is refused rather than started with an agent that can't listen.
      const other = await request(r.socket, 'PUT', '/v1/installs/ifedcba9876543210', { body: { id: 'ifedcba9876543210', runtime: 'steam', env: { AGENT_TOKEN, GAME_ADAPTER: 'pz', TZ: 'UTC' } } });
      expect(other).toMatchObject({ status: 409, body: { code: 'conflict' } });
    } finally {
      await new Promise((res) => holder.close(res));
    }
    expect(await request(r.socket, 'DELETE', `/v1/installs/${IID}/job`)).toEqual({ status: 200, body: { removed: true } });
  });
});

describe('runtime image upgrades in the fake orchestrator (HST-01, SRV-05, SRV-06)', () => {
  it('keeps a running server on its image when asked, recreates it otherwise, and remembers image ids across restarts', { timeout: 60_000 * SCALE }, async () => {
    const r = await rig();
    const [game] = await freeUdpPorts(1);
    const put = await request(r.socket, 'PUT', '/v1/servers/pz', { body: spec('pz', game!) });
    const first = put.body as ServerContainer;
    expect(first).toMatchObject({ imageId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(first.latestImageId).toBe(first.imageId);
    const started = (await request(r.socket, 'POST', '/v1/servers/pz/start')).body as ServerContainer;
    // The same spec and image: nothing changes, the agent keeps running.
    expect(await request(r.socket, 'PUT', '/v1/servers/pz', { body: spec('pz', game!) })).toMatchObject({ status: 200, body: { state: 'running', startedAt: started.startedAt } });

    const newer = r.backend.rebuildImage('gsp/steam:dev');
    expect(await request(r.socket, 'GET', '/v1/servers')).toMatchObject({ body: [{ id: 'pz', state: 'running', imageId: first.imageId, latestImageId: newer }] });
    expect(await request(r.socket, 'PUT', '/v1/servers/pz?keepImage=true', { body: spec('pz', game!) })).toMatchObject({ status: 200, body: { state: 'running', startedAt: started.startedAt, imageId: first.imageId } });

    // The ids survive the fake orchestrator going away: still an older image, still waiting.
    await close(r);
    const again = await rig({ dir: r.dir, agentPorts: r.agentPorts, controlPorts: r.controlPorts });
    expect(await request(again.socket, 'GET', '/v1/servers')).toMatchObject({ body: [{ id: 'pz', imageId: first.imageId, latestImageId: newer }] });
    // Not kept: stopped, recreated on the newer image.
    expect(await request(again.socket, 'PUT', '/v1/servers/pz', { body: spec('pz', game!) })).toMatchObject({ status: 200, body: { state: 'created', imageId: newer, latestImageId: newer } });
  });
});

describe('a release that derives containers differently, in the fake orchestrator (SRV-05, SRV-06, NFR-02)', () => {
  it('keeps a running server as derived when asked, recreates it otherwise, never across a security fix, and remembers across restarts', { timeout: 60_000 * SCALE }, async () => {
    const r = await rig();
    const [game] = await freeUdpPorts(1);
    expect(await request(r.socket, 'PUT', '/v1/servers/pz', { body: spec('pz', game!) })).toMatchObject({ status: 200, body: { derivation: 'current' } });
    const started = (await request(r.socket, 'POST', '/v1/servers/pz/start')).body as ServerContainer;

    r.backend.changeDerivation();
    expect(await request(r.socket, 'GET', '/v1/servers')).toMatchObject({ body: [{ id: 'pz', state: 'running', derivation: 'changed' }] });
    expect(await request(r.socket, 'PUT', '/v1/servers/pz?keepDerivation=true', { body: spec('pz', game!) })).toMatchObject({ status: 200, body: { state: 'running', startedAt: started.startedAt, derivation: 'changed' } });

    // Still waiting after the fake orchestrator went away and came back.
    await close(r);
    const again = await rig({ dir: r.dir, agentPorts: r.agentPorts, controlPorts: r.controlPorts });
    expect(await request(again.socket, 'GET', '/v1/servers')).toMatchObject({ body: [{ id: 'pz', derivation: 'changed' }] });
    await request(again.socket, 'POST', '/v1/servers/pz/start');
    // A security fix: recreated whatever is asked.
    again.backend.changeDerivation({ security: true });
    expect(await request(again.socket, 'GET', '/v1/servers')).toMatchObject({ body: [{ id: 'pz', derivation: 'security-fix' }] });
    expect(await request(again.socket, 'PUT', '/v1/servers/pz?keepDerivation=true&keepImage=true', { body: spec('pz', game!) })).toMatchObject({ status: 200, body: { state: 'created', derivation: 'current' } });
    // And an ordinary change, not kept: recreated too.
    again.backend.changeDerivation();
    expect(await request(again.socket, 'PUT', '/v1/servers/pz', { body: spec('pz', game!) })).toMatchObject({ status: 200, body: { state: 'created', derivation: 'current' } });
  });
});

describe('the host and what it takes, in the fake orchestrator (HST-03, HST-05, HST-07)', () => {
  it("says it is the host it is told to be, and measures each server's folders in place of its volumes", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-fake-orch-'));
    try {
      const plain = new FakeBackend({ stateDir: path.join(dir, 'plain'), policy, agentPorts: await freePorts(1), controlPorts: await freePorts(2) });
      expect((await plain.host()).traits).toMatchObject({ docker: 'engine', addressesVisible: 'expected' });
      const b = new FakeBackend({ stateDir: path.join(dir, 'told'), policy, agentPorts: await freePorts(1), controlPorts: await freePorts(6), host: { arch: 'arm64', traits: { docker: 'desktop', platform: 'macos', addressesVisible: false } } });
      expect(await b.host()).toMatchObject({ arch: 'arm64', traits: { docker: 'desktop', platform: 'macos', addressesVisible: false } });
      await b.apply({ id: 'fk', runtime: 'steam', env: { AGENT_TOKEN, GAME_ADAPTER: 'pz', TZ: 'UTC' }, ports: [], memoryMb: 2048 });
      mkdirSync(path.join(dir, 'told', 'fk', 'data', 'world'), { recursive: true });
      writeFileSync(path.join(dir, 'told', 'fk', 'data', 'world', 'map.bin'), Buffer.alloc(1000));
      const u = await b.usage();
      expect(u.servers).toEqual([{ id: 'fk', state: 'created', stats: null }]);
      expect(u.volumes).toEqual([
        { name: 'fk/data', use: 'data', server: 'fk', install: null, bytes: 1000 },
        { name: 'fk/install', use: 'install', server: 'fk', install: null, bytes: 0 },
        { name: 'fk/steam', use: 'steam', server: 'fk', install: null, bytes: 0 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what the fake orchestrator passes its agents (dev loop, M3, M5)', () => {
  it("gives them the fake games' knobs and Minecraft's and Terraria's download services, nothing of its own (UPD-01)", () => {
    const env = {
      FAKE_PZ_BOOT_MS: '2500',
      FAKE_MC_BOOT_MS: '2500',
      FAKE_TERRARIA_BOOT_MS: '2500',
      FAKE_ORCH_STATE_DIR: '/state',
      GAME_MC_MOJANG_URL: 'http://127.0.0.1:30407',
      GAME_MC_PAPER_URL: 'http://127.0.0.1:30407',
      GAME_MC_FABRIC_URL: 'http://127.0.0.1:30407',
      GAME_TERRARIA_ORG_URL: 'http://127.0.0.1:30408',
      GAME_TERRARIA_GITHUB_URL: 'http://127.0.0.1:30408',
      GAME_ADAPTER: 'pz',
      GAME_MC_OTHER: 'x',
      GAME_TERRARIA_OTHER: 'x',
      ORCH_TOKEN: 'secret',
      PATH: '/bin',
    };
    expect(agentEnvFrom(env)).toEqual({
      FAKE_PZ_BOOT_MS: '2500',
      FAKE_MC_BOOT_MS: '2500',
      FAKE_TERRARIA_BOOT_MS: '2500',
      GAME_MC_MOJANG_URL: 'http://127.0.0.1:30407',
      GAME_MC_PAPER_URL: 'http://127.0.0.1:30407',
      GAME_MC_FABRIC_URL: 'http://127.0.0.1:30407',
      GAME_TERRARIA_ORG_URL: 'http://127.0.0.1:30408',
      GAME_TERRARIA_GITHUB_URL: 'http://127.0.0.1:30408',
    });
  });
});

describe('fake-game.mjs', () => {
  const fakeGame = fileURLToPath(new URL('./fake-game.mjs', import.meta.url));
  const run = (adapter: string, ...args: string[]) => spawnSync(process.execPath, [fakeGame, ...args], { encoding: 'utf8', env: { ...process.env, GAME_ADAPTER: adapter } });

  it("runs the adapter's fake steamcmd or server with the remaining arguments", () => {
    const r = run('pz', 'steamcmd', '+quit');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Loading Steam API');
  });

  it('refuses unknown kinds and adapters, and paths', () => {
    for (const [adapter, kind] of [
      ['pz', 'rm'],
      ['nope', 'server'],
      ['../fake-pz', 'server'],
      ['', 'server'],
    ] as const) {
      expect(run(adapter, kind).status, `${adapter} ${kind}`).toBe(2);
    }
  });
});
