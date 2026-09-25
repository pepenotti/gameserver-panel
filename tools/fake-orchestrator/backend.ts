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
// - `stop` asks the agent over IPC (Docker's SIGTERM), then kills the tree.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import dgram from 'node:dgram';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PortDecl } from '@gsp/adapter-api';
import { runtimeAdapter } from '@gsp/adapters/runtime';
import { conflict, DEFAULT_STOP_TIMEOUT_SEC, IdLocks, imageName, Mutex, notFound, refused, specHash, type Backend, type Policy } from '@gsp/orchestrator';
import type { ContainerState, CpuArch, DeleteResponse, HostInfo, PortProto, ServerContainer, ServerSpec, ServerStats } from '@gsp/shared';

const root = fileURLToPath(new URL('../../', import.meta.url));
const AGENT_ENTRY = fileURLToPath(new URL('./agent-entry.mjs', import.meta.url));
const FAKE_GAME = fileURLToPath(new URL('./fake-game.mjs', import.meta.url));
const MIB = 1024 * 1024;
/** What a container would not inherit from the orchestrator's environment. */
const NOT_INHERITED = /^(ORCH_|FAKE_ORCH_|AGENT_|GAME_|GSP_|DEV_|PANEL_|PZ_|STEAMCMD_)/;

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
  agentPort: number;
  /** Port by `PortDecl.id` for ports the spec doesn't publish. */
  internal: Record<string, number>;
  /** Unless-stopped: started and not stopped since, so it comes back with the fake orchestrator. */
  running: boolean;
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
  private readonly file: string;
  private closing = false;

  constructor(private readonly o: FakeBackendOptions) {
    mkdirSync(o.stateDir, { recursive: true });
    this.file = path.join(o.stateDir, 'servers.json');
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { servers?: Record<string, Stored> };
      for (const [id, s] of Object.entries(saved.servers ?? {})) this.stored.set(id, s);
    }
  }

  /** Brings back the servers that were running, as Docker does after a restart (SRV-06). */
  async init(): Promise<void> {
    for (const [id, s] of this.stored) if (s.running) await this.start(id).catch((e: Error) => this.log(`${id}: not started again: ${e.message}`));
  }

  /** Stops every agent (the fake orchestrator is going away); they come back with `init`. */
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.live.keys()].map((id) => this.halt(id, 30)));
  }

  private log(line: string): void {
    this.o.log?.(line);
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify({ servers: Object.fromEntries(this.stored) }, null, 2), { mode: 0o600 });
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
    };
  }

  async ping(): Promise<void> {}

  async host(): Promise<HostInfo> {
    return { arch: archOf(os.arch()), cpus: os.cpus().length, memBytes: os.totalmem(), dockerVersion: 'fake', os: `${os.type()} (fake orchestrator)` };
  }

  async list(): Promise<ServerContainer[]> {
    return [...this.stored.keys()].sort().map((id) => this.describe(id));
  }

  apply(spec: ServerSpec): Promise<ServerContainer> {
    return this.busy.run(spec.id, async () => {
      const image = `gsp/${imageName(spec.runtime, spec.variant, true)}:${this.o.imageTag ?? 'dev'}`;
      const hash = specHash(spec);
      const old = this.stored.get(spec.id);
      if (old && old.specHash === hash && old.image === image) return this.describe(spec.id);
      if (spec.cpus !== undefined && spec.cpus > os.cpus().length) throw refused('cpus', `This host has ${os.cpus().length} CPUs`);
      await this.creating.run(async () => {
        if (!old && this.stored.size >= this.o.policy.maxServers) throw refused('id', `This host allows at most ${this.o.policy.maxServers} servers`);
        await this.checkPorts(spec);
      });
      if (old && this.liveOf(spec.id).proc) await this.halt(spec.id, DEFAULT_STOP_TIMEOUT_SEC);
      await this.creating.run(async () => {
        await this.checkPorts(spec);
        const agentPort = old?.agentPort ?? this.freePort(this.o.agentPorts, new Set([...this.stored.values()].map((s) => s.agentPort)), 'agent');
        const internal: Record<string, number> = {};
        const usedInternal = new Set([...this.stored.entries()].filter(([id]) => id !== spec.id).flatMap(([, s]) => Object.values(s.internal)));
        for (const d of portDecls(spec.env.GAME_ADAPTER)) {
          const inside = Number(spec.env[`GAME_PORT_${d.id.toUpperCase()}`] ?? d.default);
          if (spec.ports.some((p) => p.container === inside && p.proto === d.proto)) continue;
          internal[d.id] = old?.internal[d.id] ?? this.freePort(this.o.controlPorts, usedInternal, 'internal');
          usedInternal.add(internal[d.id]!);
        }
        this.stored.set(spec.id, { spec, specHash: hash, image, agentPort, internal, running: false });
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
      GAME_INSTALL_DIR: path.join(dir, 'install'),
      HOME: path.join(dir, 'steam'),
      STEAMCMD_COMMAND: JSON.stringify([node, FAKE_GAME, 'steamcmd']),
      GAME_START_COMMAND: JSON.stringify([node, FAKE_GAME, 'server']),
    };
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
    for (const sub of ['data', 'install', 'steam']) mkdirSync(path.join(this.dir(id), sub), { recursive: true });
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
