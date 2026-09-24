import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildIni,
  checkOptionValue,
  flattenScalars,
  getIniValue,
  iniToRecord,
  LuaDataError,
  parseIni,
  parseLogLine,
  parseLuaData,
  PZ_PATTERNS,
  scalarToJs,
  setIniValues,
  setLuaValues,
  type LuaEdit,
  type OptionMeta,
} from '@pz/formats';
import type { AgentApi } from '../agent/client';
import { nowIso, type Db } from '../db/db';
import type { PanelEnv } from '../env';
import { HttpError } from '../http/context';
import type { AgentFeed } from '../http/deps';
import type { Settings } from '../settings';
import metaJson from './option-meta.json';

export type ConfigFile = 'ini' | 'sandbox' | 'spawnregions' | 'spawnpoints';
export const CONFIG_FILES: ConfigFile[] = ['ini', 'sandbox', 'spawnregions', 'spawnpoints'];

/** Owned by the agent (ports, RCON) or the mod manager: never edited here. */
export const MANAGED_INI = ['RCONPort', 'RCONPassword', 'DefaultPort', 'UDPPort', 'UPnP', 'Mods', 'WorkshopItems', 'Map'];
/** Shown masked in forms and history. */
export const SECRET_INI = ['RCONPassword', 'Password', 'DiscordToken'];
export const MASK = '••••••••';

/**
 * Options that only take effect after a restart. `reloadoptions` re-reads the
 * file (verified on 42.20.4), but these are read once at boot or announced to
 * Steam. Everything else is treated as live.
 */
export const RESTART_ONLY_INI = new Set([
  'Public',
  'PublicName',
  'PublicDescription',
  'MaxPlayers',
  'Open',
  'Seed',
  'ResetID',
  'SteamVAC',
  'SteamScoreboard',
  'DoLuaChecksum',
  'DenyLoginOnOverloadedServer',
  'LoginQueueEnabled',
  'LoginQueueConnectTimeout',
  'server_browser_announced_ip',
  'VoiceEnable',
  'Voice3D',
  'VoiceMinDistance',
  'VoiceMaxDistance',
  'ServerPlayerID',
  'SaveWorldEveryMinutes',
]);

/** Settings seeded into a brand-new ini before the first start; PZ fills in the rest. */
export const FIRST_RUN_INI: Record<string, string> = {
  // PZ's default (0) saves only on shutdown; a crash would lose the session.
  SaveWorldEveryMinutes: '10',
};

const META = metaJson as { source: string; ini: OptionMeta[]; sandbox: OptionMeta[] };

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

export function maskIniText(text: string): string {
  return text.replace(new RegExp(`^(${SECRET_INI.join('|')})=(.+)$`, 'gm'), (_m, k: string) => `${k}=${MASK}`);
}

export interface ConfigDeps {
  env: PanelEnv;
  db: Db;
  agent: AgentApi;
  feed: AgentFeed;
  settings: Settings;
}

export class ConfigService {
  constructor(private readonly d: ConfigDeps) {}

  // ------------------------------------------------------------------ files

  pathOf(file: ConfigFile): string {
    const base = path.join(this.d.env.pzDataDir, 'Server', this.d.env.serverName);
    return file === 'ini' ? `${base}.ini` : file === 'sandbox' ? `${base}_SandboxVars.lua` : `${base}_${file}.lua`;
  }

  read(file: ConfigFile): string | null {
    try {
      return readFileSync(this.pathOf(file), 'utf8');
    } catch {
      return null;
    }
  }

  private requireFile(file: ConfigFile): string {
    const t = this.read(file);
    if (t === null) throw new HttpError(409, 'config-missing');
    return t;
  }

  /** The game rewrites these files while booting; writing then could be lost. */
  private assertWritable(): void {
    const st = this.d.feed.status_?.state;
    if (st === 'starting' || st === 'stopping' || st === 'installing') throw new HttpError(409, 'server-busy');
  }

  private write(file: ConfigFile, text: string, by: string | null, note: string): void {
    const p = this.pathOf(file);
    mkdirSync(path.dirname(p), { recursive: true });
    const before = this.read(file);
    // Record what was on disk if it changed outside the panel (the game rewrote it, or someone edited by hand).
    if (before !== null && before !== this.latestContent(file)) this.snapshot(file, before, null, 'on disk before this change');
    const tmp = `${p}.panel-tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, p);
    this.snapshot(file, text, by, note);
  }

  seedIniIfMissing(): boolean {
    if (existsSync(this.pathOf('ini'))) return false;
    this.write('ini', buildIni(FIRST_RUN_INI), null, 'first-run defaults');
    return true;
  }

  // ---------------------------------------------------------------- history

  private snapshot(file: ConfigFile, content: string, by: string | null, note: string): void {
    this.d.db.prepare('INSERT INTO config_versions (file, at, username, note, content) VALUES (?,?,?,?,?)').run(file, nowIso(), by, note, content);
    this.d.db
      .prepare('DELETE FROM config_versions WHERE file = ? AND id NOT IN (SELECT id FROM config_versions WHERE file = ? ORDER BY id DESC LIMIT 100)')
      .run(file, file);
  }

  private latestContent(file: ConfigFile): string | null {
    const r = this.d.db.prepare('SELECT content FROM config_versions WHERE file = ? ORDER BY id DESC LIMIT 1').get(file) as { content: string } | undefined;
    return r?.content ?? null;
  }

  history(file: ConfigFile): VersionRow[] {
    return this.d.db.prepare('SELECT id, file, at, username, note, length(content) AS size FROM config_versions WHERE file = ? ORDER BY id DESC').all(file) as unknown as VersionRow[];
  }

  /** A version and the one before it, secrets masked, for a diff view. */
  version(id: number): { row: VersionRow; content: string; previous: string | null } {
    const row = this.d.db.prepare('SELECT id, file, at, username, note, length(content) AS size, content FROM config_versions WHERE id = ?').get(id) as
      | (VersionRow & { content: string })
      | undefined;
    if (!row) throw new HttpError(404, 'not-found');
    const prev = this.d.db.prepare('SELECT content FROM config_versions WHERE file = ? AND id < ? ORDER BY id DESC LIMIT 1').get(row.file, id) as { content: string } | undefined;
    const mask = (t: string) => (row.file === 'ini' ? maskIniText(t) : t);
    const { content, ...meta } = row;
    return { row: meta, content: mask(content), previous: prev ? mask(prev.content) : null };
  }

  async revert(id: number, by: string | null): Promise<ApplyResult> {
    const row = this.d.db.prepare('SELECT file, content FROM config_versions WHERE id = ?').get(id) as { file: ConfigFile; content: string } | undefined;
    if (!row) throw new HttpError(404, 'not-found');
    if (row.file === 'ini') return this.putIniRaw(row.content, by, `revert to version ${id}`, { keepManagedFromDisk: true });
    return this.putLuaRaw(row.file, row.content, by, `revert to version ${id}`);
  }

  // -------------------------------------------------------- pending restart

  pendingRestart(): PendingRestart | null {
    const p = this.d.settings.getRaw<PendingRestart>('pendingRestart');
    if (!p) return null;
    const ready = this.d.feed.status_?.readyAt;
    if (ready && ready > p.since) {
      this.d.settings.setRaw('pendingRestart', null);
      return null;
    }
    return p;
  }

  /** For other services (mods) whose changes need a restart. */
  markPendingPublic(reasons: string[]): void {
    this.markPending(reasons);
  }

  private markPending(reasons: string[]): void {
    if (reasons.length === 0) return;
    const cur = this.pendingRestart();
    this.d.settings.setRaw<PendingRestart>('pendingRestart', {
      since: cur?.since ?? nowIso(),
      reasons: Array.from(new Set([...(cur?.reasons ?? []), ...reasons])).slice(0, 50),
    });
  }

  // -------------------------------------------------------------------- ini

  iniMeta(): OptionMeta[] {
    return META.ini;
  }

  getIni(): { values: Record<string, string>; missing: boolean } {
    const text = this.read('ini');
    if (text === null) return { values: {}, missing: true };
    const values = iniToRecord(parseIni(text));
    for (const k of SECRET_INI) if (values[k]) values[k] = MASK;
    return { values, missing: false };
  }

  async applyIni(changes: Record<string, string>, by: string | null): Promise<ApplyResult> {
    this.assertWritable();
    const text = this.requireFile('ini');
    const current = iniToRecord(parseIni(text));
    const clean: Record<string, string> = {};
    const errors: Record<string, string> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (MANAGED_INI.includes(key)) {
        errors[key] = 'managed';
        continue;
      }
      if (SECRET_INI.includes(key) && value === MASK) continue; // untouched secret
      const meta = META.ini.find((m) => m.key === key);
      if (!meta && !(key in current)) {
        errors[key] = 'unknown-option';
        continue;
      }
      const problem = checkOptionValue(meta ?? { type: 'string' }, value);
      if (problem) {
        errors[key] = problem;
        continue;
      }
      if (current[key] !== value) clean[key] = value;
    }
    if (Object.keys(errors).length) throw new HttpError(400, 'invalid-options', undefined, { fields: errors });
    if (Object.keys(clean).length === 0) return { applied: 'unchanged', warnings: [], restartNeeded: false };
    this.write('ini', setIniValues(text, clean), by, `changed ${Object.keys(clean).join(', ')}`.slice(0, 300));
    const restartKeys = Object.keys(clean).filter((k) => RESTART_ONLY_INI.has(k));
    return this.afterIniWrite(restartKeys);
  }

  /** Internal edits (reset flows) while the server is stopped: no managed-key or busy checks. */
  setIniDirect(changes: Record<string, string>, by: string | null, note: string): void {
    const text = this.read('ini');
    if (text === null) return;
    this.write('ini', setIniValues(text, changes), by, note);
  }

  getIniRaw(): string {
    const text = this.requireFile('ini');
    // The RCON password belongs to the agent; the UI never sees it.
    return text.replace(/^RCONPassword=.*$/m, 'RCONPassword=<managed>');
  }

  async putIniRaw(text: string, by: string | null, note = 'raw edit', opts: { keepManagedFromDisk?: boolean } = {}): Promise<ApplyResult> {
    this.assertWritable();
    if (/\0/.test(text) || text.length > 256 * 1024) throw new HttpError(400, 'invalid-file');
    const disk = this.requireFile('ini');
    const diskDoc = parseIni(disk);
    // Managed keys always come from disk, whatever the text says.
    const managed: Record<string, string> = {};
    for (const k of MANAGED_INI) {
      const v = getIniValue(diskDoc, k);
      if (v !== undefined) managed[k] = v;
    }
    let next = text;
    if (opts.keepManagedFromDisk !== false) next = setIniValues(next, managed);
    const before = iniToRecord(diskDoc);
    const after = iniToRecord(parseIni(next));
    const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
    if (next === disk) return { applied: 'unchanged', warnings: [], restartNeeded: false };
    this.write('ini', next, by, note);
    return this.afterIniWrite(changed.filter((k) => RESTART_ONLY_INI.has(k)));
  }

  /** Ask a running server to re-read the ini and report options it rejected. */
  private async afterIniWrite(restartKeys: string[]): Promise<ApplyResult> {
    this.markPending(restartKeys);
    if (this.d.feed.status_?.state !== 'running') return { applied: 'next-start', warnings: [], restartNeeded: false };
    const warnings: string[] = [];
    const off = this.d.feed.onEvent((e) => {
      if (e.event.type !== 'log') return;
      const { message } = parseLogLine(e.event.line);
      const m = PZ_PATTERNS.optionParseError.exec(message) ?? PZ_PATTERNS.optionRangeError.exec(message);
      if (m) warnings.push(`${m[1]}: ${m[2]}`);
    });
    try {
      await this.d.agent.command('reloadoptions', 'rcon');
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      off();
    }
    return { applied: 'live', warnings, restartNeeded: restartKeys.length > 0 };
  }

  // ---------------------------------------------------------------- sandbox

  sandboxMeta(): OptionMeta[] {
    return META.sandbox;
  }

  getSandbox(): { values: Record<string, string | number | boolean | null>; missing: boolean } {
    const text = this.read('sandbox');
    if (text === null) return { values: {}, missing: true };
    const values: Record<string, string | number | boolean | null> = {};
    for (const s of flattenScalars(parseLuaData(text).table)) values[s.path] = scalarToJs(s.value);
    return { values, missing: false };
  }

  applySandbox(changes: Record<string, LuaEdit>, by: string | null, opts: { force?: boolean } = {}): ApplyResult {
    if (!opts.force) this.assertWritable();
    const text = this.requireFile('sandbox');
    const errors: Record<string, string> = {};
    for (const [key, value] of Object.entries(changes)) {
      const meta = META.sandbox.find((m) => m.key === key);
      if (meta) {
        const problem = checkOptionValue(meta, String(value));
        if (problem) errors[key] = problem;
      }
    }
    if (Object.keys(errors).length) throw new HttpError(400, 'invalid-options', undefined, { fields: errors });
    let next: string;
    try {
      next = setLuaValues(text, changes);
    } catch (e) {
      throw new HttpError(400, 'invalid-options', (e as Error).message, { message: (e as Error).message });
    }
    if (next === text) return { applied: 'unchanged', warnings: [], restartNeeded: false };
    this.write('sandbox', next, by, `changed ${Object.keys(changes).join(', ')}`.slice(0, 300));
    return this.afterLuaWrite('sandbox');
  }

  private afterLuaWrite(file: ConfigFile): ApplyResult {
    const running = ['running', 'starting'].includes(this.d.feed.status_?.state ?? '');
    if (running) this.markPending([file]);
    return { applied: running ? 'next-start' : 'next-start', warnings: [], restartNeeded: running };
  }

  getLuaRaw(file: Exclude<ConfigFile, 'ini'>): string {
    return this.requireFile(file);
  }

  async putLuaRaw(file: Exclude<ConfigFile, 'ini'>, text: string, by: string | null, note = 'raw edit'): Promise<ApplyResult> {
    this.assertWritable();
    if (text.length > 512 * 1024) throw new HttpError(400, 'invalid-file');
    const expected = file === 'sandbox' ? { form: 'assign', name: 'SandboxVars' } : { form: 'function', name: file === 'spawnregions' ? 'SpawnRegions' : 'SpawnPoints' };
    try {
      const parsed = parseLuaData(text);
      if (parsed.form !== expected.form || parsed.name !== expected.name) {
        throw new HttpError(400, 'invalid-lua', undefined, { message: `Expected ${expected.form === 'assign' ? `${expected.name} = { … }` : `function ${expected.name}() return { … } end`}` });
      }
    } catch (e) {
      if (e instanceof LuaDataError) throw new HttpError(400, 'invalid-lua', undefined, { message: e.message, line: e.lineNumber });
      throw e;
    }
    if (text === this.read(file)) return { applied: 'unchanged', warnings: [], restartNeeded: false };
    this.write(file, text, by, note);
    return this.afterLuaWrite(file);
  }

  // ---------------------------------------------------------------- presets

  private presetDir(): string {
    return path.join(this.d.env.pzInstallDir, 'media', 'lua', 'shared', 'Sandbox');
  }

  presets(): string[] {
    try {
      return readdirSync(this.presetDir())
        .filter((f) => /^[A-Za-z0-9_-]+\.lua$/.test(f) && f !== 'SandboxVars.lua')
        .map((f) => f.slice(0, -4))
        .sort();
    } catch {
      return [];
    }
  }

  /** Copy a game preset's values onto the current file, for options both have. */
  applyPreset(name: string, by: string | null, opts: { force?: boolean } = {}): ApplyResult & { applied_keys: number } {
    if (!this.presets().includes(name)) throw new HttpError(404, 'not-found');
    const preset = parseLuaData(readFileSync(path.join(this.presetDir(), `${name}.lua`), 'utf8'));
    const current = new Set(Object.keys(this.getSandbox().values));
    const changes: Record<string, LuaEdit> = {};
    for (const s of flattenScalars(preset.table)) {
      const v = scalarToJs(s.value);
      if (current.has(s.path) && v !== null && s.path !== 'VERSION') changes[s.path] = v;
    }
    const r = this.applySandbox(changes, by, opts);
    return { ...r, applied_keys: Object.keys(changes).length };
  }
}

export interface ApplyResult {
  /** `live`: the running server re-read it; `next-start`: takes effect when it (re)starts. */
  applied: 'live' | 'next-start' | 'unchanged';
  /** Options the game rejected when re-reading (from its log). */
  warnings: string[];
  restartNeeded: boolean;
}
