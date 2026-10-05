// The host's traits and what this stack takes of it (HST-03, HST-07, SRV-05):
// derived from Docker's /info, stats and /system/df alone, in the contract's
// own words, and never another stack's objects (D3, NFR-02).
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeDocker } from '../../../tools/fake-docker/fake-docker';
import { DockerBackend } from '../src/docker-backend';
import { DockerClient } from '../src/docker';
import { traitsOf } from '../src/host';
import { ctx, dockerStack, policy, spec, STACK, type DockerStack } from './helpers';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const INSTALL = 'i0123456789abcdef';

let stack: DockerStack | null = null;
afterEach(async () => {
  await stack?.fd.close();
  stack = null;
});
async function setup(): Promise<DockerStack> {
  stack = await dockerStack();
  return stack;
}

const dfCalls = (fd: FakeDocker) => fd.calls.filter((c) => c.path === '/system/df');
const installLabels = (s: string, id = INSTALL) => ({ 'gsp.stack': s, 'gsp.install': id, 'gsp.install.adapter': 'pz', 'gsp.install.flavour': '', 'gsp.install.runtime': 'steam', 'gsp.install.variant': 'fake' });

describe("the host's traits (HST-07, HST-05)", () => {
  it("Docker Desktop on Windows: its port relay hides players' addresses (measured)", () => {
    expect(traitsOf({ OperatingSystem: 'Docker Desktop', KernelVersion: '6.6.87.2-microsoft-standard-WSL2', Labels: ['com.docker.desktop.address=npipe://\\\\.\\pipe\\docker_cli'] })).toEqual({
      docker: 'desktop',
      platform: 'windows',
      addressesVisible: false,
    });
  });

  it('Docker Desktop on macOS and on Linux by its CLI socket, and still Docker Desktop when it says no more', () => {
    const desktop = (address: string | null, os = 'Docker Desktop') => traitsOf({ OperatingSystem: os, KernelVersion: '6.10.14-linuxkit', Labels: address === null ? null : [`com.docker.desktop.address=${address}`] });
    expect(desktop('unix:///Users/you/Library/Containers/com.docker.docker/Data/docker-cli.sock')).toEqual({ docker: 'desktop', platform: 'macos', addressesVisible: false });
    expect(desktop('unix:///home/you/.docker/desktop/docker-cli.sock')).toEqual({ docker: 'desktop', platform: 'linux', addressesVisible: false });
    expect(desktop(null)).toEqual({ docker: 'desktop', platform: null, addressesVisible: false });
    // Its label alone says Docker Desktop, whatever its operating system reads.
    expect(desktop('unix:///somewhere/else.sock', 'Alpine Linux v3.20')).toEqual({ docker: 'desktop', platform: null, addressesVisible: false });
  });

  it("Docker Engine on Linux and inside WSL: players' addresses are expected to arrive, never claimed before M7 measures it", () => {
    expect(traitsOf({ OperatingSystem: 'Ubuntu 24.04.1 LTS', KernelVersion: '6.8.0-45-generic', Labels: [] })).toEqual({ docker: 'engine', platform: 'linux', addressesVisible: 'expected' });
    expect(traitsOf({ OperatingSystem: 'Ubuntu 24.04.1 LTS', KernelVersion: '5.15.167.4-microsoft-standard-WSL2', Labels: null })).toEqual({ docker: 'engine', platform: 'windows', addressesVisible: 'expected' });
    // An older engine that leaves fields out.
    expect(traitsOf({ OperatingSystem: 'Debian GNU/Linux 12 (bookworm)' })).toEqual({ docker: 'engine', platform: 'linux', addressesVisible: 'expected' });
  });

  it('reports them with the host, in its own words: never a value of Docker as it came', async () => {
    const { fd, backend } = await setup();
    Object.assign(fd.info, { OperatingSystem: 'Docker Desktop', KernelVersion: '6.10.14-linuxkit', Labels: ['com.docker.desktop.address=unix:///Users/you/Library/Containers/com.docker.docker/Data/docker-cli.sock'], Architecture: 'aarch64' });
    const host = await backend.host();
    expect(host).toMatchObject({ arch: 'arm64', traits: { docker: 'desktop', platform: 'macos', addressesVisible: false } });
    expect(JSON.stringify(host)).not.toMatch(/Users|Library|docker-cli|linuxkit/);
  });
});

describe('what this stack takes now (HST-03, SRV-05, D3)', () => {
  it("measures this stack's volumes only, each by what it holds, and changes nothing", async () => {
    const { fd, backend } = await setup();
    await backend.apply(spec());
    Object.assign(fd.volumes.get(`${STACK}-srv-pz-data`)!, { size: 300 * MIB });
    Object.assign(fd.volumes.get(`${STACK}-srv-pz-install`)!, { size: 7 * GIB });
    Object.assign(fd.volumes.get(`${STACK}-srv-pz-steam`)!, { size: 200 * MIB });
    fd.addVolume({ name: `${STACK}-inst-${INSTALL}`, labels: installLabels(STACK), size: 7 * GIB });
    fd.addVolume({ name: `${STACK}-job-${INSTALL}-steam`, labels: { 'gsp.stack': STACK, 'gsp.install': INSTALL, 'gsp.volume': 'job-home' }, size: 10 * MIB });
    fd.addVolume({ name: `${STACK}_panel-data`, labels: { 'com.docker.compose.project': STACK, 'com.docker.compose.volume': 'panel-data' }, size: 2 * MIB });
    // Another stack's, shaped like ours.
    fd.addVolume({ name: 'gsp-s2-srv-pz-data', labels: { 'gsp.stack': 'gsp-s2', 'gsp.server': 'pz', 'gsp.volume': 'data' }, size: GIB });
    fd.addVolume({ name: `gsp-s2-inst-${INSTALL}`, labels: installLabels('gsp-s2'), size: GIB });
    fd.addVolume({ name: 'gsp-s2_panel-data', labels: { 'com.docker.compose.project': 'gsp-s2', 'com.docker.compose.volume': 'panel-data' }, size: GIB });
    // Our labels on another name, our names without our labels, labels that don't agree with each other.
    fd.addVolume({ name: 'stolen-data', labels: { 'gsp.stack': STACK, 'gsp.server': 'pz', 'gsp.volume': 'data' }, size: GIB });
    fd.addVolume({ name: `${STACK}-srv-other-data`, size: GIB });
    fd.addVolume({ name: `${STACK}-inst-i9999999999999999`, labels: { 'gsp.stack': STACK, 'gsp.install': 'i9999999999999999' }, size: GIB });
    fd.addVolume({ name: `${STACK}_caddy-data-2`, labels: { 'com.docker.compose.project': STACK, 'com.docker.compose.volume': 'caddy-data' }, size: GIB });
    fd.addVolume({ name: `${STACK}-srv-pz-world`, labels: { 'gsp.stack': STACK, 'gsp.server': 'pz', 'gsp.volume': 'world' }, size: GIB });
    fd.addVolume({ name: 'unrelated', size: GIB });
    const before = fd.writes().length;

    const u = await backend.usage();
    expect(u.volumes).toEqual([
      { name: `${STACK}-inst-${INSTALL}`, use: 'shared-install', server: null, install: INSTALL, bytes: 7 * GIB },
      { name: `${STACK}-job-${INSTALL}-steam`, use: 'job-home', server: null, install: INSTALL, bytes: 10 * MIB },
      { name: `${STACK}-srv-pz-data`, use: 'data', server: 'pz', install: null, bytes: 300 * MIB },
      { name: `${STACK}-srv-pz-install`, use: 'install', server: 'pz', install: null, bytes: 7 * GIB },
      { name: `${STACK}-srv-pz-steam`, use: 'steam', server: 'pz', install: null, bytes: 200 * MIB },
      { name: `${STACK}_panel-data`, use: 'stack', server: null, install: null, bytes: 2 * MIB },
    ]);
    expect(u.volumesAt).toMatch(/^\d{4}-/);
    expect(JSON.stringify(u)).not.toMatch(/gsp-s2|stolen|other|i9999|caddy-data-2|world|unrelated/);
    // Volumes only, asked once; nothing written.
    expect(dfCalls(fd).map((c) => c.query)).toEqual([{ type: 'volume' }]);
    expect(fd.writes().length).toBe(before);
  });

  it('a size Docker could not measure is unknown, not a number', async () => {
    const { fd, backend } = await setup();
    fd.addVolume({ name: `${STACK}-inst-${INSTALL}`, labels: installLabels(STACK), size: -1 });
    expect((await backend.usage()).volumes).toEqual([{ name: `${STACK}-inst-${INSTALL}`, use: 'shared-install', server: null, install: INSTALL, bytes: null }]);
  });

  it("samples each running server of this stack, side by side, and none of another stack's", async () => {
    const { fd, backend } = await setup();
    await backend.apply(spec({ id: 'b-srv', ports: [] }));
    await backend.apply(spec({ id: 'a-srv', ports: [] }));
    await backend.start('a-srv');
    fd.addContainer({ name: 'gsp-s2-srv-pz', running: true, labels: { 'gsp.stack': 'gsp-s2', 'gsp.server': 'pz' } });
    fd.addContainer({ name: 'not-ours', running: true, labels: { 'gsp.stack': STACK, 'gsp.server': 'zz' } });
    fd.addContainer({ name: 'unrelated', running: true });
    const u = await backend.usage();
    expect(u.servers).toEqual([
      { id: 'a-srv', state: 'running', stats: expect.objectContaining({ id: 'a-srv', cpuPercent: 100, memBytes: 500 * MIB, memLimitBytes: 2048 * MIB }) as unknown },
      { id: 'b-srv', state: 'created', stats: null },
    ]);
    const aId = [...fd.containers.values()].find((c) => c.Name === `/${STACK}-srv-a-srv`)!.Id;
    const sampled = fd.calls.filter((c) => c.path.endsWith('/stats'));
    expect(sampled.map((c) => [c.path, c.query])).toEqual([[`/containers/${aId}/stats`, { stream: 'false' }]]);
    expect(u.at).toMatch(/^\d{4}-/);
  });

  it('a server that stops between the listing and its sample has no sample, which is no failure', async () => {
    const { fd, backend } = await setup();
    await backend.apply(spec({ ports: [] }));
    await backend.start('pz');
    fd.failNext('GET', /\/stats$/, 404, 'No such container');
    expect((await backend.usage()).servers).toEqual([{ id: 'pz', state: 'running', stats: null }]);
  });

  it('keeps a measure of the disk a little while (Docker walks every file for it, one walk at a time)', async () => {
    const { fd, docker } = await setup();
    fd.addVolume({ name: `${STACK}-inst-${INSTALL}`, labels: installLabels(STACK), size: GIB });
    let now = Date.parse('2026-10-05T10:00:00.000Z');
    const backend = new DockerBackend({ docker, ctx, policy, now: () => now, diskUsageTtlMs: 30_000 });
    const first = await backend.usage();
    now += 29_000;
    expect((await backend.usage()).volumesAt).toBe(first.volumesAt);
    expect(dfCalls(fd)).toHaveLength(1);
    // Asked twice at once once it is old: measured once.
    now += 2_000;
    fd.volumes.get(`${STACK}-inst-${INSTALL}`)!.size = 2 * GIB;
    const [a, b] = await Promise.all([backend.usage(), backend.usage()]);
    expect(dfCalls(fd)).toHaveLength(2);
    expect(a.volumes?.[0]?.bytes).toBe(2 * GIB);
    expect(b.volumesAt).toBe(new Date(now).toISOString());
    // Docker measures for someone else: the last measure stands, its time says how old.
    now += 31_000;
    fd.failNext('GET', /^\/system\/df$/, 409, 'a disk usage operation is already running');
    const busy = await backend.usage();
    expect(busy.volumes?.[0]?.bytes).toBe(2 * GIB);
    expect(busy.volumesAt).toBe(a.volumesAt);
    expect(Date.parse(busy.at) - Date.parse(busy.volumesAt!)).toBe(31_000);
  });

  it('without any measure yet, a busy Docker leaves the disk unknown and still reports the servers', async () => {
    const { fd, backend } = await setup();
    await backend.apply(spec({ ports: [] }));
    fd.failNext('GET', /^\/system\/df$/, 409, 'a disk usage operation is already running');
    const u = await backend.usage();
    expect(u).toMatchObject({ volumes: null, volumesAt: null, servers: [{ id: 'pz', state: 'created', stats: null }] });
  });

  it('answers unavailable when Docker is not there', async () => {
    const { fd } = await setup();
    await fd.close();
    const gone = new DockerBackend({ docker: new DockerClient({ url: fd.url }), ctx, policy });
    await expect(gone.usage()).rejects.toMatchObject({ code: 'unavailable', status: 503 });
    stack = null;
  });
});
