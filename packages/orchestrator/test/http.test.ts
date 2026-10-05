import type http from 'node:http';
import { ORCHESTRATOR_API_VERSION } from '@gsp/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DERIVATION_VERSION } from '../src/derive';
import { DockerBackend } from '../src/docker-backend';
import { createOrchestratorServer } from '../src/http';
import { listenOnSocket } from '../src/listen';
import { ctx, dockerStack, policy, request, socketPath, spec, STACK, TOKEN, type DockerStack } from './helpers';

let stack: DockerStack;
let server: http.Server;
const socket = socketPath('orch-http');
const lines: string[] = [];

beforeAll(async () => {
  stack = await dockerStack();
  server = createOrchestratorServer({ backend: stack.backend, token: TOKEN, version: '1.2.3-test', policy, log: (l) => lines.push(l) });
  await listenOnSocket(server, socket);
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await stack.fd.close();
});

const call = (method: string, path: string, o: Parameters<typeof request>[3] = {}) => request(socket, method, path, o);

describe('the orchestrator API (D3, NFR-02, NFR-03)', () => {
  it('asks for the bearer token on every route, health included', async () => {
    const routes: [string, string][] = [
      ['GET', '/v1/health'],
      ['GET', '/v1/host'],
      ['GET', '/v1/host/usage'],
      ['GET', '/v1/servers'],
      ['PUT', '/v1/servers/pz'],
      ['POST', '/v1/servers/pz/start'],
      ['POST', '/v1/servers/pz/stop'],
      ['POST', '/v1/servers/pz/restart'],
      ['GET', '/v1/servers/pz/stats'],
      ['DELETE', '/v1/servers/pz'],
      ['GET', '/v2/anything'],
    ];
    const before = stack.fd.calls.length;
    for (const [method, path] of routes) {
      for (const token of [null, 'wrong', `${TOKEN}x`, TOKEN.slice(0, -1)]) {
        const r = await call(method, path, { token, body: method === 'PUT' ? spec() : undefined });
        expect(r, `${method} ${path} ${token}`).toEqual({ status: 401, body: { error: 'Unauthorized', code: 'unauthorized' } });
      }
    }
    expect(stack.fd.calls.length).toBe(before);
  });

  it('reports its health, version and API version, and the host with its traits (HST-07)', async () => {
    expect(await call('GET', '/v1/health')).toEqual({ status: 200, body: { ok: true, version: '1.2.3-test', api: ORCHESTRATOR_API_VERSION } });
    expect(await call('GET', '/v1/host')).toMatchObject({ status: 200, body: { arch: 'amd64', cpus: 8, traits: { docker: 'engine', platform: 'linux', addressesVisible: 'expected' } } });
  });

  it("reports what this stack's servers and volumes take, reading only: no body, no query, GET alone (HST-03)", async () => {
    const before = stack.fd.writes().length;
    expect(await call('GET', '/v1/host/usage')).toMatchObject({ status: 200, body: { servers: [], volumes: [], at: expect.stringMatching(/^\d{4}-/) as unknown } });
    expect(stack.fd.writes().length).toBe(before);
    expect(await call('GET', '/v1/host/usage?all=true')).toMatchObject({ status: 400, body: { code: 'bad-request' } });
    expect(await call('GET', '/v1/host/usage', { body: {} })).toMatchObject({ status: 400, body: { code: 'bad-request' } });
    expect(await call('POST', '/v1/host/usage')).toMatchObject({ status: 405 });
    expect(await call('DELETE', '/v1/host/usage')).toMatchObject({ status: 405 });
    for (const path of ['/v1/host/usage/x', '/v1/host/df', '/v1/host/', '/v1/system/df']) expect(await call('GET', path), path).toMatchObject({ status: 404, body: { code: 'not-found' } });
  });

  it("tells the panel which host ports servers may publish and how much memory one may have, from its own settings (SRV-01, SRV-05)", async () => {
    const own = socketPath('orch-host');
    const ranges = createOrchestratorServer({ backend: stack.backend, token: TOKEN, version: 'x', policy: { ...policy, hostPorts: [[2456, 2499], [16261, 16299], [25565, 25565]], maxMemMb: 6144 } });
    await listenOnSocket(ranges, own);
    try {
      const r = await request(own, 'GET', '/v1/host');
      expect(r).toMatchObject({ status: 200, body: { arch: 'amd64', hostPorts: [{ from: 2456, to: 2499 }, { from: 16261, to: 16299 }, { from: 25565, to: 25565 }], maxMemMb: 6144 } });
    } finally {
      await new Promise((res) => ranges.close(res));
    }
    expect(await call('GET', '/v1/host')).toMatchObject({ body: { hostPorts: [{ from: 30150, to: 30199 }], maxMemMb: 4096 } });
  });

  it('refuses ids that are not server ids before anything reaches Docker', async () => {
    const before = stack.fd.calls.length;
    for (const path of ['/v1/servers/..%2F..', '/v1/servers/..', '/v1/servers/%2e%2e', '/v1/servers/Pz', '/v1/servers/PZ/start', `/v1/servers/${'a'.repeat(25)}`, '/v1/servers/%70z', '/v1/servers/pz%00', '/v1/servers/', '/v1/servers/pz_2/stats']) {
      const r = await call(path.endsWith('stats') ? 'GET' : 'POST', path.endsWith('/start') || path.endsWith('stats') ? path : `${path}/start`);
      expect(r, path).toMatchObject({ status: 400, body: { code: 'bad-request', field: 'id' } });
    }
    for (const path of ['/v1/servers/../pz', '/v1/servers/pz/../../x', '/v1/servers/pz/exec', '/v1/servers/pz/start/x', '/v1/containers/json', '/v1/../_ping']) {
      expect(await call('POST', path), path).toMatchObject({ status: 404, body: { code: 'not-found' } });
    }
    expect(stack.fd.calls.length).toBe(before);
  });

  it('answers refusals with the field, as an OrchestratorError', async () => {
    expect(await call('PUT', '/v1/servers/pz', { body: { ...spec(), privileged: true } })).toEqual({
      status: 403,
      body: { error: expect.stringContaining('privileged'), code: 'refused', field: 'privileged' },
    });
    expect(await call('PUT', '/v1/servers/pz', { body: { ...spec(), env: { ...spec().env, LD_PRELOAD: '/tmp/x.so' } } })).toMatchObject({ status: 403, body: { code: 'refused', field: 'env.LD_PRELOAD' } });
    expect(await call('PUT', '/v1/servers/pz', { body: { ...spec(), memoryMb: 999999 } })).toMatchObject({ status: 403, body: { code: 'refused', field: 'memoryMb' } });
    expect(await call('PUT', '/v1/servers/pz-2', { body: spec() })).toMatchObject({ status: 400, body: { code: 'bad-request', field: 'id' } });
  });

  it('takes strict JSON bodies and no stray query parameters', async () => {
    expect(await call('PUT', '/v1/servers/pz', { raw: '{"id":' })).toMatchObject({ status: 400, body: { code: 'bad-request', error: 'Invalid JSON' } });
    expect(await call('PUT', '/v1/servers/pz', { raw: JSON.stringify(spec()), contentType: 'text/plain' })).toMatchObject({ status: 415, body: { code: 'bad-request' } });
    expect(await call('PUT', '/v1/servers/pz', { raw: JSON.stringify({ ...spec(), env: { ...spec().env, GSP_BIG: 'x'.repeat(70_000) } }) })).toMatchObject({ status: 413, body: { code: 'bad-request' } });
    expect(await call('PUT', '/v1/servers/pz')).toMatchObject({ status: 400, body: { code: 'bad-request' } });
    expect(await call('PUT', '/v1/servers/pz?image=alpine', { body: spec() })).toMatchObject({ status: 400, body: { code: 'bad-request' } });
    expect(await call('PUT', '/v1/servers/pz?keepImage=yes', { body: spec() })).toMatchObject({ status: 400, body: { code: 'bad-request', field: 'keepImage' } });
    expect(await call('PUT', '/v1/servers/pz?keepImage=true&keepImage=true', { body: spec() })).toMatchObject({ status: 400, body: { field: 'keepImage' } });
    expect(await call('PUT', '/v1/servers/pz?keepImage=true&image=alpine', { body: spec() })).toMatchObject({ status: 400, body: { code: 'bad-request' } });
    expect(await call('PUT', '/v1/servers/pz?keepDerivation=1', { body: spec() })).toMatchObject({ status: 400, body: { code: 'bad-request', field: 'keepDerivation' } });
    expect(await call('PUT', '/v1/servers/pz?keepImage=true&keepDerivation=true&keepDerivation=false', { body: spec() })).toMatchObject({ status: 400, body: { field: 'keepDerivation' } });
    expect(await call('PUT', '/v1/servers/pz?keepDerivation=true&derivation=0', { body: spec() })).toMatchObject({ status: 400, body: { code: 'bad-request' } });
    expect(await call('DELETE', '/v1/servers/pz?keepDerivation=true')).toMatchObject({ status: 400 });
    expect(await call('GET', '/v1/servers?all=1')).toMatchObject({ status: 400 });
    expect(await call('GET', '/v1/health', { body: {} })).toMatchObject({ status: 400 });
    expect(await call('POST', '/v1/servers/pz/start', { body: { image: 'x' } })).toMatchObject({ status: 400 });
    expect(await call('POST', '/v1/servers/pz/stop', { body: { timeoutSec: 601 } })).toMatchObject({ status: 400, body: { field: 'timeoutSec' } });
    expect(await call('POST', '/v1/servers/pz/restart', { body: { signal: 'SIGKILL' } })).toMatchObject({ status: 400 });
    expect(await call('DELETE', '/v1/servers/pz?removeVolumes=yes')).toMatchObject({ status: 400, body: { field: 'removeVolumes' } });
    expect(await call('DELETE', '/v1/servers/pz?removeVolumes=true&removeVolumes=false')).toMatchObject({ status: 400 });
    expect(await call('DELETE', '/v1/servers/pz?force=true')).toMatchObject({ status: 400 });
    expect(await call('DELETE', '/v1/servers/pz', { body: {} })).toMatchObject({ status: 400 });
    expect(await call('POST', '/v1/servers')).toMatchObject({ status: 405, body: { code: 'bad-request' } });
    expect(await call('GET', '/v1/servers/pz/start')).toMatchObject({ status: 405 });
    expect(await call('PATCH', '/v1/servers/pz')).toMatchObject({ status: 405 });
  });

  it('creates, starts, samples, stops and removes a server', async () => {
    const put = await call('PUT', '/v1/servers/pz', { body: spec() });
    expect(put).toMatchObject({ status: 200, body: { id: 'pz', state: 'created', agentUrl: `http://${STACK}-srv-pz:8081`, image: 'gsp/steam-fake:s1' } });
    expect(await call('PUT', '/v1/servers/pz', { body: spec() })).toEqual(put);
    expect(await call('GET', '/v1/servers')).toMatchObject({ status: 200, body: [{ id: 'pz', state: 'created' }] });
    expect(await call('POST', '/v1/servers/pz/start')).toMatchObject({ status: 200, body: { state: 'running' } });
    expect(await call('POST', '/v1/servers/pz/start', { body: {} })).toMatchObject({ status: 200, body: { state: 'running' } });
    expect(await call('GET', '/v1/servers/pz/stats')).toMatchObject({ status: 200, body: { id: 'pz', cpuPercent: 100 } });
    expect(await call('POST', '/v1/servers/pz/restart', { body: { timeoutSec: 5 } })).toMatchObject({ status: 200, body: { state: 'running' } });
    expect(await call('POST', '/v1/servers/pz/stop', { body: { timeoutSec: 10 } })).toMatchObject({ status: 200, body: { state: 'exited' } });
    expect(await call('DELETE', '/v1/servers/pz')).toEqual({ status: 200, body: { removed: true, volumesRemoved: false } });
    expect(await call('DELETE', '/v1/servers/pz?removeVolumes=true')).toEqual({ status: 200, body: { removed: false, volumesRemoved: true } });
    expect(await call('POST', '/v1/servers/pz/start')).toMatchObject({ status: 404, body: { code: 'not-found' } });
  });

  it('moves a server to a rebuilt runtime image, unless the panel keeps its image (HST-01, SRV-05, D3)', async () => {
    const put = await call('PUT', '/v1/servers/pz', { body: spec() });
    const first = put.body as { imageId: string; latestImageId: string };
    expect(put).toMatchObject({ status: 200, body: { id: 'pz', imageId: expect.stringMatching(/^sha256:/) } });
    expect(first.latestImageId).toBe(first.imageId);
    const newer = stack.fd.rebuildImage('gsp/steam-fake:s1');
    expect(await call('GET', '/v1/servers')).toMatchObject({ status: 200, body: [{ id: 'pz', imageId: first.imageId, latestImageId: newer }] });
    // Kept while its game runs: the same container, still on its image.
    expect(await call('PUT', '/v1/servers/pz?keepImage=true', { body: spec() })).toEqual({ status: 200, body: { ...first, latestImageId: newer } });
    // Not kept: the same spec is no longer a no-op.
    expect(await call('PUT', '/v1/servers/pz?keepImage=false', { body: spec() })).toMatchObject({ status: 200, body: { state: 'created', imageId: newer, latestImageId: newer } });
    expect(await call('DELETE', '/v1/servers/pz?removeVolumes=true')).toMatchObject({ status: 200 });
  });

  it('keeps a container another release derived while the panel asks, and recreates it when it does not (SRV-06, NFR-02, D3)', async () => {
    expect(await call('PUT', '/v1/servers/pz', { body: spec() })).toMatchObject({ status: 200, body: { derivation: 'current' } });
    // The next release, on the same Docker and socket path of its own.
    const own = socketPath('orch-next');
    const next = createOrchestratorServer({
      backend: new DockerBackend({ docker: stack.docker, ctx, policy, derivation: { version: DERIVATION_VERSION + 1, safeFrom: 0 } }),
      token: TOKEN,
      version: 'next',
      policy,
    });
    await listenOnSocket(next, own);
    try {
      expect(await request(own, 'GET', '/v1/servers')).toMatchObject({ status: 200, body: [{ id: 'pz', derivation: 'changed' }] });
      const before = stack.fd.writes().length;
      expect(await request(own, 'PUT', '/v1/servers/pz?keepImage=true&keepDerivation=true', { body: spec() })).toMatchObject({ status: 200, body: { derivation: 'changed' } });
      expect(stack.fd.writes().length).toBe(before);
      expect(await request(own, 'PUT', '/v1/servers/pz?keepDerivation=false', { body: spec() })).toMatchObject({ status: 200, body: { state: 'created', derivation: 'current' } });
      expect(await request(own, 'DELETE', '/v1/servers/pz?removeVolumes=true')).toMatchObject({ status: 200 });
    } finally {
      await new Promise((r) => next.close(r));
    }
  });

  it('logs one line per request, never a body or a token', () => {
    expect(lines.some((l) => /^PUT \/v1\/servers\/pz 200 \d+ms$/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/token|AGENT_TOKEN|Bearer/i);
  });
});
