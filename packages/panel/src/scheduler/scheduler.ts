import { Cron } from 'croner';
import type { AgentApi } from '../agent/client';
import { SCHEDULE, type Audit } from '../audit';
import type { BackupFlows } from '../backups/flows';
import type { BackupService } from '../backups/service';
import type { Control, GameLang } from '../control/control';
import type { AgentFeed } from '../http/deps';
import type { ModsService } from '../mods/service';
import type { Notify } from '../notifier/discord';
import type { OpState } from '../ops/bus';
import type { OpRunner } from '../ops/runner';
import type { KeyValueSettings } from '../settings';
import { HostJobGate, shiftTime, type GateMember, type HeavyJob, type Started, type Turn } from './gate';

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

/** The time of day `at` is in `timezone`, as "HH:MM". */
function localTime(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${part('hour')}:${part('minute')}`;
}

export interface SchedulerDeps {
  /** The server's own settings. */
  settings: KeyValueSettings;
  agent: AgentApi;
  feed: AgentFeed;
  ops: OpRunner;
  control: Control;
  flows: BackupFlows;
  backups: BackupService;
  mods: ModsService;
  /** The server's Discord messages (its override, its name). */
  notifier: Notify;
  audit: Audit;
  /** The host's turn for heavy jobs (SCH-02), shared by every server; default: the panel's own, found by its audit log. */
  gate?: HostJobGate;
}

export interface NextRuns {
  /** When each job runs next: the time its schedule names plus this server's offset. */
  restart: string | null;
  backup: string | null;
  gameCheck: string | null;
  modCheck: string | null;
  /** Minutes this server's restarts and backups run after the times its schedule names (SCH-02). */
  offsetMinutes: number;
  /** Its jobs that are due and waiting for another server's job to end. */
  waiting: { job: HeavyJob; plannedAt: string }[];
}

type JobName = 'restart' | 'backup' | 'gameCheck' | 'modCheck';

export class Scheduler {
  private jobs: { name: JobName; cron: Cron }[] = [];
  /** Update seen but waiting for the server to empty (policy when-empty). */
  private pendingGameUpdate: string | null = null;
  private pendingModUpdate: string[] = [];
  readonly gate: HostJobGate;
  /** This server as the gate sees it: its operations, people's included. */
  private readonly member: GateMember;

  constructor(private readonly d: SchedulerDeps) {
    this.gate = d.gate ?? HostJobGate.of(d.audit);
    this.member = { serverId: d.ops.serverId, ops: d.ops };
  }

  private get serverId(): string {
    return this.d.control.server.ref.id;
  }

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

  /** Its timers stop and its waiting jobs leave the host's queue (the server is removed, or the panel stops). */
  stop(): void {
    this.stopTimers();
    this.gate.leave(this.serverId);
  }

  private stopTimers(): void {
    for (const j of this.jobs) j.cron.stop();
    this.jobs = [];
  }

  /**
   * (Re)starts its timers from the stored schedule. Restarts and backups
   * run at the times it names plus this server's offset (SCH-02), and wait
   * their turn on the host; jobs already waiting keep their place.
   */
  reload(): void {
    this.stopTimers();
    this.gate.join(this.member);
    const c = this.config();
    const off = this.gate.offsetOf(this.serverId);
    const opts = { timezone: c.timezone, protect: true, catch: (e: unknown) => this.d.audit.log({ actor: SCHEDULE, serverId: this.serverId, action: 'schedule.error', detail: String(e), ok: false }) };
    if (c.restarts.enabled) for (const t of c.restarts.times) this.jobs.push({ name: 'restart', cron: new Cron(timeToCron(shiftTime(t, off)), opts, () => this.restartDue()) });
    if (c.backups.enabled) this.jobs.push({ name: 'backup', cron: new Cron(`${off} */${Math.max(1, Math.min(24, c.backups.everyHours))} * * *`, opts, (self) => this.backupDue(self.currentRun() ?? new Date())) });
    if (c.gameUpdates.enabled) this.jobs.push({ name: 'gameCheck', cron: new Cron(`*/${Math.max(5, Math.min(59, c.gameUpdates.checkEveryMinutes))} * * * *`, opts, () => this.checkGameUpdate()) });
    if (c.modUpdates.enabled) this.jobs.push({ name: 'modCheck', cron: new Cron(`*/${Math.max(5, Math.min(59, c.modUpdates.checkEveryMinutes))} * * * *`, opts, () => this.checkModUpdates()) });
  }

  nextRuns(): NextRuns {
    const out: NextRuns = { restart: null, backup: null, gameCheck: null, modCheck: null, offsetMinutes: this.gate.offsetOf(this.serverId), waiting: this.gate.waiting(this.serverId) };
    for (const j of this.jobs) {
      const n = j.cron.nextRun()?.toISOString() ?? null;
      const cur = out[j.name];
      if (n && (!cur || n < cur)) out[j.name] = n;
    }
    return out;
  }

  private get state(): string | undefined {
    return this.d.feed.status_?.state;
  }

  private playersOnline(): number {
    return this.state === 'running' ? (this.d.feed.status_?.players?.count ?? 0) : 0;
  }

  private skip(job: string, why: string): null {
    this.d.audit.log({ actor: SCHEDULE, serverId: this.serverId, action: `schedule.${job}`, detail: `skipped: ${why}`, ok: true });
    return null;
  }

  /** Hands a due job to the host's queue (SCH-02): it starts now when the host is free, else at its turn. */
  private queue(job: HeavyJob, run: (turn: Turn) => Started | null): void {
    if (this.gate.enqueue(this.member, job, run) === 'already-waiting') this.skip(job, 'one is already waiting for its turn');
  }

  /** An operation Control started for a job: the gate looks at the server's runner to see it end. */
  private started(op: OpState): Started {
    return { opId: op.id };
  }

  // ----------------------------------------------------------------- due

  private restartDue(): void {
    if (this.state !== 'running') return void this.skip('restart', 'server not running');
    if (this.d.ops.busy) return void this.skip('restart', 'another operation is running');
    // The restart backs up while stopped: this server's backup waiting for its turn is not needed.
    if (this.config().restarts.backupWhileStopped && this.gate.drop(this.serverId, 'backup')) this.skip('backup', 'the restart takes a backup');
    this.queue('restart', (turn) => (turn.ownServerBusyMeanwhile ? this.skip('restart', 'someone ran another operation on the server while it waited') : this.restartNow()));
  }

  private backupDue(plannedAt: Date): void {
    if (this.d.ops.busy) return void this.skip('backup', 'another operation is running');
    const c = this.config();
    // Due at the same time as one of its restarts that backs up (their times move by the same offset), or after one still waiting.
    const named = localTime(new Date(plannedAt.getTime() - this.gate.offsetOf(this.serverId) * 60_000), c.timezone);
    if (c.restarts.enabled && c.restarts.backupWhileStopped && (c.restarts.times.includes(named) || this.gate.isWaiting(this.serverId, 'restart'))) return void this.skip('backup', 'the restart takes a backup');
    this.queue('backup', () => this.backupNow());
  }

  // ----------------------------------------------------------------- jobs

  /** Daily restart, now: warn, stop, cold backup while stopped, start. Without the host's queue (the timers go through it). */
  async runRestart(): Promise<void> {
    this.restartNow();
  }

  private restartNow(): Started | null {
    if (this.state !== 'running') return this.skip('restart', 'server not running');
    if (this.d.ops.busy) return this.skip('restart', 'another operation is running');
    const c = this.config();
    this.d.audit.log({ actor: SCHEDULE, serverId: this.serverId, action: 'schedule.restart' });
    const done = this.d.ops.run(
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
          await this.d.control.startAgent({ lockId: lock.id, by: 'scheduler' });
        } finally {
          await this.d.agent.unlock(lock.id).catch(() => undefined);
        }
      },
      { cancellable: c.restarts.countdownSec > 0 },
    );
    // How it ended is in its state (and on the bus); the host's queue only needs to know when.
    return { opId: this.d.ops.last()?.id ?? '', done: done.catch(() => undefined) };
  }

  /** Periodic backup, now: hot while running (saved first), cold when stopped. Without the host's queue. */
  async runBackup(): Promise<void> {
    this.backupNow();
  }

  private backupNow(): Started | null {
    if (this.d.ops.busy) return this.skip('backup', 'another operation is running');
    const done = this.d.ops.run('backup', 'scheduler', async (ctx) => {
      try {
        const b = await this.d.flows.backupNow(ctx, 'scheduled');
        this.d.audit.log({ actor: SCHEDULE, serverId: this.serverId, action: 'schedule.backup', detail: b.name });
      } catch (e) {
        // Still fails the op (and so the Discord message); this makes it visible in the activity log too.
        this.d.audit.log({ actor: SCHEDULE, serverId: this.serverId, action: 'schedule.backup', detail: (e as Error).message, ok: false });
        throw e;
      }
    });
    return { opId: this.d.ops.last()?.id ?? '', done: done.catch(() => undefined) };
  }

  /** The adapter's update check; nothing installed yet is not an update (the first start installs). */
  async checkGameUpdate(): Promise<void> {
    const c = this.config();
    const { server } = this.d.control;
    const updates = server.adapter.updates;
    if (!updates || !server.has('updateCheck')) return;
    let info;
    try {
      info = await updates.check(server.ctx('scheduler'), server.launchSettings());
    } catch {
      return;
    }
    if (!info?.available || info.current === null) {
      this.pendingGameUpdate = null;
      return;
    }
    if (this.pendingGameUpdate !== info.latest) {
      this.pendingGameUpdate = info.latest;
      this.d.notifier.notify('update', { detail: `${info.current} → ${info.latest}${info.channel ? ` (${info.channel})` : ''}` }, 'updateAvailable');
    }
    this.applyPolicy(c.gameUpdates.apply, 'update');
  }

  async checkModUpdates(): Promise<void> {
    const c = this.config();
    if (!this.d.mods.available) return;
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
   * notify-only: the Discord message was enough. "Now" is the server's turn
   * on the host (SCH-02); at its turn the policy is looked at again.
   */
  private applyPolicy(policy: ApplyPolicy, what: 'update' | 'mods'): void {
    if (policy === 'notify-only' || this.d.ops.busy) return;
    if (policy === 'when-empty' && this.playersOnline() > 0) return;
    // The server fetches updated mods when it starts: a stopped one needs nothing now.
    if (what === 'mods' && this.state !== 'running') return;
    this.queue(what, (turn) => this.applyNow(policy, what, turn));
  }

  private applyNow(policy: ApplyPolicy, what: 'update' | 'mods', turn: Turn): Started | null {
    if (this.d.ops.busy) return null;
    const empty = this.playersOnline() === 0;
    // Someone joined while it waited: a later check tries again.
    if (policy === 'when-empty' && !empty) return null;
    const countdown = policy === 'restart-countdown' && !empty ? 900 : 0;
    const lang = this.config().lang;
    if (what === 'update') {
      const op = this.d.control.update('scheduler', { countdownSec: countdown, validate: false }, lang);
      this.pendingGameUpdate = null;
      return this.started(op);
    }
    // A restart someone made meanwhile already fetched them; a stopped server fetches them at its start.
    if (turn.ownServerBusyMeanwhile || this.state !== 'running' || this.pendingModUpdate.length === 0) return null;
    const op = this.d.control.restart('scheduler', countdown, lang);
    this.pendingModUpdate = [];
    return this.started(op);
  }
}
