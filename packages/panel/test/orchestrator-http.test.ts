import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createOrchestratorServer, listenOnSocket, type Policy } from '@gsp/orchestrator';
import type { ServerSpec } from '@gsp/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeBackend } from '../../../tools/fake-orchestrator/backend';
import { OrchestratorCallError } from '../src/servers/orchestrator';
import { OrchestratorHttp, orchestratorFromEnv } from '../src/servers/orchestrator-http';

const TOKEN = 'panel-orch-token-0123456789abcdef0123456789';
const AGENT_TOKEN = 'panel-orch-agent-0123456789abcdef012345678';
const policy: Policy = { hostPorts: [[1024, 65535]], maxMemMb: 4096, maxServers: 2, allowFake: false };

/** A unix socket path, or a named pipe on Windows. */
const socketPath = (name: string) => {
  const tag = `${name}-${process.pid}-${randomBytes(4).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\gsp-test-${tag}` : path.join(os.tmpdir(), `gsp-${tag}.sock`);
};

/**
 * A free UDP port, picked by binding UDP: a free TCP port may sit in a range
 * the OS reserves for UDP only (Windows does this), so the game port can't
 * come from `freePorts`.
 */
function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

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

let dir: string;
let backend: FakeBackend;
let server: http.Server;
let client: OrchestratorHttp;
let game: number;
const socket = socketPath('panel-orch');

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-panel-orch-'));
  const ports = await freePorts(5);
  game = await freeUdpPort();
  backend = new FakeBackend({ stateDir: dir, policy, agentPorts: ports.slice(0, 2), controlPorts: ports.slice(2, 5), env: { FAKE_PZ_BOOT_MS: '200' } });
  server = createOrchestratorServer({ backend, token: TOKEN, version: 'fake', policy });
  await listenOnSocket(server, socket);
  client = new OrchestratorHttp({ socket, token: TOKEN });
});
afterAll(async () => {
  await backend.shutdown();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const spec = (over: Partial<ServerSpec> = {}): ServerSpec => ({
  id: 'pz',
  runtime: 'steam',
  env: { AGENT_TOKEN, GAME_ADAPTER: 'pz', TZ: 'UTC', GAME_PORT_GAME: String(game) },
  ports: [{ container: game, host: game, proto: 'udp' }],
  memoryMb: 2048,
  ...over,
});

async function failure(p: Promise<unknown>): Promise<OrchestratorCallError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OrchestratorCallError);
    return e as OrchestratorCallError;
  }
  throw new Error('expected a failure');
}

describe('the panel’s orchestrator client (D3, NFR-03), against the fake orchestrator', () => {
  it('reads health, host and the server list', async () => {
    expect(await client.health()).toEqual({ ok: true, version: 'fake', api: 1 });
    // With where servers may publish and how much memory one may have (SRV-01, SRV-05).
    expect(await client.host()).toMatchObject({ dockerVersion: 'fake', cpus: expect.any(Number), hostPorts: [{ from: 1024, to: 65535 }], maxMemMb: 4096 });
    expect(await client.list()).toEqual([]);
  });

  it('creates, starts, samples, restarts, stops and removes a server', { timeout: 120_000 }, async () => {
    const created = await client.apply(spec());
    expect(created).toMatchObject({ id: 'pz', state: 'created', image: 'gsp/steam:dev', specHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await client.apply(spec())).toEqual(created);
    expect(await client.list()).toEqual([created]);
    expect(await client.start('pz')).toMatchObject({ state: 'running' });
    expect(await client.stats('pz')).toMatchObject({ id: 'pz', memLimitBytes: 2048 * 1024 * 1024 });
    expect(await client.restart('pz', { timeoutSec: 30 })).toMatchObject({ state: 'running' });
    expect(await client.stop('pz', { timeoutSec: 30 })).toMatchObject({ state: 'exited' });
    expect(await client.remove('pz', { removeVolumes: false })).toEqual({ removed: true, volumesRemoved: false });
    expect(await client.remove('pz', { removeVolumes: true })).toEqual({ removed: false, volumesRemoved: true });
  });

  it('keeps a container on its image when asked, and moves it to a rebuilt one otherwise (HST-01, SRV-05)', async () => {
    const created = await client.apply(spec());
    expect(created.imageId).toMatch(/^sha256:/);
    const newer = backend.rebuildImage('gsp/steam:dev');
    expect(await client.list()).toEqual([{ ...created, latestImageId: newer }]);
    expect(await client.apply(spec(), { keepImage: true })).toEqual({ ...created, latestImageId: newer });
    expect(await client.apply(spec(), { keepImage: false })).toMatchObject({ state: 'created', imageId: newer, latestImageId: newer });
    expect(await client.remove('pz', { removeVolumes: true })).toEqual({ removed: true, volumesRemoved: true });
  });

  it("passes the orchestrator's refusals on with their code and field", async () => {
    // What a compromised panel might try: the type says no, the orchestrator says no too.
    const injected = { ...spec().env, LD_PRELOAD: '/tmp/x.so' } as unknown as ServerSpec['env'];
    const refused = await failure(client.apply(spec({ env: injected })));
    expect(refused).toMatchObject({ status: 403, code: 'refused', field: 'env.LD_PRELOAD' });
    expect(await failure(client.apply(spec({ memoryMb: 8192 })))).toMatchObject({ code: 'refused', field: 'memoryMb' });
    expect(await failure(client.start('nope'))).toMatchObject({ status: 404, code: 'not-found' });
    expect(await failure(client.stop('pz', { timeoutSec: 601 }))).toMatchObject({ status: 400, code: 'bad-request', field: 'timeoutSec' });
    await client.apply(spec());
    expect(await failure(client.apply(spec({ id: 'pz-2' })))).toMatchObject({ status: 409, code: 'conflict', field: 'ports[0].host' });
    await client.remove('pz', { removeVolumes: true });
  });

  it('never sends an id outside the contract', async () => {
    for (const id of ['../x', 'Pz', 'a'.repeat(25), 'pz/start', '']) {
      expect(await failure(client.start(id)), id).toMatchObject({ status: 400, code: 'bad-request', field: 'id' });
      expect(await failure(client.remove(id, { removeVolumes: true })), id).toMatchObject({ code: 'bad-request' });
    }
    expect(await failure(client.apply(spec({ id: '../../x' })))).toMatchObject({ code: 'bad-request', field: 'id' });
  });

  it('says unauthorized with a wrong token, and unreachable when nobody answers', async () => {
    expect(await failure(new OrchestratorHttp({ socket, token: `${TOKEN}x` }).health())).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(await failure(new OrchestratorHttp({ socket: socketPath('nobody'), token: TOKEN }).list())).toMatchObject({ status: 503, code: 'unreachable' });

    const silent = http.createServer(() => undefined);
    const quiet = socketPath('silent');
    await listenOnSocket(silent, quiet);
    try {
      expect(await failure(new OrchestratorHttp({ socket: quiet, token: TOKEN, timeoutMs: 200 }).health())).toMatchObject({ code: 'unreachable', message: expect.stringContaining('no answer') });
    } finally {
      silent.closeAllConnections();
      await new Promise((r) => silent.close(r));
    }
  });

  it('is built from ORCH_SOCKET and ORCH_TOKEN', () => {
    expect(orchestratorFromEnv({})).toBeNull();
    expect(orchestratorFromEnv({ ORCH_SOCKET: socket, ORCH_TOKEN: TOKEN })).toBeInstanceOf(OrchestratorHttp);
    expect(() => orchestratorFromEnv({ ORCH_SOCKET: socket })).toThrow(/together/);
    expect(() => orchestratorFromEnv({ ORCH_TOKEN: TOKEN })).toThrow(/together/);
    expect(() => orchestratorFromEnv({ ORCH_SOCKET: socket, ORCH_TOKEN: 'short' })).toThrow(/32/);
  });
});
