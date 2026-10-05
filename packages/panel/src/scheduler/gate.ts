import { createHash } from 'node:crypto';
import { SCHEDULE, type Audit } from '../audit';
import type { OpState } from '../ops/bus';
import type { KeyValueSettings } from '../settings';

/** The jobs a schedule starts that load the host (SCH-02): a restart stops a game, a backup packs a world, an update installs. */
export type HeavyJob = 'restart' | 'backup' | 'update' | 'mods';

export interface StaggerSettings {
  /** Minutes the host rests between one server's heavy job and the next server's. */
  gapMinutes: number;
  /** Each server's scheduled times move later by a fixed number of minutes below this (its offset). */
  spreadMinutes: number;
}

export const STAGGER_DEFAULTS: StaggerSettings = { gapMinutes: 2, spreadMinutes: 15 };
/** The host setting (table `settings`) that overrides the defaults, when the gate is given the host's settings. */
export const STAGGER_KEY = 'schedules.stagger';
/** Both are minutes, 0 to 30: an offset stays inside the hour a schedule names. */
export const STAGGER_MAX_MINUTES = 30;

/**
 * A server's offset in minutes, in [0, spreadMinutes): the same for the
 * same server id on every panel start (a hash of the id), so servers whose
 * schedules name the same time are spread apart without anyone choosing.
 */
export function staggerOffset(serverId: string, spreadMinutes: number): number {
  const spread = Math.floor(spreadMinutes);
  if (spread <= 0) return 0;
  return createHash('sha256').update(serverId).digest().readUInt32BE(0) % spread;
}

/** "06:00" plus 7 minutes → "06:07" (past midnight it wraps to the next day's time). */
export function shiftTime(hhmm: string, minutes: number): string {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`Invalid time ${hhmm}`);
  const total = (((Number(m[1]) * 60 + Number(m[2]) + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** One server as the gate sees it: its id and its one-operation-at-a-time runner, where people's own jobs show too. */
export interface GateMember {
  readonly serverId: string;
  readonly ops: { readonly busy: OpState | null };
}

/** What a job's turn tells it. */
export interface Turn {
  /** Its own server ran an operation the gate didn't start (someone's restart, say) while it waited. */
  ownServerBusyMeanwhile: boolean;
}

/** What a job started on its turn: its operation, and when it is known, the promise that settles as it ends. */
export interface Started {
  opId: string;
  done?: Promise<unknown>;
}

interface Entry {
  member: GateMember;
  job: HeavyJob;
  plannedAt: number;
  run: (turn: Turn) => Started | null;
  /** What it waited for: "<kind> on <server>". */
  behind: Set<string>;
  ownBusy: boolean;
  gap: boolean;
}

interface InFlight {
  member: GateMember;
  job: HeavyJob;
  opId: string;
  /** Its end comes as a promise (else it is looked at until it ends). */
  done: boolean;
}

/**
 * The host's turn for heavy scheduled jobs (SCH-02). Every server's
 * scheduler hands its restarts, backups and update installs here instead of
 * starting them: the gate runs them one at a time, first come first
 * served, and lets the host rest `gapMinutes` before the next server's job.
 * It also waits while any server runs an operation a person started; those
 * never wait for the gate (they go straight to their server's runner), so a
 * manual job starts at once, beside a scheduled one if one is running.
 * Each server's scheduled times are moved by its offset (`offsetOf`), so
 * schedules that name the same time rarely even meet here.
 *
 * Whatever waited is in the activity log (`schedule.waited`): when it was
 * planned, how long it waited and for what.
 */
export class HostJobGate {
  private static readonly byAudit = new WeakMap<Audit, HostJobGate>();

  /**
   * The gate of the panel that owns this audit log: one per panel, shared by
   * its servers' schedulers (what wiring uses until it hands each scheduler
   * the host's gate itself, with the host's settings).
   */
  static of(audit: Audit): HostJobGate {
    let g = HostJobGate.byAudit.get(audit);
    if (!g) HostJobGate.byAudit.set(audit, (g = new HostJobGate({ audit })));
    return g;
  }

  private readonly members = new Map<string, GateMember>();
  private queue: Entry[] = [];
  private inFlight: InFlight | null = null;
  /** Servers where people's operations were seen running while jobs waited (their end starts the rest). */
  private othersSeen = new Set<string>();
  /** When each server's last heavy job ended, as far as the gate saw. */
  private readonly lastEnds = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly pollMs: number;

  constructor(
    private readonly o: {
      audit: Audit;
      /** The host's settings (`STAGGER_KEY`); without them, the defaults. */
      settings?: KeyValueSettings;
      /** How often it looks at the servers' operations while something waits (default 5 s). */
      pollMs?: number;
    },
  ) {
    this.pollMs = o.pollMs ?? 5000;
  }

  config(): StaggerSettings {
    const s = this.o.settings?.getRaw<Partial<StaggerSettings>>(STAGGER_KEY) ?? {};
    const clamp = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(STAGGER_MAX_MINUTES, Math.floor(v))) : d);
    return { gapMinutes: clamp(s.gapMinutes, STAGGER_DEFAULTS.gapMinutes), spreadMinutes: clamp(s.spreadMinutes, STAGGER_DEFAULTS.spreadMinutes) };
  }

  /** This server's offset in minutes (see `staggerOffset`). */
  offsetOf(serverId: string): number {
    return staggerOffset(serverId, this.config().spreadMinutes);
  }

  /** A server whose operations the gate waits for (its scheduler joins when its timers start). */
  join(m: GateMember): void {
    this.members.set(m.serverId, m);
  }

  /** A server removed or shut down: its waiting jobs go with it. */
  leave(serverId: string): void {
    this.members.delete(serverId);
    this.queue = this.queue.filter((e) => e.member.serverId !== serverId);
    this.pump();
  }

  /** Whether this server's job of this kind is waiting for its turn. */
  isWaiting(serverId: string, job: HeavyJob): boolean {
    return this.queue.some((e) => e.member.serverId === serverId && e.job === job);
  }

  /** This server's jobs waiting for their turn, oldest first. */
  waiting(serverId: string): { job: HeavyJob; plannedAt: string }[] {
    return this.queue.filter((e) => e.member.serverId === serverId).map((e) => ({ job: e.job, plannedAt: new Date(e.plannedAt).toISOString() }));
  }

  /** Takes a waiting job out of the queue (a restart that backs up makes its server's waiting backup needless). */
  drop(serverId: string, job: HeavyJob): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((e) => !(e.member.serverId === serverId && e.job === job));
    return this.queue.length < before;
  }

  /**
   * A scheduled job is due: it runs now when the host is free, else waits
   * its turn. `run` starts its operation, or returns null when it decides
   * not to (its server stopped meanwhile, say). One job of each kind per
   * server waits at a time: `already-waiting` when this one is a repeat.
   */
  enqueue(member: GateMember, job: HeavyJob, run: (turn: Turn) => Started | null): 'started' | 'waiting' | 'already-waiting' {
    if (this.isWaiting(member.serverId, job)) return 'already-waiting';
    const e: Entry = { member, job, plannedAt: Date.now(), run, behind: new Set(), ownBusy: false, gap: false };
    this.queue.push(e);
    this.pump();
    return this.queue.includes(e) ? 'waiting' : 'started';
  }

  /** Operations running on the host now, but the gate's own job: what a waiting job waits for. */
  private others(): { serverId: string; kind: string }[] {
    const out: { serverId: string; kind: string }[] = [];
    for (const m of this.members.values()) {
      const op = m.ops.busy;
      if (op && !(this.inFlight && this.inFlight.member.serverId === m.serverId && this.inFlight.opId === op.id)) out.push({ serverId: m.serverId, kind: op.kind });
    }
    return out;
  }

  private ended(serverId: string): void {
    this.lastEnds.set(serverId, Date.now());
  }

  /** When the host's rest before this server's job ends: after the latest job of any other server (a server's own jobs already run one after another). */
  private restEnds(serverId: string): number {
    const gapMs = this.config().gapMinutes * 60_000;
    let end = 0;
    for (const [sid, at] of this.lastEnds) if (sid !== serverId) end = Math.max(end, at + gapMs);
    return end;
  }

  private pump(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const f = this.inFlight;
    if (f && f.member.ops.busy?.id !== f.opId) {
      this.inFlight = null;
      this.ended(f.member.serverId);
    }
    if (!this.queue.length) {
      this.othersSeen.clear();
      // A job whose end has no promise is looked at until it ends, so the rest after it counts from then.
      if (this.inFlight && !this.inFlight.done) this.arm(this.pollMs);
      return;
    }
    if (this.inFlight) for (const e of this.queue) this.note(e, this.inFlight.member.serverId, this.inFlight.job, false);
    const others = this.others();
    for (const o of others) for (const e of this.queue) this.note(e, o.serverId, o.kind, true);
    // People's operations that were running and no longer are: the rest counts from now.
    const busy = new Set(others.map((o) => o.serverId));
    for (const sid of this.othersSeen) if (!busy.has(sid)) this.ended(sid);
    this.othersSeen = busy;
    if (this.inFlight || others.length) return this.arm(this.pollMs);
    const now = Date.now();
    while (this.queue.length) {
      const head = this.queue[0]!;
      const gapEnds = this.restEnds(head.member.serverId);
      if (now < gapEnds) {
        head.gap = true;
        return this.arm(gapEnds - now);
      }
      this.queue.shift();
      let started: Started | null = null;
      try {
        started = head.run({ ownServerBusyMeanwhile: head.ownBusy });
      } catch (err) {
        this.o.audit.log({ actor: SCHEDULE, serverId: head.member.serverId, action: 'schedule.error', detail: `${head.job}: ${(err as Error).message}`, ok: false });
      }
      this.auditWait(head, now, started !== null);
      if (started) {
        const flight: InFlight = { member: head.member, job: head.job, opId: started.opId, done: !!started.done };
        this.inFlight = flight;
        const end = () => {
          if (this.inFlight !== flight) return;
          this.inFlight = null;
          this.ended(flight.member.serverId);
          this.pump();
        };
        started.done?.then(end, end);
        if (this.queue.length || !started.done) this.arm(this.pollMs);
        return;
      }
    }
  }

  /** `other`: an operation the gate didn't start (a person's), which on the job's own server counts as "busy meanwhile". */
  private note(e: Entry, serverId: string, kind: string, other: boolean): void {
    if (other && serverId === e.member.serverId) e.ownBusy = true;
    e.behind.add(`${kind} on ${serverId}`);
  }

  private arm(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.pump(), Math.max(1, ms));
    this.timer.unref?.();
  }

  private auditWait(e: Entry, startedAt: number, started: boolean): void {
    const waited = startedAt - e.plannedAt;
    if (waited < 1000) return;
    const why = [...e.behind];
    if (e.gap) why.push(`the ${this.config().gapMinutes}-minute rest between servers`);
    this.o.audit.log({
      actor: SCHEDULE,
      serverId: e.member.serverId,
      action: 'schedule.waited',
      target: e.job,
      detail: `${e.job} due at ${new Date(e.plannedAt).toISOString()} waited ${duration(waited)} for its turn${why.length ? ` (after ${why.join(', ')})` : ''}${started ? '' : '; then it was not needed'}`,
    });
  }
}

/** "9 min 30 s", "45 s". */
function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} s`;
}
