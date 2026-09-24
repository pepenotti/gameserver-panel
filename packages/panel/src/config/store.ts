import type { LuaEdit, OptionMeta } from '@gsp/formats';

/**
 * The server's settings as routes and other services use them (today's
 * ConfigService). Services depend on this interface, not on the class, so
 * the config work (CFG-01…10) can replace the implementation.
 */

export type ConfigFile = 'ini' | 'sandbox' | 'spawnregions' | 'spawnpoints';

export interface PendingRestart {
  since: string;
  reasons: string[];
}

export interface VersionRow {
  id: number;
  file: ConfigFile;
  at: string;
  username: string | null;
  note: string | null;
  size: number;
}

export interface ApplyResult {
  /** `live`: the running server re-read it; `next-start`: takes effect when it (re)starts. */
  applied: 'live' | 'next-start' | 'unchanged';
  /** Options the game rejected when re-reading (from its log). */
  warnings: string[];
  restartNeeded: boolean;
}

export interface ConfigStore {
  // ------------------------------------------------------------------ files
  /** A file's text, or null when it doesn't exist. */
  read(file: ConfigFile): string | null;
  /** Writes the first-run settings when there is no ini yet; true if it did. */
  seedIniIfMissing(): boolean;

  // ---------------------------------------------------------------- history
  history(file: ConfigFile): VersionRow[];
  /** A version and the one before it, secrets masked, for a diff view. */
  version(id: number): { row: VersionRow; content: string; previous: string | null };
  revert(id: number, by: string | null): Promise<ApplyResult>;

  // -------------------------------------------------------- pending restart
  pendingRestart(): PendingRestart | null;
  /** For other services (mods) whose changes need a restart. */
  markPendingPublic(reasons: string[]): void;

  // -------------------------------------------------------------------- ini
  iniMeta(): OptionMeta[];
  getIni(): { values: Record<string, string>; missing: boolean };
  applyIni(changes: Record<string, string>, by: string | null): Promise<ApplyResult>;
  /** Internal edits (resets, the mod list) while the server is stopped: no managed-key or busy checks. */
  setIniDirect(changes: Record<string, string>, by: string | null, note: string): void;
  getIniRaw(): string;
  putIniRaw(text: string, by: string | null, note?: string, opts?: { keepManagedFromDisk?: boolean }): Promise<ApplyResult>;

  // ---------------------------------------------------------------- sandbox
  sandboxMeta(): OptionMeta[];
  getSandbox(): { values: Record<string, string | number | boolean | null>; missing: boolean };
  applySandbox(changes: Record<string, LuaEdit>, by: string | null, opts?: { force?: boolean }): ApplyResult;
  getLuaRaw(file: Exclude<ConfigFile, 'ini'>): string;
  putLuaRaw(file: Exclude<ConfigFile, 'ini'>, text: string, by: string | null, note?: string): Promise<ApplyResult>;

  // ---------------------------------------------------------------- presets
  presets(): string[];
  /** Copies a game preset's values onto the current file, for options both have. */
  applyPreset(name: string, by: string | null, opts?: { force?: boolean }): ApplyResult & { applied_keys: number };
}
