// Shared installs (HST-09, D12, D3, NFR-02, NFR-03): install volumes, install
// and copy jobs, and servers mounting an install read-only, all derived by
// the orchestrator, with a refusal for every rule.
import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SHARED_INSTALL_MARKER, type InstallJobSpec, type ServerSpec } from '@gsp/shared';
import type { FakeDocker } from '../../../tools/fake-docker/fake-docker';
import { DERIVATION_VERSION, planContainer } from '../src/derive';
import { createOrchestratorServer } from '../src/http';
import { COPY_COMMAND, JOB_DATA_TMPFS, MAX_INSTALL_JOBS } from '../src/installs';
import { listenOnSocket } from '../src/listen';
import { parseInstallJobSpec, parseInstallPutOptions, parseSpec } from '../src/spec';
import { OrchError } from '../src/errors';
import { AGENT_TOKEN, ctx, dockerStack, policy, request, socketPath, spec, STACK, TOKEN, type DockerStack } from './helpers';

const MIB = 1024 * 1024;
const IID = 'i0123456789abcdef';
const IID2 = 'ifedcba9876543210';
const VOL = `${STACK}-inst-${IID}`;
const JOB = `${STACK}-job-${IID}`;

let stack: DockerStack | null = null;
afterEach(async () => {
  await stack?.fd.close();
  stack = null;
});
async function setup(o: Parameters<typeof dockerStack>[0] = {}): Promise<DockerStack> {
  stack = await dockerStack(o);
  return stack;
}

async function rejection(p: Promise<unknown>): Promise<{ code?: string; field?: string; status?: number; message?: string; reason?: string }> {
  try {
    await p;
  } catch (e) {
    const x = e as { code?: string; field?: string; status?: number; message?: string; reason?: string };
    return { code: x.code, field: x.field, status: x.status, message: x.message, reason: x.reason };
  }
  throw new Error('expected a rejection');
}

function answer(fn: () => unknown): { code: string; field?: string; status: number } {
  try {
    fn();
  } catch (e) {
    if (e instanceof OrchError) return { code: e.code, field: e.field, status: e.status };
    throw e;
  }
  throw new Error('expected a refusal, got none');
}

const writes = (fd: FakeDocker) => fd.writes().map((c) => `${c.method} ${c.path}`);

/** An install job spec for Project Zomboid in the fake steam image. */
const jobSpec = (over: Partial<InstallJobSpec> = {}): InstallJobSpec => ({ id: IID, runtime: 'steam', variant: 'fake', env: { AGENT_TOKEN, GAME_ADAPTER: 'pz', TZ: 'Europe/Madrid' }, ...over });
/** A server spec on install `IID`. */
const onInstall = (over: Partial<ServerSpec> = {}): ServerSpec => spec({ install: IID, ...over });
/** What an install job leaves: the shared-install marker. */
const marker = (o: { adapter?: string; flavour?: string | null } = {}) =>
  JSON.stringify({ schema: 1, adapter: o.adapter ?? 'pz', flavour: o.flavour ?? null, mode: 'shared', key: { flavour: null, version: null, build: '1', branch: 'public' }, installed: null, redirects: [], bytes: 1, files: 1, agentVersion: 'test', finishedAt: new Date().toISOString() });

/** An install as a finished job leaves it: its volume, with the marker, and no job. */
async function readyInstall(s: DockerStack, id = IID, o: { adapter?: string } = {}): Promise<void> {
  await s.backend.putInstall(jobSpec({ id, env: { AGENT_TOKEN, GAME_ADAPTER: o.adapter ?? 'pz', TZ: 'UTC' } }), null);
  s.fd.volumes.get(`${STACK}-inst-${id}`)!.files.set(SHARED_INSTALL_MARKER, marker({ adapter: o.adapter }));
  await s.backend.removeInstallJob(id);
}

describe('a server on a shared install (HST-09, D12, NFR-02)', () => {
  it("mounts the install read-only where the game's install goes, tells the agent, and makes no install volume of its own", () => {
    const plan = planContainer(onInstall(), ctx);
    expect(plan.body.HostConfig.Mounts).toEqual([
      { Type: 'volume', Source: `${STACK}-srv-pz-data`, Target: '/data', ReadOnly: false },
      { Type: 'volume', Source: VOL, Target: '/opt/game', ReadOnly: true },
      { Type: 'volume', Source: `${STACK}-srv-pz-steam`, Target: '/home/node', ReadOnly: false },
    ]);
    expect(plan.body.Env).toContain('GSP_INSTALL_SHARED=1');
    expect(plan.volumes.map((v) => v.kind)).toEqual(['data', 'steam']);
    expect(plan.install).toEqual({ id: IID, volume: VOL });
    // A spec without one derives as before (the pinned hashes in derive.test.ts): no new derivation version.
    const own = planContainer(spec(), ctx);
    expect(own.install).toBeNull();
    expect(own.body.Env.some((e) => e.startsWith('GSP_INSTALL_SHARED'))).toBe(false);
    expect(own.body.HostConfig.Mounts.every((m) => m.ReadOnly === false)).toBe(true);
    expect(own.body.Labels['gsp.derivation']).toBe(String(DERIVATION_VERSION));
  });

  it('never lets a spec mount an install read-write, name a malformed one, or say it is shared or a job itself', () => {
    expect(answer(() => parseSpec({ ...spec(), install: 'pz' }, 'pz', policy))).toEqual({ code: 'bad-request', field: 'install', status: 400 });
    expect(answer(() => parseSpec({ ...spec(), install: 42 }, 'pz', policy))).toEqual({ code: 'bad-request', field: 'install', status: 400 });
    expect(answer(() => parseSpec({ ...spec(), install: `../${IID}` }, 'pz', policy))).toEqual({ code: 'bad-request', field: 'install', status: 400 });
    for (const key of ['installReadOnly', 'readOnly', 'installMode', 'mounts']) expect(answer(() => parseSpec({ ...spec(), [key]: false }, 'pz', policy)), key).toEqual({ code: 'refused', field: key, status: 403 });
    for (const env of ['GSP_INSTALL_SHARED', 'GSP_AGENT_MODE']) expect(answer(() => parseSpec({ ...spec(), env: { ...spec().env, [env]: '0' } }, 'pz', policy)), env).toEqual({ code: 'refused', field: `env.${env}`, status: 403 });
    expect(parseSpec(JSON.parse(JSON.stringify(onInstall())), 'pz', policy)).toEqual(onInstall());
  });

  it('creates the server on a finished install: the install read-only, read through a probe that is gone again', async () => {
    const s = await setup();
    await readyInstall(s);
    const before = s.fd.writes().length;
    await s.backend.apply(onInstall());
    const probeOnce = ['POST /containers/create', `DELETE /containers/${STACK}-probe-${IID}`];
    expect(writes(s.fd).slice(before)).toEqual([
      // Checked before anything changes, and again once no other create can race: a probe each time.
      ...probeOnce,
      ...probeOnce,
      'POST /volumes/create',
      'POST /volumes/create',
      'POST /networks/create',
      `POST /networks/${STACK}-net-pz/connect`,
      'POST /containers/create',
    ]);
    const probe = s.fd.writes().slice(before).find((c) => c.path === '/containers/create' && c.query.name === `${STACK}-probe-${IID}`)!.body as { HostConfig: Record<string, unknown>; Cmd: string[]; User: string };
    // Never started, nothing to run, no network, the install read-only.
    expect(probe.HostConfig).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], Mounts: [{ Type: 'volume', Source: VOL, Target: '/opt/game', ReadOnly: true }] });
    expect(probe.User).toBe('1000:1000');
    expect(s.fd.writes().some((c) => c.path.endsWith('/start') && c.path.includes('probe'))).toBe(false);
    expect([...s.fd.containers.values()].map((c) => c.Name)).not.toContain(`/${STACK}-probe-${IID}`);
    // Its own volumes only: data and HOME, never an install of its own.
    expect([...s.fd.volumes.keys()].sort()).toEqual([`${STACK}-inst-${IID}`, `${STACK}-srv-pz-data`, `${STACK}-srv-pz-steam`].sort());
    const create = s.fd.writes().filter((c) => c.path === '/containers/create').at(-1)!.body as { HostConfig: { Mounts: unknown[] }; Env: string[] };
    expect(create.HostConfig.Mounts).toContainEqual({ Type: 'volume', Source: VOL, Target: '/opt/game', ReadOnly: true });
    expect(create.Env).toContain('GSP_INSTALL_SHARED=1');
    expect((await s.backend.installs())[0]).toMatchObject({ id: IID, mountedBy: ['pz'], job: null });
    // The same spec again: nothing to do, no probe.
    const after = s.fd.writes().length;
    await s.backend.apply(onInstall());
    expect(s.fd.writes().length).toBe(after);
  });

  it("refuses an install that doesn't exist, another stack's, one of another game, flavour or image, one with a job, and one no job finished", async () => {
    const s = await setup();
    expect(await rejection(s.backend.apply(onInstall()))).toMatchObject({ code: 'refused', field: 'install', status: 403, message: expect.stringContaining('does not exist') });
    // Another stack's volume under our install's name.
    s.fd.addVolume({ name: VOL, labels: { 'gsp.stack': 'gsp-s2', 'gsp.install': IID, 'gsp.install.adapter': 'pz', 'gsp.install.runtime': 'steam' }, files: { [SHARED_INSTALL_MARKER]: marker() } });
    expect(await rejection(s.backend.apply(onInstall()))).toMatchObject({ code: 'refused', field: 'install', message: expect.stringContaining('not this stack') });
    s.fd.volumes.clear();
    await readyInstall(s);
    expect(await rejection(s.backend.apply(onInstall({ env: { ...spec().env, GAME_ADAPTER: 'minecraft' } })))).toMatchObject({ code: 'refused', field: 'install', message: expect.stringContaining("doesn't fit") });
    expect(await rejection(s.backend.apply(onInstall({ env: { ...spec().env, GAME_FLAVOUR: 'modded' } })))).toMatchObject({ code: 'refused', field: 'install' });
    expect(await rejection(s.backend.apply(onInstall({ runtime: 'native' })))).toMatchObject({ code: 'refused', field: 'install' });
    const { variant: _v, ...plain } = onInstall();
    expect(await rejection(s.backend.apply(plain))).toMatchObject({ code: 'refused', field: 'install' });
    // A job (an update on it, say): never mounted half-written.
    await s.backend.putInstall(jobSpec(), null);
    expect(await rejection(s.backend.apply(onInstall()))).toMatchObject({ code: 'conflict', field: 'install', status: 409, reason: 'install-busy' });
    await s.backend.removeInstallJob(IID);
    // No marker: no job finished it (a failed one, or one still to run).
    s.fd.volumes.get(VOL)!.files.clear();
    expect(await rejection(s.backend.apply(onInstall()))).toMatchObject({ code: 'conflict', field: 'install', reason: 'install-not-ready' });
    // A marker of another game than its volume says.
    s.fd.volumes.get(VOL)!.files.set(SHARED_INSTALL_MARKER, marker({ adapter: 'minecraft' }));
    expect(await rejection(s.backend.apply(onInstall()))).toMatchObject({ code: 'refused', field: 'install', message: expect.stringContaining('marker') });
    // Nothing of the server was made, and no probe stayed.
    expect([...s.fd.containers.values()].map((c) => c.Name).filter((n) => n.includes('-srv-') || n.includes('-probe-'))).toEqual([]);
    expect([...s.fd.volumes.keys()]).toEqual([VOL]);
  });

  it("never touches the install when the server is removed, its volumes too; and refuses a probe's name taken by something else", async () => {
    const s = await setup();
    await readyInstall(s);
    await s.backend.apply(onInstall());
    expect(await s.backend.remove('pz', true)).toEqual({ removed: true, volumesRemoved: true });
    expect([...s.fd.volumes.keys()]).toEqual([VOL]);
    s.fd.addContainer({ name: `${STACK}-probe-${IID}`, labels: { 'gsp.stack': 'gsp-s2' } });
    expect(await rejection(s.backend.apply(onInstall()))).toMatchObject({ code: 'refused', field: 'install', message: expect.stringContaining('probe') });
  });
});

describe('install jobs (HST-09, D3, NFR-02, NFR-03)', () => {
  it('creates the install volume, a network of its own with the panel on it, a fresh HOME, then the job, and starts it', async () => {
    const s = await setup();
    const info = await s.backend.putInstall(jobSpec(), null);
    expect(writes(s.fd)).toEqual(['POST /volumes/create', 'POST /volumes/create', 'POST /networks/create', `POST /networks/${STACK}-jobnet-${IID}/connect`, 'POST /containers/create', `POST /containers/${JOB}/start`]);
    const [vol, home] = s.fd.writes().filter((c) => c.path === '/volumes/create').map((c) => c.body);
    expect(vol).toEqual({ Name: VOL, Driver: 'local', Labels: { 'gsp.stack': STACK, 'gsp.install': IID, 'gsp.install.adapter': 'pz', 'gsp.install.flavour': '', 'gsp.install.runtime': 'steam', 'gsp.install.variant': 'fake' } });
    expect(home).toEqual({ Name: `${STACK}-job-${IID}-steam`, Driver: 'local', Labels: { 'gsp.stack': STACK, 'gsp.install': IID, 'gsp.volume': 'job-home' } });
    expect(s.fd.writes().find((c) => c.path === '/networks/create')?.body).toEqual({ Name: `${STACK}-jobnet-${IID}`, Driver: 'bridge', Internal: false, Attachable: false, EnableIPv6: false, Labels: { 'gsp.stack': STACK, 'gsp.install': IID } });
    expect(info).toMatchObject({ id: IID, adapter: 'pz', flavour: null, runtime: 'steam', variant: 'fake', volume: VOL, mountedBy: [], job: { kind: 'install', state: 'running', agentUrl: `http://${JOB}:8081`, from: null, image: 'gsp/steam-fake:s1', exitCode: null } });
  });

  it('derives every security-relevant setting itself, as hardened as a server: no ports ever, a fixed memory limit, /data a small tmpfs', async () => {
    const s = await setup();
    await s.backend.putInstall(jobSpec({ env: { AGENT_TOKEN, GAME_ADAPTER: 'pz', TZ: 'UTC', GAME_PORT_GAME: '30161' } }), null);
    const create = s.fd.writes().find((x) => x.path === '/containers/create')!;
    expect(create.query).toEqual({ name: JOB });
    const body = create.body as Record<string, unknown> & { HostConfig: Record<string, unknown>; Env: string[]; Labels: Record<string, string> };
    expect(Object.keys(body).sort()).toEqual(['Env', 'ExposedPorts', 'HostConfig', 'Image', 'Labels', 'NetworkingConfig', 'StopTimeout', 'User']);
    expect(body.Image).toBe('gsp/steam-fake:s1');
    expect(body.User).toBe('1000:1000');
    expect(body.ExposedPorts).toEqual({});
    expect(body.Env).toEqual([`AGENT_TOKEN=${AGENT_TOKEN}`, 'GAME_ADAPTER=pz', 'GAME_DATA_DIR=/data', 'GAME_INSTALL_DIR=/opt/game', 'GAME_PORT_GAME=30161', 'GSP_AGENT_MODE=install-job', 'TZ=UTC']);
    expect(body.Labels).toMatchObject({ 'gsp.stack': STACK, 'gsp.install': IID, 'gsp.job': 'install', 'gsp.job.from': '', 'gsp.install.adapter': 'pz' });
    const hc = body.HostConfig;
    expect(Object.keys(hc).sort()).toEqual(['CapDrop', 'IpcMode', 'LogConfig', 'Memory', 'MemorySwap', 'Mounts', 'NetworkMode', 'PidsLimit', 'PortBindings', 'Privileged', 'ReadonlyRootfs', 'RestartPolicy', 'SecurityOpt', 'Tmpfs']);
    expect(hc).toMatchObject({ CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Privileged: false, ReadonlyRootfs: true, PidsLimit: 4096, IpcMode: 'private', PortBindings: {}, Memory: 1024 * MIB, MemorySwap: 1024 * MIB, RestartPolicy: { Name: 'no' }, NetworkMode: `${STACK}-jobnet-${IID}` });
    expect(hc.Tmpfs).toEqual({ '/tmp': 'rw,exec,nosuid,nodev,size=256m', '/data': JOB_DATA_TMPFS });
    expect(hc.Mounts).toEqual([
      { Type: 'volume', Source: VOL, Target: '/opt/game', ReadOnly: false },
      { Type: 'volume', Source: `${STACK}-job-${IID}-steam`, Target: '/home/node', ReadOnly: false },
    ]);
    for (const k of ['Binds', 'CapAdd', 'Devices', 'DeviceRequests', 'PidMode', 'UsernsMode', 'VolumesFrom', 'Links', 'ExtraHosts', 'Sysctls', 'NanoCpus']) expect(hc, k).not.toHaveProperty(k);
    expect(body.NetworkingConfig).toEqual({ EndpointsConfig: { [`${STACK}-jobnet-${IID}`]: {} } });
  });

  it('gives a job of the java and native families no HOME volume', async () => {
    const s = await setup();
    await s.backend.putInstall(jobSpec({ runtime: 'java', env: { AGENT_TOKEN, GAME_ADAPTER: 'minecraft', GAME_FLAVOUR: 'fabric', TZ: 'UTC' } }), null);
    expect([...s.fd.volumes.keys()]).toEqual([VOL]);
    const body = s.fd.writes().find((x) => x.path === '/containers/create')!.body as { Image: string; HostConfig: { Mounts: unknown[] } };
    expect(body.Image).toBe('gsp/java-fake:s1');
    expect(body.HostConfig.Mounts).toEqual([{ Type: 'volume', Source: VOL, Target: '/opt/game', ReadOnly: false }]);
  });

  it('answers the same job asked again as it is, and refuses another while it exists', async () => {
    const s = await setup();
    await s.backend.putInstall(jobSpec(), null);
    const before = s.fd.writes().length;
    expect(await s.backend.putInstall(jobSpec(), null)).toMatchObject({ job: { kind: 'install' } });
    expect(s.fd.writes().length).toBe(before);
    expect(await rejection(s.backend.putInstall(jobSpec({ env: { AGENT_TOKEN, GAME_ADAPTER: 'pz', TZ: 'UTC' } }), null))).toMatchObject({ code: 'conflict', reason: 'install-busy' });
  });

  it("refuses a job for an install of another game, another stack's volume of its name, one a container mounts, and more jobs than it allows", async () => {
    const s = await setup();
    await readyInstall(s);
    expect(await rejection(s.backend.putInstall(jobSpec({ env: { AGENT_TOKEN, GAME_ADAPTER: 'valheim', TZ: 'UTC' } }), null))).toMatchObject({ code: 'refused', field: 'id', message: expect.stringContaining('another game') });
    // A server mounts it: no job writes it, even with its server stopped.
    await s.backend.apply(onInstall({ ports: [] }));
    expect(await rejection(s.backend.putInstall(jobSpec(), null))).toMatchObject({ code: 'conflict', reason: 'install-in-use', message: expect.stringContaining('server pz') });
    s.fd.addVolume({ name: `${STACK}-inst-${IID2}`, labels: { 'gsp.stack': 'gsp-s2', 'gsp.install': IID2, 'gsp.install.adapter': 'pz', 'gsp.install.runtime': 'steam' } });
    expect(await rejection(s.backend.putInstall(jobSpec({ id: IID2 }), null))).toMatchObject({ code: 'refused', field: 'id', message: expect.stringContaining('not this stack') });
    for (let i = 0; i < MAX_INSTALL_JOBS; i++) await s.backend.putInstall(jobSpec({ id: `iaaaaaaaa${i}` }), null);
    expect(await rejection(s.backend.putInstall(jobSpec({ id: 'ibbbbbbbbb' }), null))).toMatchObject({ code: 'conflict', message: expect.stringContaining(`At most ${MAX_INSTALL_JOBS}`) });
  });

  it('refuses a job spec that asks for anything but its id, image family, variant and environment (NFR-02)', () => {
    const p = (body: unknown, id = IID) => parseInstallJobSpec(body, id, policy);
    expect(p(JSON.parse(JSON.stringify(jobSpec())))).toEqual(jobSpec());
    for (const key of ['ports', 'mounts', 'image', 'Image', 'privileged', 'memoryMb', 'network', 'networkMode', 'install', 'cmd', 'Cmd', 'labels', 'user', 'HostConfig']) {
      expect(answer(() => p({ ...jobSpec(), [key]: 'x' })), key).toEqual({ code: 'refused', field: key, status: 403 });
    }
    for (const env of ['GSP_AGENT_MODE', 'GSP_INSTALL_SHARED', 'GAME_INSTALL_DIR', 'GAME_DATA_DIR', 'GAME_START_COMMAND', 'PATH', 'LD_PRELOAD']) expect(answer(() => p({ ...jobSpec(), env: { ...jobSpec().env, [env]: 'x' } })), env).toEqual({ code: 'refused', field: `env.${env}`, status: 403 });
    expect(answer(() => p({ ...jobSpec(), id: 'pz' }, 'pz'))).toEqual({ code: 'bad-request', field: 'id', status: 400 });
    expect(answer(() => p(jobSpec(), IID2))).toEqual({ code: 'bad-request', field: 'id', status: 400 });
    expect(answer(() => p({ ...jobSpec(), runtime: 'windows' }))).toEqual({ code: 'refused', field: 'runtime', status: 403 });
    expect(answer(() => parseInstallJobSpec(jobSpec(), IID, { ...policy, allowFake: false }))).toEqual({ code: 'refused', field: 'variant', status: 403 });
    expect(answer(() => p({ ...jobSpec(), env: { GAME_ADAPTER: 'pz', TZ: 'UTC' } }))).toEqual({ code: 'bad-request', field: 'env.AGENT_TOKEN', status: 400 });
  });

  it('removes a job with its network and HOME, keeps the install, and never the panel', async () => {
    const s = await setup();
    await s.backend.putInstall(jobSpec(), null);
    expect(await s.backend.removeInstallJob(IID)).toEqual({ removed: true });
    expect([...s.fd.containers.values()].map((c) => c.Name).filter((n) => n.includes('-job-'))).toEqual([]);
    expect([...s.fd.networks.values()].map((n) => n.Name).filter((n) => n.includes('jobnet'))).toEqual([]);
    expect([...s.fd.volumes.keys()]).toEqual([VOL]);
    expect(s.fd.containers.get(stack!.panelId)?.NetworkSettings.Networks).not.toHaveProperty(`${STACK}-jobnet-${IID}`);
    expect(await s.backend.removeInstallJob(IID)).toEqual({ removed: false });
    // Another stack's container under the job's name is never touched.
    s.fd.addContainer({ name: JOB, labels: { 'gsp.stack': 'gsp-s2', 'gsp.install': IID, 'gsp.job': 'install' } });
    expect(await rejection(s.backend.removeInstallJob(IID))).toMatchObject({ code: 'refused', field: 'id' });
  });
});

describe('copy jobs (HST-09, UPD-03, D12)', () => {
  it("copies a finished install into a new one with the orchestrator's own command: no network, the source read-only", async () => {
    const s = await setup();
    await readyInstall(s);
    const info = await s.backend.putInstall(jobSpec({ id: IID2 }), { install: IID });
    const create = s.fd.writes().filter((x) => x.path === '/containers/create').at(-1)!;
    expect(create.query).toEqual({ name: `${STACK}-job-${IID2}` });
    const body = create.body as { Cmd: string[]; Env: string[]; HostConfig: Record<string, unknown>; Labels: Record<string, string> };
    expect(body.Cmd).toEqual([...COPY_COMMAND]);
    expect(COPY_COMMAND).toEqual(['cp', '-a', '/src/.', '/opt/game/']);
    // Nothing of the caller's: not its token.
    expect(body.Env).toEqual([]);
    expect(body.HostConfig).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], Privileged: false, PortBindings: {}, Memory: 1024 * MIB });
    expect(body.HostConfig.Mounts).toEqual([
      { Type: 'volume', Source: VOL, Target: '/src', ReadOnly: true },
      { Type: 'volume', Source: `${STACK}-inst-${IID2}`, Target: '/opt/game', ReadOnly: false },
    ]);
    expect(body.Labels).toMatchObject({ 'gsp.job': 'copy', 'gsp.job.from': IID });
    expect(info.job).toMatchObject({ kind: 'copy', agentUrl: null, from: IID });
    // No network, no HOME made for it.
    expect([...s.fd.networks.values()].map((n) => n.Name).filter((n) => n.includes('jobnet'))).toEqual([]);
    expect([...s.fd.volumes.keys()].sort()).toEqual([VOL, `${STACK}-inst-${IID2}`].sort());
  });

  it("refuses a copy from a missing, another stack's, unfinished or busy install, of another game, or into an install that exists", async () => {
    const s = await setup();
    expect(await rejection(s.backend.putInstall(jobSpec({ id: IID2 }), { install: IID }))).toMatchObject({ code: 'refused', field: 'from' });
    await s.backend.putInstall(jobSpec(), null);
    expect(await rejection(s.backend.putInstall(jobSpec({ id: IID2 }), { install: IID }))).toMatchObject({ code: 'conflict', field: 'from', reason: 'install-busy' });
    await s.backend.removeInstallJob(IID);
    expect(await rejection(s.backend.putInstall(jobSpec({ id: IID2 }), { install: IID }))).toMatchObject({ code: 'conflict', field: 'from', reason: 'install-not-ready' });
    s.fd.volumes.get(VOL)!.files.set(SHARED_INSTALL_MARKER, marker());
    expect(await rejection(s.backend.putInstall(jobSpec({ id: IID2, runtime: 'java' }), { install: IID }))).toMatchObject({ code: 'refused', field: 'from', message: expect.stringContaining("can't be copied") });
    await readyInstall(s, IID2);
    expect(await rejection(s.backend.putInstall(jobSpec({ id: IID2 }), { install: IID }))).toMatchObject({ code: 'conflict', field: 'id', message: expect.stringContaining('exists already') });
    const other = 'iccccccccc';
    s.fd.addVolume({ name: `${STACK}-inst-${other}`, labels: { 'gsp.stack': 'gsp-s2', 'gsp.install': other, 'gsp.install.adapter': 'pz', 'gsp.install.runtime': 'steam', 'gsp.install.variant': 'fake' } });
    expect(await rejection(s.backend.putInstall(jobSpec({ id: 'idddddddddd' }), { install: other }))).toMatchObject({ code: 'refused', field: 'from', message: expect.stringContaining('not this stack') });
  });

  it("adopts a stopped server's own install by a copy (migration), never a running server's or another game's", async () => {
    const s = await setup();
    await s.backend.apply(spec({ ports: [] }));
    await s.backend.start('pz');
    expect(await rejection(s.backend.putInstall(jobSpec(), { server: 'pz' }))).toMatchObject({ code: 'conflict', field: 'fromServer', reason: 'server-running' });
    await s.backend.stop('pz');
    expect(await rejection(s.backend.putInstall(jobSpec({ env: { AGENT_TOKEN, GAME_ADAPTER: 'valheim', TZ: 'UTC' } }), { server: 'pz' }))).toMatchObject({ code: 'refused', field: 'fromServer' });
    expect(await rejection(s.backend.putInstall(jobSpec(), { server: 'nope' }))).toMatchObject({ code: 'refused', field: 'fromServer' });
    const info = await s.backend.putInstall(jobSpec(), { server: 'pz' });
    expect(info.job).toMatchObject({ kind: 'copy', from: 'server:pz' });
    const body = s.fd.writes().filter((x) => x.path === '/containers/create').at(-1)!.body as { HostConfig: { Mounts: unknown[] } };
    expect(body.HostConfig.Mounts).toEqual([
      { Type: 'volume', Source: `${STACK}-srv-pz-install`, Target: '/src', ReadOnly: true },
      { Type: 'volume', Source: VOL, Target: '/opt/game', ReadOnly: false },
    ]);
  });

  it("removes a server's own install volume once it moved to a shared install, never while it still runs from it, never its data", async () => {
    const s = await setup();
    await s.backend.apply(spec({ ports: [] }));
    const own = `${STACK}-srv-pz-install`;
    expect(await rejection(s.backend.removeOwnInstall('pz'))).toMatchObject({ code: 'conflict', field: 'id', reason: 'install-in-use', message: expect.stringContaining('still runs from it') });
    // Adopted by a copy, finished by a job, then the server moves to it (its container is recreated).
    await s.backend.putInstall(jobSpec(), { server: 'pz' });
    await s.backend.removeInstallJob(IID);
    s.fd.volumes.get(VOL)!.files.set(SHARED_INSTALL_MARKER, marker());
    await s.backend.apply(onInstall({ ports: [] }));
    expect(s.fd.volumes.has(own)).toBe(true);
    expect(await s.backend.removeOwnInstall('pz')).toEqual({ removed: true });
    expect([...s.fd.volumes.keys()].sort()).toEqual([VOL, `${STACK}-srv-pz-data`, `${STACK}-srv-pz-steam`].sort());
    expect(await s.backend.removeOwnInstall('pz')).toEqual({ removed: false });
    // Another stack's volume under that name is never touched.
    s.fd.addVolume({ name: `${STACK}-srv-pz2-install`, labels: { 'gsp.stack': 'gsp-s2', 'gsp.server': 'pz2', 'gsp.volume': 'install' } });
    expect(await rejection(s.backend.removeOwnInstall('pz2'))).toMatchObject({ code: 'refused', field: 'id' });
  });

  it('takes one source, by name, never the install itself', () => {
    const q = (s: string) => parseInstallPutOptions(new URLSearchParams(s), IID);
    expect(q('')).toBeNull();
    expect(q(`from=${IID2}`)).toEqual({ install: IID2 });
    expect(q('fromServer=pz-2')).toEqual({ server: 'pz-2' });
    for (const bad of [`from=${IID}`, `from=${IID2}&fromServer=pz`, `from=${IID2}&from=${IID2}`, 'from=pz', 'fromServer=Pz', 'source=pz', `from=${IID2}&keepImage=true`]) expect(answer(() => q(bad)), bad).toMatchObject({ code: 'bad-request', status: 400 });
  });
});

describe('listing and removing installs (HST-09, HST-03)', () => {
  it("lists this stack's installs with who mounts them and their job, nothing of another stack's or a spoofed one", async () => {
    const s = await setup();
    await readyInstall(s);
    await s.backend.apply(onInstall({ ports: [] }));
    await s.backend.apply(onInstall({ id: 'pz-2', ports: [] }));
    await s.backend.putInstall(jobSpec({ id: IID2 }), null);
    s.fd.addVolume({ name: 'gsp-s2-inst-iffffffffff', labels: { 'gsp.stack': 'gsp-s2', 'gsp.install': 'iffffffffff', 'gsp.install.adapter': 'pz', 'gsp.install.runtime': 'steam' } });
    s.fd.addVolume({ name: `${STACK}-inst-odd`, labels: { 'gsp.stack': STACK, 'gsp.install': 'ieeeeeeeeee', 'gsp.install.adapter': 'pz', 'gsp.install.runtime': 'steam' } });
    const list = await s.backend.installs();
    expect(list.map((i) => [i.id, i.mountedBy, i.job?.kind ?? null])).toEqual([
      [IID, ['pz', 'pz-2'], null],
      [IID2, [], 'install'],
    ]);
    expect(list[0]).toMatchObject({ adapter: 'pz', flavour: null, runtime: 'steam', variant: 'fake', volume: VOL, createdAt: expect.stringMatching(/^\d{4}-/) });
  });

  it('removes an install nothing mounts and no job writes; refuses one a container mounts (a stopped one too) or with a job', async () => {
    const s = await setup();
    await readyInstall(s);
    await s.backend.apply(onInstall({ ports: [] }));
    expect(await rejection(s.backend.removeInstall(IID))).toMatchObject({ code: 'conflict', status: 409, reason: 'install-in-use', message: expect.stringContaining('server pz') });
    // Read from Docker: any container mounting it, whatever its project.
    await s.backend.remove('pz', true);
    s.fd.addContainer({ name: 'someone-else', labels: {} }).HostConfig.Mounts = [{ Source: VOL, Target: '/x' }];
    expect(await rejection(s.backend.removeInstall(IID))).toMatchObject({ reason: 'install-in-use', message: expect.stringContaining('someone-else') });
    for (const c of s.fd.containers.values()) if (c.Name === '/someone-else') s.fd.containers.delete(c.Id);
    await s.backend.putInstall(jobSpec(), null);
    expect(await rejection(s.backend.removeInstall(IID))).toMatchObject({ code: 'conflict', reason: 'install-busy' });
    await s.backend.removeInstallJob(IID);
    expect(await s.backend.removeInstall(IID)).toEqual({ removed: true });
    expect(s.fd.volumes.has(VOL)).toBe(false);
    expect(await s.backend.removeInstall(IID)).toEqual({ removed: false });
    s.fd.addVolume({ name: VOL, labels: { 'gsp.stack': 'gsp-s2', 'gsp.install': IID } });
    expect(await rejection(s.backend.removeInstall(IID))).toMatchObject({ code: 'refused', field: 'id' });
    expect(s.fd.volumes.has(VOL)).toBe(true);
  });
});

describe('the install routes (HST-09, D3)', () => {
  it('serve the installs API behind the token, with strict ids, queries and bodies', async () => {
    const s = await setup();
    const socket = socketPath('orch-installs');
    const server: http.Server = createOrchestratorServer({ backend: s.backend, token: TOKEN, version: 'x', policy });
    await listenOnSocket(server, socket);
    try {
      const call = (method: string, p: string, o: Parameters<typeof request>[3] = {}) => request(socket, method, p, o);
      for (const [m, p] of [
        ['GET', '/v1/installs'],
        ['PUT', `/v1/installs/${IID}`],
        ['DELETE', `/v1/installs/${IID}`],
        ['DELETE', `/v1/installs/${IID}/job`],
      ] as const) expect(await call(m, p, { token: null }), `${m} ${p}`).toMatchObject({ status: 401 });
      expect(await call('GET', '/v1/installs')).toEqual({ status: 200, body: [] });
      const put = await call('PUT', `/v1/installs/${IID}`, { body: jobSpec() });
      expect(put).toMatchObject({ status: 200, body: { id: IID, job: { kind: 'install', state: 'running' } } });
      expect(await call('PUT', `/v1/installs/${IID}`, { body: jobSpec({ env: { AGENT_TOKEN, GAME_ADAPTER: 'pz', TZ: 'UTC' } }) })).toMatchObject({ status: 409, body: { code: 'conflict', reason: 'install-busy', field: 'id' } });
      expect(await call('DELETE', `/v1/installs/${IID}`)).toMatchObject({ status: 409, body: { reason: 'install-busy' } });
      expect(await call('PUT', `/v1/installs/${IID}`, { body: { ...jobSpec(), ports: [] } })).toMatchObject({ status: 403, body: { code: 'refused', field: 'ports' } });
      expect(await call('PUT', `/v1/installs/${IID2}?from=${IID}&fromServer=pz`, { body: jobSpec({ id: IID2 }) })).toMatchObject({ status: 400 });
      for (const bad of ['/v1/installs/pz', '/v1/installs/I0123456789', `/v1/installs/${IID}%2f..`, `/v1/installs/..%2f${IID}`]) expect(await call('DELETE', bad), bad).toMatchObject({ status: 400, body: { field: 'id' } });
      expect(await call('POST', `/v1/installs/${IID}`)).toMatchObject({ status: 405 });
      expect(await call('GET', `/v1/installs/${IID}/job`)).toMatchObject({ status: 405 });
      expect(await call('DELETE', `/v1/installs/${IID}/start`)).toMatchObject({ status: 404 });
      expect(await call('GET', '/v1/installs?all=true')).toMatchObject({ status: 400 });
      expect(await call('DELETE', `/v1/installs/${IID}/job`)).toEqual({ status: 200, body: { removed: true } });
      expect(await call('DELETE', `/v1/installs/${IID}`)).toEqual({ status: 200, body: { removed: true } });
      expect(await call('GET', '/v1/installs')).toEqual({ status: 200, body: [] });
      // A server's own install volume: DELETE only, no query or body.
      expect(await call('DELETE', '/v1/servers/pz/install')).toEqual({ status: 200, body: { removed: false } });
      expect(await call('POST', '/v1/servers/pz/install')).toMatchObject({ status: 405 });
      expect(await call('DELETE', '/v1/servers/pz/install?force=true')).toMatchObject({ status: 400 });
      expect(await call('DELETE', '/v1/servers/pz/install', { token: null })).toMatchObject({ status: 401 });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
