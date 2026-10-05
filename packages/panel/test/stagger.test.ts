import { afterEach, describe, expect, it, vi } from 'vitest';
import { Audit } from '../src/audit';
import type { BackupFlows } from '../src/backups/flows';
import type { BackupService } from '../src/backups/service';
import type { Control } from '../src/control/control';
import { openDb } from '../src/db/db';
import type { ModsService } from '../src/mods/service';
import type { Notify } from '../src/notifier/discord';
import { PanelBus } from '../src/ops/bus';
import { OpRunner, type OpContext } from '../src/ops/runner';
import { HostJobGate, shiftTime, STAGGER_DEFAULTS, STAGGER_KEY, staggerOffset, type StaggerSettings } from '../src/scheduler/gate';
import { SCHEDULE_DEFAULTS, Scheduler, type ScheduleSettings } from '../src/scheduler/scheduler';
import type { KeyValueSettings } from '../src/settings';
import { FakeFeed, fakeAgent, fakeStatus, makePanel, ownerReady } from './harness';

class MemSettings implements KeyValueSettings {
  private readonly m = new Map<string, unknown>();
  getRaw<T>(key: string): T | null {
    return (this.m.get(key) as T | undefined) ?? null;
  }
  setRaw<T>(key: string, value: T | null): void {
    this.m.set(key, value);
  }
}

const MIN = 60_000;
const T0 = Date.parse('2026-10-05T05:58:00Z');
/** "HH:MM" of a time on the test's day (UTC). */
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/**
 * A host of fake servers with real schedulers, operation runners and gate:
 * each job's work takes the minutes the test gives it (fake clock), and
 * every start of a job's work is recorded.
 */
function host(stagger: Partial<StaggerSettings> = {}) {
  const audit = new Audit(openDb(':memory:'));
  const hostSettings = new MemSettings();
  hostSettings.setRaw<StaggerSettings>(STAGGER_KEY, { ...STAGGER_DEFAULTS, ...stagger });
  const gate = new HostJobGate({ audit, settings: hostSettings, pollMs: 1000 });
  const bus = new PanelBus();
  /** What happened, as "<HH:MM> <server> <what>". */
  const log: string[] = [];
  const at = () => hhmm(Date.now());

  function server(id: string, o: { schedule?: Partial<ScheduleSettings>; restartMin?: number; backupMin?: number } = {}) {
    const feed = new FakeFeed();
    feed.status_ = fakeStatus({ state: 'running', players: { count: 0, names: [], at: '' } });
    const agent = fakeAgent(feed);
    const ops = new OpRunner(bus, id);
    const settings = new MemSettings();
    settings.setRaw<ScheduleSettings>('schedules', {
      ...SCHEDULE_DEFAULTS,
      timezone: 'UTC',
      restarts: { enabled: false, times: ['06:00'], countdownSec: 0, backupWhileStopped: true },
      backups: { enabled: false, everyHours: 6 },
      gameUpdates: { ...SCHEDULE_DEFAULTS.gameUpdates, enabled: false },
      modUpdates: { ...SCHEDULE_DEFAULTS.modUpdates, enabled: false },
      ...o.schedule,
    });
    const work = (what: string, minutes: number) => async () => {
      log.push(`${at()} ${id} ${what}`);
      await new Promise((r) => setTimeout(r, minutes * MIN));
      log.push(`${at()} ${id} ${what} done`);
    };
    const restartWork = work('restart', o.restartMin ?? 3);
    agent.stop = async () => (await restartWork(), feed.status_!);
    const backups = { create: async () => ({ name: 'cold' }) } as unknown as BackupService;
    const backupWork = work('backup', o.backupMin ?? 3);
    const flows = { backupNow: async (_ctx: OpContext | null) => (await backupWork(), { name: `${id}.tar.zst` }) } as unknown as BackupFlows;
    const control = {
      server: { ref: { id } },
      countdown: async () => undefined,
      startAgent: async () => undefined,
      update: (by: string) => ops.start('update', by, work('update', 3)),
      restart: (by: string) => ops.start('restart', by, work('mods restart', 3)),
    } as unknown as Control;
    const mods = { available: false } as unknown as ModsService;
    const notifier = { notify: () => undefined } as unknown as Notify;
    const scheduler = new Scheduler({ settings, agent, feed, ops, control, flows, backups, mods, notifier, audit, gate });
    return { id, feed, ops, scheduler, settings };
  }
  return { audit, gate, hostSettings, server, log };
}

/** Advances the fake clock in steps of a second, letting promises run between them. */
async function run(minutes: number) {
  for (let i = 0; i < minutes * 60; i++) await vi.advanceTimersByTimeAsync(1000);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('job staggering (SCH-02)', () => {
  it('SCH-02: a server’s offset is a fixed function of its id, inside the spread', () => {
    // Pinned: a different hash would move every existing server's jobs after an upgrade.
    expect(staggerOffset('default', 15)).toBe(staggerOffset('default', 15));
    expect([staggerOffset('default', 15), staggerOffset('pz-two', 15), staggerOffset('mc-a', 15)]).toEqual([GOLDEN.default, GOLDEN['pz-two'], GOLDEN['mc-a']]);
    for (const id of ['a', 'b', 'c', 'srv-1', 'srv-2']) {
      expect(staggerOffset(id, 15)).toBeGreaterThanOrEqual(0);
      expect(staggerOffset(id, 15)).toBeLessThan(15);
    }
    expect(staggerOffset('default', 0)).toBe(0);
    expect(shiftTime('06:00', 7)).toBe('06:07');
    expect(shiftTime('23:55', 10)).toBe('00:05');
    // The host's settings are clamped to 0–30 minutes; anything else falls back to the defaults.
    const { gate, hostSettings } = host();
    hostSettings.setRaw(STAGGER_KEY, { gapMinutes: 99, spreadMinutes: 'x' });
    expect(gate.config()).toEqual({ gapMinutes: 30, spreadMinutes: STAGGER_DEFAULTS.spreadMinutes });
    expect(new HostJobGate({ audit: new Audit(openDb(':memory:')) }).config()).toEqual(STAGGER_DEFAULTS);
  });

  it('SCH-02: three servers whose restarts all say 06:00 run one after another, with the rest between them', async () => {
    vi.useFakeTimers({ now: T0 });
    // No spread: all three are due at the same moment, so only the queue keeps them apart.
    const h = host({ spreadMinutes: 0, gapMinutes: 2 });
    const restartsAt6 = { restarts: { enabled: true, times: ['06:00'], countdownSec: 0, backupWhileStopped: true } };
    const servers = ['srv-a', 'srv-b', 'srv-c'].map((id) => h.server(id, { schedule: restartsAt6, restartMin: 3 }));
    for (const s of servers) s.scheduler.reload();
    expect(servers.map((s) => hhmm(Date.parse(s.scheduler.nextRuns().restart!)))).toEqual(['06:00', '06:00', '06:00']);
    await run(20);
    expect(h.log).toEqual(['06:00 srv-a restart', '06:03 srv-a restart done', '06:05 srv-b restart', '06:08 srv-b restart done', '06:10 srv-c restart', '06:13 srv-c restart done']);
    // What waited is in the activity log, with why.
    const waited = h.audit.list({ action: 'schedule.waited' }).reverse();
    expect(waited.map((e) => [e.serverId, e.target])).toEqual([
      ['srv-b', 'restart'],
      ['srv-c', 'restart'],
    ]);
    expect(waited[0]!.detail).toBe('restart due at 2026-10-05T06:00:00.000Z waited 5 min for its turn (after restart on srv-a, the 2-minute rest between servers)');
    expect(waited[1]!.detail).toMatch(/^restart due at .* waited 10 min for its turn \(after restart on srv-a, restart on srv-b, the 2-minute rest/);
    expect(h.audit.list({ action: 'schedule.restart' })).toHaveLength(3);
    for (const s of servers) s.scheduler.stop();
  });

  it('SCH-02: with the spread on, the same 06:00 becomes each server’s own planned time, shown as the next run', async () => {
    vi.useFakeTimers({ now: T0 });
    const h = host({ spreadMinutes: 15, gapMinutes: 2 });
    const restartsAt6 = { restarts: { enabled: true, times: ['06:00'], countdownSec: 0, backupWhileStopped: true } };
    const ids = ['minecraft', 'pz-1', 'mc-1'];
    const servers = ids.map((id) => h.server(id, { schedule: restartsAt6, restartMin: 1 }));
    for (const s of servers) s.scheduler.reload();
    const planned = servers.map((s) => s.scheduler.nextRuns());
    expect(planned.map((n) => n.offsetMinutes)).toEqual([0, 6, 12]);
    expect(planned.map((n) => hhmm(Date.parse(n.restart!)))).toEqual(['06:00', '06:06', '06:12']);
    await run(20);
    // Each started at its own planned time: the offsets are far enough apart for a 1-minute restart and the rest.
    expect(h.log.filter((l) => l.endsWith('restart'))).toEqual(['06:00 minecraft restart', '06:06 pz-1 restart', '06:12 mc-1 restart']);
    expect(h.audit.list({ action: 'schedule.waited' })).toEqual([]);
    for (const s of servers) s.scheduler.stop();
  });

  it('SCH-02: two servers whose offsets happen to match still take turns', async () => {
    vi.useFakeTimers({ now: T0 });
    const h = host({ spreadMinutes: 15, gapMinutes: 2 });
    const restartsAt6 = { restarts: { enabled: true, times: ['06:00'], countdownSec: 0, backupWhileStopped: true } };
    // Both hash to 9 minutes.
    const servers = ['default', 'mc-a'].map((id) => h.server(id, { schedule: restartsAt6, restartMin: 1 }));
    for (const s of servers) s.scheduler.reload();
    expect(servers.map((s) => hhmm(Date.parse(s.scheduler.nextRuns().restart!)))).toEqual(['06:09', '06:09']);
    await run(20);
    expect(h.log).toEqual(['06:09 default restart', '06:10 default restart done', '06:12 mc-a restart', '06:13 mc-a restart done']);
    for (const s of servers) s.scheduler.stop();
  });

  it('SCH-02: a long backup delays the next server’s job until it ends, plus the rest', async () => {
    vi.useFakeTimers({ now: T0 });
    const h = host({ spreadMinutes: 0, gapMinutes: 2 });
    const a = h.server('srv-a', { schedule: { backups: { enabled: true, everyHours: 6 } }, backupMin: 10 });
    const b = h.server('srv-b', { schedule: { restarts: { enabled: true, times: ['06:05'], countdownSec: 0, backupWhileStopped: false } }, restartMin: 1 });
    a.scheduler.reload();
    b.scheduler.reload();
    await run(8);
    // b's restart is due at 06:05 while a's backup runs: it waits.
    expect(b.scheduler.nextRuns().waiting).toEqual([{ job: 'restart', plannedAt: expect.stringMatching(/^2026-10-05T06:05:00/) }]);
    await run(12);
    expect(h.log).toEqual(['06:00 srv-a backup', '06:10 srv-a backup done', '06:12 srv-b restart', '06:13 srv-b restart done']);
    expect(b.scheduler.nextRuns().waiting).toEqual([]);
    expect(h.audit.list({ action: 'schedule.waited' })[0]).toMatchObject({ serverId: 'srv-b', target: 'restart', detail: expect.stringContaining('waited 7 min for its turn (after backup on srv-a, the 2-minute rest') });
    a.scheduler.stop();
    b.scheduler.stop();
  });

  it('SCH-02: a panel restart keeps every server’s offset and planned times', async () => {
    vi.useFakeTimers({ now: T0 });
    const schedule = { restarts: { enabled: true, times: ['06:00', '18:30'], countdownSec: 0, backupWhileStopped: true }, backups: { enabled: true, everyHours: 6 } };
    const before = host();
    const first = ['default', 'pz-two', 'mc-a'].map((id) => before.server(id, { schedule }));
    for (const s of first) s.scheduler.reload();
    const plannedBefore = first.map((s) => s.scheduler.nextRuns());
    for (const s of first) s.scheduler.stop();
    // A new panel process: new gate, new schedulers, the same server ids.
    const after = host();
    const second = ['default', 'pz-two', 'mc-a'].map((id) => after.server(id, { schedule }));
    for (const s of second) s.scheduler.reload();
    expect(second.map((s) => s.scheduler.nextRuns())).toEqual(plannedBefore);
    expect(plannedBefore.map((n) => n.offsetMinutes)).toEqual([GOLDEN.default, GOLDEN['pz-two'], GOLDEN['mc-a']]);
    // The backup slot moves by the same offset as the restarts.
    expect(plannedBefore.map((n) => new Date(n.backup!).getUTCMinutes())).toEqual(plannedBefore.map((n) => n.offsetMinutes));
    for (const s of second) s.scheduler.stop();
  });

  it('SCH-02: a manual backup during a scheduled one starts at once; jobs that wait let both finish', async () => {
    vi.useFakeTimers({ now: T0 });
    const h = host({ spreadMinutes: 0, gapMinutes: 2 });
    const a = h.server('srv-a', { schedule: { backups: { enabled: true, everyHours: 6 } }, backupMin: 10 });
    const b = h.server('srv-b');
    const c = h.server('srv-c', { schedule: { restarts: { enabled: true, times: ['06:03'], countdownSec: 0, backupWhileStopped: false } }, restartMin: 1 });
    for (const s of [a, b, c]) s.scheduler.reload();
    await run(2);
    expect(a.ops.busy).toMatchObject({ kind: 'backup', startedBy: 'scheduler' });
    // A person backs up srv-b at 06:02: it is not held by the gate.
    b.ops.start('backup', 'alice', () => new Promise((r) => setTimeout(r, 15 * MIN)));
    expect(b.ops.busy).toMatchObject({ kind: 'backup', startedBy: 'alice' });
    // And on srv-a itself, the server's own rule still applies: one operation at a time.
    expect(() => a.ops.start('backup', 'alice', async () => undefined)).toThrow(expect.objectContaining({ statusCode: 409, code: 'busy' }));
    // srv-c's restart, due at 06:03, waits for both: srv-a's ends at 06:10, srv-b's at 06:15; then the rest.
    await run(25);
    expect(h.log).toEqual(['06:00 srv-a backup', '06:10 srv-a backup done', '06:17 srv-c restart', '06:18 srv-c restart done']);
    expect(h.audit.list({ action: 'schedule.waited' })[0]!.detail).toMatch(/waited 14 min( \d+ s)? for its turn \(after backup on srv-a, backup on srv-b, the 2-minute rest between servers\)/);
    for (const s of [a, b, c]) s.scheduler.stop();
  });

  it('SCH-02: one job of each kind waits per server; a restart that backs up stands in for its server’s backup', async () => {
    vi.useFakeTimers({ now: T0 });
    const h = host({ spreadMinutes: 0, gapMinutes: 2 });
    const a = h.server('srv-a', { schedule: { restarts: { enabled: true, times: ['06:00'], countdownSec: 0, backupWhileStopped: true } }, restartMin: 70 });
    // srv-b backs up every hour and restarts at 06:00 too: both due while srv-a's long restart runs.
    const b = h.server('srv-b', { schedule: { restarts: { enabled: true, times: ['06:00'], countdownSec: 0, backupWhileStopped: true }, backups: { enabled: true, everyHours: 1 } }, restartMin: 1 });
    a.scheduler.reload();
    b.scheduler.reload();
    await run(80);
    // 06:00: srv-b's backup is left to its restart (both named 06:00). 07:00: its backup is due again while the restart still waits.
    expect(h.audit.list({ action: 'schedule.backup' }).map((e) => e.detail)).toEqual(['skipped: the restart takes a backup', 'skipped: the restart takes a backup']);
    expect(h.log).toEqual(['06:00 srv-a restart', '07:10 srv-a restart done', '07:12 srv-b restart', '07:13 srv-b restart done']);
    a.scheduler.stop();
    b.scheduler.stop();
  });

  it('SCH-02: a waiting restart is dropped when someone runs another operation on its server meanwhile', async () => {
    vi.useFakeTimers({ now: T0 });
    const h = host({ spreadMinutes: 0, gapMinutes: 2 });
    const a = h.server('srv-a', { schedule: { backups: { enabled: true, everyHours: 6 } }, backupMin: 10 });
    const b = h.server('srv-b', { schedule: { restarts: { enabled: true, times: ['06:01'], countdownSec: 0, backupWhileStopped: true } } });
    a.scheduler.reload();
    b.scheduler.reload();
    await run(3.5);
    expect(h.gate.isWaiting('srv-b', 'restart')).toBe(true);
    b.ops.start('restart', 'alice', () => new Promise((r) => setTimeout(r, MIN)));
    await run(15);
    expect(h.log).toEqual(['06:00 srv-a backup', '06:10 srv-a backup done']);
    expect(h.audit.list({ action: 'schedule.restart' })[0]).toMatchObject({ serverId: 'srv-b', detail: 'skipped: someone ran another operation on the server while it waited' });
    a.scheduler.stop();
    b.scheduler.stop();
  });

  it('SCH-02: an update the policy applies waits its turn, and looks at the players again when it comes', async () => {
    vi.useFakeTimers({ now: T0 });
    const h = host({ spreadMinutes: 0, gapMinutes: 2 });
    const a = h.server('srv-a', { schedule: { backups: { enabled: true, everyHours: 6 } }, backupMin: 10 });
    const b = h.server('srv-b');
    a.scheduler.reload();
    b.scheduler.reload();
    await run(3);
    // srv-b's update check finds one with nobody online (the private hook the check ends in).
    const apply = (b.scheduler as unknown as { applyPolicy(p: string, w: string): void }).applyPolicy.bind(b.scheduler);
    apply('when-empty', 'update');
    expect(b.ops.busy).toBeNull();
    expect(b.scheduler.nextRuns().waiting.map((w) => w.job)).toEqual(['update']);
    // A second check while it waits doesn't queue another.
    apply('when-empty', 'update');
    expect(h.audit.list({ action: 'schedule.update' })[0]!.detail).toBe('skipped: one is already waiting for its turn');
    await run(20);
    expect(h.log).toEqual(['06:00 srv-a backup', '06:10 srv-a backup done', '06:12 srv-b update', '06:15 srv-b update done']);

    // Next time someone joins while it waits: at its turn it does nothing, and a later check tries again.
    void a.scheduler.runBackup();
    apply('when-empty', 'update');
    b.feed.status_ = fakeStatus({ state: 'running', players: { count: 1, names: ['rick'], at: '' } });
    await run(15);
    expect(h.log.filter((l) => l.includes('srv-b'))).toEqual(['06:12 srv-b update', '06:15 srv-b update done']);
    expect(b.scheduler.nextRuns().waiting).toEqual([]);
    a.scheduler.stop();
    b.scheduler.stop();
  });

  it('SCH-02: a server removed while its job waits takes the job with it', async () => {
    vi.useFakeTimers({ now: T0 });
    const h = host({ spreadMinutes: 0 });
    const a = h.server('srv-a', { schedule: { backups: { enabled: true, everyHours: 6 } }, backupMin: 10 });
    const b = h.server('srv-b', { schedule: { backups: { enabled: true, everyHours: 6 } } });
    a.scheduler.reload();
    b.scheduler.reload();
    await run(2.5);
    expect(h.gate.isWaiting('srv-b', 'backup')).toBe(true);
    b.scheduler.stop();
    expect(h.gate.isWaiting('srv-b', 'backup')).toBe(false);
    await run(15);
    expect(h.log).toEqual(['06:00 srv-a backup', '06:10 srv-a backup done']);
    a.scheduler.stop();
  });
});

describe('job staggering through the panel (SCH-02)', () => {
  it('SCH-02: every server of a panel shares one gate, shows its offset, and a manual backup isn’t held by a scheduled job', async () => {
    const p = await makePanel();
    const { client: c } = await ownerReady(p);
    expect((await c.post('/api/servers', { id: 'pz-two', name: 'Second', adapter: 'pz' })).statusCode).toBe(200);
    const two = p.deps.servers.get('pz-two')!;
    expect(two.scheduler.gate).toBe(p.srv.scheduler.gate);
    p.srv.scheduler.reload();
    two.scheduler.reload();
    const next = (await c.get('/api/servers/pz-two/schedules')).json() as { next: { offsetMinutes: number; restart: string; waiting: unknown[] } };
    expect(next.next.offsetMinutes).toBe(staggerOffset('pz-two', STAGGER_DEFAULTS.spreadMinutes));
    expect(new Date(next.next.restart).getUTCMinutes()).toBe(next.next.offsetMinutes);
    expect(next.next.waiting).toEqual([]);
    // The servers list and the dashboard show the same planned time.
    const list = (await c.get('/api/servers')).json() as { id: string; nextRestart: string }[];
    expect(list.find((s) => s.id === 'pz-two')!.nextRestart).toBe(next.next.restart);

    // A scheduled job holds the host's turn on `default`…
    let release!: () => void;
    p.srv.scheduler.gate.enqueue({ serverId: 'default', ops: p.srv.ops }, 'backup', () => ({ opId: p.srv.ops.start('backup', 'scheduler', () => new Promise<void>((r) => (release = r))).id }));
    expect(p.srv.ops.busy).toMatchObject({ kind: 'backup', startedBy: 'scheduler' });
    // …and a person's backup of pz-two starts at once.
    const r = await c.post('/api/servers/pz-two/backups');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ kind: 'backup', startedBy: 'alice' });
    await two.ops.idle();
    release();
    await p.srv.ops.idle();
    p.srv.scheduler.stop();
    two.scheduler.stop();
  });
});

/** Each id's offset with the default 15-minute spread (sha256 of the id). */
const GOLDEN: Record<string, number> = { default: 9, 'pz-two': 10, 'mc-a': 9, minecraft: 0, 'pz-1': 6, 'mc-1': 12 };
