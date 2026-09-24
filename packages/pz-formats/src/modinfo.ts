/**
 * Workshop mod metadata and the ini lines that enable mods.
 *
 * B42 layout (from the local workshop cache, fixtures/b42/workshop):
 *   mods/<Folder>/mod.info          B41 / fallback
 *   mods/<Folder>/common/           shared assets
 *   mods/<Folder>/42/, 42.13/, 42.20.1/ …  per-version; each with its own mod.info
 * `require=\A,\B,` uses a backslash per id and a trailing comma;
 * `incompatible=A,B,` has no backslashes.
 */

export interface ModInfo {
  id: string;
  name: string;
  description: string;
  require: string[];
  incompatible: string[];
  versionMin?: string;
  versionMax?: string;
  modVersion?: string;
  author?: string;
  poster?: string;
  icon?: string;
  url?: string;
  /** Every key as written, for anything not modelled above. */
  raw: Record<string, string[]>;
}

export function parseModInfo(text: string): ModInfo {
  const raw: Record<string, string[]> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    (raw[key] ??= []).push(line.slice(eq + 1).trim());
  }
  const one = (k: string) => raw[k]?.[0] || undefined;
  const id = one('id');
  if (!id) throw new Error('mod.info has no id');
  return {
    id: stripModPrefix(id),
    name: one('name') ?? id,
    description: (raw.description ?? []).join('\n').trim(),
    require: splitIdList(raw.require?.join(',') ?? ''),
    incompatible: splitIdList(raw.incompatible?.join(',') ?? ''),
    versionMin: one('versionmin'),
    versionMax: one('versionmax'),
    modVersion: one('modversion'),
    author: one('author'),
    poster: one('poster'),
    icon: one('icon'),
    url: one('url'),
    raw,
  };
}

export function stripModPrefix(id: string): string {
  return id.trim().replace(/^\\+/, '');
}

export function splitIdList(value: string): string[] {
  return value
    .split(/[,;]/)
    .map(stripModPrefix)
    .filter((s) => s !== '');
}

/** Compare dotted numeric versions: "42.20.4" vs "42.20.1". Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const VERSION_DIR = /^\d+(\.\d+)*$/;

/**
 * The versioned folder the game will load for `gameVersion`: the highest
 * numeric folder that is not newer than the game. Null when the mod has none
 * (a B41-only mod).
 */
export function selectVersionFolder(folders: string[], gameVersion: string): string | null {
  const candidates = folders.filter((f) => VERSION_DIR.test(f) && compareVersions(f, gameVersion) <= 0);
  candidates.sort(compareVersions);
  return candidates.at(-1) ?? null;
}

export interface ModCompat {
  folder: string | null;
  compatible: boolean;
  reason?: 'no-b42-folder' | 'needs-newer-game' | 'too-old-for-game';
}

export function checkCompat(folders: string[], gameVersion: string, info?: Pick<ModInfo, 'versionMin' | 'versionMax'>): ModCompat {
  const folder = selectVersionFolder(folders, gameVersion);
  const major = gameVersion.split('.')[0]!;
  if (!folder && !folders.includes('common')) {
    const hasAnyForMajor = folders.some((f) => VERSION_DIR.test(f) && f.split('.')[0] === major);
    return { folder: null, compatible: false, reason: hasAnyForMajor ? 'needs-newer-game' : 'no-b42-folder' };
  }
  if (info?.versionMin && compareVersions(gameVersion, info.versionMin) < 0) return { folder, compatible: false, reason: 'needs-newer-game' };
  if (info?.versionMax && compareVersions(gameVersion, info.versionMax) > 0) return { folder, compatible: false, reason: 'too-old-for-game' };
  return { folder, compatible: true };
}

/** `Mods=` value → ordered mod ids (accepts B41 lines without backslashes). */
export function parseModsLine(value: string): string[] {
  return splitIdList(value);
}

/** Ordered mod ids → B42 `Mods=` value with a backslash before each id. */
export function formatModsLine(ids: string[]): string {
  return ids.map((id) => `\\${stripModPrefix(id)}`).join(';');
}

export function parseWorkshopItems(value: string): string[] {
  return value
    .split(';')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
}

export function formatWorkshopItems(ids: string[]): string {
  for (const id of ids) if (!/^\d+$/.test(id)) throw new Error(`Invalid workshop id ${id}`);
  return ids.join(';');
}

/** Workshop id from an id or a steamcommunity URL (`…/filedetails/?id=123`). */
export function parseWorkshopRef(input: string): string | null {
  const s = input.trim();
  if (/^\d{5,20}$/.test(s)) return s;
  try {
    const url = new URL(s);
    if (!/(^|\.)steamcommunity\.com$/.test(url.hostname)) return null;
    const id = url.searchParams.get('id');
    return id && /^\d{5,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
