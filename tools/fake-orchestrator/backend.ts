// The orchestrator without Docker, for the development loop and tests: each
// "container" is a local agent process (packages/agent) driving the fake
// game of its adapter, on 127.0.0.1 inside the slot's ports. It sits behind
// the real orchestrator's HTTP layer and spec checks, so the panel sees the
// same API and the same refusals as in production.
//
// What differs from Docker, on purpose:
// - the game binds its ports on the host, so a spec's container ports become
//   their host ports, and ports that would stay inside a container (RCON)
//   get a free port from `controlPorts`;
// - the agent listens on a port from `agentPorts` (`agentUrl` says which);
// - stats are not measured (zeros, with the memory limit);
// - `stop` asks the agent over IPC (Docker's SIGTERM), then kills the tree;
// - images are names with made-up content ids, kept in servers.json;
//   `rebuildImage` stands for `docker build` again under the same tag;
// - each "container" records the derivation version it was made with, and
//   `changeDerivation` stands for an orchestrator release that derives
//   containers differently (a security fix, if it says so);
// - shared installs (HST-09, D12) are folders under `installs/<id>/`: an
//   install job is a local agent in install-job mode on `install/`, with
//   `data/` as its data folder, kept with the install (there are no mount
//   namespaces here, so the redirect links the job makes point into it: the
//   servers on one install share what lands behind them); a copy job is a
//   local copy; a server on a shared install gets its folder as its install
//   and is told it is shared, but nothing makes it read-only (the fake games
//   treat an install holding the shared-install marker as read-only).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PortDecl } from '@gsp/adapter-api';
import { runtimeAdapter } from '@gsp/adapters/runtime';
import {
  canonicalJson,
  conflict,
  DEFAULT_STOP_TIMEOUT_SEC,
  DERIVATION,
  derivationState,
  gameMismatch,
  IdLocks,
  imageName,
  installConflict,
  LABEL,
  MAX_INSTALL_JOBS,
  Mutex,
  notFound,
  refused,
  serverMismatch,
  specHash,
  type Backend,
  type CopySource,
  type Derivation,
  type InstallGame,
  type Policy,
} from '@gsp/orchestrator';
import {
  SHARED_INSTALL_MARKER,
  type ApplyOptions,
  type ContainerState,
  type CpuArch,
  type DeleteResponse,
  type HostInfo,
  type InstallDeleteResponse,
  type InstallInfo,
  type InstallJob,
  type InstallJobKind,
  type InstallJobSpec,
  type PortProto,
  type ServerContainer,
  type ServerSpec,
  type ServerStats,
} from '@gsp/shared';

const root = fileURLToPath(new URL('../../', import.meta.url));
const AGENT_ENTRY = fileURLToPath(new URL('./agent-entry.mjs', import.meta.url));
const FAKE_GAME = fileURLToPath(new URL('./fake-game.mjs', import.meta.url));
const MIB = 1024 * 1024;
/** What a container would not inherit from the orchestrator's environment. */
const NOT_INHERITED = /^(ORCH_|FAKE_ORCH_|AGENT_|GAME_|GSP_|DEV_|PANEL_|PZ_|STEAMCMD_)/;

/**
 * What of the fake orchestrator's own environment every agent gets
 * (`FakeBackendOptions.env`): the fake games' knobs (`FAKE_*`) and where
 * Minecraft and Terraria download from (`GAME_MC_*_URL`,
 * `GAME_TERRARIA_*_URL`: the fake download services in the dev loop, which
 * a real server spec would set as `GAME_*` keys).
 */
export function agentEnvFrom(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => /^(?:FAKE_(?!ORCH_)|GAME_(?:MC|TERRARIA)_[A-Z]+_URL$)/.test(e[0]) && e[1] !== undefined));
}

export interface FakeBackendOptions {
  /** servers.json and one folder per server (data, install, steam). */
  stateDir: string;
  policy: Policy;
  /** One per server, for its agent. */
  agentPorts: readonly number[];
  /** For ports that would stay inside a container (RCON…). */
  controlPorts: readonly number[];
  /** Nominal image tag in `ServerContainer.image` (default `dev`). */
  imageTag?: string;
  /** Extra environment for every agent (e.g. FAKE_PZ_BOOT_MS). */
  env?: Readonly<Record<string, string>>;
  /** Agent output, one line at a time, and what the fake does. */
  log?: (line: string) => void;
  /** Before an agent that exited on its own is started again (unless-stopped). Default 2000. */
  restartDelayMs?: number;
}

interface Stored {
  spec: ServerSpec;
  specHash: string;
  image: string;
  /** The content id `image` named when this "container" was made. */
  imageId: string;
  /** The derivation version it was made with. */
  derivation: number;
  agentPort: number;
  /** Port by `PortDecl.id` for ports the spec doesn't publish. */
  internal: Record<string, number>;
  /** Unless-stopped: started and not stopped since, so it comes back with the fake orchestrator. */
  running: boolean;
}

/** A shared install (HST-09): the game it holds, and its job while one exists. */
interface StoredInstall {
  game: InstallGame;
  createdAt: string;
  job: StoredJob | null;
}

interface StoredJob {
  kind: InstallJobKind;
  specHash: string;
  spec: InstallJobSpec;
  from: string | null;
  image: string;
  /** Install jobs: their agent's port. */
  agentPort: number | null;
}

interface Live {
  proc: ChildProcess | null;
  state: ContainerState;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  stopping: boolean;
  restartTimer: NodeJS.Timeout | null;
  exited: Promise<void> | null;
}

function archOf(a: string): CpuArch {
  return a === 'arm64' ? 'arm64' : 'amd64';
}

const bindTcp = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(true)));
  });
const bindUdp = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => {
      s.close();
      resolve(false);
    });
    s.bind({ port, address: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(true)));
  });
const isFree = (port: number, proto: PortProto) => (proto === 'tcp' ? bindTcp(port) : bindUdp(port));

function portDecls(adapter: string): readonly PortDecl[] {
  try {
    return runtimeAdapter(adapter).meta.ports;
  } catch {
    return [];
  }
}

function killTree(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

export class FakeBackend implements Backend {
  private readonly busy = new IdLocks();
  private readonly creating = new Mutex();
  private readonly stored = new Map<string, Stored>();
  private readonly live = new Map<string, Live>();
  private readonly stockedInstalls = new Map<string, StoredInstall>();
  /** Jobs: an install job's agent, or a copy (done in this process), by install id. */
  private readonly jobs = new Map<string, Live>();
  private readonly installBusy = new IdLocks();
  /** Image name → the content id it names now. */
  private readonly images = new Map<string, string>();
  /** How this "release" derives containers (the real one's, until `changeDerivation`). */
  private derivation: Derivation = { ...DERIVATION };
  private readonly file: string;
  private closing = false;

  constructor(private readonly o: FakeBackendOptions) {
    mkdirSync(o.stateDir, { recursive: true });
    this.file = path.join(o.stateDir, 'servers.json');
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { servers?: Record<string, Partial<Stored> & Omit<Stored, 'imageId' | 'derivation'>>; images?: Record<string, string>; derivation?: Derivation; installs?: Record<string, StoredInstall> };
      // A job doesn't outlive the fake orchestrator: its install stays, its job is gone.
      for (const [id, i] of Object.entries(saved.installs ?? {})) this.stockedInstalls.set(id, { ...i, job: null });
      for (const [name, id] of Object.entries(saved.images ?? {})) this.images.set(name, id);
      if (saved.derivation) this.derivation = saved.derivation;
      // A state file from before image ids or derivations: each server runs what its image names now, derived as now.
      for (const [id, s] of Object.entries(saved.servers ?? {})) this.stored.set(id, { ...s, imageId: s.imageId || this.imageId(s.image), derivation: s.derivation ?? this.derivation.version });
    }
  }

  /** The content id an image name resolves to now (made up on first use, like a first build). */
  imageId(name: string): string {
    let id = this.images.get(name);
    if (!id) {
      id = `sha256:${randomBytes(32).toString('hex')}`;
      this.images.set(name, id);
    }
    return id;
  }

  /** `docker build` again under the same name (a product upgrade): a new content id, which it returns. */
  rebuildImage(name: string): string {
    this.images.delete(name);
    const id = this.imageId(name);
    this.save();
    return id;
  }

  /**
   * An orchestrator release that derives containers differently (a product
   * upgrade): the next derivation version, and with `security` the oldest one
   * it keeps too. Returns the new version.
   */
  changeDerivation(o: { security?: boolean } = {}): number {
    const version = this.derivation.version + 1;
    this.derivation = { version, safeFrom: o.security ? version : this.derivation.safeFrom };
    this.save();
    return version;
  }

  private derivationOf(s: Stored) {
    return derivationState({ [LABEL.derivation]: String(s.derivation) }, this.derivation);
  }

  /** Brings back the servers that were running, as Docker does after a restart (SRV-06). */
  async init(): Promise<void> {
    for (const [id, s] of this.stored) if (s.running) await this.start(id).catch((e: Error) => this.log(`${id}: not started again: ${e.message}`));
  }

  /** Stops every agent (the fake orchestrator is going away); they come back with `init`. */
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.live.keys()].map((id) => this.halt(id, 30)));
    await Promise.all([...this.jobs.keys()].map((id) => this.haltJob(id)));
  }

  private log(line: string): void {
    this.o.log?.(line);
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify({ servers: Object.fromEntries(this.stored), images: Object.fromEntries(this.images), derivation: this.derivation, installs: Object.fromEntries(this.stockedInstalls) }, null, 2), { mode: 0o600 });
  }

  private liveOf(id: string): Live {
    let l = this.live.get(id);
    if (!l) {
      l = { proc: null, state: 'created', startedAt: null, finishedAt: null, exitCode: null, stopping: false, restartTimer: null, exited: null };
      this.live.set(id, l);
    }
    return l;
  }

  private dir(id: string): string {
    return path.join(this.o.stateDir, id);
  }

  private describe(id: string): ServerContainer {
    const s = this.stored.get(id);
    if (!s) throw notFound(`Server ${id} has no container`);
    const l = this.liveOf(id);
    return {
      id,
      state: l.state,
      startedAt: l.startedAt,
      finishedAt: l.finishedAt,
      exitCode: l.state === 'exited' ? l.exitCode : null,
      image: s.image,
      specHash: s.specHash,
      agentUrl: `http://127.0.0.1:${s.agentPort}`,
      imageId: s.imageId,
      latestImageId: this.imageId(s.image),
      derivation: this.derivationOf(s),
    };
  }

  async ping(): Promise<void> {}

  async host(): Promise<HostInfo> {
    return { arch: archOf(os.arch()), cpus: os.cpus().length, memBytes: os.totalmem(), dockerVersion: 'fake', os: `${os.type()} (fake orchestrator)` };
  }

  async list(): Promise<ServerContainer[]> {
    return [...this.stored.keys()].sort().map((id) => this.describe(id));
  }

  apply(spec: ServerSpec, o: ApplyOptions = {}): Promise<ServerContainer> {
    return this.busy.run(spec.id, async () => {
      const image = `gsp/${imageName(spec.runtime, spec.variant, true)}:${this.o.imageTag ?? 'dev'}`;
      const hash = specHash(spec);
      const old = this.stored.get(spec.id);
      // As the real one: a rebuilt image, or another release's derivation, recreates a matching "container" unless
      // the caller keeps it (never across a security fix).
      const derived = old ? this.derivationOf(old) : 'current';
      const keptDerivation = derived === 'current' || (derived === 'changed' && o.keepDerivation === true);
      if (old && old.specHash === hash && old.image === image && keptDerivation && (o.keepImage === true || old.imageId === this.imageId(image))) return this.describe(spec.id);
      if (spec.cpus !== undefined && spec.cpus > os.cpus().length) throw refused('cpus', `This host has ${os.cpus().length} CPUs`);
      await this.creating.run(async () => {
        if (!old && this.stored.size >= this.o.policy.maxServers) throw refused('id', `This host allows at most ${this.o.policy.maxServers} servers`);
        if (spec.install !== undefined) this.checkSharedInstall(spec, spec.install);
        await this.checkPorts(spec);
      });
      if (old && this.liveOf(spec.id).proc) await this.halt(spec.id, DEFAULT_STOP_TIMEOUT_SEC);
      await this.creating.run(async () => {
        if (spec.install !== undefined) this.checkSharedInstall(spec, spec.install);
        await this.checkPorts(spec);
        const agentPort = old?.agentPort ?? this.freePort(this.o.agentPorts, this.agentPortsUsed(), 'agent');
        const internal: Record<string, number> = {};
        const usedInternal = new Set([...this.stored.entries()].filter(([id]) => id !== spec.id).flatMap(([, s]) => Object.values(s.internal)));
        for (const d of portDecls(spec.env.GAME_ADAPTER)) {
          const inside = Number(spec.env[`GAME_PORT_${d.id.toUpperCase()}`] ?? d.default);
          if (spec.ports.some((p) => p.container === inside && p.proto === d.proto)) continue;
          internal[d.id] = old?.internal[d.id] ?? this.freePort(this.o.controlPorts, usedInternal, 'internal');
          usedInternal.add(internal[d.id]!);
        }
        this.stored.set(spec.id, { spec, specHash: hash, image, imageId: this.imageId(image), derivation: this.derivation.version, agentPort, internal, running: false });
        this.save();
      });
      const l = this.liveOf(spec.id);
      Object.assign(l, { state: 'created', startedAt: null, finishedAt: null, exitCode: null });
      return this.describe(spec.id);
    });
  }

  private freePort(pool: readonly number[], used: ReadonlySet<number>, what: string): number {
    const p = pool.find((x) => !used.has(x));
    if (p === undefined) throw conflict(`No free ${what} port left in the fake orchestrator's pool`);
    return p;
  }

  /** Host ports another server holds, or something else on this machine listens on. */
  private async checkPorts(spec: ServerSpec): Promise<void> {
    const mine = this.stored.get(spec.id);
    for (const [i, p] of spec.ports.entries()) {
      for (const [id, s] of this.stored) {
        if (id !== spec.id && s.spec.ports.some((q) => q.host === p.host && q.proto === p.proto)) throw conflict(`Host port ${p.host}/${p.proto} is already published by server ${id}`, `ports[${i}].host`);
      }
      const ownRunning = mine && this.liveOf(spec.id).proc && mine.spec.ports.some((q) => q.host === p.host && q.proto === p.proto);
      if (!ownRunning && !(await isFree(p.host, p.proto))) throw conflict(`Host port ${p.host}/${p.proto} is already in use on this host`, `ports[${i}].host`);
    }
  }

  private env(id: string, s: Stored): NodeJS.ProcessEnv {
    const dir = this.dir(id);
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !NOT_INHERITED.test(k)) env[k] = v;
    Object.assign(env, this.o.env ?? {});
    for (const [k, v] of Object.entries(s.spec.env)) if (v !== undefined) env[k] = v;
    // The game binds on this machine: published ports keep their host number, the rest get their own.
    for (const [k, v] of Object.entries(s.spec.env)) {
      const m = /^GAME_PORT_([A-Z0-9_]+)$/.exec(k);
      const p = m && s.spec.ports.find((q) => q.container === Number(v));
      if (p) env[k] = String(p.host);
    }
    for (const d of portDecls(s.spec.env.GAME_ADAPTER)) {
      const key = `GAME_PORT_${d.id.toUpperCase()}` as const;
      const inside = Number(s.spec.env[key] ?? d.default);
      const published = s.spec.ports.find((q) => q.container === inside && q.proto === d.proto);
      env[key] = String(published ? published.host : s.internal[d.id]);
    }
    const node = process.execPath;
    return {
      ...env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(s.agentPort),
      GAME_DATA_DIR: path.join(dir, 'data'),
      // A shared install (HST-09) in place of its own, and the agent told so, as the orchestrator does.
      GAME_INSTALL_DIR: s.spec.install === undefined ? path.join(dir, 'install') : this.installDir(s.spec.install),
      ...(s.spec.install === undefined ? {} : { GSP_INSTALL_SHARED: '1' }),
      HOME: path.join(dir, 'steam'),
      STEAMCMD_COMMAND: JSON.stringify([node, FAKE_GAME, 'steamcmd']),
      GAME_START_COMMAND: JSON.stringify([node, FAKE_GAME, 'server']),
    };
  }

  // ------------------------------------------------------------ shared installs (HST-09, D12)

  private installRoot(id: string): string {
    return path.join(this.o.stateDir, 'installs', id);
  }

  /** The install's files, as servers on it see them. */
  installDir(id: string): string {
    return path.join(this.installRoot(id), 'install');
  }

  private agentPortsUsed(): Set<number> {
    const used = new Set([...this.stored.values()].map((s) => s.agentPort));
    for (const i of this.stockedInstalls.values()) if (i.job?.agentPort) used.add(i.job.agentPort);
    return used;
  }

  /** As the real one refuses (`DockerBackend`): no such install, another game's, one with a job, one no job finished. */
  private checkSharedInstall(spec: ServerSpec, id: string): void {
    const i = this.stockedInstalls.get(id);
    if (!i) throw refused('install', `Install ${id} does not exist in this stack`);
    const why = serverMismatch(i.game, spec);
    if (why) throw refused('install', `Install ${id} doesn't fit server ${spec.id}: ${why}`);
    if (i.job) throw installConflict('install-busy', `Install ${id} has a job: no server mounts it before its job is removed`);
    if (!existsSync(path.join(this.installDir(id), SHARED_INSTALL_MARKER))) throw installConflict('install-not-ready', `No install job finished install ${id} (it has no shared-install marker): no server mounts it`);
  }

  private mountedBy(id: string): string[] {
    return [...this.stored.entries()].filter(([, s]) => s.spec.install === id).map(([sid]) => sid).sort();
  }

  private describeInstall(id: string): InstallInfo {
    const i = this.stockedInstalls.get(id);
    if (!i) throw notFound(`Install ${id} does not exist in this stack`);
    const l = this.jobs.get(id);
    const job: InstallJob | null = i.job
      ? {
          kind: i.job.kind,
          state: (l?.state ?? 'exited') as InstallJob['state'],
          startedAt: l?.startedAt ?? null,
          finishedAt: l?.finishedAt ?? null,
          exitCode: l && l.state === 'exited' ? l.exitCode : null,
          image: i.job.image,
          agentUrl: i.job.agentPort ? `http://127.0.0.1:${i.job.agentPort}` : null,
          from: i.job.from,
        }
      : null;
    return { id, ...i.game, volume: `installs/${id}`, createdAt: i.createdAt, mountedBy: this.mountedBy(id), job };
  }

  async installs(): Promise<InstallInfo[]> {
    return [...this.stockedInstalls.keys()].sort().map((id) => this.describeInstall(id));
  }

  putInstall(spec: InstallJobSpec, src: CopySource | null): Promise<InstallInfo> {
    const id = spec.id;
    return this.installBusy.run(id, async () => {
      const kind: InstallJobKind = src === null ? 'install' : 'copy';
      const from = src === null ? null : 'install' in src ? src.install : `server:${src.server}`;
      const hash = createHash('sha256').update(canonicalJson({ spec, kind, from })).digest('hex');
      const old = this.stockedInstalls.get(id);
      if (old?.job) {
        if (old.job.specHash !== hash) throw installConflict('install-busy', `Install ${id} has a job already: remove it first`, 'id');
        return this.describeInstall(id);
      }
      const game: InstallGame = { adapter: spec.env.GAME_ADAPTER, flavour: spec.env.GAME_FLAVOUR ?? null, runtime: spec.runtime, variant: spec.variant ?? null };
      await this.creating.run(async () => {
        if ([...this.stockedInstalls.values()].filter((i) => i.job).length >= MAX_INSTALL_JOBS) throw conflict(`At most ${MAX_INSTALL_JOBS} install jobs run at once on this host`, 'id');
        if (old) {
          const why = gameMismatch(old.game, spec);
          if (why) throw refused('id', `Install ${id} was made for another game: ${why}`);
          if (src) throw conflict(`Install ${id} exists already: a copy goes into a new install`, 'id');
        }
        const users = this.mountedBy(id);
        if (users.length) throw installConflict('install-in-use', `Install ${id} is mounted by ${users.map((u) => `server ${u}`).join(', ')}: a job never writes an install a server reads`, 'id');
        const source = src === null ? null : this.copySource(spec, src);
        const image = `gsp/${imageName(spec.runtime, spec.variant, true)}:${this.o.imageTag ?? 'dev'}`;
        const job: StoredJob = { kind, specHash: hash, spec, from, image, agentPort: kind === 'install' ? this.freePort(this.o.agentPorts, this.agentPortsUsed(), 'agent') : null };
        this.stockedInstalls.set(id, { game, createdAt: old?.createdAt ?? new Date().toISOString(), job });
        for (const sub of ['install', 'data']) mkdirSync(path.join(this.installRoot(id), sub), { recursive: true });
        this.save();
        if (source !== null) this.copy(id, source);
        else this.launchJob(id, job);
      });
      return this.describeInstall(id);
    });
  }

  /** A copy's source folder, as the real one checks it: a finished install of the game, or a stopped server's own install of it. */
  private copySource(spec: InstallJobSpec, src: CopySource): string {
    if ('install' in src) {
      const s = this.stockedInstalls.get(src.install);
      if (!s) throw refused('from', `Install ${src.install} does not exist in this stack`);
      const why = gameMismatch(s.game, spec);
      if (why) throw refused('from', `Install ${src.install} can't be copied into ${spec.id}: ${why}`);
      if (s.job) throw installConflict('install-busy', `Install ${src.install} has a job: nothing copies it before its job is removed`, 'from');
      if (!existsSync(path.join(this.installDir(src.install), SHARED_INSTALL_MARKER))) throw installConflict('install-not-ready', `No install job finished install ${src.install}: nothing copies it`, 'from');
      return this.installDir(src.install);
    }
    const s = this.stored.get(src.server);
    if (!s || s.spec.install !== undefined) throw refused('fromServer', `Server ${src.server} has no install volume of its own`);
    const why = gameMismatch({ adapter: s.spec.env.GAME_ADAPTER, flavour: s.spec.env.GAME_FLAVOUR ?? null, runtime: s.spec.runtime, variant: s.spec.variant ?? null }, spec);
    if (why) throw refused('fromServer', `Server ${src.server}'s install can't be copied into ${spec.id}: ${why}`);
    if (this.liveOf(src.server).proc) throw installConflict('server-running', `Server ${src.server} is running: its install is copied once it is stopped`, 'fromServer');
    return path.join(this.dir(src.server), 'install');
  }

  /** The copy job: links kept as links, times kept (`cp -a`); it has finished when this returns. */
  private copy(id: string, source: string): void {
    const l: Live = { proc: null, state: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, stopping: false, restartTimer: null, exited: null };
    this.jobs.set(id, l);
    let code = 0;
    try {
      cpSync(source, this.installDir(id), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, force: true });
    } catch (e) {
      code = 1;
      this.log(`install ${id}: the copy failed: ${(e as Error).message}`);
    }
    Object.assign(l, { state: 'exited', finishedAt: new Date().toISOString(), exitCode: code });
  }

  /** The install job: the agent in install-job mode on the install's folder, its own data folder and HOME. */
  private launchJob(id: string, job: StoredJob): void {
    const base = this.installRoot(id);
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !NOT_INHERITED.test(k)) env[k] = v;
    Object.assign(env, this.o.env ?? {});
    for (const [k, v] of Object.entries(job.spec.env)) if (v !== undefined) env[k] = v;
    mkdirSync(path.join(base, 'home'), { recursive: true });
    const node = process.execPath;
    Object.assign(env, {
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(job.agentPort),
      GAME_DATA_DIR: path.join(base, 'data'),
      GAME_INSTALL_DIR: this.installDir(id),
      HOME: path.join(base, 'home'),
      GSP_AGENT_MODE: 'install-job',
      STEAMCMD_COMMAND: JSON.stringify([node, FAKE_GAME, 'steamcmd']),
      GAME_START_COMMAND: JSON.stringify([node, FAKE_GAME, 'server']),
    });
    const child = spawn(process.execPath, ['--import', 'tsx', AGENT_ENTRY], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: process.platform !== 'win32', windowsHide: true });
    for (const stream of [child.stdout, child.stderr]) {
      let rest = '';
      stream?.on('data', (d: Buffer) => {
        rest += d.toString();
        const lines = rest.split(/\r?\n/);
        rest = lines.pop() ?? '';
        for (const line of lines) this.log(`[job ${id}] ${line}`);
      });
    }
    const l: Live = { proc: child, state: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, stopping: false, restartTimer: null, exited: null };
    l.exited = new Promise<void>((resolve) => {
      child.on('exit', (code, signal) => {
        Object.assign(l, { proc: null, state: 'exited', finishedAt: new Date().toISOString(), exitCode: code ?? (signal ? 137 : 0) });
        resolve();
      });
    });
    this.jobs.set(id, l);
  }

  /** Stops a job's agent (if it runs), killing it after a while. */
  private async haltJob(id: string): Promise<void> {
    const l = this.jobs.get(id);
    const child = l?.proc;
    if (!l || !child) return;
    if (child.connected) child.send('stop');
    const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000).unref());
    if ((await Promise.race([l.exited, timer])) === 'timeout' && child.pid) killTree(child.pid);
    await l.exited;
  }

  removeInstallJob(id: string): Promise<InstallDeleteResponse> {
    return this.installBusy.run(id, async () => {
      const i = this.stockedInstalls.get(id);
      if (!i?.job) return { removed: false };
      await this.haltJob(id);
      this.jobs.delete(id);
      i.job = null;
      rmSync(path.join(this.installRoot(id), 'home'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      this.save();
      return { removed: true };
    });
  }

  removeOwnInstall(id: string): Promise<InstallDeleteResponse> {
    return this.busy.run(id, async () => {
      const dir = path.join(this.dir(id), 'install');
      if (!existsSync(dir)) return { removed: false };
      const s = this.stored.get(id);
      if (s && s.spec.install === undefined) throw installConflict('install-in-use', `Server ${id}'s own install is mounted by server ${id}: it still runs from it`, 'id');
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return { removed: true };
    });
  }

  removeInstall(id: string): Promise<InstallDeleteResponse> {
    return this.installBusy.run(id, () =>
      this.creating.run(async () => {
        const i = this.stockedInstalls.get(id);
        if (!i) return { removed: false };
        if (i.job) throw installConflict('install-busy', `Install ${id} has a job: remove the job first`, 'id');
        const users = this.mountedBy(id);
        if (users.length) throw installConflict('install-in-use', `Install ${id} is mounted by ${users.map((u) => `server ${u}`).join(', ')}`, 'id');
        this.stockedInstalls.delete(id);
        this.save();
        rmSync(this.installRoot(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        return { removed: true };
      }),
    );
  }

  start(id: string): Promise<ServerContainer> {
    return this.busy.run(id, () => this.launch(id));
  }

  private async launch(id: string): Promise<ServerContainer> {
    const s = this.stored.get(id);
    if (!s) throw notFound(`Server ${id} has no container`);
    const l = this.liveOf(id);
    if (l.restartTimer) clearTimeout(l.restartTimer);
    l.restartTimer = null;
    if (l.proc) return this.describe(id);
    // Like Docker: a port someone else holds fails the start.
    if (!(await bindTcp(s.agentPort))) throw conflict(`Agent port ${s.agentPort} is already in use on this host`);
    for (const p of s.spec.ports) if (!(await isFree(p.host, p.proto))) throw conflict(`Bind for 127.0.0.1:${p.host} failed: port is already allocated`);
    // Its own volumes: no install of its own on a shared one (HST-09).
    for (const sub of s.spec.install === undefined ? ['data', 'install', 'steam'] : ['data', 'steam']) mkdirSync(path.join(this.dir(id), sub), { recursive: true });
    s.running = true;
    this.save();
    const child = spawn(process.execPath, ['--import', 'tsx', AGENT_ENTRY], {
      cwd: root,
      env: this.env(id, s),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    for (const stream of [child.stdout, child.stderr]) {
      let rest = '';
      stream?.on('data', (d: Buffer) => {
        rest += d.toString();
        const lines = rest.split(/\r?\n/);
        rest = lines.pop() ?? '';
        for (const line of lines) this.log(`[${id}] ${line}`);
      });
    }
    Object.assign(l, { proc: child, state: 'running', startedAt: new Date().toISOString(), stopping: false, exitCode: null });
    l.exited = new Promise<void>((resolve) => {
      child.on('exit', (code, signal) => {
        if (l.proc === child) {
          Object.assign(l, { proc: null, state: 'exited', finishedAt: new Date().toISOString(), exitCode: code ?? (signal ? 137 : 0) });
          if (!l.stopping && !this.closing && this.stored.get(id)?.running) {
            this.log(`${id}: agent exited (${code ?? signal}); starting it again`);
            l.restartTimer = setTimeout(() => void this.launch(id).catch((e: Error) => this.log(`${id}: ${e.message}`)), this.o.restartDelayMs ?? 2000);
          }
        }
        resolve();
      });
    });
    return this.describe(id);
  }

  /** Stops the agent (the "container") without changing whether it should run. */
  private async halt(id: string, timeoutSec: number): Promise<void> {
    const l = this.liveOf(id);
    if (l.restartTimer) clearTimeout(l.restartTimer);
    l.restartTimer = null;
    const child = l.proc;
    if (!child) return;
    l.stopping = true;
    if (child.connected) child.send('stop');
    const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutSec * 1000).unref());
    if ((await Promise.race([l.exited, timer])) === 'timeout' && child.pid) killTree(child.pid);
    await l.exited;
    // The agent is gone; whatever it left behind (a game that ignored it) goes with its tree.
    l.stopping = false;
  }

  stop(id: string, timeoutSec = DEFAULT_STOP_TIMEOUT_SEC): Promise<ServerContainer> {
    return this.busy.run(id, async () => {
      const s = this.stored.get(id);
      if (!s) throw notFound(`Server ${id} has no container`);
      s.running = false;
      this.save();
      await this.halt(id, timeoutSec);
      return this.describe(id);
    });
  }

  restart(id: string, timeoutSec = DEFAULT_STOP_TIMEOUT_SEC): Promise<ServerContainer> {
    return this.busy.run(id, async () => {
      if (!this.stored.has(id)) throw notFound(`Server ${id} has no container`);
      await this.halt(id, timeoutSec);
      return this.launch(id);
    });
  }

  async stats(id: string): Promise<ServerStats> {
    const s = this.stored.get(id);
    if (!s) throw notFound(`Server ${id} has no container`);
    return { id, at: new Date().toISOString(), cpuPercent: 0, memBytes: 0, memLimitBytes: s.spec.memoryMb * MIB, netRxBytes: 0, netTxBytes: 0 };
  }

  remove(id: string, removeVolumes: boolean): Promise<DeleteResponse> {
    return this.busy.run(id, async () => {
      const existed = this.stored.has(id);
      await this.halt(id, DEFAULT_STOP_TIMEOUT_SEC);
      this.stored.delete(id);
      this.live.delete(id);
      this.save();
      if (removeVolumes) rmSync(this.dir(id), { recursive: true, force: true });
      return { removed: existed, volumesRemoved: removeVolumes };
    });
  }
}
