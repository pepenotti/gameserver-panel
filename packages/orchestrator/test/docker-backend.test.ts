import { afterEach, describe, expect, it } from 'vitest';
import type { FakeDocker } from '../../../tools/fake-docker/fake-docker';
import { DockerBackend } from '../src/docker-backend';
import { DockerClient } from '../src/docker';
import { specHash } from '../src/hash';
import { AGENT_TOKEN, ctx, dockerStack, policy, spec, STACK, type DockerStack } from './helpers';

const MIB = 1024 * 1024;
let stack: DockerStack | null = null;
afterEach(async () => {
  await stack?.fd.close();
  stack = null;
});
async function setup(o: Parameters<typeof dockerStack>[0] = {}): Promise<DockerStack> {
  stack = await dockerStack(o);
  return stack;
}

/** What `fn` rejects with, as the API would answer it. */
async function rejection(p: Promise<unknown>): Promise<{ code?: string; field?: string; status?: number; message?: string }> {
  try {
    await p;
  } catch (e) {
    const x = e as { code?: string; field?: string; status?: number; message?: string };
    return { code: x.code, field: x.field, status: x.status, message: x.message };
  }
  throw new Error('expected a rejection');
}

const writes = (fd: FakeDocker) => fd.writes().map((c) => `${c.method} ${c.path}`);

describe('creating a server (D3, NFR-02, NFR-03)', () => {
  it('creates its volumes, its network with the panel on it, then the container, and nothing else', async () => {
    const { fd, backend } = await setup();
    const c = await backend.apply(spec());
    expect(writes(fd)).toEqual([
      'POST /volumes/create',
      'POST /volumes/create',
      'POST /volumes/create',
      'POST /networks/create',
      `POST /networks/${STACK}-net-pz/connect`,
      'POST /containers/create',
    ]);
    // Every call speaks the pinned API version.
    expect(new Set(fd.calls.map((x) => x.version))).toEqual(new Set(['v1.44']));
    expect(c).toMatchObject({ id: 'pz', state: 'created', startedAt: null, exitCode: null, image: 'gsp/steam-fake:s1', specHash: specHash(spec()), agentUrl: `http://${STACK}-srv-pz:8081` });

    const vols = fd.writes().filter((x) => x.path === '/volumes/create').map((x) => x.body);
    expect(vols).toEqual(['data', 'install', 'steam'].map((kind) => ({ Name: `${STACK}-srv-pz-${kind}`, Driver: 'local', Labels: { 'gsp.stack': STACK, 'gsp.server': 'pz', 'gsp.volume': kind } })));
    expect(fd.writes().find((x) => x.path === '/networks/create')?.body).toEqual({
      Name: `${STACK}-net-pz`,
      Driver: 'bridge',
      Internal: false,
      Attachable: false,
      EnableIPv6: false,
      Labels: { 'gsp.stack': STACK, 'gsp.server': 'pz' },
    });
    expect(fd.writes().find((x) => x.path.endsWith('/connect'))?.body).toEqual({ Container: stack!.panelId });
  });

  it('derives every security-relevant setting itself, field by field', async () => {
    const { fd, backend } = await setup();
    await backend.apply({ ...spec(), cpus: 2 });
    const create = fd.writes().find((x) => x.path === '/containers/create')!;
    expect(create.query).toEqual({ name: `${STACK}-srv-pz` });
    const body = create.body as Record<string, unknown> & { HostConfig: Record<string, unknown>; Labels: Record<string, string> };
    expect(Object.keys(body).sort()).toEqual(['Env', 'ExposedPorts', 'HostConfig', 'Image', 'Labels', 'NetworkingConfig', 'StopTimeout', 'User']);
    expect(body.Image).toBe('gsp/steam-fake:s1');
    expect(body.User).toBe('1000:1000');
    expect(body.StopTimeout).toBe(240);
    expect(body.Env).toEqual([
      `AGENT_TOKEN=${AGENT_TOKEN}`,
      'GAME_ADAPTER=pz',
      'GAME_DATA_DIR=/data',
      'GAME_INSTALL_DIR=/opt/game',
      'GAME_PORT_GAME=30161',
      'GAME_PORT_UDP=30162',
      'TZ=Europe/Madrid',
    ]);
    expect(body.ExposedPorts).toEqual({ '30161/udp': {}, '30162/udp': {} });
    expect(body.NetworkingConfig).toEqual({ EndpointsConfig: { [`${STACK}-net-pz`]: {} } });
    expect(body.Labels).toEqual({ 'gsp.stack': STACK, 'gsp.server': 'pz', 'gsp.spec-hash': specHash({ ...spec(), cpus: 2 }), 'gsp.config-hash': expect.stringMatching(/^[0-9a-f]{64}$/) });

    const hc = body.HostConfig;
    expect(Object.keys(hc).sort()).toEqual([
      'CapDrop',
      'IpcMode',
      'LogConfig',
      'Memory',
      'MemorySwap',
      'Mounts',
      'NanoCpus',
      'NetworkMode',
      'PidsLimit',
      'PortBindings',
      'Privileged',
      'ReadonlyRootfs',
      'RestartPolicy',
      'SecurityOpt',
      'Tmpfs',
    ]);
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(hc.Privileged).toBe(false);
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.Tmpfs).toEqual({ '/tmp': 'rw,exec,nosuid,nodev,size=256m' });
    expect(hc.PidsLimit).toBe(4096);
    expect(hc.Memory).toBe(2048 * MIB);
    expect(hc.MemorySwap).toBe(2048 * MIB);
    expect(hc.NanoCpus).toBe(2e9);
    expect(hc.IpcMode).toBe('private');
    expect(hc.RestartPolicy).toEqual({ Name: 'unless-stopped', MaximumRetryCount: 0 });
    expect(hc.LogConfig).toEqual({ Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } });
    expect(hc.NetworkMode).toBe(`${STACK}-net-pz`);
    expect(hc.Mounts).toEqual([
      { Type: 'volume', Source: `${STACK}-srv-pz-data`, Target: '/data', ReadOnly: false },
      { Type: 'volume', Source: `${STACK}-srv-pz-install`, Target: '/opt/game', ReadOnly: false },
      { Type: 'volume', Source: `${STACK}-srv-pz-steam`, Target: '/home/node', ReadOnly: false },
    ]);
    expect(hc.PortBindings).toEqual({
      '30161/udp': [{ HostIp: '127.0.0.1', HostPort: '30161' }],
      '30162/udp': [{ HostIp: '127.0.0.1', HostPort: '30162' }],
    });
    // What it never sets.
    for (const k of ['Binds', 'CapAdd', 'Devices', 'DeviceRequests', 'PidMode', 'UsernsMode', 'VolumesFrom', 'Links', 'ExtraHosts', 'Sysctls']) expect(hc, k).not.toHaveProperty(k);
  });

  it('gives each runtime family its own image and only its own volumes', async () => {
    const { fd, backend } = await setup();
    const { variant: _, ...plain } = spec({ id: 'mc', ports: [], env: { AGENT_TOKEN, GAME_ADAPTER: 'mc', TZ: 'UTC' } });
    await backend.apply({ ...plain, runtime: 'java' });
    const body = fd.writes().find((x) => x.path === '/containers/create')!.body as { Image: string; HostConfig: { Mounts: { Source: string }[] } };
    expect(body.Image).toBe('gsp/java:s1');
    expect(body.HostConfig.Mounts.map((m) => m.Source)).toEqual([`${STACK}-srv-mc-data`, `${STACK}-srv-mc-install`]);
  });

  it('changes nothing when the same spec comes again, and rejoins a recreated panel', async () => {
    const { fd, backend } = await setup();
    await backend.apply(spec());
    const before = fd.writes().length;
    expect((await backend.apply(spec())).state).toBe('created');
    expect(fd.writes().length).toBe(before);

    // The panel container was recreated (docker compose up): not on the server's network any more.
    const panel = fd.containers.get(stack!.panelId)!;
    fd.containers.delete(panel.Id);
    for (const n of fd.networks.values()) delete n.Containers[panel.Id];
    const fresh = fd.addContainer({ name: `${STACK}-panel-1`, running: true, labels: { 'com.docker.compose.project': STACK, 'com.docker.compose.service': 'panel' } });
    await backend.apply(spec());
    expect(fd.writes().slice(before).map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body)}`)).toEqual([`POST /networks/${STACK}-net-pz/connect {"Container":"${fresh.Id}"}`]);
  });

  it('recreates the container for a different spec, stopping it first and keeping its volumes', async () => {
    const { fd, backend } = await setup();
    await backend.apply(spec());
    await backend.start('pz');
    const oldId = [...fd.containers.values()].find((c) => c.Name === `/${STACK}-srv-pz`)!.Id;
    const before = fd.writes().length;
    const c = await backend.apply(spec({ memoryMb: 3072 }));
    expect(fd.writes().slice(before).map((x) => `${x.method} ${x.path}`)).toEqual([`POST /containers/${oldId}/stop`, `DELETE /containers/${oldId}`, 'POST /containers/create']);
    expect(fd.writes().slice(before)[0]?.query).toEqual({ t: '240' });
    expect(c).toMatchObject({ state: 'created', specHash: specHash(spec({ memoryMb: 3072 })) });
    expect(fd.volumes.size).toBe(3);
  });

  it('refuses when the image is not built, or no panel of this stack exists to join', async () => {
    const { fd, backend } = await setup();
    fd.images = new Set(['gsp/steam:s1']);
    expect(await rejection(backend.apply(spec()))).toMatchObject({ code: 'unavailable', message: expect.stringContaining('gsp/steam-fake:s1') });

    const other = await dockerStack({ panel: false });
    try {
      expect(await rejection(other.backend.apply(spec()))).toMatchObject({ code: 'unavailable', message: expect.stringContaining('panel') });
      expect(writes(other.fd)).not.toContain('POST /containers/create');
    } finally {
      await other.fd.close();
    }
  });
});

describe('what it refuses against Docker (NFR-02, SRV-01, SRV-05)', () => {
  it('refuses host ports another container publishes, whatever its project', async () => {
    const { fd, backend } = await setup();
    fd.addContainer({ name: 'prodstack-caddy-1', running: true, labels: { 'com.docker.compose.project': 'prodstack' }, ports: [{ container: 443, host: 30162, proto: 'udp' }] });
    fd.addContainer({ name: 'loose', running: true, ports: [{ container: 1, host: 30170, proto: 'tcp' }] });
    expect(await rejection(backend.apply(spec()))).toEqual({ code: 'conflict', field: 'ports[1].host', status: 409, message: expect.stringContaining('30162/udp') });
    expect(await rejection(backend.apply(spec({ ports: [{ container: 1, host: 30170, proto: 'tcp' }] })))).toMatchObject({ code: 'conflict', field: 'ports[0].host' });
    // Same number, other protocol: free.
    await backend.apply(spec({ ports: [{ container: 1, host: 30170, proto: 'udp' }] }));
    expect(writes(fd)).toContain('POST /containers/create');
  });

  it("refuses ports this stack's stopped servers hold, but not the server's own", async () => {
    const { backend } = await setup();
    await backend.apply(spec());
    expect(await rejection(backend.apply(spec({ id: 'pz-2' })))).toMatchObject({ code: 'conflict', field: 'ports[0].host', message: expect.stringContaining('server pz') });
    await backend.apply(spec({ memoryMb: 1024 }));
  });

  it('refuses more servers than ORCH_MAX_SERVERS, counting servers whose container is gone', async () => {
    const { fd, backend } = await setup();
    await backend.apply(spec({ id: 'a1', ports: [] }));
    await backend.apply(spec({ id: 'a2', ports: [] }));
    fd.addNetwork({ name: `${STACK}-net-a3`, labels: { 'gsp.stack': STACK, 'gsp.server': 'a3' } });
    expect(await rejection(backend.apply(spec({ id: 'a4', ports: [] })))).toEqual({ code: 'refused', field: 'id', status: 403, message: expect.stringContaining('at most 3') });
    // Existing ones may still change, and another stack's servers don't count.
    fd.addContainer({ name: 'gsp-s2-srv-b1', labels: { 'gsp.stack': 'gsp-s2', 'gsp.server': 'b1' } });
    await backend.apply(spec({ id: 'a2', ports: [], memoryMb: 1024 }));
    await backend.apply(spec({ id: 'a3', ports: [] }));
  });

  it("refuses more CPUs than the host has", async () => {
    const { fd, backend } = await setup();
    expect(await rejection(backend.apply({ ...spec(), cpus: 9 }))).toMatchObject({ code: 'refused', field: 'cpus' });
    expect(writes(fd)).toEqual([]);
  });

  it('never touches a container, network or volume that carries its name but not its labels (spoofing)', async () => {
    const { fd, backend } = await setup();
    const impostor = fd.addContainer({ name: `${STACK}-srv-pz`, running: true, labels: { 'gsp.server': 'pz' } });
    for (const call of [() => backend.apply(spec()), () => backend.start('pz'), () => backend.stop('pz'), () => backend.restart('pz'), () => backend.stats('pz'), () => backend.remove('pz', true)]) {
      expect(await rejection(call())).toMatchObject({ code: 'refused', field: 'id' });
    }
    // Another stack's label on our name is no better.
    impostor.Config.Labels = { 'gsp.stack': 'gsp-s2', 'gsp.server': 'pz' };
    expect(await rejection(backend.start('pz'))).toMatchObject({ code: 'refused' });
    // Nor are our labels on another name.
    impostor.Name = '/gsp-s1-something-else';
    impostor.Config.Labels = { 'gsp.stack': STACK, 'gsp.server': 'pz' };
    expect(await rejection(backend.start('pz'))).toMatchObject({ code: 'not-found' });
    expect(await backend.list()).toEqual([]);
    expect(writes(fd)).toEqual([]);

    fd.addVolume({ name: `${STACK}-srv-pz-data`, labels: { 'gsp.stack': 'gsp-s2', 'gsp.server': 'pz' } });
    expect(await rejection(backend.apply(spec()))).toMatchObject({ code: 'refused', field: 'id', message: expect.stringContaining('Volume') });
    fd.volumes.clear();
    fd.addNetwork({ name: `${STACK}-net-pz` });
    expect(await rejection(backend.apply(spec()))).toMatchObject({ code: 'refused', field: 'id', message: expect.stringContaining('Network') });
    expect(await rejection(backend.remove('pz', true))).toMatchObject({ code: 'refused' });
    expect(writes(fd)).toEqual([]);
  });

  it("never reaches another stack's servers", async () => {
    const { fd, backend } = await setup();
    const theirs = fd.addContainer({ name: 'gsp-s2-srv-pz', running: true, labels: { 'gsp.stack': 'gsp-s2', 'gsp.server': 'pz' } });
    expect(await backend.list()).toEqual([]);
    for (const call of [() => backend.stop('pz'), () => backend.start('pz'), () => backend.restart('pz'), () => backend.stats('pz')]) {
      expect(await rejection(call())).toMatchObject({ code: 'not-found' });
    }
    expect(await backend.remove('pz', true)).toEqual({ removed: false, volumesRemoved: true });
    expect(theirs.State.Running).toBe(true);
    expect(writes(fd)).toEqual([]);
  });

  it('answers conflict when a server is being changed by another request, or its port is taken at start', async () => {
    const { fd, backend } = await setup();
    await backend.apply(spec());
    const [a, b] = await Promise.allSettled([backend.stop('pz'), backend.start('pz')]);
    expect(a.status).toBe('fulfilled');
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } });
    fd.failNext('POST', /\/start$/, 500, 'driver failed programming external connectivity on endpoint x: Bind for 127.0.0.1:30161 failed: port is already allocated');
    expect(await rejection(backend.start('pz'))).toMatchObject({ code: 'conflict', message: expect.stringContaining('already allocated') });
  });

  it('answers unavailable when Docker is not there', async () => {
    const { fd } = await setup();
    await fd.close();
    const gone = new DockerBackend({ docker: new DockerClient({ url: fd.url }), ctx, policy });
    for (const call of [() => gone.ping(), () => gone.list(), () => gone.apply(spec()), () => gone.host()]) expect(await rejection(call())).toMatchObject({ code: 'unavailable', status: 503 });
    stack = null;
  });
});

describe('running servers (SRV-03, SRV-06)', () => {
  it('starts, stops with the asked timeout, and restarts', async () => {
    const { fd, backend } = await setup();
    await backend.apply(spec());
    const started = await backend.start('pz');
    expect(started).toMatchObject({ state: 'running', exitCode: null });
    expect(started.startedAt).toMatch(/^\d{4}-/);
    expect((await backend.start('pz')).state).toBe('running');
    const stopped = await backend.stop('pz', 30);
    expect(stopped).toMatchObject({ state: 'exited', exitCode: 0 });
    expect(fd.writes().find((x) => x.path.endsWith('/stop'))?.query).toEqual({ t: '30' });
    expect((await backend.restart('pz')).state).toBe('running');
    expect(fd.writes().find((x) => x.path.endsWith('/restart'))?.query).toEqual({ t: '240' });
    expect(await rejection(backend.start('nope'))).toMatchObject({ code: 'not-found', status: 404 });
  });

  it("lists this stack's servers only, with a missing state for a server whose container is gone", async () => {
    const { fd, backend } = await setup();
    await backend.apply(spec({ id: 'b-srv', ports: [] }));
    await backend.apply(spec({ id: 'a-srv', ports: [] }));
    await backend.start('a-srv');
    fd.addContainer({ name: 'gsp-s2-srv-pz', labels: { 'gsp.stack': 'gsp-s2', 'gsp.server': 'pz' } });
    fd.addContainer({ name: 'unrelated', running: true });
    fd.addNetwork({ name: `${STACK}-net-gone`, labels: { 'gsp.stack': STACK, 'gsp.server': 'gone' } });
    const list = await backend.list();
    expect(list.map((c) => [c.id, c.state])).toEqual([
      ['a-srv', 'running'],
      ['b-srv', 'created'],
      ['gone', 'missing'],
    ]);
    expect(list[2]).toEqual({ id: 'gone', state: 'missing', startedAt: null, finishedAt: null, exitCode: null, image: '', specHash: '', agentUrl: `http://${STACK}-srv-gone:8081` });
  });

  it('reports stats as one sample: CPU in percent of one core, memory without page cache', async () => {
    const { backend } = await setup();
    await backend.apply(spec());
    const s = await backend.stats('pz');
    expect(s).toMatchObject({ id: 'pz', cpuPercent: 100, memBytes: 500 * MIB, memLimitBytes: 2048 * MIB, netRxBytes: 1010, netTxBytes: 2020 });
    expect(s.at).toMatch(/^\d{4}-/);
  });

  it("describes the host for HST-05 and SRV-05", async () => {
    const { fd, backend } = await setup();
    expect(await backend.host()).toEqual({ arch: 'amd64', cpus: 8, memBytes: 16 * 1024 ** 3, dockerVersion: '29.0.0-fake', os: 'Fake Linux' });
    fd.info.Architecture = 'aarch64';
    expect((await backend.host()).arch).toBe('arm64');
    fd.info.Architecture = 's390x';
    expect(await rejection(backend.host())).toMatchObject({ code: 'unavailable' });
  });
});

describe('removing a server (SRV-04)', () => {
  it('removes the container and its network, and keeps the volumes unless asked', async () => {
    const { fd, backend } = await setup();
    await backend.apply(spec());
    await backend.start('pz');
    expect(await backend.remove('pz', false)).toEqual({ removed: true, volumesRemoved: false });
    const w = writes(fd);
    expect(w.slice(-4)).toEqual([expect.stringMatching(/^POST \/containers\/[0-9a-f]+\/stop$/), expect.stringMatching(/^DELETE \/containers\//), expect.stringMatching(/^POST \/networks\/[0-9a-f]+\/disconnect$/), expect.stringMatching(/^DELETE \/networks\//)]);
    expect(fd.networks.size).toBe(1); // the panel's own
    expect(fd.volumes.size).toBe(3);
    expect(fd.containers.get(stack!.panelId)?.NetworkSettings.Networks).not.toHaveProperty(`${STACK}-net-pz`);

    await backend.apply(spec());
    expect(await backend.remove('pz', true)).toEqual({ removed: true, volumesRemoved: true });
    expect(fd.volumes.size).toBe(0);
    expect(await backend.list()).toEqual([]);
  });
});
