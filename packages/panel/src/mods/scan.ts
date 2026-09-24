import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { checkCompat, parseModInfo, selectVersionFolder } from '@pz/formats';

export interface ScannedMod {
  modId: string;
  name: string;
  /** Folder under mods/ in the workshop item. */
  folder: string;
  /** Versioned folder the game will load (e.g. "42.20.1"), or null. */
  versionFolder: string | null;
  versionMin: string | null;
  require: string[];
  incompatible: string[];
  compatible: boolean;
  reason: string | null;
  /** Map folders the mod adds (need to go on the Map= line). */
  maps: string[];
}

/** Where a workshop item's files can be: the server's own download or the panel's cache. */
export function itemDirs(pzInstallDir: string, pzDataDir: string, workshopId: string): string[] {
  return [
    path.join(pzInstallDir, 'steamapps', 'workshop', 'content', '108600', workshopId),
    path.join(pzDataDir, '.workshop', 'steamapps', 'workshop', 'content', '108600', workshopId),
  ];
}

function dirs(p: string): string[] {
  try {
    return readdirSync(p).filter((e) => statSync(path.join(p, e)).isDirectory());
  } catch {
    return [];
  }
}

/**
 * Read every mod in a downloaded workshop item, choosing the versioned folder
 * B42 would load for `gameVersion` (as the game does: newest one not newer
 * than the game).
 */
export function scanItem(itemDir: string, gameVersion: string): ScannedMod[] {
  const modsDir = path.join(itemDir, 'mods');
  const out: ScannedMod[] = [];
  for (const folder of dirs(modsDir).sort()) {
    const base = path.join(modsDir, folder);
    const folders = dirs(base);
    const versionFolder = selectVersionFolder(folders, gameVersion);
    const candidates = [versionFolder ? path.join(base, versionFolder, 'mod.info') : null, path.join(base, 'common', 'mod.info'), path.join(base, 'mod.info')].filter(
      (x): x is string => x !== null,
    );
    const infoFile = candidates.find((f) => existsSync(f));
    if (!infoFile) continue;
    let info;
    try {
      info = parseModInfo(readFileSync(infoFile, 'utf8'));
    } catch {
      continue;
    }
    const compat = checkCompat(folders, gameVersion, info);
    const maps = new Set<string>();
    for (const root of [versionFolder ? path.join(base, versionFolder) : null, path.join(base, 'common')]) {
      if (root) for (const m of dirs(path.join(root, 'media', 'maps'))) maps.add(m);
    }
    out.push({
      modId: info.id,
      name: info.name,
      folder,
      versionFolder: compat.folder,
      versionMin: info.versionMin ?? null,
      require: info.require,
      incompatible: info.incompatible,
      compatible: compat.compatible,
      reason: compat.reason ?? null,
      maps: [...maps].sort(),
    });
  }
  return out;
}
