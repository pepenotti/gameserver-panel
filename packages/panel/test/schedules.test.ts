import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { backupPanelDb } from '../src/backups/panel-db';
import { MESSAGES, NOTIFY_EVENTS } from '../src/notifier/discord';
import { timeToCron } from '../src/scheduler/scheduler';
import type { Client } from './harness';
import { fakeStatus, friend, makePanel, ownerReady, type TestPanel } from './harness';

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123';

function fakeDiscord() {
  const posts: { url: string; body: { username?: string; embeds: { title: string; description?: string }[] } }[] = [];
  let status = 204;
  const doFetch = (async (url: string, init: { body: string }) => {
    posts.push({ url, body: JSON.parse(init.body) });
    const s = status;
    status = 204;
    return new Response(s === 429 ? JSON.stringify({ retry_after: 0.01 }) : null, { status: s });
  }) as unknown as typeof fetch;
  return { posts, doFetch, rateLimitNext: () => (status = 429) };
}

async function setup() {
  const d = fakeDiscord();
  const p = await makePanel({}, { fetch: d.doFetch });
  const { client } = await ownerReady(p);
  return { p, c: client, d };
}

async function configure(c: Client, events: Record<string, boolean> = {}) {
  const r = await c.req('PUT', '/api/notifications', { webhookUrl: HOOK, lang: 'es', events: { serverUp: true, playerJoin: true, backup: true, ...events } });
  expect(r.statusCode).toBe(200);
}

describe('Discord notifications', () => {
  it('has every message in both languages', () => {
    expect(Object.keys(MESSAGES.es).sort()).toEqual(Object.keys(MESSAGES.en).sort());
    for (const e of NOTIFY_EVENTS) expect(Object.keys(MESSAGES.en)).toContain(e);
  });

  it('accepts only Discord webhook URLs and never shows the full URL again', async () => {
    const { c } = await setup();
    expect((await c.req('PUT', '/api/notifications', { webhookUrl: 'https://evil.example/api/webhooks/1/x', lang: 'es', events: {} })).json()).toEqual({ error: 'invalid-webhook' });
    await configure(c);
    const v = (await c.get('/api/notifications')).json() as { webhookUrl: string; configured: boolean };
    expect(v.configured).toBe(true);
    expect(v.webhookUrl).not.toContain('abcdefghijklmnopqrstuvwxyz');
    // Saving other settings without a URL keeps the stored one.
    await c.req('PUT', '/api/notifications', { lang: 'en', events: {} });
    expect(((await c.get('/api/notifications')).json() as { configured: boolean }).configured).toBe(true);
  });

  it('sends server, player and backup events in the chosen language', async () => {
    const { p, c, d } = await setup();
    await configure(c);
    p.feed.emit({ type: 'state', status: fakeStatus({ state: 'starting' }) });
    p.feed.emit({ type: 'state', status: fakeStatus({ state: 'running' }) });
    p.feed.emit({ type: 'players', count: 1, names: ['rick'] });
    p.deps.bus.emit({ type: 'op', serverId: 'default', op: { id: '1', kind: 'backup', startedAt: '', startedBy: 'alice', step: 'failed', countdownEndsAt: null, cancellable: false, progress: null, done: true, ok: false, error: 'disk full' } });
    await p.deps.notifier.drain();
    expect(d.posts.map((x) => x.body.embeds[0]!.title)).toEqual(['🟢 Servidor en línea · zomboid', '➡️ Entró rick · zomboid', '⚠️ Falló la copia de seguridad · zomboid']);
    expect(d.posts[2]!.body.embeds[0]!.description).toBe('👤 alice — disk full');
    expect(d.posts[0]!.url).toBe(`${HOOK}?wait=true`);
  });

  it('respects per-event switches and retries after a rate limit', async () => {
    const { p, c, d } = await setup();
    await configure(c, { playerJoin: false });
    p.feed.emit({ type: 'players', count: 1, names: ['rick'] });
    d.rateLimitNext();
    p.feed.emit({ type: 'alert', kind: 'crash', message: 'boom' });
    await p.deps.notifier.drain();
    expect(d.posts.map((x) => x.body.embeds[0]!.title)).toEqual(['💥 Problema en el servidor · zomboid', '💥 Problema en el servidor · zomboid']);
  });

  it('has a test button', async () => {
    const { c, d } = await setup();
    expect((await c.post('/api/notifications/test')).json()).toEqual({ error: 'webhook-failed', status: 0 });
    await configure(c);
    expect((await c.post('/api/notifications/test')).json()).toEqual({ ok: true });
    expect(d.posts.at(-1)!.body.embeds[0]!.title).toBe('✅ Mensaje de prueba');
    expect(d.posts.at(-1)!.body.username).toBe('Game Server Panel');
  });
});

describe('schedules', () => {
  it('turns HH:MM into cron and validates settings', async () => {
    expect(timeToCron('06:00')).toBe('0 6 * * *');
    expect(timeToCron('23:45')).toBe('45 23 * * *');
    expect(() => timeToCron('24:00')).toThrow();
    const { c } = await setup();
    const cur = ((await c.get('/api/servers/default/schedules')).json() as { settings: Record<string, unknown> }).settings;
    const bad = await c.req('PUT', '/api/servers/default/schedules', { ...cur, timezone: 'Mars/Olympus' });
    expect(bad.json()).toMatchObject({ error: 'invalid-schedule' });
    const ok = (await c.req('PUT', '/api/servers/default/schedules', { ...cur, timezone: 'America/New_York', restarts: { enabled: true, times: ['05:30'], countdownSec: 300, backupWhileStopped: true } })).json() as { next: { restart: string; offsetMinutes: number } };
    // The time it names, moved by the server's offset (SCH-02).
    expect(new Date(ok.next.restart).getUTCMinutes()).toBe((30 + ok.next.offsetMinutes) % 60);
    // The dashboard shows the same next restart.
    expect(((await c.get('/api/servers/default/status')).json() as { nextRestart: string }).nextRestart).toBe(ok.next.restart);
  });

  it('daily restart: stops, backs up while stopped, starts again, under the agent lock', async () => {
    const { p, c } = await setup();
    const cur = ((await c.get('/api/servers/default/schedules')).json() as { settings: Record<string, unknown> }).settings;
    await c.req('PUT', '/api/servers/default/schedules', { ...cur, restarts: { enabled: true, times: ['06:00'], countdownSec: 0, backupWhileStopped: true } });
    seedWorld(p);
    p.feed.status_ = fakeStatus({ state: 'running', players: { count: 0, names: [], at: '' } });
    await p.srv.scheduler.runRestart();
    await p.srv.ops.idle();
    expect(p.agent.calls).toEqual(['stop', 'start']);
    expect(p.srv.backups.list().map((b) => b.manifest.trigger)).toEqual(['scheduled']);
    expect(((await c.get('/api/servers/default/status')).json() as { lastBackup: unknown }).lastBackup).toMatchObject({ trigger: 'scheduled', mode: 'cold' });
  });

  it('copies the panel database nightly and keeps the newest seven', async () => {
    const { p } = await setup();
    const dir = path.join(p.deps.env.backupDir, 'panel');
    for (let i = 0; i < 9; i++) backupPanelDb(p.deps.db, p.deps.env.backupDir, 7, new Date(Date.UTC(2026, 8, 1 + i, 4, 30)));
    p.deps.hostJobs.runPanelDbBackup();
    const kept = readdirSync(dir).sort();
    expect(kept).toHaveLength(7);
    expect(kept[0]).toBe('panel-20260904T043000Z.sqlite');
    // The copy is a working database with the accounts in it.
    const copy = new DatabaseSync(path.join(dir, kept.at(-1)!), { readOnly: true });
    expect(copy.prepare('SELECT username FROM users').all()).toEqual([{ username: 'alice' }]);
    copy.close();
    p.deps.hostJobs.start();
    expect(p.deps.hostJobs.nextRuns().panelDb).not.toBeNull();
    p.deps.hostJobs.stop();
  });

  it('runs the periodic backup while stopped, cold, and audits it', async () => {
    const { p } = await setup();
    seedWorld(p);
    await p.srv.scheduler.runBackup();
    await p.srv.ops.idle();
    expect(p.srv.backups.list().map((b) => [b.manifest.trigger, b.manifest.mode])).toEqual([['scheduled', 'cold']]);
    expect(p.deps.audit.list({ action: 'schedule.backup' })[0]).toMatchObject({ ok: true });
  });

  it('takes a hot copy when the periodic backup runs on a live server, saving once, in the agent', async () => {
    const { p } = await setup();
    seedWorld(p);
    p.feed.status_ = fakeStatus({ state: 'running' });
    await p.srv.scheduler.runBackup();
    await p.srv.ops.idle();
    // The agent's pack saves the world first (the adapter's hotCopy, BAK-02); the panel neither saves nor locks.
    expect(p.agent.calls).toEqual([]);
    expect(p.srv.backups.list()[0]!.manifest.mode).toBe('hot');
  });

  it('audits a periodic backup that fails', async () => {
    const { p } = await setup();
    seedWorld(p);
    p.srv.backups.create = async () => {
      throw new Error('disk full');
    };
    await p.srv.scheduler.runBackup();
    await p.srv.ops.idle();
    expect(p.deps.audit.list({ action: 'schedule.backup' })[0]).toMatchObject({ ok: false, detail: 'disk full' });
  });

  it('skips the restart when the server is stopped', async () => {
    const { p } = await setup();
    await p.srv.scheduler.runRestart();
    expect(p.agent.calls).toEqual([]);
    expect(p.deps.audit.list({ action: 'schedule.restart' })[0]!.detail).toBe('skipped: server not running');
  });

  it('applies a game update when nobody is playing, waits when someone is', async () => {
    const { p } = await setup();
    p.agent.versions = async () => ({ installed: { version: '42.20.4', channel: 'public', build: '100' }, versions: [{ id: 'public', build: '200' }] });
    p.feed.status_ = fakeStatus({ state: 'running', players: { count: 2, names: ['a', 'b'], at: '' } });
    await p.srv.scheduler.checkGameUpdate();
    expect(p.srv.ops.busy).toBeNull();
    p.feed.status_ = fakeStatus({ state: 'running', players: { count: 0, names: [], at: '' } });
    await p.srv.scheduler.checkGameUpdate();
    expect(p.srv.ops.busy).toMatchObject({ kind: 'update', startedBy: 'scheduler' });
    await p.srv.ops.idle();
    expect(p.agent.calls).toEqual(['stop', 'install', 'start']);
  });
});

function seedWorld(p: TestPanel) {
  const w = path.join(p.deps.env.pzDataDir, 'Saves', 'Multiplayer', 'zomboid');
  mkdirSync(w, { recursive: true });
  writeFileSync(path.join(w, 'map_t.bin'), 'x');
}

const HOOK2 = 'https://discord.com/api/webhooks/987654321098765432/ZYXWVUTSRQPONMLKJIHGFEDCBA_zyxwv-987';

describe('per server (M2): schedules, operations and Discord (SCH-01, SCH-03, SRV-07)', () => {
  /** default plus `pz-two`, the host webhook set, and pz-two's fakes. */
  async function withTwo() {
    const s = await setup();
    await configure(s.c);
    expect((await s.c.post('/api/servers', { id: 'pz-two', name: 'Second', adapter: 'pz' })).statusCode).toBe(200);
    return { ...s, two: s.p.deps.servers.get('pz-two')!, fakes: s.p.fakes('pz-two') };
  }

  it('keeps each server’s schedules and timers apart', async () => {
    const { p, c, two } = await withTwo();
    const cur = ((await c.get('/api/servers/pz-two/schedules')).json() as { settings: Record<string, unknown> }).settings;
    await c.req('PUT', '/api/servers/pz-two/schedules', { ...cur, restarts: { enabled: true, times: ['03:15'], countdownSec: 0, backupWhileStopped: true }, backups: { enabled: false, everyHours: 6 } });
    expect(two.scheduler.config().restarts.times).toEqual(['03:15']);
    expect(p.srv.scheduler.config().restarts.times).toEqual(['06:00']);
    expect(p.srv.scheduler.config().backups.enabled).toBe(true);
    two.scheduler.reload();
    p.srv.scheduler.reload();
    expect(new Date(two.scheduler.nextRuns().restart!).getUTCMinutes()).toBe(15 + two.scheduler.nextRuns().offsetMinutes);
    expect(two.scheduler.nextRuns().backup).toBeNull();
    expect(p.srv.scheduler.nextRuns().backup).not.toBeNull();
    two.scheduler.stop();
    p.srv.scheduler.stop();
    expect(p.deps.audit.list({ action: 'schedules.update' })[0]).toMatchObject({ serverId: 'pz-two' });
  });

  it('runs a scheduled job on its own server only, alongside the other’s operation', async () => {
    const { p, two, fakes } = await withTwo();
    const world = path.join(fakes.dataDir, 'Saves', 'Multiplayer', 'pz-two');
    mkdirSync(world, { recursive: true });
    writeFileSync(path.join(world, 'map_t.bin'), 'x');
    // default is busy with something long; pz-two's backup doesn't wait for it.
    let release!: () => void;
    p.srv.ops.start('restore', 'alice', () => new Promise<void>((r) => (release = r)));
    await two.scheduler.runBackup();
    await two.ops.idle();
    expect(two.backups.list().map((b) => b.manifest.trigger)).toEqual(['scheduled']);
    expect(two.backups.dir).toBe(path.join(p.deps.env.backupDir, 'pz-two'));
    expect(p.srv.backups.list()).toEqual([]);
    expect(p.deps.audit.list({ action: 'schedule.backup' })[0]).toMatchObject({ serverId: 'pz-two', actorType: 'schedule', ok: true });
    expect(p.agent.calls).toEqual([]);
    release();
    await p.srv.ops.idle();
  });

  it('names the server in every message, and follows each server’s own webhook, language and switches', async () => {
    const { p, c, d, fakes } = await withTwo();
    // A crash (the watchdog's alert, SRV-07) and a join on each server.
    p.feed.emit({ type: 'alert', kind: 'crash', message: 'boom' });
    fakes.feed.emit({ type: 'alert', kind: 'crash', message: 'bang' });
    await p.deps.notifier.drain();
    expect(d.posts.map((x) => [x.url, x.body.embeds[0]!.title, x.body.embeds[0]!.description])).toEqual([
      [`${HOOK}?wait=true`, '💥 Problema en el servidor · zomboid', 'boom'],
      [`${HOOK}?wait=true`, '💥 Problema en el servidor · Second', 'bang'],
    ]);

    const bad = await c.req('PUT', '/api/servers/pz-two/notifications', { webhookUrl: 'https://evil.example/api/webhooks/1/x', lang: null, events: {} });
    expect(bad.json()).toEqual({ error: 'invalid-webhook' });
    const saved = (await c.req('PUT', '/api/servers/pz-two/notifications', { webhookUrl: HOOK2, lang: 'en', events: { playerJoin: false } })).json() as {
      override: { webhookUrl: string; lang: string };
      effective: { configured: boolean; lang: string; events: Record<string, boolean> };
    };
    expect(saved.override.webhookUrl).not.toContain('ZYXWVUTSRQ');
    expect(saved.effective).toMatchObject({ configured: true, lang: 'en', events: expect.objectContaining({ playerJoin: false, crash: true }) });
    d.posts.length = 0;
    fakes.feed.emit({ type: 'alert', kind: 'crash', message: 'again' });
    fakes.feed.emit({ type: 'players', count: 1, names: ['rick'] });
    p.feed.emit({ type: 'players', count: 1, names: ['rick'] });
    await p.deps.notifier.drain();
    expect(d.posts.map((x) => [x.url, x.body.embeds[0]!.title])).toEqual([
      [`${HOOK2}?wait=true`, '💥 Server problem · Second'],
      [`${HOOK}?wait=true`, '➡️ Entró rick · zomboid'],
    ]);
    expect((await c.post('/api/servers/pz-two/notifications/test')).json()).toEqual({ ok: true });
    expect(d.posts.at(-1)).toMatchObject({ url: `${HOOK2}?wait=true`, body: { embeds: [{ title: '✅ Test message · Second' }] } });

    // Saving without a URL keeps it; null goes back to the host's webhook.
    await c.req('PUT', '/api/servers/pz-two/notifications', { lang: 'en', events: {} });
    expect(((await c.get('/api/servers/pz-two/notifications')).json() as { override: { webhookUrl: string | null } }).override.webhookUrl).not.toBeNull();
    await c.req('PUT', '/api/servers/pz-two/notifications', { webhookUrl: null, lang: null, events: {} });
    expect((await c.get('/api/servers/pz-two/notifications')).json()).toMatchObject({ override: { webhookUrl: null, lang: null, events: {} }, effective: { lang: 'es' } });
    expect(p.deps.audit.list({ action: 'notifications.update' })[0]).toMatchObject({ serverId: 'pz-two' });
  });

  it('lets an admin of one server set that server’s override, and nothing else', async () => {
    const { p, c } = await withTwo();
    const adm = await friend(p, c, 'two-admin', 'admin', { 'pz-two': 'admin' });
    expect((await adm.req('PUT', '/api/servers/pz-two/notifications', { webhookUrl: HOOK2, lang: 'en', events: {} })).statusCode).toBe(200);
    expect((await adm.req('PUT', '/api/servers/default/notifications', { webhookUrl: HOOK2, lang: 'en', events: {} })).json()).toEqual({ error: 'server-not-found' });
    expect((await adm.req('PUT', '/api/notifications', { lang: 'en', events: {} })).json()).toEqual({ error: 'forbidden' });
    const op = await friend(p, c, 'two-op', 'operator', { 'pz-two': 'operator' });
    expect((await op.get('/api/servers/pz-two/notifications')).json()).toEqual({ error: 'forbidden' });
  });
});
