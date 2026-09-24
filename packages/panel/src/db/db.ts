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
];

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

export function migrate(db: Db): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
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
