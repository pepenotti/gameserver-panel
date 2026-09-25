import { nowIso, type Db } from './db/db';

/** JSON values by key: the host's settings, or one server's. */
export interface KeyValueSettings {
  /** Untyped JSON value (null when unset). */
  getRaw<T>(key: string): T | null;
  setRaw<T>(key: string, value: T | null): void;
}

/**
 * The host's settings (table `settings`): what isn't about one server, such
 * as the Discord webhook. Each server's own keys live in `ServerSettings`.
 */
export class Settings implements KeyValueSettings {
  constructor(private readonly db: Db) {}

  getRaw<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T | null) : null;
  }

  setRaw<T>(key: string, value: T | null): void {
    this.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), nowIso());
  }
}

/**
 * One server's settings (table `server_settings`), stored as JSON per key:
 * its launch settings (`launch`, the adapter's shape, which `ServerHandle`
 * reads over the adapter's defaults), schedules, the mod list, the
 * pending-restart badge, the last restore. `SERVER_SETTING_KEYS` lists them.
 */
export class ServerSettings implements KeyValueSettings {
  constructor(
    private readonly db: Db,
    readonly serverId: string,
  ) {}

  getRaw<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM server_settings WHERE server_id = ? AND key = ?').get(this.serverId, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T | null) : null;
  }

  setRaw<T>(key: string, value: T | null): void {
    this.db
      .prepare(
        'INSERT INTO server_settings (server_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(this.serverId, key, JSON.stringify(value), nowIso());
  }
}
