import { quoteArg } from '@pz/formats';
import type { LaunchParams } from '@pz/shared';
import type { AgentApi } from '../agent/client';
import type { Audit } from '../audit';
import type { PanelEnv } from '../env';
import type { AgentFeed } from '../http/deps';
import type { OpContext, OpRunner } from '../ops/runner';
import type { OpState } from '../ops/bus';
import type { Settings } from '../settings';

export type GameLang = 'en' | 'es';

/** In-game announcements (players read them in chat, so keep them short). */
export type AnnounceKind = 'restart' | 'stop' | 'update' | 'restore' | 'reset';

const MSG: Record<GameLang, Record<AnnounceKind, string> & { cancelled: string; min: (n: number) => string; sec: (n: number) => string }> = {
  es: {
    restart: 'El servidor se reinicia en {t}. Busquen un lugar seguro.',
    stop: 'El servidor se apaga en {t}. Busquen un lugar seguro.',
    update: 'El servidor se actualiza en {t}. Busquen un lugar seguro.',
    restore: 'El servidor se apaga en {t} para restaurar una copia de seguridad.',
    reset: 'El mundo se reinicia en {t}. Todo lo construido se va a perder.',
    cancelled: 'Se canceló el reinicio del servidor.',
    min: (n) => (n === 1 ? '1 minuto' : `${n} minutos`),
    sec: (n) => `${n} segundos`,
  },
  en: {
    restart: 'Server restarting in {t}. Find somewhere safe.',
    stop: 'Server shutting down in {t}. Find somewhere safe.',
    update: 'Server updating in {t}. Find somewhere safe.',
    restore: 'Server shutting down in {t} to restore a backup.',
    reset: 'The world resets in {t}. Everything built will be lost.',
    cancelled: 'The server restart was cancelled.',
    min: (n) => (n === 1 ? '1 minute' : `${n} minutes`),
    sec: (n) => `${n} seconds`,
  },
};

/** When to warn, in seconds before the action. */
const MARKS = [900, 600, 300, 120, 60, 30, 10];
export const COUNTDOWNS = [0, 60, 300, 900] as const;

export function announcement(kind: AnnounceKind, secondsLeft: number, lang: GameLang): string {
  const m = MSG[lang];
  const t = secondsLeft >= 60 ? m.min(Math.round(secondsLeft / 60)) : m.sec(secondsLeft);
  return m[kind].replace('{t}', t);
}

export interface ControlDeps {
  env: PanelEnv;
  settings: Settings;
  agent: AgentApi;
  feed: AgentFeed;
  ops: OpRunner;
  audit: Audit;
}

export class Control {
  /** Hook run before every start (the config service seeds a first-run ini). */
  onBeforeStart: () => void = () => undefined;
  /** Hook run after stopping for an update, before installing (a pre-update backup). */
  beforeUpdateInstall: () => Promise<void> = async () => undefined;

  constructor(private readonly d: ControlDeps) {}

  launchParams(): LaunchParams {
    const l = this.d.settings.get('launch');
    return {
      serverName: this.d.env.serverName,
      adminUsername: 'admin',
      adminPassword: this.d.env.pzAdminPassword,
      memoryMb: l.memoryMb,
      branch: l.branch,
      updateOnStart: l.updateOnStart,
    };
  }

  private playersOnline(): number {
    const s = this.d.feed.status_;
    return s?.state === 'running' ? (s.players?.count ?? 0) : 0;
  }

  async broadcast(message: string): Promise<void> {
    await this.d.agent.command(`servermsg ${quoteArg(message, 'message')}`, 'rcon');
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
      await this.broadcast(announcement(kind, seconds, lang)).catch(() => undefined);
      for (const mark of MARKS.filter((m) => m < seconds)) {
        await ctx.sleep(endsAt - mark * 1000 - Date.now());
        await this.broadcast(announcement(kind, mark, lang)).catch(() => undefined);
      }
      await ctx.sleep(endsAt - Date.now());
    } catch (e) {
      await this.broadcast(MSG[lang].cancelled).catch(() => undefined);
      throw e;
    }
    ctx.step('acting', { countdownEndsAt: null, cancellable: false });
  }

  start(by: string | null): OpState {
    return this.d.ops.start('start', by, async (ctx) => {
      ctx.step('starting');
      this.onBeforeStart();
      await this.d.agent.start(this.launchParams());
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
        await this.d.agent.start(this.launchParams());
      },
      { cancellable: countdownSec > 0 },
    );
  }

  /** Stop (with warnings), install/validate the configured branch, start again if it was running. */
  update(by: string | null, opts: { countdownSec: number; validate: boolean }, lang: GameLang): OpState {
    return this.d.ops.start(
      'update',
      by,
      async (ctx) => {
        const wasRunning = ['running', 'starting'].includes(this.d.feed.status_?.state ?? '');
        await this.countdown(ctx, 'update', opts.countdownSec, lang);
        if (wasRunning) {
          ctx.step('stopping');
          await this.d.agent.stop({ reason: 'update' });
        }
        ctx.step('safety-backup');
        await this.beforeUpdateInstall();
        ctx.step(opts.validate ? 'validating' : 'updating');
        const r = await this.d.agent.install({ branch: this.launchParams().branch, validate: opts.validate });
        if (!r.ok) {
          // Leave the old build running rather than a stopped server.
          if (wasRunning) await this.d.agent.start({ ...this.launchParams(), updateOnStart: false }).catch(() => undefined);
          throw new Error(r.error ?? 'update failed');
        }
        if (wasRunning) {
          ctx.step('starting');
          await this.d.agent.start({ ...this.launchParams(), updateOnStart: false });
        }
      },
      { cancellable: opts.countdownSec > 0 },
    );
  }
}
