import type { AnnounceKind, Lang, ToAgentOptions } from '@gsp/adapter-api';
import type { AgentApi } from '../agent/client';
import type { BackupService } from '../backups/service';
import type { AgentFeed } from '../http/deps';
import type { OpContext, OpRunner } from '../ops/runner';
import type { OpState } from '../ops/bus';
import type { ServerHandle } from '../server/handle';

/** Language of in-game messages. */
export type GameLang = Lang;

/** Why players are warned in game. The kinds are the adapter contract's. */
export type { AnnounceKind };

/** When to warn, in seconds before the action. */
const MARKS = [900, 600, 300, 120, 60, 30, 10];
export const COUNTDOWNS = [0, 60, 300, 900] as const;

export interface ControlDeps {
  agent: AgentApi;
  feed: AgentFeed;
  ops: OpRunner;
  server: ServerHandle;
  /** For the safety backup before an update. */
  backups: Pick<BackupService, 'hasData' | 'create'>;
  /** Before the game starts: the registry recreates a container that waits for changed settings (SRV-05). */
  beforeStart?: () => Promise<void>;
}

export class Control {
  constructor(private readonly d: ControlDeps) {}

  /** The server this controls (routes reach its launch settings and context through it). */
  get server(): ServerHandle {
    return this.d.server;
  }

  private playersOnline(): number {
    const s = this.d.feed.status_;
    return s?.state === 'running' ? (s.players?.count ?? 0) : 0;
  }

  /** A message to every player; throws when the game can't show one (or the text is refused). */
  async broadcast(message: string): Promise<void> {
    const cmd = this.d.server.adapter.messages.broadcast?.(message);
    if (!cmd) throw new Error('This game cannot show messages to players');
    await this.d.agent.command(cmd.command, cmd.via);
  }

  private async announce(kind: AnnounceKind | 'cancelled', secondsLeft: number, lang: GameLang): Promise<void> {
    const { messages } = this.d.server.adapter;
    const text = messages.announce(kind, secondsLeft, lang);
    if (text === null || !messages.broadcast) return;
    await this.broadcast(text).catch(() => undefined);
  }

  /**
   * Warn players at the usual marks, then return. Skipped entirely when
   * nobody is online. Cancelling tells the players it was called off.
   */
  async countdown(ctx: OpContext, kind: AnnounceKind, seconds: number, lang: GameLang): Promise<void> {
    if (seconds <= 0 || this.playersOnline() === 0) return;
    const endsAt = Date.now() + seconds * 1000;
    ctx.step('countdown', { countdownEndsAt: new Date(endsAt).toISOString(), cancellable: true });
    try {
      await this.announce(kind, seconds, lang);
      for (const mark of MARKS.filter((m) => m < seconds)) {
        await ctx.sleep(endsAt - mark * 1000 - Date.now());
        await this.announce(kind, mark, lang);
      }
      await ctx.sleep(endsAt - Date.now());
    } catch (e) {
      await this.announce('cancelled', 0, lang);
      throw e;
    }
    ctx.step('acting', { countdownEndsAt: null, cancellable: false });
  }

  /**
   * Start the game: its container brought in line first (new memory or CPU
   * limits wait for this moment), the adapter's before-start hook, then the
   * agent with the stored launch settings.
   */
  async startAgent(o: { lockId?: string; by?: string | null; hints?: ToAgentOptions } = {}): Promise<void> {
    await this.d.beforeStart?.();
    const launch = this.d.server.launchEnvelope(o.hints);
    await this.d.server.adapter.hooks?.beforeStart?.(this.d.server.ctx(o.by ?? null));
    await this.d.agent.start(launch, o.lockId);
  }

  start(by: string | null): OpState {
    return this.d.ops.start('start', by, async (ctx) => {
      ctx.step('starting');
      await this.startAgent({ by });
    });
  }

  stop(by: string | null, countdownSec: number, lang: GameLang): OpState {
    return this.d.ops.start(
      'stop',
      by,
      async (ctx) => {
        await this.countdown(ctx, 'stop', countdownSec, lang);
        ctx.step('stopping');
        await this.d.agent.stop({ reason: by ? `stopped by ${by}` : 'stopped' });
      },
      { cancellable: countdownSec > 0 },
    );
  }

  restart(by: string | null, countdownSec: number, lang: GameLang): OpState {
    return this.d.ops.start(
      'restart',
      by,
      async (ctx) => {
        await this.countdown(ctx, 'restart', countdownSec, lang);
        ctx.step('stopping');
        await this.d.agent.stop({ reason: 'restart' });
        ctx.step('starting');
        await this.startAgent({ by });
      },
      { cancellable: countdownSec > 0 },
    );
  }

  /** Stop (with warnings), install/validate for the stored launch settings, start again if it was running. */
  update(by: string | null, opts: { countdownSec: number; validate: boolean }, lang: GameLang): OpState {
    return this.d.ops.start(
      'update',
      by,
      async (ctx) => {
        const launch = this.d.server.launchEnvelope();
        const wasRunning = ['running', 'starting'].includes(this.d.feed.status_?.state ?? '');
        await this.countdown(ctx, 'update', opts.countdownSec, lang);
        if (wasRunning) {
          ctx.step('stopping');
          await this.d.agent.stop({ reason: 'update' });
        }
        ctx.step('safety-backup');
        // Only when there is something to protect; the server is stopped, so a cold copy.
        if (await this.d.backups.hasData()) await this.d.backups.create({ trigger: 'pre-update', hot: false });
        ctx.step(opts.validate ? 'validating' : 'updating');
        const r = await this.d.agent.install({ validate: opts.validate, launch });
        if (!r.ok) {
          // Leave the old build running rather than a stopped server.
          if (wasRunning) await this.startAgent({ by, hints: { afterInstall: true } }).catch(() => undefined);
          throw new Error(r.error ?? 'update failed');
        }
        if (wasRunning) {
          ctx.step('starting');
          await this.startAgent({ by, hints: { afterInstall: true } });
        }
      },
      { cancellable: opts.countdownSec > 0 },
    );
  }
}
