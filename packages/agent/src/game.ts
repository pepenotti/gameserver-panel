import type { ChannelSpec, CommandVia, ControlHandle, LaunchCommand, LineSignal } from '@gsp/adapter-api';
import { spawnGame, type GameProcess } from './process';
import { RconClient } from './rcon-client';

/** A connection to the game's control channel (RCON, REST). */
export interface Channel {
  readonly connected: boolean;
  command(cmd: string): Promise<string>;
  close(): void;
}

/** The client for a channel spec; null for games controlled through stdin (or not at all). */
export function openChannel(spec: ChannelSpec): Channel | null {
  switch (spec.kind) {
    case 'rcon':
      // The game runs next to the agent: its channel is always local.
      return new RconClient('127.0.0.1', spec.port, () => spec.password);
    case 'rest':
      return {
        connected: false,
        command: () => Promise.reject(new Error('REST control channels are not supported yet')),
        close: () => undefined,
      };
    default:
      return null;
  }
}

export type GameExit = { code: number | null; signal: NodeJS.Signals | null };

/**
 * How long a quiet console line waits after one people sent (PLY-01): the
 * console gives no end to a reply, so one printed that long after its command
 * could otherwise be read as the quiet query's.
 */
export const QUIET_AFTER_LOUD_MS = 2_000;

export interface GameRunOptions {
  command: LaunchCommand;
  /** The agent's environment (without its token); the command's own `env` goes on top. */
  env: NodeJS.ProcessEnv;
  /** The adapter's `classify`; a throw counts as a plain line. */
  classify(line: string): LineSignal;
  channel: ChannelSpec;
  /** Every output line, raw, with what it means, as soon as it is read (readiness, fatal lines…). */
  onLine(raw: string, stream: 'out' | 'err', signal: LineSignal): void;
  /**
   * The lines people see, in order: every line but a quiet query's reply
   * (`handle(…, { quiet: true })`, PLY-01). Lines read while a quiet query
   * waits for its reply come once it has it (or gave up).
   */
  onShow?(raw: string, stream: 'out' | 'err', signal: LineSignal): void;
  /** Outcome of each channel command (null: it worked), for the status. */
  onChannel?(error: Error | null): void;
  /** `QUIET_AFTER_LOUD_MS` unless a test says otherwise. */
  quietAfterLoudMs?: number;
}

/** What a quiet handle waits for: its reply, when the window it waits in is open. */
interface Pending {
  /** The quiet handle's own pending set, when it came from one. */
  mine?: Set<Pending>;
  window?: QuietWindow;
}

interface Waiter extends Pending {
  re: RegExp;
  resolve(m: RegExpExecArray | null): void;
  timer: NodeJS.Timeout;
}

/** A `waitForLines` in progress: the lines so far, until `done` says the reply is complete. */
interface Collector extends Pending {
  lines: string[];
  done(lines: readonly string[]): boolean;
  resolve(lines: string[] | null): void;
  timer: NodeJS.Timeout;
}

/** A line read while a quiet query waits for its reply. */
interface Held {
  raw: string;
  stream: 'out' | 'err';
  signal: LineSignal;
  /** It went to a waiter or collector of the query (after its line was written). */
  reply: boolean;
}

/**
 * A console query the agent makes for itself (a player poll, PLY-01), from
 * the moment its line is written until every waiter and collector of its
 * handle that was pending then has settled.
 */
interface QuietWindow {
  readonly owners: Set<Pending>;
  readonly held: Held[];
  /** Every owner got its reply (none timed out or saw the game exit). */
  complete: boolean;
}

/** Whether a line says something beyond its text (it joins, it is fatal, it is progress…): shown even inside a quiet query's reply. */
function meaningful(s: LineSignal): boolean {
  return Object.entries(s).some(([k, v]) => k !== 'message' && v !== undefined && v !== false);
}

/**
 * One run of the game: the process, its classified output, its control
 * channel, and the `ControlHandle` adapters drive it with. Readiness is the
 * agent's call (`ready`); this only carries it.
 *
 * Quiet queries (PLY-01): a line a quiet handle writes to the console opens a
 * window until the reply its waiters and collectors expect is complete; the
 * lines that went to them in that window stay out of `onShow` (unless they
 * mean something, or the reply never completed). Stdin replies carry no tag,
 * so the console is shared out in turns: people's lines (any other handle,
 * `command`) wait while a window is open, and a quiet line waits until
 * `quietAfterLoudMs` after the last line people sent.
 */
export class GameRun {
  readonly proc: GameProcess;
  readonly channel: Channel | null;
  readonly exited: Promise<GameExit>;
  /** Set by the agent once the game is up; channel commands wait for it. */
  ready = false;
  private closed = false;
  private readonly waiters = new Set<Waiter>();
  private readonly collectors = new Set<Collector>();
  private window: QuietWindow | null = null;
  /** Lines people sent while a quiet query waited for its reply: written once it has it. */
  private readonly loudQueue: string[] = [];
  /** Quiet lines waiting for their turn, each with the owners of its reply. */
  private readonly quietQueue: { line: string; owners: Set<Pending> }[] = [];
  private quietTimer: NodeJS.Timeout | null = null;
  private loudAt = Number.NEGATIVE_INFINITY;
  private readonly quietAfterLoudMs: number;

  /** Spawns the game; throws when it can't be started. */
  constructor(private readonly o: GameRunOptions) {
    this.quietAfterLoudMs = o.quietAfterLoudMs ?? QUIET_AFTER_LOUD_MS;
    this.proc = spawnGame(o.command.argv, {
      cwd: o.command.cwd,
      env: { ...o.env, ...o.command.env },
      onStdout: (line) => this.onLine(line, 'out'),
      onStderr: (line) => this.onLine(line, 'err'),
    });
    this.channel = openChannel(o.channel);
    this.exited = this.proc.exited.then((exit) => {
      this.close();
      return exit;
    });
  }

  get pid(): number {
    return this.proc.pid;
  }

  get kind(): ChannelSpec['kind'] {
    return this.o.channel.kind;
  }

  private onLine(raw: string, stream: 'out' | 'err'): void {
    let signal: LineSignal;
    try {
      signal = this.o.classify(raw);
    } catch {
      signal = { message: raw };
    }
    const w = this.window;
    const held: Held | null = w ? { raw, stream, signal, reply: false } : null;
    if (held) w!.held.push(held);
    else this.o.onShow?.(raw, stream, signal);
    this.o.onLine(raw, stream, signal);
    for (const x of this.waiters) {
      x.re.lastIndex = 0;
      const m = x.re.exec(signal.message);
      if (!m) continue;
      if (held && x.window === w) held.reply = true;
      this.settle(x, true);
      x.resolve(m);
    }
    for (const c of this.collectors) {
      c.lines.push(signal.message);
      if (held && c.window === w) held.reply = true;
      let done: boolean;
      try {
        done = c.done(c.lines);
      } catch {
        done = false;
      }
      if (!done) continue;
      this.settle(c, true);
      c.resolve(c.lines);
    }
  }

  /** A waiter or collector is done (`ok`: it got what it waited for); its quiet window closes once it was the last. */
  private settle(x: Waiter | Collector, ok: boolean): void {
    this.waiters.delete(x as Waiter);
    this.collectors.delete(x as Collector);
    clearTimeout(x.timer);
    x.mine?.delete(x);
    const w = x.window;
    if (!w) return;
    x.window = undefined;
    w.owners.delete(x);
    if (!ok) w.complete = false;
    if (w.owners.size === 0) this.closeWindow(w);
  }

  /** The quiet query is over: what it held is shown (but its complete reply), then what people sent meanwhile is written. */
  private closeWindow(w: QuietWindow): void {
    if (this.window !== w) return;
    this.window = null;
    for (const x of w.owners) x.window = undefined;
    for (const h of w.held) if (!(w.complete && h.reply && !meaningful(h.signal))) this.o.onShow?.(h.raw, h.stream, h.signal);
    if (this.closed) return;
    const queued = this.loudQueue.splice(0);
    for (const line of queued) this.proc.writeLine(line);
    if (queued.length) this.loudAt = Date.now();
    this.pumpQuiet();
  }

  /** A console line people send (or the agent does for them): after the quiet query in progress, if any. */
  private loudLine(line: string, mark = true): boolean {
    if (this.closed) return false;
    if (this.window) {
      this.loudQueue.push(line);
      return true;
    }
    const ok = this.proc.writeLine(line);
    if (ok && mark) this.loudAt = Date.now();
    return ok;
  }

  /** A quiet handle's console line: a query whose reply its pending waiters and collectors (`mine`) expect. */
  private quietLine(line: string, mine: Set<Pending>): boolean {
    if (this.closed) return false;
    // Nothing waits for a reply: nothing to keep out of the log.
    if (mine.size === 0) return this.loudLine(line, false);
    this.quietQueue.push({ line, owners: new Set(mine) });
    this.pumpQuiet();
    return true;
  }

  /** Writes the next quiet line when the console is free: no quiet query open, nothing people sent recently. */
  private pumpQuiet(): void {
    while (!this.closed && !this.window && this.quietQueue.length) {
      const wait = this.loudAt + this.quietAfterLoudMs - Date.now();
      if (wait > 0) {
        if (!this.quietTimer) {
          this.quietTimer = setTimeout(() => {
            this.quietTimer = null;
            this.pumpQuiet();
          }, wait);
          this.quietTimer.unref();
        }
        return;
      }
      const next = this.quietQueue.shift()!;
      // Those that gave up meanwhile wait for nothing now.
      const owners = new Set([...next.owners].filter((x) => this.waiters.has(x as Waiter) || this.collectors.has(x as Collector)));
      if (owners.size === 0) continue;
      const w: QuietWindow = { owners, held: [], complete: true };
      for (const x of owners) x.window = w;
      this.window = w;
      if (!this.proc.writeLine(next.line)) {
        w.complete = false;
        this.closeWindow(w);
      }
    }
  }

  /**
   * Ends the quiet query in progress (the game is being stopped): what it
   * held is shown, and people's lines go out now. Quiet lines not written
   * yet never are.
   */
  endQuiet(): void {
    this.quietQueue.length = 0;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    const w = this.window;
    if (!w) return;
    w.complete = false;
    this.closeWindow(w);
  }

  /** A console command: see `ControlHandle.command`. `quiet`: a quiet handle's pending waiters and collectors. */
  async command(cmd: string, via: CommandVia | undefined, onChannelError?: (e: Error) => void, quiet?: Set<Pending>): Promise<string | null> {
    if (/[\r\n\0]/.test(cmd)) throw new Error('Command must be a single line');
    if (via !== 'stdin') {
      if (this.channel && this.ready && !this.closed) {
        try {
          const output = await this.channel.command(cmd);
          this.o.onChannel?.(null);
          return output;
        } catch (e) {
          this.o.onChannel?.(e as Error);
          onChannelError?.(e as Error);
          if (via === 'channel') throw e;
        }
      } else if (via === 'channel') {
        throw new Error(this.channel ? 'The server is not ready for commands yet' : 'This game has no control channel');
      }
    }
    if (!(quiet ? this.quietLine(cmd, quiet) : this.loudLine(cmd))) throw new Error('Could not write to the server console');
    return null;
  }

  waitForLine(re: RegExp, timeoutMs: number, mine?: Set<Pending>): Promise<RegExpExecArray | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const x: Waiter = {
        re,
        resolve,
        mine,
        timer: setTimeout(() => {
          this.settle(x, false);
          resolve(null);
        }, timeoutMs),
      };
      x.timer.unref();
      this.waiters.add(x);
      mine?.add(x);
    });
  }

  /** See `ControlHandle.waitForLines`: a reply spread over several lines. */
  waitForLines(until: RegExp | ((lines: readonly string[]) => boolean), timeoutMs: number, mine?: Set<Pending>): Promise<string[] | null> {
    if (this.closed) return Promise.resolve(null);
    const done =
      typeof until === 'function'
        ? until
        : (lines: readonly string[]) => {
            until.lastIndex = 0;
            return until.test(lines[lines.length - 1] ?? '');
          };
    return new Promise((resolve) => {
      const c: Collector = {
        lines: [],
        done,
        resolve,
        mine,
        timer: setTimeout(() => {
          this.settle(c, false);
          resolve(null);
        }, timeoutMs),
      };
      c.timer.unref();
      this.collectors.add(c);
      mine?.add(c);
    });
  }

  /**
   * What adapters get. `onChannelError` hears channel failures of commands
   * sent through this handle. `quiet`: the agent's own queries (PLY-01):
   * what it writes to the console, and the replies it waits for, stay out
   * of the lines people see.
   */
  handle(onChannelError?: (e: Error) => void, o: { quiet?: boolean } = {}): ControlHandle {
    const isReady = () => this.ready && !this.closed;
    const mine = o.quiet ? new Set<Pending>() : undefined;
    return {
      get ready() {
        return isReady();
      },
      command: (cmd, via) => this.command(cmd, via, onChannelError, mine),
      stdin: (line) => (mine ? this.quietLine(line, mine) : this.loudLine(line)),
      signal: (sig) => this.proc.signal(sig),
      waitForLine: (re, timeoutMs) => this.waitForLine(re, timeoutMs, mine),
      waitForLines: (until, timeoutMs) => this.waitForLines(until, timeoutMs, mine),
    };
  }

  /** The process is gone: drop the channel and wake every waiter. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel?.close();
    this.quietQueue.length = 0;
    this.loudQueue.length = 0;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    for (const x of [...this.waiters]) {
      this.settle(x, false);
      x.resolve(null);
    }
    for (const c of [...this.collectors]) {
      this.settle(c, false);
      c.resolve(null);
    }
  }
}
