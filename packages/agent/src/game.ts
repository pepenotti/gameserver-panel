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

export interface GameRunOptions {
  command: LaunchCommand;
  /** The agent's environment (without its token); the command's own `env` goes on top. */
  env: NodeJS.ProcessEnv;
  /** The adapter's `classify`; a throw counts as a plain line. */
  classify(line: string): LineSignal;
  channel: ChannelSpec;
  /** Every output line, raw, with what it means. */
  onLine(raw: string, stream: 'out' | 'err', signal: LineSignal): void;
  /** Outcome of each channel command (null: it worked), for the status. */
  onChannel?(error: Error | null): void;
}

interface Waiter {
  re: RegExp;
  resolve(m: RegExpExecArray | null): void;
  timer: NodeJS.Timeout;
}

/**
 * One run of the game: the process, its classified output, its control
 * channel, and the `ControlHandle` adapters drive it with. Readiness is the
 * agent's call (`ready`); this only carries it.
 */
export class GameRun {
  readonly proc: GameProcess;
  readonly channel: Channel | null;
  readonly exited: Promise<GameExit>;
  /** Set by the agent once the game is up; channel commands wait for it. */
  ready = false;
  private closed = false;
  private readonly waiters = new Set<Waiter>();

  /** Spawns the game; throws when it can't be started. */
  constructor(private readonly o: GameRunOptions) {
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
    this.o.onLine(raw, stream, signal);
    for (const w of this.waiters) {
      w.re.lastIndex = 0;
      const m = w.re.exec(signal.message);
      if (!m) continue;
      this.waiters.delete(w);
      clearTimeout(w.timer);
      w.resolve(m);
    }
  }

  /** A console command: see `ControlHandle.command`. */
  async command(cmd: string, via: CommandVia | undefined, onChannelError?: (e: Error) => void): Promise<string | null> {
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
    if (!this.proc.writeLine(cmd)) throw new Error('Could not write to the server console');
    return null;
  }

  waitForLine(re: RegExp, timeoutMs: number): Promise<RegExpExecArray | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const w: Waiter = {
        re,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(w);
          resolve(null);
        }, timeoutMs),
      };
      w.timer.unref();
      this.waiters.add(w);
    });
  }

  /** What adapters get. `onChannelError` hears channel failures of commands sent through this handle. */
  handle(onChannelError?: (e: Error) => void): ControlHandle {
    const isReady = () => this.ready && !this.closed;
    return {
      get ready() {
        return isReady();
      },
      command: (cmd, via) => this.command(cmd, via, onChannelError),
      stdin: (line) => this.proc.writeLine(line),
      signal: (sig) => this.proc.signal(sig),
      waitForLine: (re, timeoutMs) => this.waitForLine(re, timeoutMs),
    };
  }

  /** The process is gone: drop the channel and wake every waiter. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel?.close();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.waiters.clear();
  }
}
