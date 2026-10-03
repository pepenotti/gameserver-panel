import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { ModSource, PanelAdapter } from '@gsp/adapter-api';
import { createWorkshopSource } from '@gsp/adapter-pz/panel/core';
import { createTmlWorkshopSource } from '@gsp/adapter-terraria/panel';
import {
  ORCHESTRATOR_API_VERSION,
  type AgentStatus,
  type ApplyOptions,
  type CpuArch,
  type DerivationState,
  type GrantRole,
  type InstallInfo,
  type InstallJobSpec,
  type InstallKey,
  type InstallPutOptions,
  type LaunchEnvelope,
  type PortRangeInfo,
  type SeqEvent,
  type ServerContainer,
  type ServerSpec,
  type SharedInstallMarker,
} from '@gsp/shared';
import { AgentCallError, type AgentApi } from '../src/agent/client';
import { buildApp } from '../src/app';
import { bootstrapOwner } from '../src/auth/bootstrap';
import { syncRoleWithGrants } from '../src/auth/grants';
import { SESSION_COOKIE } from '../src/auth/sessions';
import { base32Decode, currentStep, hotp } from '../src/auth/totp';
import { openDb, type Db } from '../src/db/db';
import type { PanelEnv } from '../src/env';
import { LocalServerFiles } from '../src/files/local';
import type { AgentFeed, Deps } from '../src/http/deps';
import type { ServerContext } from '../src/servers/context';
import { OrchestratorCallError, type OrchestratorClient } from '../src/servers/orchestrator';
import type { AgentTarget } from '../src/servers/registry';
import { createPanelDeps, isManaged } from '../src/wiring';

export const ORIGIN = 'https://panel.test:8443';
export const OWNER = { username: 'alice', password: 'Primera-clave-2026' };

export function fakeStatus(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    agentVersion: 'test',
    bootId: 'boot-1',
    state: 'stopped',
    desired: 'stopped',
    pid: null,
    startedAt: null,
    readyAt: null,
    lastExit: null,
    failure: null,
    installedInfo: { version: '42.20.4', channel: 'public', build: '24909800' },
    players: null,
    control: { kind: 'rcon', connected: false, lastError: null },
    lock: null,
    job: null,
    recentCrashes: [],
    launch: null,
    process: null,
    disks: [],
    now: new Date().toISOString(),
    ...over,
  };
}

export class FakeFeed implements AgentFeed {
  connected = true;
  status_: AgentStatus | null = fakeStatus();
  logs: SeqEvent[] = [];
  private listeners = new Set<(e: SeqEvent) => void>();
  private seq = 0;
  recentLogs() {
    return this.logs;
  }
  onEvent(l: (e: SeqEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(event: SeqEvent['event']) {
    const e = { seq: ++this.seq, at: new Date().toISOString(), event };
    for (const l of this.listeners) l(e);
  }
}

/** Records calls; tests override methods as needed. */
export function fakeAgent(feed: FakeFeed): AgentApi & { calls: string[] } {
  const calls: string[] = [];
  const st = async () => feed.status_ ?? fakeStatus();
  return {
    calls,
    status: st,
    setLaunch: async () => (calls.push('setLaunch'), st()),
    start: async () => (calls.push('start'), st()),
    stop: async () => (calls.push('stop'), st()),
    restart: async () => (calls.push('restart'), st()),
    kill: async () => (calls.push('kill'), st()),
    command: async (c) => (calls.push(`command:${c}`), { via: 'rcon' as const, output: 'ok' }),
    install: async () => (calls.push('install'), { ok: true }),
    versions: async () => ({ installed: null, versions: [] }),
    save: async () => (calls.push('save'), { ok: true }),
    action: async (name) => {
      calls.push(`action:${name}`);
      throw new AgentCallError(404, 'not-found', `No action ${name}`);
    },
    lock: async (holder) => {
      // The agent's own rule for holders (packages/agent/src/agent.ts), so a name it would refuse fails here too.
      if (!/^[\w .:-]{1,64}$/.test(holder)) throw new AgentCallError(400, 'bad-request', 'Invalid lock holder');
      return { id: 'lock-1', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    renewLock: async () => undefined,
    unlock: async () => undefined,
  };
}

export const noNetwork = (() => Promise.reject(new Error('no network in tests'))) as unknown as typeof fetch;

type FakeContainer = ServerContainer & { spec: ServerSpec; volumes: boolean; imageId: string; derivedBy: number };

/** A shared install in the fake orchestrator (HST-09): the game it holds, its marker once a job wrote one, its job while one exists. */
export interface FakeInstall {
  id: string;
  adapter: string;
  flavour: string | null;
  runtime: ServerSpec['runtime'];
  variant: string | null;
  createdAt: string;
  marker: SharedInstallMarker | null;
  /** The copies its files came from, oldest first (install ids, `server:<id>`); empty: downloaded by its own job. */
  filledFrom: string[];
  job: { kind: 'install' | 'copy'; hash: string; token: string; from: string | null; state: 'running' | 'exited'; exitCode: number | null; launch: LaunchEnvelope | null } | null;
}

/** What a fake install job installs by default: what the launch names (its branch, version or loader), build `b1`. */
export function defaultJobKey(spec: InstallJobSpec, launch: LaunchEnvelope | null): InstallKey {
  const p = (launch?.params ?? {}) as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' && x !== '' ? x : null);
  const flavour = spec.env.GAME_FLAVOUR ?? null;
  if (str(p.branch)) return { flavour, version: null, build: 'b1', branch: str(p.branch) };
  return { flavour, version: str(p.version) ?? 'v1', build: str(p.loaderVersion) ?? null, branch: null };
}

/**
 * The orchestrator in memory (D3's API, `@gsp/shared` orchestrator-api):
 * containers by id with the spec each was created from, every call made,
 * failures on demand, runtime images a test can rebuild (`rebuildImage`), and
 * a release that derives containers differently (`rederive`).
 */
export class FakeOrchestrator implements OrchestratorClient {
  /** The derivation it builds, and the oldest it keeps (the real one's `DERIVATION`). */
  derivation = { version: 1, safeFrom: 0 };
  arch: CpuArch = 'amd64';
  cpus = 8;
  /** `ORCH_HOST_PORTS` as `GET /v1/host` reports it; undefined: an orchestrator that doesn't say. */
  hostPorts: PortRangeInfo[] | undefined = undefined;
  /** `ORCH_MAX_MEM_MB`; undefined: an orchestrator that doesn't say. */
  maxMemMb: number | undefined = undefined;
  readonly containers = new Map<string, FakeContainer>();
  /** Image name → the content id it names now. */
  readonly images = new Map<string, string>();
  private builds = 0;
  /** Volumes left behind by removals that kept them, by server id. */
  readonly keptVolumes = new Set<string>();
  readonly calls: string[] = [];
  /** The next call of a method fails with this error (once). */
  readonly failNext = new Map<keyof OrchestratorClient, OrchestratorCallError>();
  /** Every call fails with this: the orchestrator is down. */
  down: OrchestratorCallError | null = null;

  // ------------------------------------------------------------ shared installs (HST-09, D12)
  /** Whether it has shared installs; off (the default): an orchestrator from before them (`not-found`), so servers keep installs of their own. */
  sharedInstalls = false;
  readonly installsById = new Map<string, FakeInstall>();
  /** Servers whose own install volume exists (made with their first container without `install`; kept until removed). */
  readonly ownInstalls = new Set<string>();
  /** What an install job's agent installs, from its spec and launch: the key its marker names. */
  jobKey: (spec: InstallJobSpec, launch: LaunchEnvelope | null) => InstallKey = defaultJobKey;
  /** Install jobs fail with this error while it is set. */
  failJobs: string | null = null;
  /** Copy jobs exit with this code. */
  copyExit = 0;
  /** While set, an install job's install waits for it (to see servers wait on one job). */
  hold: Promise<void> | null = null;
  /** Every install job's install that ran, by install id (one per job). */
  readonly jobsRun: string[] = [];
  /** Every copy job, as `<id> <from>`. */
  readonly copies: string[] = [];
  /** Install jobs that downloaded the whole game (nothing copied into their install first), by install id. */
  readonly downloads: string[] = [];

  private check(method: keyof OrchestratorClient, detail = ''): void {
    this.calls.push(detail ? `${method} ${detail}` : method);
    if (this.down) throw this.down;
    const f = this.failNext.get(method);
    if (f) {
      this.failNext.delete(method);
      throw f;
    }
  }

  private get(id: string) {
    const c = this.containers.get(id);
    if (!c) throw new OrchestratorCallError(404, 'not-found', `No server ${id}`);
    return c;
  }

  private view(c: FakeContainer): ServerContainer {
    const { spec: _spec, volumes: _volumes, derivedBy: _derivedBy, ...rest } = c;
    return { ...rest, latestImageId: this.imageId(c.image), derivation: this.derivationOf(c) };
  }

  private derivationOf(c: FakeContainer): DerivationState {
    if (c.derivedBy === this.derivation.version) return 'current';
    return c.derivedBy < this.derivation.safeFrom ? 'security-fix' : 'changed';
  }

  /** An orchestrator release that derives containers differently (a product upgrade); with `security`, one that closes a security gap. */
  rederive(o: { security?: boolean } = {}): void {
    const version = this.derivation.version + 1;
    this.derivation = { version, safeFrom: o.security ? version : this.derivation.safeFrom };
  }

  /** The image a spec runs here. */
  imageOf(spec: Pick<ServerSpec, 'runtime'>): string {
    return `gsp/${spec.runtime}:fake`;
  }

  /** The content id an image name resolves to now. */
  imageId(name: string): string {
    let id = this.images.get(name);
    if (!id) {
      id = `sha256:${createHash('sha256').update(`${name}#${++this.builds}`).digest('hex')}`;
      this.images.set(name, id);
    }
    return id;
  }

  /** A rebuild under the same tag (a product upgrade): the name resolves to a new id, which it returns. */
  rebuildImage(name = 'gsp/steam:fake'): string {
    this.images.delete(name);
    return this.imageId(name);
  }

  async health() {
    this.check('health');
    return { ok: true as const, version: 'fake', api: ORCHESTRATOR_API_VERSION };
  }
  async host() {
    this.check('host');
    return {
      arch: this.arch,
      cpus: this.cpus,
      memBytes: 64 * 1024 ** 3,
      dockerVersion: 'fake',
      os: 'fake',
      ...(this.hostPorts ? { hostPorts: this.hostPorts } : {}),
      ...(this.maxMemMb !== undefined ? { maxMemMb: this.maxMemMb } : {}),
    };
  }
  async list() {
    this.check('list');
    return [...this.containers.values()].map((c) => this.view(c));
  }
  /** Recorded as `apply <id>`, with ` keepImage` and ` keepDerivation` when asked. */
  async apply(spec: ServerSpec, o: ApplyOptions = {}) {
    this.check('apply', `${spec.id}${o.keepImage ? ' keepImage' : ''}${o.keepDerivation ? ' keepDerivation' : ''}`);
    const specHash = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
    const cur = this.containers.get(spec.id);
    // As the real one refuses a server on an install (HST-09): none of that id, another game's, one with a job, one no job finished.
    if (spec.install !== undefined) {
      const i = this.installsById.get(spec.install);
      if (!i) throw new OrchestratorCallError(403, 'refused', `Install ${spec.install} does not exist in this stack`, 'install');
      if (i.adapter !== spec.env.GAME_ADAPTER || i.flavour !== (spec.env.GAME_FLAVOUR ?? null) || i.runtime !== spec.runtime || i.variant !== (spec.variant ?? null)) throw new OrchestratorCallError(403, 'refused', `Install ${spec.install} holds another game`, 'install');
      if (i.job) throw new OrchestratorCallError(409, 'conflict', `Install ${spec.install} has a job`, 'install', 'install-busy');
      if (!i.marker) throw new OrchestratorCallError(409, 'conflict', `No install job finished install ${spec.install}`, 'install', 'install-not-ready');
    } else this.ownInstalls.add(spec.id);
    // The same spec on the image its tag names now, or kept on its own (a newer image waits); derived as now, or
    // kept as derived (a changed derivation waits), never across a security fix.
    const derived = cur ? this.derivationOf(cur) : 'current';
    if (cur?.specHash === specHash && (o.keepImage || cur.imageId === this.imageId(cur.image)) && (derived === 'current' || (derived === 'changed' && o.keepDerivation))) return this.view(cur);
    const image = this.imageOf(spec);
    const c: FakeContainer = {
      id: spec.id,
      state: 'created',
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      image,
      specHash,
      agentUrl: `http://gsp-${spec.id}:8081`,
      imageId: this.imageId(image),
      spec,
      volumes: true,
      derivedBy: this.derivation.version,
    };
    this.containers.set(spec.id, c);
    return this.view(c);
  }
  async start(id: string) {
    this.check('start', id);
    const c = this.get(id);
    c.state = 'running';
    c.startedAt = new Date().toISOString();
    return this.view(c);
  }
  async stop(id: string) {
    this.check('stop', id);
    const c = this.get(id);
    c.state = 'exited';
    return this.view(c);
  }
  async restart(id: string) {
    this.check('restart', id);
    const c = this.get(id);
    c.state = 'running';
    return this.view(c);
  }
  async stats(id: string) {
    this.check('stats', id);
    this.get(id);
    return { id, at: new Date().toISOString(), cpuPercent: 0, memBytes: 0, memLimitBytes: null, netRxBytes: 0, netTxBytes: 0 };
  }
  async remove(id: string, o: { removeVolumes: boolean }) {
    this.check('remove', `${id} volumes=${o.removeVolumes}`);
    this.get(id);
    this.containers.delete(id);
    if (!o.removeVolumes) this.keptVolumes.add(id);
    else this.ownInstalls.delete(id);
    return { removed: true, volumesRemoved: o.removeVolumes };
  }

  // ------------------------------------------------------------ shared installs (HST-09, D12)

  private sharedOnly(method: keyof OrchestratorClient, detail: string): void {
    this.check(method, detail);
    if (!this.sharedInstalls) throw new OrchestratorCallError(404, 'not-found', 'No such route');
  }

  private mountedBy(id: string): string[] {
    return [...this.containers.values()]
      .filter((c) => c.spec.install === id)
      .map((c) => c.id)
      .sort();
  }

  private installView(i: FakeInstall): InstallInfo {
    return {
      id: i.id,
      adapter: i.adapter,
      flavour: i.flavour,
      runtime: i.runtime,
      variant: i.variant,
      volume: `fake-inst-${i.id}`,
      createdAt: i.createdAt,
      mountedBy: this.mountedBy(i.id),
      job: i.job
        ? {
            kind: i.job.kind,
            state: i.job.state,
            startedAt: i.createdAt,
            finishedAt: null,
            exitCode: i.job.exitCode,
            image: `gsp/${i.runtime}:fake`,
            agentUrl: i.job.kind === 'install' ? `http://job-${i.id}:8081` : null,
            from: i.job.from,
          }
        : null,
    };
  }

  async installs(): Promise<InstallInfo[]> {
    this.sharedOnly('installs', '');
    return [...this.installsById.values()].map((i) => this.installView(i));
  }

  /** Recorded as `putInstall <id>`, with ` from=<id>` or ` fromServer=<id>`. */
  async putInstall(spec: InstallJobSpec, o: InstallPutOptions = {}): Promise<InstallInfo> {
    this.sharedOnly('putInstall', `${spec.id}${o.from ? ` from=${o.from}` : ''}${o.fromServer ? ` fromServer=${o.fromServer}` : ''}`);
    const from = o.from ?? (o.fromServer ? `server:${o.fromServer}` : null);
    const kind = from === null ? 'install' : 'copy';
    const hash = createHash('sha256').update(JSON.stringify({ spec, kind, from })).digest('hex');
    const old = this.installsById.get(spec.id);
    if (old?.job) {
      if (old.job.hash !== hash) throw new OrchestratorCallError(409, 'conflict', `Install ${spec.id} has a job already`, 'id', 'install-busy');
      return this.installView(old);
    }
    if (old && (old.adapter !== spec.env.GAME_ADAPTER || old.flavour !== (spec.env.GAME_FLAVOUR ?? null))) throw new OrchestratorCallError(403, 'refused', `Install ${spec.id} was made for another game`, 'id');
    if (old && from) throw new OrchestratorCallError(409, 'conflict', `Install ${spec.id} exists already: a copy goes into a new install`, 'id');
    if (this.mountedBy(spec.id).length) throw new OrchestratorCallError(409, 'conflict', `Install ${spec.id} is mounted`, 'id', 'install-in-use');
    let marker: SharedInstallMarker | null = old?.marker ?? null;
    let filledFrom = old?.filledFrom ?? [];
    if (o.from) {
      const src = this.installsById.get(o.from);
      if (!src) throw new OrchestratorCallError(403, 'refused', `Install ${o.from} does not exist in this stack`, 'from');
      if (src.job) throw new OrchestratorCallError(409, 'conflict', `Install ${o.from} has a job`, 'from', 'install-busy');
      if (!src.marker) throw new OrchestratorCallError(409, 'conflict', `No install job finished install ${o.from}`, 'from', 'install-not-ready');
      marker = src.marker;
      filledFrom = [...src.filledFrom, o.from];
    }
    if (o.fromServer) {
      if (!this.ownInstalls.has(o.fromServer)) throw new OrchestratorCallError(403, 'refused', `Server ${o.fromServer} has no install volume of its own`, 'fromServer');
      if (this.containers.get(o.fromServer)?.state === 'running') throw new OrchestratorCallError(409, 'conflict', `Server ${o.fromServer} is running`, 'fromServer', 'server-running');
      marker = null;
      filledFrom = [`server:${o.fromServer}`];
    }
    const i: FakeInstall = {
      id: spec.id,
      adapter: spec.env.GAME_ADAPTER,
      flavour: spec.env.GAME_FLAVOUR ?? null,
      runtime: spec.runtime,
      variant: spec.variant ?? null,
      createdAt: old?.createdAt ?? new Date().toISOString(),
      marker,
      filledFrom,
      job: { kind, hash, token: spec.env.AGENT_TOKEN, from, state: kind === 'copy' ? 'exited' : 'running', exitCode: kind === 'copy' ? this.copyExit : null, launch: null },
    };
    if (kind === 'copy') this.copies.push(`${spec.id} ${from}`);
    this.installsById.set(spec.id, i);
    return this.installView(i);
  }

  async removeInstallJob(id: string) {
    this.sharedOnly('removeInstallJob', id);
    const i = this.installsById.get(id);
    if (!i?.job) return { removed: false };
    i.job = null;
    return { removed: true };
  }

  async removeInstall(id: string) {
    this.sharedOnly('removeInstall', id);
    const i = this.installsById.get(id);
    if (!i) return { removed: false };
    if (i.job) throw new OrchestratorCallError(409, 'conflict', `Install ${id} has a job`, 'id', 'install-busy');
    const users = this.mountedBy(id);
    if (users.length) throw new OrchestratorCallError(409, 'conflict', `Install ${id} is mounted by ${users.map((u) => `server ${u}`).join(', ')}`, 'id', 'install-in-use');
    this.installsById.delete(id);
    return { removed: true };
  }

  async removeOwnInstall(serverId: string) {
    this.sharedOnly('removeOwnInstall', serverId);
    if (!this.ownInstalls.has(serverId)) return { removed: false };
    const c = this.containers.get(serverId);
    if (c && c.spec.install === undefined) throw new OrchestratorCallError(409, 'conflict', `Server ${serverId}'s own install is mounted by server ${serverId}`, 'id', 'install-in-use');
    this.ownInstalls.delete(serverId);
    return { removed: true };
  }

  /**
   * An install job's agent (the panel's `jobAgent` factory): it answers once
   * its job runs, keeps the launch, and its install writes the marker of
   * `jobKey` (or fails with `failJobs`), after `hold`.
   */
  jobAgent(url: string, token: string): AgentApi {
    const id = /^http:\/\/job-(i[a-z0-9]+):8081$/.exec(url)?.[1] ?? '';
    const live = () => {
      const i = this.installsById.get(id);
      if (!i?.job || i.job.kind !== 'install' || i.job.token !== token) throw new AgentCallError(503, 'unreachable', 'Install job agent unreachable');
      return i;
    };
    const status = async (): Promise<AgentStatus> => {
      const i = live();
      return fakeStatus({ installedInfo: null, install: { mode: 'job', sharing: { mode: 'shared' }, marker: i.marker, mismatch: null } });
    };
    const refuse = async (): Promise<never> => {
      throw new AgentCallError(409, 'conflict', 'This is an install job');
    };
    return {
      status,
      setLaunch: async (l) => {
        live().job!.launch = l;
        return status();
      },
      install: async () => {
        const i = live();
        // A job drops the marker a copy brought, and writes its own last.
        i.marker = null;
        if (this.hold) await this.hold;
        this.jobsRun.push(id);
        if (this.failJobs) return { ok: false, error: this.failJobs };
        const spec: InstallJobSpec = { id, runtime: i.runtime, ...(i.variant ? { variant: i.variant } : {}), env: { AGENT_TOKEN: token, GAME_ADAPTER: i.adapter, ...(i.flavour ? { GAME_FLAVOUR: i.flavour } : {}), TZ: 'UTC' } };
        const key = this.jobKey(spec, i.job!.launch);
        i.marker = { schema: 1, adapter: i.adapter, flavour: i.flavour, mode: 'shared', key, installed: { version: key.version, ...(key.build ? { build: key.build } : {}), ...(key.branch ? { channel: key.branch } : {}) }, redirects: [], bytes: 1_000_000, files: 10, agentVersion: 'fake', finishedAt: new Date().toISOString() };
        // A job on nothing copied downloads the whole game.
        if (i.filledFrom.length === 0) this.downloads.push(id);
        return { ok: true };
      },
      versions: refuse,
      start: refuse,
      stop: refuse,
      restart: refuse,
      kill: refuse,
      command: refuse,
      save: refuse,
      action: refuse,
      lock: refuse,
      renewLock: refuse,
      unlock: refuse,
    };
  }
}

/** An orchestrator-run server's fakes: its agent, its live mirror, and its files on the test's disk. */
export interface FakeServer {
  agent: ReturnType<typeof fakeAgent>;
  feed: FakeFeed;
  dataDir: string;
  /** Where the registry says its agent answers, and its token. */
  target?: AgentTarget;
  /** How many times the panel asked for its agent client (once per server: rebuilt contexts reuse it). */
  made?: number;
}

export interface TestPanel {
  app: FastifyInstance;
  deps: Deps;
  feed: FakeFeed;
  agent: ReturnType<typeof fakeAgent>;
  /** The server the environment describes (`default`): its services. */
  srv: ServerContext;
  /** The orchestrator the panel was built with. */
  orch: FakeOrchestrator;
  /** The fakes of an orchestrator-run server, by id (made on first use). */
  fakes(id: string): FakeServer;
}

/**
 * The folders `makePanel` made, removed when the test file is done, or when
 * a script that builds a panel with this harness (scripts/gen-api-docs.ts)
 * exits. rmSync never follows a link: links tests make to folders outside
 * go, what they point at stays (those tests remove it themselves).
 */
const made: string[] = [];
function removeMade(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
if (process.env.VITEST) {
  const { afterAll } = await import('vitest');
  afterAll(removeMade);
} else process.once('exit', removeMade);

export async function makePanel(
  envOver: Partial<PanelEnv> = {},
  opts: { mods?: ModSource[] | Record<string, ModSource[]>; fetch?: typeof fetch; db?: Db; orch?: FakeOrchestrator; adapters?: readonly PanelAdapter[]; downloads?: { fetch?: typeof fetch; env?: Record<string, string | undefined> }; detect?: typeof fetch } = {},
): Promise<TestPanel> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gsp-panel-'));
  made.push(tmp);
  const env: PanelEnv = {
    version: 'test',
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    dataDir: ':memory:',
    publicDir: null,
    agentUrl: 'http://agent.invalid',
    agentToken: 'x'.repeat(40),
    orchestrator: null,
    serverImageVariant: null,
    pzDataDir: path.join(tmp, 'data'),
    pzInstallDir: path.join(tmp, 'install'),
    backupDir: path.join(tmp, 'backups'),
    serverName: 'zomboid',
    secrets: { adminPassword: 'AdminPw-123456' },
    ports: {},
    origins: [ORIGIN],
    owner: OWNER,
    trustProxy: 'loopback',
    clientIpTrustworthy: false,
    secureCookies: true,
    ...envOver,
  };
  const db = opts.db ?? openDb(':memory:');
  const feed = new FakeFeed();
  const agent = fakeAgent(feed);
  const orch = opts.orch ?? new FakeOrchestrator();
  const servers = new Map<string, FakeServer>();
  const fakes = (id: string): FakeServer => {
    let s = servers.get(id);
    if (!s) {
      const f = new FakeFeed();
      s = { agent: fakeAgent(f), feed: f, dataDir: path.join(tmp, 'servers', id, 'data') };
      servers.set(id, s);
    }
    return s;
  };
  // The same construction as main.ts, without the network (Discord, the Steam Workshop API, Docker).
  const deps = createPanelDeps({
    env,
    db,
    agent,
    feed,
    fetch: opts.fetch ?? noNetwork,
    // The games' download services only when a test brings its fakes.
    downloads: opts.downloads ?? { fetch: noNetwork, env: {} },
    // The host address's Detect only reaches a fake service a test brings (HST-08), never the real one.
    detect: { fetch: opts.detect ?? noNetwork },
    // Each game's Workshop source without the network (a list given applies to every game).
    mods: opts.mods ?? { pz: [createWorkshopSource({ fetch: noNetwork })], terraria: [createTmlWorkshopSource({ fetch: noNetwork })] },
    orchestrator: orch,
    adapters: opts.adapters,
    // Fake agents for orchestrator-run servers; every server's files (its agent's, in production) on the test's
    // disk: `default`'s where the environment says (tests write game files there), the others' in their own folder.
    factories: {
      agent: (row, target) => Object.assign(fakes(row.id), { target, made: (fakes(row.id).made ?? 0) + 1 }),
      files: (row, _target, e) =>
        isManaged(row) ? new LocalServerFiles({ data: fakes(row.id).dataDir, install: path.join(tmp, 'servers', row.id, 'install') }) : new LocalServerFiles({ data: e.pzDataDir, install: e.pzInstallDir }),
      // Install jobs' agents are the fake orchestrator's (HST-09).
      jobAgent: (url, token) => orch.jobAgent(url, token),
    },
    installPollMs: 5,
  });
  await bootstrapOwner(deps);
  const app = await buildApp(deps);
  return { app, deps, feed, agent, srv: deps.servers.get('default')!, orch, fakes };
}

/** A tiny cookie-jar client that behaves like the web UI (Origin + CSRF header). */
export class Client {
  cookie: string | null = null;
  csrf: string | null = null;

  constructor(
    private readonly app: FastifyInstance,
    private readonly origin: string | null = ORIGIN,
  ) {}

  async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, extra: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { ...extra };
    if (this.origin) headers.origin = this.origin;
    if (this.cookie) headers.cookie = `${SESSION_COOKIE}=${this.cookie}`;
    if (this.csrf && method !== 'GET') headers['x-gsp-csrf'] = this.csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.app.inject({ method, url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.cookies.find((c) => c.name === SESSION_COOKIE);
    if (set) this.cookie = set.value || null;
    if (res.statusCode < 300 && res.headers['content-type']?.toString().includes('json')) {
      const j = res.json() as { csrf?: string };
      if (j && typeof j === 'object' && 'csrf' in j && j.csrf) this.csrf = j.csrf;
    }
    return res;
  }

  get(url: string) {
    return this.req('GET', url);
  }
  post(url: string, body: unknown = {}) {
    return this.req('POST', url, body);
  }
}

/** A valid code for the step after the current one (never replays the enrolment step). */
export function totpCode(secret: string, offsetSteps = 1): string {
  return hotp(base32Decode(secret), currentStep() + offsetSteps);
}

/** Sign in as the owner and finish the forced password change and 2FA enrolment. */
export async function ownerReady(p: TestPanel): Promise<{ client: Client; secret: string; password: string; recoveryCodes: string[] }> {
  const c = new Client(p.app);
  await c.post('/api/auth/login', OWNER);
  const password = 'Nueva-clave-segura-2026';
  await c.post('/api/auth/password', { current: OWNER.password, next: password });
  const setup = (await c.post('/api/auth/totp/setup')).json() as { secret: string };
  const enabled = (await c.post('/api/auth/totp/enable', { code: totpCode(setup.secret, 0) })).json() as { recoveryCodes: string[] };
  return { client: c, secret: setup.secret, password, recoveryCodes: enabled.recoveryCodes };
}

/**
 * A friend signed in and ready: password changed, 2FA enrolled when their
 * role needs it. With `grants`, an account of scope `granted` holding those
 * roles (a bare role: on `default`; `null`: on nothing).
 */
export async function friend(p: TestPanel, owner: Client, name: string, role: 'viewer' | 'operator' | 'admin', grants?: GrantRole | Record<string, GrantRole> | null): Promise<Client> {
  const created = (await owner.post('/api/users', { username: name, password: 'Temporal-12345', role })).json() as { id: number };
  if (grants !== undefined) {
    p.deps.users.setScope(created.id, 'granted');
    const byServer = grants === null ? {} : typeof grants === 'string' ? { default: grants } : grants;
    for (const [sid, r] of Object.entries(byServer)) p.deps.grants.set(created.id, sid, r);
    syncRoleWithGrants(p.deps.users, p.deps.grants, created.id);
  }
  const c = new Client(p.app);
  await c.post('/api/auth/login', { username: name, password: 'Temporal-12345' });
  const after = (await c.post('/api/auth/password', { current: 'Temporal-12345', next: 'La-mia-propia-2026' })).json() as { pending: string | null };
  if (after.pending === 'enrol') {
    const { secret } = (await c.post('/api/auth/totp/setup')).json() as { secret: string };
    await c.post('/api/auth/totp/enable', { code: totpCode(secret, 0) });
  }
  return c;
}

/** What a websocket received, parsed. */
export type WsSeen = { type: string; serverId?: string; servers?: { serverId: string }[] } & Record<string, unknown>;

/** Opens the websocket as `c` and collects what it receives. */
export async function listenWs(p: TestPanel, c: Client): Promise<{ ws: { terminate(): void }; messages: WsSeen[] }> {
  await p.app.ready();
  const messages: WsSeen[] = [];
  const ws = await p.app.injectWS('/api/ws', { headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${c.cookie}` } }, {
    onInit: (sock) => sock.on('message', (d) => messages.push(JSON.parse(d.toString()) as WsSeen)),
  });
  await until(() => messages.length > 0);
  return { ws, messages };
}

/** Waits until `ok()` holds (at most `ms`, scaled like every test timeout); throws when it never does. */
export async function until(ok: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms * Number(process.env.TEST_TIME_SCALE || 1);
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}
