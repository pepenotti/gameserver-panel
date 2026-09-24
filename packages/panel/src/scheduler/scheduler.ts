import path from 'node:path';
import { Cron } from 'croner';
import type { AgentApi } from '../agent/client';
import type { Audit } from '../audit';
import type { BackupFlows } from '../backups/flows';
import type { BackupService } from '../backups/service';
import type { Control, GameLang } from '../control/control';
import type { AgentFeed } from '../http/deps';
import type { ModsService } from '../mods/service';
import type { DiscordNotifier } from '../notifier/discord';
import type { OpRunner } from '../ops/runner';
import type { Settings } from '../settings';

export type ApplyPolicy = 'when-empty' | 'restart-countdown' | 'notify-only';

export interface ScheduleSettings {
  timezone: string;
  /** Language of the in-game warnings sent by scheduled jobs. */
  lang: GameLang;
  restarts: { enabled: boolean; times: string[]; countdownSec: number; backupWhileStopped: boolean };
  backups: { enabled: boolean; everyHours: number };
  gameUpdates: { enabled: boolean; checkEveryMinutes: number; apply: ApplyPolicy };
  modUpdates: { enabled: boolean; checkEveryMinutes: number; apply: ApplyPolicy };
}

export const SCHEDULE_DEFAULTS: ScheduleSettings = {
  timezone: process.env.TZ || 'UTC',
  lang: 'es',
  restarts: { enabled: true, times: ['06:00'], countdownSec: 900, backupWhileStopped: true },
  backups: { enabled: true, everyHours: 6 },
  gameUpdates: { enabled: true, checkEveryMinutes: 30, apply: 'when-empty' },
  modUpdates: { enabled: true, checkEveryMinutes: 30, apply: 'when-empty' },
};

/** "06:00" → "0 6 * * *". */
export function timeToCron(hhmm: string): string {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`Invalid time ${hhmm}`);
  return `${Number(m[2])} ${Number(m[1])} * * *`;
}

export interface SchedulerDeps {
  settings: Settings;
  agent: AgentApi;
  feed: AgentFeed;
  ops: OpRunner;
  control: Control;
  flows: BackupFlows;
  backups: BackupService;
  mods: ModsService;
  notifier: DiscordNotifier;
  audit: Audit;
  /** Nightly copy of the panel's own database; see backups/panel-db.ts. */
  backupPanelDb: () => string;
}

export interface NextRuns {
  restart: string | null;
  backup: string | null;
  gameCheck: string | null;
  modCheck: string | null;
  panelDb: string | null;
}

export class Scheduler {
  private jobs: { name: keyof NextRuns; cron: Cron }[] = [];
  /** Update seen but waiting for the server to empty (policy when-empty). */
  private pendingGameUpdate: string | null = null;
  private pendingModUpdate: string[] = [];

  constructor(private readonly d: SchedulerDeps) {}

  config(): ScheduleSettings {
    const s = this.d.settings.getRaw<Partial<ScheduleSettings>>('schedules') ?? {};
    return {
      ...SCHEDULE_DEFAULTS,
      ...s,
      restarts: { ...SCHEDULE_DEFAULTS.restarts, ...s.restarts },
      backups: { ...SCHEDULE_DEFAULTS.backups, ...s.backups },
      gameUpdates: { ...SCHEDULE_DEFAULTS.gameUpdates, ...s.gameUpdates },
      modUpdates: { ...SCHEDULE_DEFAULTS.modUpdates, ...s.modUpdates },
    };
  }

  save(next: ScheduleSettings): void {
    for (const t of next.restarts.times) timeToCron(t);
    new Cron('* * * * *', { timezone: next.timezone, paused: true }).stop(); // throws on a bad timezone
    this.d.settings.setRaw('schedules', next);
    this.reload();
  }

  stop(): void {
    for (const j of this.jobs) j.cron.stop();
    this.jobs = [];
  }

  reload(): void {
    this.stop();
    const c = this.config();
    const opts = { timezone: c.timezone, protect: true, catch: (e: unknown) => this.d.audit.log({ action: 'schedule.error', detail: String(e), ok: false }) };
    if (c.restarts.enabled) for (const t of c.restarts.times) this.jobs.push({ name: 'restart', cron: new Cron(timeToCron(t), opts, () => this.runRestart()) });
    if (c.backups.enabled) this.jobs.push({ name: 'backup', cron: new Cron(`0 */${Math.max(1, Math.min(24, c.backups.everyHours))} * * *`, opts, () => this.runBackup()) });
    if (c.gameUpdates.enabled) this.jobs.push({ name: 'gameCheck', cron: new Cron(`*/${Math.max(5, Math.min(59, c.gameUpdates.checkEveryMinutes))} * * * *`, opts, () => this.checkGameUpdate()) });
    if (c.modUpdates.enabled) this.jobs.push({ name: 'modCheck', cron: new Cron(`*/${Math.max(5, Math.min(59, c.modUpdates.checkEveryMinutes))} * * * *`, opts, () => this.checkModUpdates()) });
    // Always on: losing the panel database means re-creating every account and 2FA.
    this.jobs.push({ name: 'panelDb', cron: new Cron('30 4 * * *', opts, () => this.runPanelDbBackup()) });
  }

  nextRuns(): NextRuns {
    const out: NextRuns = { restart: null, backup: null, gameCheck: null, modCheck: null, panelDb: null };
    for (const j of this.jobs) {
      const n = j.cron.nextRun()?.toISOString() ?? null;
      if (n && (!out[j.name] || n < out[j.name]!)) out[j.name] = n;
    }
    return out;
  }

  private get state(): string | undefined {
    return this.d.feed.status_?.state;
  }

  private playersOnline(): number {
    return this.state === 'running' ? (this.d.feed.status_?.players?.count ?? 0) : 0;
  }

  private skip(job: string, why: string): void {
    this.d.audit.log({ action: `schedule.${job}`, detail: `skipped: ${why}`, ok: true });
  }

  // ----------------------------------------------------------------- jobs

  /** Daily restart: warn, stop, cold backup while stopped, start. */
  async runRestart(): Promise<void> {
    if (this.state !== 'running') return this.skip('restart', 'server not running');
    if (this.d.ops.busy) return this.skip('restart', 'another operation is running');
    const c = this.config();
    this.d.audit.log({ action: 'schedule.restart' });
    this.d.ops.start(
      'restart',
      'scheduler',
      async (ctx) => {
        await this.d.control.countdown(ctx, 'restart', c.restarts.countdownSec, c.lang);
        const lock = await this.d.agent.lock('scheduled restart', 2 * 3_600_000);
        try {
          ctx.step('stopping');
          await this.d.agent.stop({ reason: 'scheduled restart' }, lock.id);
          if (c.restarts.backupWhileStopped) {
            ctx.step('archiving');
            try {
              await this.d.backups.create({ trigger: 'scheduled', hot: false });
            } catch (e) {
              // A failed backup must not keep the server down.
              this.d.notifier.notify('backup', { ok: 'false', detail: `🕒 auto — ${(e as Error).message}` });
            }
          }
          // Mod updates waiting for a restart are applied by the server's own download at start.
          this.pendingModUpdate = [];
          ctx.step('starting');
          await this.d.agent.start(this.d.control.launchParams(), lock.id);
        } finally {
          await this.d.agent.unlock(lock.id).catch(() => undefined);
        }
      },
      { cancellable: c.restarts.countdownSec > 0 },
    );
  }

  runPanelDbBackup(): void {
    try {
      const file = this.d.backupPanelDb();
      this.d.audit.log({ action: 'schedule.panelDb', detail: path.basename(file) });
    } catch (e) {
      this.d.audit.log({ action: 'schedule.panelDb', detail: (e as Error).message, ok: false });
    }
  }

  /** Periodic backup: hot while running (saved first), cold when stopped. */
  async runBackup(): Promise<void> {
    if (this.d.ops.busy) return this.skip('backup', 'another operation is running');
    this.d.ops.start('backup', 'scheduler', async (ctx) => {
      try {
        const b = await this.d.flows.backupNow(ctx, 'scheduled');
        this.d.audit.log({ action: 'schedule.backup', detail: b.name });
      } catch (e) {
        // Still fails the op (and so the Discord message); this makes it visible in the activity log too.
        this.d.audit.log({ action: 'schedule.backup', detail: (e as Error).message, ok: false });
        throw e;
      }
    });
  }

  async checkGameUpdate(): Promise<void> {
    const c = this.config();
    let info;
    try {
      info = await this.d.agent.appInfo();
    } catch {
      return;
    }
    const branch = this.d.control.launchParams().branch;
    const latest = info.branches.find((b) => b.name === branch);
    if (!latest || !info.installed || (info.installed.branch === branch && info.installed.buildId === latest.buildId)) {
      this.pendingGameUpdate = null;
      return;
    }
    if (this.pendingGameUpdate !== latest.buildId) {
      this.pendingGameUpdate = latest.buildId;
      this.d.notifier.notify('update', { detail: `${info.installed.buildId} → ${latest.buildId} (${branch})` }, 'updateAvailable');
    }
    this.applyPolicy(c.gameUpdates.apply, 'update');
  }

  async checkModUpdates(): Promise<void> {
    const c = this.config();
    let ids: string[];
    try {
      ids = await this.d.mods.checkUpdates();
    } catch {
      return;
    }
    const enabledItems = new Set(this.d.mods.enabled().map((e) => e.workshopId));
    const relevant = ids.filter((id) => enabledItems.has(id));
    if (relevant.length === 0) return;
    if (relevant.join() !== this.pendingModUpdate.join()) {
      this.pendingModUpdate = relevant;
      this.d.notifier.notify('mods', { detail: `⬆️ ${relevant.join(', ')}` });
    }
    this.applyPolicy(c.modUpdates.apply, 'mods');
  }

  /**
   * when-empty: act now if nobody is playing (or the server is stopped), else
   * wait for a later check. restart-countdown: act now with warnings.
   * notify-only: the Discord message was enough.
   */
  private applyPolicy(policy: ApplyPolicy, what: 'update' | 'mods'): void {
    if (policy === 'notify-only' || this.d.ops.busy) return;
    const empty = this.playersOnline() === 0;
    if (policy === 'when-empty' && !empty) return;
    const countdown = policy === 'restart-countdown' && !empty ? 900 : 0;
    const lang = this.config().lang;
    if (what === 'update') {
      this.d.control.update('scheduler', { countdownSec: countdown, validate: false }, lang);
      this.pendingGameUpdate = null;
    } else if (this.state === 'running') {
      // The server downloads updated workshop items when it starts.
      this.d.control.restart('scheduler', countdown, lang);
      this.pendingModUpdate = [];
    }
  }
}
