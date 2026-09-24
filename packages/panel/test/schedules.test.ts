import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { backupPanelDb } from '../src/backups/panel-db';
import { MESSAGES, NOTIFY_EVENTS } from '../src/notifier/discord';
import { timeToCron } from '../src/scheduler/scheduler';
import type { Client } from './harness';
import { fakeStatus, makePanel, ownerReady, type TestPanel } from './harness';

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123';

function fakeDiscord() {
  const posts: { url: string; body: { embeds: { title: string; description?: string }[] } }[] = [];
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
    p.deps.bus.emit({ type: 'op', op: { id: '1', kind: 'backup', startedAt: '', startedBy: 'alice', step: 'failed', countdownEndsAt: null, cancellable: false, progress: null, done: true, ok: false, error: 'disk full' } });
    await p.deps.notifier.drain();
    expect(d.posts.map((x) => x.body.embeds[0]!.title)).toEqual(['🟢 Servidor en línea', '➡️ Entró rick', '⚠️ Falló la copia de seguridad']);
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
    expect(d.posts.map((x) => x.body.embeds[0]!.title)).toEqual(['💥 Problema en el servidor', '💥 Problema en el servidor']);
  });

  it('has a test button', async () => {
    const { c, d } = await setup();
    expect((await c.post('/api/notifications/test')).json()).toEqual({ error: 'webhook-failed', status: 0 });
    await configure(c);
    expect((await c.post('/api/notifications/test')).json()).toEqual({ ok: true });
    expect(d.posts.at(-1)!.body.embeds[0]!.title).toBe('✅ Mensaje de prueba');
  });
});

describe('schedules', () => {
  it('turns HH:MM into cron and validates settings', async () => {
    expect(timeToCron('06:00')).toBe('0 6 * * *');
    expect(timeToCron('23:45')).toBe('45 23 * * *');
    expect(() => timeToCron('24:00')).toThrow();
    const { c } = await setup();
    const cur = ((await c.get('/api/schedules')).json() as { settings: Record<string, unknown> }).settings;
    const bad = await c.req('PUT', '/api/schedules', { ...cur, timezone: 'Mars/Olympus' });
    expect(bad.json()).toMatchObject({ error: 'invalid-schedule' });
    const ok = (await c.req('PUT', '/api/schedules', { ...cur, timezone: 'America/New_York', restarts: { enabled: true, times: ['05:30'], countdownSec: 300, backupWhileStopped: true } })).json() as { next: { restart: string } };
    expect(new Date(ok.next.restart).getUTCMinutes()).toBe(30);
    // The dashboard shows the same next restart.
    expect(((await c.get('/api/status')).json() as { nextRestart: string }).nextRestart).toBe(ok.next.restart);
  });

  it('daily restart: stops, backs up while stopped, starts again, under the agent lock', async () => {
    const { p, c } = await setup();
    const cur = ((await c.get('/api/schedules')).json() as { settings: Record<string, unknown> }).settings;
    await c.req('PUT', '/api/schedules', { ...cur, restarts: { enabled: true, times: ['06:00'], countdownSec: 0, backupWhileStopped: true } });
    seedWorld(p);
    p.feed.status_ = fakeStatus({ state: 'running', players: { count: 0, names: [], at: '' } });
    await p.deps.scheduler.runRestart();
    await p.deps.ops.idle();
    expect(p.agent.calls).toEqual(['stop', 'start']);
    expect(p.deps.backups.list().map((b) => b.manifest.trigger)).toEqual(['scheduled']);
    expect(((await c.get('/api/status')).json() as { lastBackup: unknown }).lastBackup).toMatchObject({ trigger: 'scheduled', mode: 'cold' });
  });

  it('copies the panel database nightly and keeps the newest seven', async () => {
    const { p } = await setup();
    const dir = path.join(p.deps.env.backupDir, 'panel');
    for (let i = 0; i < 9; i++) backupPanelDb(p.deps.db, p.deps.env.backupDir, 7, new Date(Date.UTC(2026, 8, 1 + i, 4, 30)));
    p.deps.scheduler.runPanelDbBackup();
    const kept = readdirSync(dir).sort();
    expect(kept).toHaveLength(7);
    expect(kept[0]).toBe('panel-20260904T043000Z.sqlite');
    // The copy is a working database with the accounts in it.
    const copy = new DatabaseSync(path.join(dir, kept.at(-1)!), { readOnly: true });
    expect(copy.prepare('SELECT username FROM users').all()).toEqual([{ username: 'alice' }]);
    copy.close();
    p.deps.scheduler.reload();
    expect(p.deps.scheduler.nextRuns().panelDb).not.toBeNull();
    p.deps.scheduler.stop();
  });

  it('runs the periodic backup while stopped, cold, and audits it', async () => {
    const { p } = await setup();
    seedWorld(p);
    await p.deps.scheduler.runBackup();
    await p.deps.ops.idle();
    expect(p.deps.backups.list().map((b) => [b.manifest.trigger, b.manifest.mode])).toEqual([['scheduled', 'cold']]);
    expect(p.deps.audit.list({ action: 'schedule.backup' })[0]).toMatchObject({ ok: true });
  });

  it('saves the world first when the periodic backup runs on a live server', async () => {
    const { p } = await setup();
    seedWorld(p);
    p.feed.status_ = fakeStatus({ state: 'running' });
    p.agent.command = async (cmd) => {
      p.agent.calls.push(`command:${cmd}`);
      p.feed.emit({ type: 'log', stream: 'out', line: 'LOG  : General      f:0 st:1> Saving finish' });
      return { via: 'rcon', output: 'World saved' };
    };
    await p.deps.scheduler.runBackup();
    await p.deps.ops.idle();
    expect(p.agent.calls).toContain('command:save');
    expect(p.deps.backups.list()[0]!.manifest.mode).toBe('hot');
  });

  it('audits a periodic backup that fails', async () => {
    const { p } = await setup();
    seedWorld(p);
    p.deps.backups.create = async () => {
      throw new Error('disk full');
    };
    await p.deps.scheduler.runBackup();
    await p.deps.ops.idle();
    expect(p.deps.audit.list({ action: 'schedule.backup' })[0]).toMatchObject({ ok: false, detail: 'disk full' });
  });

  it('skips the restart when the server is stopped', async () => {
    const { p } = await setup();
    await p.deps.scheduler.runRestart();
    expect(p.agent.calls).toEqual([]);
    expect(p.deps.audit.list({ action: 'schedule.restart' })[0]!.detail).toBe('skipped: server not running');
  });

  it('applies a game update when nobody is playing, waits when someone is', async () => {
    const { p } = await setup();
    p.agent.appInfo = async () => ({ installed: { buildId: '100', branch: 'public' }, branches: [{ name: 'public', buildId: '200', passwordRequired: false }] });
    p.feed.status_ = fakeStatus({ state: 'running', players: { count: 2, names: ['a', 'b'], at: '' } });
    await p.deps.scheduler.checkGameUpdate();
    expect(p.deps.ops.busy).toBeNull();
    p.feed.status_ = fakeStatus({ state: 'running', players: { count: 0, names: [], at: '' } });
    await p.deps.scheduler.checkGameUpdate();
    expect(p.deps.ops.busy).toMatchObject({ kind: 'update', startedBy: 'scheduler' });
    await p.deps.ops.idle();
    expect(p.agent.calls).toEqual(['stop', 'install', 'start']);
  });
});

function seedWorld(p: TestPanel) {
  const w = path.join(p.deps.env.pzDataDir, 'Saves', 'Multiplayer', 'zomboid');
  mkdirSync(w, { recursive: true });
  writeFileSync(path.join(w, 'map_t.bin'), 'x');
}
