import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildIni, isFatal, makeRedactor, parseAppManifest, parseLogLine, parsePlayers, PZ_PATTERNS, setIniValues } from '@pz/formats';
import type { AgentStatus, AlertKind, AppInfoResponse, CommandResponse, JobInfo, JobKind, JobResult, LaunchParams, ServerState } from '@pz/shared';
import type { AgentConfig } from './config';
import type { EventHub } from './events';
import { spawnGame, type GameProcess } from './process';
import { RconClient } from './rcon-client';
import { downloadWorkshopItems, fetchBranches, installGame } from './steamcmd';
import type { StateStore } from './state-store';
import { diskStats, ProcessSampler } from './stats';

export class AgentError extends Error {
  constructor(
    readonly code: 'bad-request' | 'conflict' | 'locked' | 'unavailable' | 'not-found',
    message: string,
  ) {
    super(message);
  }
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const ADMIN_USER = /^[A-Za-z0-9_]{1,32}$/;
const ADMIN_PASSWORD = /^[\x21-\x7e]{8,64}$/;
const BRANCH = /^[A-Za-z0-9._-]{1,64}$/;

export function validateLaunch(l: unknown): LaunchParams {
  const o = (l ?? {}) as Record<string, unknown>;
  const bad = (m: string): never => {
    throw new AgentError('bad-request', m);
  };
  if (typeof o.serverName !== 'string' || !NAME.test(o.serverName)) bad('serverName must be 1-32 letters, digits, _ or -');
  if (typeof o.adminUsername !== 'string' || !ADMIN_USER.test(o.adminUsername)) bad('adminUsername must be 1-32 letters, digits or _');
  if (typeof o.adminPassword !== 'string' || !ADMIN_PASSWORD.test(o.adminPassword)) bad('adminPassword must be 8-64 printable characters without spaces');
  if (typeof o.memoryMb !== 'number' || !Number.isInteger(o.memoryMb) || o.memoryMb < 1024 || o.memoryMb > 65536) bad('memoryMb must be 1024-65536');
  if (typeof o.branch !== 'string' || !BRANCH.test(o.branch)) bad('branch is invalid');
  if (typeof o.updateOnStart !== 'boolean') bad('updateOnStart must be a boolean');
  return {
    serverName: o.serverName as string,
    adminUsername: o.adminUsername as string,
    adminPassword: o.adminPassword as string,
    memoryMb: o.memoryMb as number,
    branch: o.branch as string,
    updateOnStart: o.updateOnStart as boolean,
  };
}

/** The game's environment: ours minus the agent secret (mods run inside the JVM). */
function gameEnv(): NodeJS.ProcessEnv {
  const { AGENT_TOKEN: _token, ...env } = process.env;
  return { ...env, LANG: 'C.UTF-8' };
}

export class Agent {
  private state: ServerState = 'stopped';
  private proc: GameProcess | null = null;
  private startedAt: Date | null = null;
  private readyAt: Date | null = null;
  private lastExit: AgentStatus['lastExit'] = null;
  private failure: string | null = null;
  private installed: AgentStatus['installed'] = null;
  private players: AgentStatus['players'] = null;
  private rconError: string | null = null;
  private lock: { id: string; holder: string; expiresAt: number } | null = null;
  private job: JobInfo | null = null;
  private crashes: number[] = [];
  private expectExit = false;
  private readyTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private failedPolls = 0;
  private serverStartedAt: number | null = null;
  private unresponsiveAlerted = false;
  private readonly control = new Mutex();
  private readonly steam = new Mutex();
  private readonly sampler = new ProcessSampler();
  private readonly rcon: RconClient;
  private redact: (line: string) => string;
  private shuttingDown = false;
  private readonly bootId = randomUUID();

  constructor(
    private readonly cfg: AgentConfig,
    private readonly store: StateStore,
    private readonly hub: EventHub,
  ) {
    this.rcon = new RconClient('127.0.0.1', cfg.rconPort, () => this.store.get().rconPassword);
    this.redact = this.makeRedactor();
  }

  private makeRedactor() {
    const s = this.store.get();
    return makeRedactor([s.rconPassword, s.launch?.adminPassword, this.cfg.token]);
  }

  // ---------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    this.readInstalled();
    this.statusTimer = setInterval(() => this.emitState(), 15_000);
    this.statusTimer.unref();
    const s = this.store.get();
    if (s.desired === 'running' && s.launch) {
      this.log(`Resuming: the server was running before the agent restarted.`);
      this.start(undefined, undefined).catch((e: Error) => this.log(`Autostart failed: ${e.message}`));
    }
  }

  /** Container is going down: stop the game cleanly but remember it should run. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.proc) await this.control.run(() => this.gracefulStop(this.cfg.stopTimeoutMs, 'container shutdown'));
    this.rcon.close();
  }

  // ------------------------------------------------------------------ status

  status(): AgentStatus {
    const s = this.store.get();
    this.expireLock();
    const { adminPassword: _pw, ...launch } = s.launch ?? ({} as LaunchParams);
    return {
      agentVersion: this.cfg.version,
      bootId: this.bootId,
      state: this.state,
      desired: s.desired,
      pid: this.proc?.pid ?? null,
      startedAt: this.startedAt?.toISOString() ?? null,
      readyAt: this.readyAt?.toISOString() ?? null,
      lastExit: this.lastExit,
      failure: this.failure,
      gameVersion: s.gameVersion,
      installed: this.installed,
      players: this.players,
      rcon: { connected: this.rcon.connected, lastError: this.rconError },
      lock: this.lock ? { holder: this.lock.holder, expiresAt: new Date(this.lock.expiresAt).toISOString() } : null,
      job: this.job,
      recentCrashes: this.crashes.map((t) => new Date(t).toISOString()),
      launch: s.launch ? launch : null,
      process: this.sampler.sample(this.proc?.pid ?? null),
      disks: diskStats([this.cfg.dataDir, this.cfg.installDir]),
      now: new Date().toISOString(),
    };
  }

  private setState(next: ServerState): void {
    if (this.state === next) return;
    this.state = next;
    this.emitState();
  }

  private emitState(): void {
    this.hub.emit({ type: 'state', status: this.status() });
  }

  private log(line: string): void {
    this.hub.emit({ type: 'log', stream: 'agent', line: this.redact(line) });
  }

  private alert(kind: AlertKind, message: string): void {
    this.hub.emit({ type: 'alert', kind, message });
    this.log(`[${kind}] ${message}`);
  }

  // -------------------------------------------------------------------- lock

  private expireLock(): void {
    if (this.lock && this.lock.expiresAt <= Date.now()) this.lock = null;
  }

  private checkLock(lockId: string | undefined): void {
    this.expireLock();
    if (this.lock && this.lock.id !== lockId) throw new AgentError('locked', `Maintenance in progress (${this.lock.holder})`);
  }

  acquireLock(holder: string, ttlMs: number): { id: string; expiresAt: string } {
    this.expireLock();
    if (this.lock) throw new AgentError('locked', `Already locked by ${this.lock.holder}`);
    if (!/^[\w .:-]{1,64}$/.test(holder)) throw new AgentError('bad-request', 'Invalid lock holder');
    const ttl = Math.min(Math.max(ttlMs, 10_000), 6 * 3_600_000);
    this.lock = { id: randomUUID(), holder, expiresAt: Date.now() + ttl };
    this.emitState();
    return { id: this.lock.id, expiresAt: new Date(this.lock.expiresAt).toISOString() };
  }

  renewLock(id: string, ttlMs: number): void {
    this.checkLock(id);
    if (!this.lock) throw new AgentError('not-found', 'No lock');
    this.lock.expiresAt = Date.now() + Math.min(Math.max(ttlMs, 10_000), 6 * 3_600_000);
  }

  releaseLock(id: string): void {
    this.expireLock();
    if (this.lock?.id === id) {
      this.lock = null;
      this.emitState();
    }
  }

  // ------------------------------------------------------------------- start

  setLaunch(launch: LaunchParams): void {
    this.store.update({ launch });
    this.redact = this.makeRedactor();
    this.emitState();
  }

  start(launch: LaunchParams | undefined, lockId: string | undefined): Promise<void> {
    this.checkLock(lockId);
    if (launch) this.setLaunch(launch);
    return this.control.run(async () => {
      if (this.proc || this.state === 'installing') return; // already up or coming up
      const l = this.store.get().launch;
      if (!l) throw new AgentError('bad-request', 'No launch parameters yet');
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      this.store.update({ desired: 'running' });
      this.failure = null;
      await this.doStart(l);
    });
  }

  private async doStart(l: LaunchParams): Promise<void> {
    const needsInstall = !this.installed || this.installed.branch !== l.branch;
    if (needsInstall || l.updateOnStart) {
      const res = await this.runInstall(l.branch, false);
      if (!res.ok) {
        // An update failure with a working install is not fatal: start the old build.
        if (needsInstall) return this.fail('start-failed', `Game install failed: ${res.error ?? 'unknown error'}`);
        this.log(`Update failed (${res.error}); starting the installed build.`);
      }
    }
    this.enforceIni(l.serverName);

    const cmd = [
      ...this.cfg.startCommand,
      `-Xms${l.memoryMb}m`,
      `-Xmx${l.memoryMb}m`,
      ...this.cfg.baseJvmArgs,
      '--',
      '-servername',
      l.serverName,
      `-cachedir=${this.cfg.dataDir}`,
      '-adminusername',
      l.adminUsername,
      '-adminpassword',
      l.adminPassword,
    ];
    this.log(`Starting: ${this.redact(cmd.join(' '))}`);
    this.expectExit = false;
    this.players = null;
    this.readyAt = null;
    this.serverStartedAt = null;
    this.failedPolls = 0;
    this.unresponsiveAlerted = false;
    this.sampler.reset();
    let proc: GameProcess;
    try {
      proc = spawnGame(cmd, {
        cwd: this.cfg.installDir,
        env: gameEnv(),
        onStdout: (line) => this.onGameLine(line, 'out'),
        onStderr: (line) => this.onGameLine(line, 'err'),
      });
    } catch (e) {
      return this.fail('start-failed', (e as Error).message);
    }
    this.proc = proc;
    this.startedAt = new Date();
    this.setState('starting');
    this.readyTimer = setTimeout(() => {
      if (this.state !== 'starting' || this.proc !== proc) return;
      this.failure = 'The server did not finish starting in time';
      this.alert('start-timeout', this.failure);
      this.expectExit = true;
      proc.signal('SIGKILL');
    }, this.cfg.readyTimeoutMs);
    void proc.exited.then((exit) => this.onExit(proc, exit));
  }

  /** Force the keys only the agent may own; PZ completes a partial ini with defaults. */
  private enforceIni(serverName: string): void {
    const managed: Record<string, string> = {
      RCONPort: String(this.cfg.rconPort),
      RCONPassword: this.store.get().rconPassword,
      DefaultPort: String(this.cfg.gamePort),
      UDPPort: String(this.cfg.udpPort),
      UPnP: 'false',
    };
    const dir = path.join(this.cfg.dataDir, 'Server');
    const file = path.join(dir, `${serverName}.ini`);
    mkdirSync(dir, { recursive: true });
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const after = before === null ? buildIni(managed) : setIniValues(before, managed);
    if (after !== before) writeFileSync(file, after);
  }

  private onGameLine(raw: string, stream: 'out' | 'err'): void {
    const line = this.redact(raw);
    this.hub.emit({ type: 'log', stream, line });
    const { message } = parseLogLine(raw);
    const v = PZ_PATTERNS.version.exec(message);
    if (v) this.store.update({ gameVersion: v[1]! });
    if (this.state === 'starting') {
      // Measured on 42.20.4: "SERVER STARTED", then "RCON: listening" ~50 ms later.
      // Ready means RCON works too, with a grace period in case the line changes.
      if (PZ_PATTERNS.ready.test(message) && !this.serverStartedAt) {
        this.serverStartedAt = Date.now();
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.readyTimer = setTimeout(() => this.markReady(), 10_000);
      } else if (PZ_PATTERNS.rconListening.test(message) && this.serverStartedAt) {
        this.markReady();
      }
    }
    if (PZ_PATTERNS.adminPrompt.test(message) && this.proc) {
      // The server blocks on stdin waiting for a password we will never type.
      this.failure = 'The server asked for an admin password on the console';
      this.alert('admin-prompt', this.failure);
      this.expectExit = true;
      this.proc.signal('SIGKILL');
    }
    if (isFatal(raw)) this.alert('fatal', line.slice(0, 300));
  }

  private markReady(): void {
    if (this.state !== 'starting') return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.readyAt = new Date();
    this.setState('running');
    this.schedulePoll(1_000);
  }

  private onExit(proc: GameProcess, exit: { code: number | null; signal: NodeJS.Signals | null }): void {
    if (this.proc !== proc) return;
    this.proc = null;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.rcon.close();
    this.players = null;
    const expected = this.expectExit;
    this.lastExit = { code: exit.code, signal: exit.signal, at: new Date().toISOString(), expected };
    this.log(`Server process exited (code ${exit.code}, signal ${exit.signal ?? 'none'})${expected ? '' : ' unexpectedly'}`);

    if (this.failure) {
      this.store.update({ desired: 'stopped' });
      this.setState('failed');
      return;
    }
    if (expected || this.shuttingDown) {
      this.setState('stopped');
      return;
    }
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < this.cfg.crashLoop.windowMs), now];
    if (this.crashes.length >= this.cfg.crashLoop.count) {
      this.failure = `Crashed ${this.crashes.length} times in ${Math.round(this.cfg.crashLoop.windowMs / 60_000)} minutes; not restarting`;
      this.alert('crash-loop', this.failure);
      this.store.update({ desired: 'stopped' });
      this.setState('failed');
      return;
    }
    this.alert('crash', `The server stopped unexpectedly (code ${exit.code}); restarting in ${Math.round(this.cfg.restartDelayMs / 1000)} s`);
    this.setState('crashed');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.expireLock();
      if (this.lock) {
        this.log('Not restarting after the crash: maintenance lock is held.');
        return;
      }
      const l = this.store.get().launch;
      if (this.store.get().desired !== 'running' || !l) return;
      this.control.run(() => this.doStart(l)).catch((e: Error) => this.log(`Restart failed: ${e.message}`));
    }, this.cfg.restartDelayMs);
  }

  private fail(kind: AlertKind, message: string): void {
    this.failure = message;
    this.alert(kind, message);
    this.store.update({ desired: 'stopped' });
    this.setState('failed');
  }

  // -------------------------------------------------------------------- stop

  stop(opts: { timeoutMs?: number; reason?: string }, lockId: string | undefined): Promise<void> {
    this.checkLock(lockId);
    this.store.update({ desired: 'stopped' });
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
      if (!this.proc) this.setState('stopped');
    }
    return this.control.run(async () => {
      if (!this.proc) {
        if (this.state === 'crashed' || this.state === 'failed') {
          this.failure = null;
          this.setState('stopped');
        }
        return;
      }
      await this.gracefulStop(opts.timeoutMs ?? this.cfg.stopTimeoutMs, opts.reason ?? 'requested');
    });
  }

  async restart(lockId: string | undefined): Promise<void> {
    await this.stop({ reason: 'restart' }, lockId);
    await this.start(undefined, lockId);
  }

  kill(lockId: string | undefined): void {
    this.checkLock(lockId);
    this.store.update({ desired: 'stopped' });
    if (!this.proc) return;
    this.expectExit = true;
    this.log('Killing the server process (no save).');
    this.proc.signal('SIGKILL');
  }

  private async gracefulStop(timeoutMs: number, reason: string): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.expectExit = true;
    const wasStarting = this.state === 'starting';
    this.setState('stopping');
    this.log(`Stopping (${reason})…`);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    let sent = false;
    if (!wasStarting) {
      try {
        await this.rcon.command('save');
        await this.rcon.command('quit');
        sent = true;
      } catch (e) {
        this.log(`RCON quit failed (${(e as Error).message}); using the console.`);
      }
    }
    if (!sent) proc.writeLine('quit');
    const waitExit = (ms: number) => Promise.race([proc.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
    // While still loading, the console is not read yet: don't wait the full timeout.
    if (await waitExit(wasStarting ? Math.min(timeoutMs, 30_000) : timeoutMs)) return;
    this.log('The server did not exit in time; sending SIGTERM.');
    proc.signal('SIGTERM');
    if (await waitExit(this.cfg.termTimeoutMs)) return;
    this.log('Still running; sending SIGKILL.');
    proc.signal('SIGKILL');
    await waitExit(10_000);
  }

  // ---------------------------------------------------------------- commands

  async command(cmd: string, via: 'rcon' | 'stdin' | undefined): Promise<CommandResponse> {
    const c = cmd.trim();
    if (!c || c.length > 1000 || /[\r\n\0]/.test(c)) throw new AgentError('bad-request', 'Command must be a single line of up to 1000 characters');
    if (!this.proc) throw new AgentError('unavailable', 'The server is not running');
    if (via !== 'stdin' && this.state === 'running') {
      try {
        const output = await this.rcon.command(c);
        this.rconError = null;
        return { via: 'rcon', output };
      } catch (e) {
        this.rconError = (e as Error).message;
        if (via === 'rcon') throw new AgentError('unavailable', this.rconError);
      }
    }
    if (!this.proc.writeLine(c)) throw new AgentError('unavailable', 'Could not write to the server console');
    return { via: 'stdin', output: null };
  }

  private schedulePoll(delay = this.cfg.playersPollMs): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.pollPlayers(), delay);
    this.pollTimer.unref();
  }

  private async pollPlayers(): Promise<void> {
    if (this.state !== 'running') return;
    try {
      const out = await this.rcon.command('players');
      const p = parsePlayers(out);
      this.rconError = null;
      this.failedPolls = 0;
      if (this.unresponsiveAlerted) {
        this.unresponsiveAlerted = false;
        this.log('The server is responding again.');
      }
      if (p) {
        const changed = !this.players || this.players.count !== p.count || this.players.names.join('\n') !== p.names.join('\n');
        this.players = { count: p.count, names: p.names, at: new Date().toISOString() };
        if (changed) this.hub.emit({ type: 'players', count: p.count, names: p.names });
      }
    } catch (e) {
      this.rconError = (e as Error).message;
      this.failedPolls++;
      if (this.failedPolls >= this.cfg.unresponsiveAfter && !this.unresponsiveAlerted) {
        this.unresponsiveAlerted = true;
        this.alert('unresponsive', `The server has not answered RCON for ${this.failedPolls} polls: ${this.rconError}`);
      }
    }
    this.schedulePoll();
  }

  // ---------------------------------------------------------------- steamcmd

  private readInstalled(): void {
    const f = path.join(this.cfg.installDir, 'steamapps', `appmanifest_${this.cfg.appId}.acf`);
    try {
      const m = parseAppManifest(readFileSync(f, 'utf8'));
      this.installed = { buildId: m.buildId, branch: m.branch };
    } catch {
      this.installed = null;
    }
  }

  private beginJob(kind: JobKind, message: string): JobInfo {
    this.job = { id: randomUUID(), kind, startedAt: new Date().toISOString(), progress: null, message };
    this.hub.emit({ type: 'job', job: this.job });
    return this.job;
  }

  private endJob(job: JobInfo, result: JobResult): void {
    this.hub.emit({ type: 'job', job: { ...job, progress: result.ok ? 100 : job.progress }, result });
    if (this.job?.id === job.id) this.job = null;
    this.emitState();
  }

  private steamOpts(job: JobInfo) {
    let lastEmit = 0;
    return {
      steamcmd: this.cfg.steamcmd,
      home: process.env.HOME ?? '/home/node',
      onLine: (line: string) => this.hub.emit({ type: 'log', stream: 'agent', line: `[steamcmd] ${this.redact(line)}` }),
      onProgress: (percent: number, state: string) => {
        job.progress = Math.round(percent * 10) / 10;
        job.message = state;
        if (Date.now() - lastEmit > 1000) {
          lastEmit = Date.now();
          this.hub.emit({ type: 'job', job: { ...job } });
        }
      },
    };
  }

  private runInstall(branch: string, validate: boolean): Promise<JobResult> {
    return this.steam.run(async () => {
      const job = this.beginJob(validate ? 'validate' : 'install', `${validate ? 'Validating' : 'Installing/updating'} (${branch})`);
      const prev = this.state;
      this.setState('installing');
      try {
        const r = await installGame({
          ...this.steamOpts(job),
          installDir: this.cfg.installDir,
          appId: this.cfg.appId,
          branch,
          validate,
          onRetry: (n, e) => this.log(`steamcmd attempt ${n} failed (${e}); retrying`),
        });
        this.readInstalled();
        const result = r.ok ? { ok: true } : { ok: false, error: r.error };
        this.endJob(job, result);
        return result;
      } finally {
        if (this.state === 'installing') this.setState(prev === 'installing' ? 'stopped' : prev);
      }
    });
  }

  /** Install, update or validate while the server is stopped. */
  install(opts: { branch?: string; validate: boolean }, lockId: string | undefined): Promise<JobResult> {
    this.checkLock(lockId);
    return this.control.run(async () => {
      if (this.proc) throw new AgentError('conflict', 'Stop the server before updating it');
      const branch = opts.branch ?? this.store.get().launch?.branch ?? 'public';
      if (!BRANCH.test(branch)) throw new AgentError('bad-request', 'Invalid branch');
      return this.runInstall(branch, opts.validate);
    });
  }

  appInfo(): Promise<AppInfoResponse> {
    return this.steam.run(async () => {
      const job = this.beginJob('appinfo', 'Checking Steam for the latest builds');
      try {
        const branches = await fetchBranches({ ...this.steamOpts(job), appId: this.cfg.appId });
        this.endJob(job, { ok: true });
        this.readInstalled();
        return { installed: this.installed, branches };
      } catch (e) {
        this.endJob(job, { ok: false, error: (e as Error).message });
        throw new AgentError('unavailable', (e as Error).message);
      }
    });
  }

  downloadWorkshop(ids: string[]): Promise<JobResult> {
    if (ids.length === 0 || ids.length > 100) throw new AgentError('bad-request', 'Give 1-100 workshop ids');
    return this.steam.run(async () => {
      const job = this.beginJob('workshop', `Downloading ${ids.length} workshop item(s)`);
      try {
        const r = await downloadWorkshopItems({ ...this.steamOpts(job), cacheDir: path.join(this.cfg.dataDir, '.workshop'), ids });
        const result = r.ok ? { ok: true } : { ok: false, error: r.error };
        this.endJob(job, result);
        return result;
      } catch (e) {
        const result = { ok: false, error: (e as Error).message };
        this.endJob(job, result);
        return result;
      }
    });
  }
}
