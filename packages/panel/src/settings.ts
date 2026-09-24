import { nowIso, type Db } from './db/db';

/**
 * Panel-level settings, stored as JSON per key. The game server's launch
 * settings (key `launch`) are its adapter's shape; `ServerHandle` reads them
 * over the adapter's defaults.
 */
export class Settings {
  constructor(private readonly db: Db) {}

  /** Untyped JSON value (null when unset). */
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
