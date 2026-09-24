import { nowIso, type Db } from './db/db';

/** Panel-level settings the UI can change, stored as JSON per key. */
export interface SettingsShape {
  /** Java heap, steam branch and update policy for the game server. */
  launch: { memoryMb: number; branch: string; updateOnStart: boolean };
}

export const SETTING_DEFAULTS: SettingsShape = {
  launch: { memoryMb: 8192, branch: 'public', updateOnStart: true },
};

export class Settings {
  constructor(private readonly db: Db) {}

  get<K extends keyof SettingsShape>(key: K): SettingsShape[K] {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return structuredClone(SETTING_DEFAULTS[key]);
    // Merge so settings added in a later version get their defaults.
    return { ...SETTING_DEFAULTS[key], ...(JSON.parse(row.value) as object) } as SettingsShape[K];
  }

  /** Untyped JSON value (null when unset); for internal bookkeeping keys. */
  getRaw<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T | null) : null;
  }

  setRaw<T>(key: string, value: T | null): void {
    this.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), nowIso());
  }

  set<K extends keyof SettingsShape>(key: K, value: SettingsShape[K]): void {
    this.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), nowIso());
  }
}
