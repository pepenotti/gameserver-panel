import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Ordered schema migrations; `PRAGMA user_version` records how many ran.
 * Never edit a released migration — append a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer','operator','admin','owner')),
    lang TEXT NOT NULL DEFAULT 'es' CHECK (lang IN ('en','es')),
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE UNIQUE INDEX one_owner ON users(role) WHERE role = 'owner';

  CREATE TABLE recovery_codes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at TEXT,
    PRIMARY KEY (user_id, code_hash)
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    mfa_ok INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    ip TEXT,
    ok INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX audit_at ON audit(at);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE config_versions (
    id INTEGER PRIMARY KEY,
    file TEXT NOT NULL,
    at TEXT NOT NULL,
    username TEXT,
    note TEXT,
    content TEXT NOT NULL
  );
  CREATE INDEX config_versions_file ON config_versions(file, id);
  `,
  `
  CREATE TABLE player_sessions (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    left_at TEXT
  );
  CREATE INDEX player_sessions_open ON player_sessions(left_at);
  CREATE INDEX player_sessions_user ON player_sessions(username, id);
  `,
  `
  CREATE TABLE mods (
    workshop_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    preview_url TEXT,
    time_updated INTEGER NOT NULL DEFAULT 0,
    scanned_updated INTEGER NOT NULL DEFAULT 0,
    info TEXT NOT NULL DEFAULT '[]',
    added_at TEXT NOT NULL,
    added_by TEXT,
    last_checked TEXT,
    error TEXT
  );
  `,
  // Change proposals (AST-03, CFG-07): submitted, shown as a diff, applied once approved.
  `
  CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    server_id TEXT,
    file_id TEXT NOT NULL,
    base_sha256 TEXT NOT NULL,
    content TEXT NOT NULL,
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    actor_type TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL CHECK (status IN ('pending','applied','rejected','stale','expired')),
    decided_by TEXT,
    decided_at TEXT,
    result TEXT
  );
  CREATE INDEX proposals_status ON proposals(status, created_at);
  CREATE INDEX proposals_file ON proposals(file_id, status);
  `,
  // Several servers (M2, G1, D3). Everything the panel stored for its one
  // server becomes server `default`'s; its `servers` row is written at boot
  // from the environment that describes it (servers/store.ts).
  `
  CREATE TABLE servers (
    id TEXT PRIMARY KEY CHECK (id GLOB '[a-z]*' AND length(id) BETWEEN 2 AND 24 AND id NOT GLOB '*[^a-z0-9-]*'),
    name TEXT NOT NULL,
    adapter TEXT NOT NULL,
    flavour TEXT,
    game_name TEXT NOT NULL,
    version_pin TEXT,
    ports TEXT NOT NULL,
    mem_limit_mb INTEGER NOT NULL,
    cpus REAL,
    secrets TEXT NOT NULL DEFAULT '{}',
    spec TEXT,
    eula_accepted_at TEXT,
    eula_accepted_by INTEGER,
    created_at TEXT NOT NULL,
    created_by INTEGER,
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE server_grants (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('viewer','operator','admin')),
    PRIMARY KEY (user_id, server_id)
  );
  CREATE INDEX server_grants_server ON server_grants(server_id);

  ALTER TABLE users ADD COLUMN scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all','granted'));

  CREATE TABLE server_settings (
    server_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (server_id, key)
  );
  INSERT INTO server_settings (server_id, key, value, updated_at)
    SELECT 'default', key, value, updated_at FROM settings
    WHERE key IN ('launch', 'pendingRestart', 'lastRestore', 'mods.enabled', 'mods.imported', 'schedules');
  DELETE FROM settings WHERE key IN ('launch', 'pendingRestart', 'lastRestore', 'mods.enabled', 'mods.imported', 'schedules');

  ALTER TABLE audit ADD COLUMN server_id TEXT;
  ALTER TABLE audit ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','schedule','recovery','assistant','system'));
  ALTER TABLE audit ADD COLUMN on_behalf_of INTEGER;
  UPDATE audit SET actor_type = CASE
    WHEN action LIKE 'cli.%' THEN 'recovery'
    WHEN action LIKE 'schedule.%' THEN 'schedule'
    WHEN action LIKE 'security.%' THEN 'system'
    ELSE 'user' END;
  UPDATE audit SET server_id = 'default'
    WHERE action GLOB 'server.*' OR action GLOB 'backup.*' OR action GLOB 'config.*' OR action GLOB 'mods.*'
       OR action GLOB 'player.*' OR action GLOB 'reset.*' OR action = 'schedules.update'
       OR (action GLOB 'schedule.*' AND action != 'schedule.panelDb');
  CREATE INDEX audit_server ON audit(server_id, id);

  ALTER TABLE config_versions ADD COLUMN server_id TEXT NOT NULL DEFAULT 'default';
  DROP INDEX config_versions_file;
  CREATE INDEX config_versions_file ON config_versions(server_id, file, id);

  ALTER TABLE player_sessions ADD COLUMN server_id TEXT NOT NULL DEFAULT 'default';
  DROP INDEX player_sessions_open;
  DROP INDEX player_sessions_user;
  CREATE INDEX player_sessions_open ON player_sessions(server_id, left_at);
  CREATE INDEX player_sessions_user ON player_sessions(server_id, username, id);

  -- proposals had a nullable server_id: rebuilt with it required.
  CREATE TABLE proposals_new (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL DEFAULT 'default',
    file_id TEXT NOT NULL,
    base_sha256 TEXT NOT NULL,
    content TEXT NOT NULL,
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    actor_type TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL CHECK (status IN ('pending','applied','rejected','stale','expired')),
    decided_by TEXT,
    decided_at TEXT,
    result TEXT
  );
  INSERT INTO proposals_new (id, server_id, file_id, base_sha256, content, note, created_by, created_at, actor_type, status, decided_by, decided_at, result)
    SELECT id, COALESCE(server_id, 'default'), file_id, base_sha256, content, note, created_by, created_at, actor_type, status, decided_by, decided_at, result FROM proposals;
  DROP TABLE proposals;
  ALTER TABLE proposals_new RENAME TO proposals;
  CREATE INDEX proposals_status ON proposals(server_id, status, created_at);
  CREATE INDEX proposals_file ON proposals(server_id, file_id, status);

  -- Mods per server and per mod source; today's were all Steam Workshop items.
  CREATE TABLE server_mods (
    server_id TEXT NOT NULL,
    source TEXT NOT NULL,
    item_id TEXT NOT NULL,
    title TEXT NOT NULL,
    preview_url TEXT,
    time_updated INTEGER NOT NULL DEFAULT 0,
    scanned_updated INTEGER NOT NULL DEFAULT 0,
    info TEXT NOT NULL DEFAULT '[]',
    added_at TEXT NOT NULL,
    added_by TEXT,
    last_checked TEXT,
    error TEXT,
    PRIMARY KEY (server_id, source, item_id)
  );
  INSERT INTO server_mods (server_id, source, item_id, title, preview_url, time_updated, scanned_updated, info, added_at, added_by, last_checked, error)
    SELECT 'default', 'steam-workshop', workshop_id, title, preview_url, time_updated, scanned_updated, info, added_at, added_by, last_checked, error FROM mods;
  DROP TABLE mods;
  `,
];

/** Settings keys that belong to one server (`server_settings`); every other key is the host's (`settings`). */
export const SERVER_SETTING_KEYS = ['launch', 'pendingRestart', 'lastRestore', 'mods.enabled', 'mods.imported', 'schedules', 'discord.override', 'config.panelEdits'] as const;

/** How many migrations exist: the database's `user_version` once it is up to date. */
export const SCHEMA_VERSION = MIGRATIONS.length;

export type Db = DatabaseSync;

export function openDb(dataDir: string | ':memory:'): Db {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    file = path.join(dataDir, 'panel.db');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

/** Runs the migrations not run yet, up to `target` (default: all; tests stop earlier to build old databases). */
export function migrate(db: Db, target = MIGRATIONS.length): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = current; v < Math.min(target, MIGRATIONS.length); v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Run `fn` in a transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
