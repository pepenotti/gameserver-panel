import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  ChannelSpec,
  CommandVia,
  FileRoots,
  InstallCtx,
  InstalledInfo,
  JobResult,
  LaunchCommand,
  LineSignal,
  RuntimeAdapter,
  RuntimeCtx,
  RuntimeState,
  VersionsResponse,
} from '@gsp/adapter-api';
import { makeRedactor } from '@gsp/formats';
import type { AgentStatus, AlertKind, CommandResponse, ControlKind, JobInfo, JobKind, PublicLaunch, ServerState } from '@gsp/shared';
import type { AgentConfig } from './config';
import type { EventHub } from './events';
import { GameRun } from './game';
import type { StateStore } from './state-store';
import { diskStats, ProcessSampler } from './stats';
import { SteamcmdDriver } from './steamcmd';

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

/** How log lines and alerts name a control channel. */
const CHANNEL_LABEL: Record<ControlKind, string> = { rcon: 'RCON', rest: 'The REST API', stdin: 'The console', none: 'The control channel' };

/** Roots before any launch is stored and without `GAME_*_DIR` (the image sets both). */
const FALLBACK_ROOTS: FileRoots = { data: '/data', install: '/opt/game' };

/** The environment adapters and the game see: the agent's, minus its token (mods run inside the game). */
function agentEnv(): Record<string, string | undefined> {
  const { AGENT_TOKEN: _token, ...env } = process.env;
  return env;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isJobResult(x: unknown): x is JobResult {
  return isObject(x) && typeof x.ok === 'boolean';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/**
 * Supervises one game server through its runtime adapter (PRD §10): install
 * before start, launch, readiness, control channel, player polls, clean
 * stop, the crash watchdog, jobs and the adapter's actions. Everything
 * specific to a game comes from the adapter.
 */
export class Agent {
  private state: ServerState = 'stopped';
  private run: GameRun | null = null;
  private startedAt: Date | null = null;
  private readyAt: Date | null = null;
  private lastExit: AgentStatus['lastExit'] = null;
  private failure: string | null = null;
  private installedInfo: InstalledInfo | null = null;
  private players: AgentStatus['players'] = null;
  private controlError: string | null = null;
  private channelKind: ControlKind = 'none';
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
  private readonly jobs = new Mutex();
  private readonly sampler = new ProcessSampler();
  private readonly portMap: Record<string, number>;
  /** The stored launch, as the adapter parsed it; null until the panel sets one. */
  private params: unknown = null;
  private redact: (line: string) => string;
  private shuttingDown = false;
  private readonly bootId = randomUUID();

  constructor(
    private readonly cfg: AgentConfig,
    private readonly adapter: RuntimeAdapter,
    private readonly store: StateStore,
    private readonly hub: EventHub,
  ) {
    this.portMap = Object.fromEntries(adapter.meta.ports.map((p) => [p.id, cfg.ports[p.id] ?? p.default]));
    this.redact = makeRedactor([cfg.token, store.controlSecret]);
    this.params = this.loadLaunch();
    if (this.params !== null) this.channelKind = this.channelOf(this.params);
    this.redact = this.makeRedactor();
  }

  private loadLaunch(): unknown {
    const l = this.store.get().launch;
    if (!l) return null;
    if (l.adapter !== this.adapter.meta.id) {
      this.log(`Ignoring the stored launch for "${l.adapter}": this agent runs "${this.adapter.meta.id}".`);
      return null;
    }
    try {
      return this.adapter.parseLaunch(l.params);
    } catch (e) {
      this.log(`The stored launch parameters are no longer valid (${(e as Error).message}); waiting for new ones.`);
      return null;
    }
  }

  private runtimeState(): RuntimeState {
    return { controlSecret: this.store.controlSecret, gameVersion: this.store.get().gameVersion };
  }

  private makeRedactor() {
    const secrets = [this.cfg.token, this.store.controlSecret];
    if (this.params !== null) secrets.push(...this.adapter.secrets(this.params, this.runtimeState()));
    return makeRedactor(secrets);
  }

  // ------------------------------------------------------------- adapter ctx

  /** The adapter's roots for the stored launch, relocated by `GAME_*_DIR`. */
  private roots(): FileRoots {
    const base = this.params !== null ? this.adapter.roots(this.params) : FALLBACK_ROOTS;
    return { ...base, data: this.cfg.dataDir ?? base.data, install: this.cfg.installDir ?? base.install };
  }

  private runtimeCtx(): RuntimeCtx {
    return {
      roots: this.roots(),
      stateDir: this.cfg.stateDir,
      ports: { ...this.portMap },
      state: this.runtimeState(),
      tools: { steamcmd: this.cfg.steamcmd, launcher: this.cfg.launcher ?? undefined, home: this.cfg.home },
      env: agentEnv(),
      log: (line) => this.log(line),
    };
  }

  /** A job's context: tool lines to the log, progress to the job, and the steamcmd driver for Steam games. */
  private installCtx(job: JobInfo | null): InstallCtx {
    const ctx = this.runtimeCtx();
    const onLine = (line: string) => this.hub.emit({ type: 'log', stream: 'agent', line: this.redact(line) });
    let lastEmit = 0;
    const progress = (percent: number | null, message: string) => {
      if (!job) return;
      job.progress = percent === null ? null : Math.round(percent * 10) / 10;
      job.message = message;
      if (Date.now() - lastEmit > 1000) {
        lastEmit = Date.now();
        this.hub.emit({ type: 'job', job: { ...job } });
      }
    };
    const steam =
      this.adapter.meta.runtime === 'steam'
        ? new SteamcmdDriver({
            steamcmd: this.cfg.steamcmd,
            home: this.cfg.home,
            installDir: ctx.roots.install,
            workshopDir: path.join(ctx.roots.data, '.workshop'),
            onLine: (line) => onLine(`[steamcmd] ${line}`),
            onProgress: (percent, state) => progress(percent, state),
            log: ctx.log,
          })
        : undefined;
    return { ...ctx, onLine, progress, steam };
  }

  private channelOf(p: unknown): ControlKind {
    try {
      return this.adapter.channel(this.runtimeCtx(), p).kind;
    } catch {
      return 'none';
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    this.readInstalled();
    this.statusTimer = setInterval(() => this.emitState(), 15_000);
    this.statusTimer.unref();
    const s = this.store.get();
    if (s.desired === 'running' && this.params !== null) {
      this.log(`Resuming: the server was running before the agent restarted.`);
      this.start(undefined, undefined).catch((e: Error) => this.log(`Autostart failed: ${e.message}`));
    }
  }

  /** Container is going down: stop the game cleanly but remember it should run. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.run) await this.control.run(() => this.gracefulStop(this.stopBudgetMs(), 'container shutdown'));
    this.run?.close();
  }

  private stopBudgetMs(): number {
    return this.cfg.stopTimeoutMs ?? this.adapter.meta.stopBudgetMs;
  }

  // ------------------------------------------------------------------ status

  status(): AgentStatus {
    const s = this.store.get();
    this.expireLock();
    const info = this.installedInfo;
    const connected = this.run?.channel?.connected ?? false;
    const roots = this.roots();
    return {
      agentVersion: this.cfg.version,
      bootId: this.bootId,
      state: this.state,
      desired: s.desired,
      pid: this.run?.pid ?? null,
      startedAt: this.startedAt?.toISOString() ?? null,
      readyAt: this.readyAt?.toISOString() ?? null,
      lastExit: this.lastExit,
      failure: this.failure,
      installedInfo: info,
      players: this.players,
      control: { kind: this.channelKind, connected, lastError: this.controlError },
      lock: this.lock ? { holder: this.lock.holder, expiresAt: new Date(this.lock.expiresAt).toISOString() } : null,
      job: this.job,
      recentCrashes: this.crashes.map((t) => new Date(t).toISOString()),
      launch: this.publicLaunch(),
      process: this.sampler.sample(this.run?.pid ?? null),
      disks: diskStats([roots.data, roots.install]),
      now: new Date().toISOString(),
    };
  }

  /** The stored launch without its secrets: top-level fields holding one of the adapter's secrets are left out. */
  private publicLaunch(): PublicLaunch | null {
    const p = this.params;
    if (!isObject(p)) return null;
    const secrets = new Set(this.adapter.secrets(p, this.runtimeState()));
    return Object.fromEntries(Object.entries(p).filter(([, v]) => !(typeof v === 'string' && secrets.has(v))));
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

  // ------------------------------------------------------------------ launch

  /**
   * Launch params from the wire: a `LaunchEnvelope` for this agent's adapter,
   * or (deprecated, during M1) that adapter's bare params.
   */
  private parseLaunchInput(input: unknown): unknown {
    let params = input;
    if (isObject(input) && typeof input.adapter === 'string' && 'params' in input) {
      if (input.adapter !== this.adapter.meta.id) throw new AgentError('bad-request', `This agent runs "${this.adapter.meta.id}", not "${input.adapter}"`);
      params = input.params;
    }
    try {
      return this.adapter.parseLaunch(params);
    } catch (e) {
      throw new AgentError('bad-request', (e as Error).message);
    }
  }

  private applyLaunch(p: unknown): void {
    this.params = p;
    this.store.update({ launch: { adapter: this.adapter.meta.id, params: p } });
    this.channelKind = this.channelOf(p);
    this.redact = this.makeRedactor();
    this.readInstalled(); // the roots may have moved
    this.emitState();
  }

  setLaunch(input: unknown): void {
    this.applyLaunch(this.parseLaunchInput(input));
  }

  /** The stored launch, or 409 `no-launch`. */
  private storedParams(): unknown {
    if (this.params === null) throw new AgentError('conflict', 'no-launch');
    return this.params;
  }

  // ------------------------------------------------------------------- start

  start(launch: unknown, lockId: string | undefined): Promise<void> {
    const p = launch === undefined ? undefined : this.parseLaunchInput(launch);
    this.checkLock(lockId);
    if (p !== undefined) this.applyLaunch(p);
    return this.control.run(async () => {
      if (this.run || this.state === 'installing') return; // already up or coming up
      if (this.params === null) throw new AgentError('bad-request', 'No launch parameters yet');
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      this.store.update({ desired: 'running' });
      this.failure = null;
      await this.doStart();
    });
  }

  /** Install if the adapter asks for it, prepare the files, spawn. Runs under the control lock. */
  private async doStart(): Promise<void> {
    const p = this.params;
    if (p === null) return this.fail('start-failed', 'No launch parameters');
    let need: 'required' | 'update' | null = null;
    if (this.adapter.install && this.adapter.installOnStart) {
      try {
        need = this.adapter.installOnStart(this.runtimeCtx(), p);
      } catch (e) {
        return this.fail('start-failed', `Could not check the install: ${(e as Error).message}`);
      }
    }
    if (need) {
      const res = await this.runInstall(p, false);
      if (!res.ok) {
        // An update failure with a working install is not fatal: start the installed build.
        if (need === 'required') return this.fail('start-failed', `Game install failed: ${res.error ?? 'unknown error'}`);
        this.log(`Update failed (${res.error}); starting the installed build.`);
      }
    }

    const ctx = this.runtimeCtx();
    let command: LaunchCommand;
    let channel: ChannelSpec;
    try {
      await this.adapter.prepare(ctx, p);
      command = this.adapter.command(ctx, p);
      channel = this.adapter.channel(ctx, p);
    } catch (e) {
      return this.fail('start-failed', `Could not prepare the start: ${(e as Error).message}`);
    }
    this.channelKind = channel.kind;
    this.log(`Starting: ${this.redact(command.argv.join(' '))}`);
    this.expectExit = false;
    this.players = null;
    this.readyAt = null;
    this.serverStartedAt = null;
    this.failedPolls = 0;
    this.unresponsiveAlerted = false;
    this.sampler.reset();
    let run: GameRun;
    try {
      run = new GameRun({
        command,
        env: agentEnv(),
        classify: (line) => this.adapter.classify(line),
        channel,
        onLine: (raw, stream, signal) => this.onGameLine(run, raw, stream, signal),
        onChannel: (e) => {
          this.controlError = e ? e.message : null;
        },
      });
    } catch (e) {
      return this.fail('start-failed', (e as Error).message);
    }
    this.run = run;
    this.startedAt = new Date();
    this.setState('starting');
    this.readyTimer = setTimeout(() => {
      if (this.state !== 'starting' || this.run !== run) return;
      this.failure = 'The server did not finish starting in time';
      this.alert('start-timeout', this.failure);
      this.expectExit = true;
      run.proc.signal('SIGKILL');
    }, this.cfg.readyTimeoutMs);
    void run.exited.then((exit) => this.onExit(run, exit));
  }

  private onGameLine(run: GameRun, raw: string, stream: 'out' | 'err', sig: LineSignal): void {
    const line = this.redact(raw);
    this.hub.emit({ type: 'log', stream, line });
    if (sig.version && sig.version !== this.store.get().gameVersion) {
      this.store.update({ gameVersion: sig.version });
      this.readInstalled();
    }
    if (this.state === 'starting' && this.run === run) {
      // Ready means the control channel works too, with a grace period in
      // case its line changes (PZ: "SERVER STARTED", "RCON: listening" ~50 ms later).
      if (sig.ready && this.serverStartedAt === null) {
        this.serverStartedAt = Date.now();
        if (this.readyTimer) clearTimeout(this.readyTimer);
        if (run.channel === null || sig.channelReady) this.markReady(run);
        else this.readyTimer = setTimeout(() => this.markReady(run), this.cfg.channelGraceMs);
      } else if (sig.channelReady && this.serverStartedAt !== null) {
        this.markReady(run);
      }
    }
    if (sig.blockingPrompt && this.run === run) {
      // The game waits for console input nobody will type.
      this.failure = sig.blockingPrompt;
      this.alert('blocking-prompt', this.failure);
      this.expectExit = true;
      run.proc.signal('SIGKILL');
    }
    if (sig.fatal) this.alert('fatal', line.slice(0, 300));
  }

  private markReady(run: GameRun): void {
    if (this.state !== 'starting' || this.run !== run) return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    run.ready = true;
    this.readyAt = new Date();
    this.setState('running');
    this.schedulePoll(1_000);
  }

  private onExit(run: GameRun, exit: { code: number | null; signal: NodeJS.Signals | null }): void {
    if (this.run !== run) return;
    this.run = null;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
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
      if (this.store.get().desired !== 'running' || this.params === null) return;
      this.control.run(() => this.doStart()).catch((e: Error) => this.log(`Restart failed: ${e.message}`));
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
      if (!this.run) this.setState('stopped');
    }
    return this.control.run(async () => {
      if (!this.run) {
        if (this.state === 'crashed' || this.state === 'failed') {
          this.failure = null;
          this.setState('stopped');
        }
        return;
      }
      await this.gracefulStop(opts.timeoutMs ?? this.stopBudgetMs(), opts.reason ?? 'requested');
    });
  }

  async restart(lockId: string | undefined): Promise<void> {
    await this.stop({ reason: 'restart' }, lockId);
    await this.start(undefined, lockId);
  }

  kill(lockId: string | undefined): void {
    this.checkLock(lockId);
    this.store.update({ desired: 'stopped' });
    if (!this.run) return;
    this.expectExit = true;
    this.log('Killing the server process (no save).');
    this.run.proc.signal('SIGKILL');
  }

  /** The adapter asks the game to stop; after the budget, SIGTERM, then SIGKILL. */
  private async gracefulStop(timeoutMs: number, reason: string): Promise<void> {
    const run = this.run;
    if (!run) return;
    this.expectExit = true;
    const wasStarting = this.state === 'starting';
    this.setState('stopping');
    this.log(`Stopping (${reason})…`);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    // While still loading, the console is not read yet: don't wait the full budget.
    const budgetMs = wasStarting ? Math.min(timeoutMs, 30_000) : timeoutMs;
    const ctl = run.handle((e) => this.log(`${CHANNEL_LABEL[run.kind]} command failed (${e.message}).`));
    void Promise.resolve()
      .then(() => this.adapter.stop(ctl, { budgetMs }))
      .catch((e: Error) => this.log(`Clean stop failed: ${e.message}`));
    const waitExit = (ms: number) => Promise.race([run.exited.then(() => true), sleep(ms).then(() => false)]);
    if (await waitExit(budgetMs)) return;
    this.log('The server did not exit in time; sending SIGTERM.');
    run.proc.signal('SIGTERM');
    if (await waitExit(this.cfg.termTimeoutMs)) return;
    this.log('Still running; sending SIGKILL.');
    run.proc.signal('SIGKILL');
    await waitExit(10_000);
  }

  // ---------------------------------------------------------------- commands

  /** `POST /v1/command`. `rcon` on the wire is the adapter's control channel. */
  async command(cmd: string, via: 'rcon' | 'stdin' | undefined): Promise<CommandResponse> {
    const c = cmd.trim();
    if (!c || c.length > 1000 || /[\r\n\0]/.test(c)) throw new AgentError('bad-request', 'Command must be a single line of up to 1000 characters');
    const run = this.run;
    if (!run) throw new AgentError('unavailable', 'The server is not running');
    // Only a running server gets channel commands; otherwise everything goes to the console.
    const running = this.state === 'running';
    const v: CommandVia | undefined = via === 'stdin' || !running ? 'stdin' : via === 'rcon' ? 'channel' : undefined;
    try {
      const output = await run.command(c, v);
      return { via: output === null ? 'stdin' : 'rcon', output };
    } catch (e) {
      throw new AgentError('unavailable', (e as Error).message);
    }
  }

  private schedulePoll(delay = this.cfg.playersPollMs): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.pollPlayers(), delay);
    this.pollTimer.unref();
  }

  private async pollPlayers(): Promise<void> {
    const run = this.run;
    if (this.state !== 'running' || !run || !this.adapter.listPlayers) return;
    try {
      const p = await this.adapter.listPlayers(run.handle());
      this.controlError = null;
      this.failedPolls = 0;
      if (this.unresponsiveAlerted) {
        this.unresponsiveAlerted = false;
        this.log('The server is responding again.');
      }
      if (p && this.run === run) {
        const changed = !this.players || this.players.count !== p.count || this.players.names.join('\n') !== p.names.join('\n');
        this.players = { count: p.count, names: p.names, at: new Date().toISOString() };
        if (changed) this.hub.emit({ type: 'players', count: p.count, names: p.names });
      }
    } catch (e) {
      this.controlError = (e as Error).message;
      this.failedPolls++;
      if (this.failedPolls >= this.cfg.unresponsiveAfter && !this.unresponsiveAlerted) {
        this.unresponsiveAlerted = true;
        this.alert('unresponsive', `The server has not answered ${CHANNEL_LABEL[run.kind]} for ${this.failedPolls} polls: ${this.controlError}`);
      }
    }
    this.schedulePoll();
  }

  /** `POST /v1/save`: the adapter saves the running world; `ok: false` when it didn't finish within `timeoutMs`. */
  async save(timeoutMs = 20_000): Promise<JobResult> {
    const save = this.adapter.save;
    if (!save) throw new AgentError('not-found', 'This game has no save command');
    const run = this.run;
    if (!run || this.state !== 'running') throw new AgentError('unavailable', 'The server is not running');
    const ctl = run.handle((e) => this.log(`${CHANNEL_LABEL[run.kind]} command failed (${e.message}).`));
    // The adapter gets the same budget, so it stops waiting when the agent does.
    const saving = Promise.resolve()
      .then(() => save.call(this.adapter, ctl, { budgetMs: timeoutMs }))
      .then(
        () => null,
        (e: Error) => e,
      );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), timeoutMs);
    });
    try {
      const r = await Promise.race([saving, timeout]);
      if (r === 'timeout') return { ok: false, error: 'The game did not finish saving in time' };
      return r === null ? { ok: true } : { ok: false, error: r.message };
    } finally {
      clearTimeout(timer);
    }
  }

  // --------------------------------------------------------- install, jobs

  private readInstalled(): void {
    try {
      this.installedInfo = this.adapter.installed(this.runtimeCtx());
    } catch {
      this.installedInfo = null;
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

  private runInstall(p: unknown, validate: boolean): Promise<JobResult> {
    return this.jobs.run(async () => {
      const job = this.beginJob(validate ? 'validate' : 'install', validate ? 'Validating the game files' : 'Installing/updating the game');
      const prev = this.state;
      this.setState('installing');
      try {
        let result: JobResult;
        try {
          result = this.adapter.install ? await this.adapter.install(this.installCtx(job), p, { validate }) : { ok: false, error: 'This game has no installer' };
        } catch (e) {
          result = { ok: false, error: (e as Error).message };
        }
        this.readInstalled();
        this.endJob(job, result);
        return result;
      } finally {
        if (this.state === 'installing') this.setState(prev === 'installing' ? 'stopped' : prev);
      }
    });
  }

  /** `POST /v1/install`: install, update or validate while the server is stopped; `launch` picks other params than the stored ones. */
  install(opts: { validate: boolean; launch?: unknown }, lockId: string | undefined): Promise<JobResult> {
    const p = opts.launch === undefined ? undefined : this.parseLaunchInput(opts.launch);
    this.checkLock(lockId);
    if (!this.adapter.install) throw new AgentError('not-found', 'This game has no installer');
    return this.control.run(async () => {
      if (this.run) throw new AgentError('conflict', 'Stop the server before updating it');
      return this.runInstall(p ?? this.storedParams(), opts.validate);
    });
  }

  /** `POST /v1/versions`: what the server could be pinned to. */
  versions(opts: { launch?: unknown } = {}): Promise<VersionsResponse> {
    const p = opts.launch === undefined ? this.storedParams() : this.parseLaunchInput(opts.launch);
    const versions = this.adapter.versions;
    if (!versions) throw new AgentError('not-found', 'This game has no versions to pick from');
    return this.jobs.run(async () => {
      const job = this.beginJob('appinfo', 'Checking for available versions');
      try {
        const r = await versions.call(this.adapter, this.installCtx(job), p);
        this.endJob(job, { ok: true });
        this.readInstalled();
        return r;
      } catch (e) {
        this.endJob(job, { ok: false, error: (e as Error).message });
        throw new AgentError('unavailable', (e as Error).message);
      }
    });
  }

  /** `POST /v1/actions/:name`. Actions with a job kind run as jobs, one at a time. */
  async action(name: string, input: unknown): Promise<unknown> {
    const actions = this.adapter.actions ?? {};
    const action = Object.hasOwn(actions, name) ? actions[name] : undefined;
    if (!action) throw new AgentError('not-found', `No action "${name}"`);
    let parsed: unknown;
    try {
      parsed = action.parse(input);
    } catch (e) {
      throw new AgentError('bad-request', (e as Error).message);
    }
    const ctl = () => (this.run && this.state === 'running' ? this.run.handle() : null);
    const kind = action.job;
    if (!kind) {
      try {
        return await action.run(this.installCtx(null), ctl(), parsed);
      } catch (e) {
        throw new AgentError('unavailable', (e as Error).message);
      }
    }
    return this.jobs.run(async () => {
      const job = this.beginJob(kind, `Running ${name}`);
      try {
        const r = await action.run(this.installCtx(job), ctl(), parsed);
        this.endJob(job, isJobResult(r) ? { ok: r.ok, ...(r.error ? { error: r.error } : {}) } : { ok: true });
        return r;
      } catch (e) {
        this.endJob(job, { ok: false, error: (e as Error).message });
        throw new AgentError('unavailable', (e as Error).message);
      }
    });
  }
}
