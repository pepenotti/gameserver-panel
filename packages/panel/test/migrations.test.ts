// Migration 6 (M2): an install from before several servers keeps everything
// it had, now as server `default`, and the new tables hold their rules.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { isServerId } from '@gsp/shared';
import { migrate, SCHEMA_VERSION, SERVER_SETTING_KEYS, type Db } from '../src/db/db';
import { ServerGrants } from '../src/auth/grants';
import { DEFAULT_SERVER_ID, ServersStore } from '../src/servers/store';
import { makePanel } from './harness';

const T = '2026-09-01T10:00:00.000Z';

/** A database as the panel left it at migration 5, with something in every table migration 6 touches. */
function panelDbAt5(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, 5);
  expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(5);
  const user = db.prepare('INSERT INTO users (username, password_hash, role, lang, must_change_password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)');
  user.run('alice', 'scrypt$x', 'owner', 'es', 0, T, T);
  user.run('glenn', 'scrypt$y', 'admin', 'en', 0, T, T);
  db.prepare('INSERT INTO sessions (id_hash, user_id, csrf, mfa_ok, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?,?)').run('h1', 1, 'c', 1, 1, 1, Date.now() + 60_000);
  db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)').run(1, 'rc1');
  const setting = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  setting.run('launch', JSON.stringify({ memoryMb: 6144, branch: 'public', updateOnStart: false }), T);
  setting.run('schedules', JSON.stringify({ restarts: { enabled: false, times: ['05:30'], countdownSec: 300, backupWhileStopped: true } }), T);
  setting.run('discord', JSON.stringify({ webhookUrl: 'https://discord.com/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz', lang: 'en', events: {} }), T);
  setting.run('mods.enabled', JSON.stringify([{ modId: 'Hydrocraft', workshopId: '2544353492' }]), T);
  setting.run('mods.imported', 'true', T);
  setting.run('pendingRestart', JSON.stringify({ since: T, reasons: ['Mods'] }), T);
  setting.run('lastRestore', JSON.stringify({ id: 'r1', backup: 'b', parts: ['world'], at: T, trash: null }), T);
  const audit = db.prepare('INSERT INTO audit (at, user_id, username, action, target, detail, ip, ok) VALUES (?,?,?,?,?,?,?,?)');
  audit.run(T, 1, 'alice', 'server.start', null, null, '10.0.0.1', 1);
  audit.run(T, null, null, 'cli.reset-2fa', 'glenn', null, null, 1);
  audit.run(T, null, null, 'schedule.backup', null, 'x.tar.zst', null, 1);
  audit.run(T, null, null, 'schedule.panelDb', null, 'panel.sqlite', null, 1);
  audit.run(T, null, null, 'security.login-spike', null, null, null, 0);
  audit.run(T, 2, 'glenn', 'auth.login', null, null, '10.0.0.2', 1);
  audit.run(T, 2, 'glenn', 'user.create', 'rick', null, '10.0.0.2', 1);
  db.prepare('INSERT INTO config_versions (file, at, username, note, content) VALUES (?,?,?,?,?)').run('ini', T, 'alice', 'raw edit', 'PVP=true\n');
  db.prepare('INSERT INTO player_sessions (username, joined_at, left_at) VALUES (?,?,?)').run('rick', T, T);
  const mod = db.prepare('INSERT INTO mods (workshop_id, title, time_updated, scanned_updated, info, added_at, added_by) VALUES (?,?,?,?,?,?,?)');
  mod.run('2544353492', 'Hydrocraft', 100, 100, JSON.stringify([{ modId: 'Hydrocraft', name: 'Hydrocraft', require: [], incompatible: [], compatible: true, reason: null }]), T, 'alice');
  mod.run('2169435993', 'Brita', 50, 0, '[]', T, null);
  db.prepare('INSERT INTO proposals (id, server_id, file_id, base_sha256, content, created_by, created_at, status) VALUES (?,?,?,?,?,?,?,?)').run(
    '00000000-0000-4000-8000-000000000001',
    null,
    'ini',
    'a'.repeat(64),
    'PVP=false\n',
    'alice',
    // Pending ones expire after a week.
    new Date().toISOString(),
    'pending',
  );
  return db;
}

const rows = (db: Db, sql: string, ...args: (string | number | null)[]) => db.prepare(sql).all(...args) as Record<string, unknown>[];

describe('migration 6 (several servers)', () => {
  it('keeps every account, session and recovery code, all with scope all', () => {
    const db = panelDbAt5();
    migrate(db);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(6);
    expect(rows(db, 'SELECT username, role, scope FROM users ORDER BY id')).toEqual([
      { username: 'alice', role: 'owner', scope: 'all' },
      { username: 'glenn', role: 'admin', scope: 'all' },
    ]);
    expect(rows(db, 'SELECT COUNT(*) AS n FROM sessions')).toEqual([{ n: 1 }]);
    expect(rows(db, 'SELECT COUNT(*) AS n FROM recovery_codes')).toEqual([{ n: 1 }]);
    expect(() => db.prepare("UPDATE users SET scope = 'some' WHERE id = 2").run()).toThrow(/CHECK/);
  });

  it("moves the server's settings to server_settings as default's, and leaves the host's", () => {
    const db = panelDbAt5();
    migrate(db);
    expect(rows(db, 'SELECT key FROM settings ORDER BY key')).toEqual([{ key: 'discord' }]);
    const moved = rows(db, "SELECT key FROM server_settings WHERE server_id = 'default' ORDER BY key").map((r) => r.key);
    expect(moved).toEqual(['lastRestore', 'launch', 'mods.enabled', 'mods.imported', 'pendingRestart', 'schedules']);
    for (const k of moved) expect(SERVER_SETTING_KEYS).toContain(k);
    expect(rows(db, "SELECT value FROM server_settings WHERE key = 'launch'")).toEqual([{ value: JSON.stringify({ memoryMb: 6144, branch: 'public', updateOnStart: false }) }]);
  });

  it('tells who acted and on which server in the old audit entries', () => {
    const db = panelDbAt5();
    migrate(db);
    expect(rows(db, 'SELECT action, actor_type, server_id FROM audit ORDER BY id')).toEqual([
      { action: 'server.start', actor_type: 'user', server_id: 'default' },
      { action: 'cli.reset-2fa', actor_type: 'recovery', server_id: null },
      { action: 'schedule.backup', actor_type: 'schedule', server_id: 'default' },
      { action: 'schedule.panelDb', actor_type: 'schedule', server_id: null },
      { action: 'security.login-spike', actor_type: 'system', server_id: null },
      { action: 'auth.login', actor_type: 'user', server_id: null },
      { action: 'user.create', actor_type: 'user', server_id: null },
    ]);
    expect(() => db.prepare("INSERT INTO audit (at, action, actor_type) VALUES ('x', 'y', 'robot')").run()).toThrow(/CHECK/);
  });

  it('gives history, player sessions, proposals and mods to default', () => {
    const db = panelDbAt5();
    migrate(db);
    expect(rows(db, 'SELECT server_id, file, content FROM config_versions')).toEqual([{ server_id: 'default', file: 'ini', content: 'PVP=true\n' }]);
    expect(rows(db, 'SELECT server_id, username FROM player_sessions')).toEqual([{ server_id: 'default', username: 'rick' }]);
    expect(rows(db, 'SELECT server_id, file_id, status FROM proposals')).toEqual([{ server_id: 'default', file_id: 'ini', status: 'pending' }]);
    expect(() => db.prepare("INSERT INTO proposals (id, server_id, file_id, base_sha256, content, created_at, status) VALUES ('p', NULL, 'ini', 'x', 'y', 'z', 'pending')").run()).toThrow(/NOT NULL/);
    expect(rows(db, 'SELECT server_id, source, item_id, title, scanned_updated, added_by FROM server_mods ORDER BY item_id')).toEqual([
      { server_id: 'default', source: 'steam-workshop', item_id: '2169435993', title: 'Brita', scanned_updated: 0, added_by: null },
      { server_id: 'default', source: 'steam-workshop', item_id: '2544353492', title: 'Hydrocraft', scanned_updated: 100, added_by: 'alice' },
    ]);
    expect(rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mods'")).toEqual([]);
  });

  it('holds server ids to the orchestrator contract, and drops grants with their user or server', () => {
    const db = panelDbAt5();
    migrate(db);
    const store = new ServersStore(db);
    const base = { name: 'x', adapter: 'pz', flavour: null, gameName: 'x', versionPin: null, ports: {}, memLimitMb: 1024, cpus: null, createdBy: null };
    for (const id of ['A1', 'a', '1a', 'a_b', 'a.b', 'a'.repeat(25), 'ab/']) {
      expect(isServerId(id)).toBe(false);
      // The database refuses them even without the store's check.
      expect(() => db.prepare("INSERT INTO servers (id, name, adapter, game_name, ports, mem_limit_mb, created_at) VALUES (?, 'x', 'pz', 'x', '{}', 1, 'now')").run(id), id).toThrow(/CHECK/);
    }
    store.insert({ ...base, id: 'pz-2' }, { agentToken: 't'.repeat(40) });
    expect(store.get('pz-2')).toMatchObject({ id: 'pz-2', ports: {}, spec: null });
    expect(JSON.stringify(store.list())).not.toContain('agentToken');
    expect(store.secrets('pz-2')).toEqual({ agentToken: 't'.repeat(40) });

    const grants = new ServerGrants(db);
    grants.set(2, 'pz-2', 'operator');
    expect(grants.forUser(2)).toEqual([{ serverId: 'pz-2', role: 'operator' }]);
    expect(() => grants.set(2, 'missing', 'viewer')).toThrow(/FOREIGN KEY/);
    store.delete('pz-2');
    expect(grants.forUser(2)).toEqual([]);
    grants.set(2, (store.insert({ ...base, id: 'pz-3' }), 'pz-3'), 'admin');
    db.prepare('DELETE FROM users WHERE id = 2').run();
    expect(grants.forServer('pz-3')).toEqual([]);
  });

  it('runs the panel on the migrated data as server default', async () => {
    const db = panelDbAt5();
    migrate(db);
    const p = await makePanel({ ports: { udp: 30162 } }, { db });
    // The row the environment describes: ports from GAME_PORT_*, memory from the stored launch settings plus the adapter's overhead.
    expect(new ServersStore(db).list()).toEqual([
      expect.objectContaining({ id: DEFAULT_SERVER_ID, name: 'zomboid', adapter: 'pz', gameName: 'zomboid', ports: { game: 16261, udp: 30162 }, memLimitMb: 6144 + 3072, spec: null }),
    ]);
    expect(new ServersStore(db).secrets(DEFAULT_SERVER_ID)).toEqual({});
    expect(p.deps.server.launchSettings()).toEqual({ memoryMb: 6144, branch: 'public', updateOnStart: false });
    expect(p.deps.scheduler.config().restarts).toMatchObject({ enabled: false, times: ['05:30'] });
    expect(p.deps.notifier.config().webhookUrl).toMatch(/^https:\/\/discord\.com\//);
    expect(p.deps.mods.enabled()).toEqual([{ modId: 'Hydrocraft', workshopId: '2544353492' }]);
    expect(p.deps.mods.itemIds().sort()).toEqual(['2169435993', '2544353492']);
    expect(p.deps.config.historyOf('ini').map((v) => v.note)).toEqual(['raw edit']);
    expect(p.deps.changes.list({ status: 'pending' }).map((x) => x.serverId)).toEqual(['default']);
    expect(p.deps.flows.lastRestore()).toMatchObject({ id: 'r1', backup: 'b' });
    // Booting again adds nothing.
    await makePanel({}, { db });
    expect(new ServersStore(db).count()).toBe(1);
  });
});
