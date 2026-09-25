/**
 * Project Zomboid mods from the Steam Workshop (MOD-01), through the shared
 * Workshop source (`@gsp/source-workshop`: Steam's Workshop API, the agent's
 * steamcmd): what is PZ's own lives here — the items' mod.info files for
 * what they contain, and the ini's Mods / WorkshopItems / Map lines for
 * what is enabled.
 */
import type { ModEntry, ModSource, RootId, ServerCtx } from '@gsp/adapter-api';
import { createWorkshopSource as workshopSource, workshopItemLocations } from '@gsp/source-workshop';
import { checkCompat, formatModsLine, formatWorkshopItems, parseModInfo, parseModsLine, parseWorkshopItems, selectVersionFolder } from '../../shared/modinfo';

export { SteamWorkshopApi, type WorkshopDetails } from '@gsp/source-workshop';

/** The game's app id on the Workshop (the dedicated server is 380870). */
export const PZ_WORKSHOP_APP_ID = 108600;
/** Last on the Map= line: map mods go before the vanilla map. */
export const VANILLA_MAP = 'Muldraugh, KY';
/** Build the mods are checked against until the agent reports the real one (the fixtures' build). */
export const FALLBACK_GAME_VERSION = '42.20.4';

const MOD_INFO_MAX_BYTES = 256 * 1024;

/** One mod found in a Workshop item. */
export interface PzMod extends ModEntry {
  /** Folder under mods/ in the item. */
  folder: string;
  /** Versioned folder the game will load (e.g. "42.20.1"), or null. */
  versionFolder: string | null;
  versionMin: string | null;
  /** Map folders the mod adds (they go on the Map= line). */
  maps: string[];
}

type Fetch = typeof fetch;

/** Where an item's files can be: the server's own download (at start) or the agent's steamcmd cache. */
export function itemLocations(workshopId: string): { root: RootId; rel: string }[] {
  return workshopItemLocations(PZ_WORKSHOP_APP_ID, workshopId);
}

async function subdirs(ctx: ServerCtx, root: RootId, rel: string): Promise<string[]> {
  try {
    return (await ctx.files.list(root, rel)).filter((e) => e.kind === 'dir').map((e) => e.name);
  } catch {
    // Not a folder, or a name the file API refuses.
    return [];
  }
}

async function readText(ctx: ServerCtx, root: RootId, rel: string): Promise<string | null> {
  try {
    return (await ctx.files.read(root, rel, { maxBytes: MOD_INFO_MAX_BYTES }))?.toString('utf8') ?? null;
  } catch {
    return null;
  }
}

/**
 * Every mod in a downloaded item, reading the versioned folder B42 would load
 * for `gameVersion` (as the game does: the newest one not newer than it).
 */
export async function scanItem(ctx: ServerCtx, root: RootId, itemRel: string, gameVersion: string): Promise<PzMod[]> {
  const out: PzMod[] = [];
  for (const folder of (await subdirs(ctx, root, `${itemRel}/mods`)).sort()) {
    const base = `${itemRel}/mods/${folder}`;
    const folders = await subdirs(ctx, root, base);
    const versionFolder = selectVersionFolder(folders, gameVersion);
    let text: string | null = null;
    for (const f of [versionFolder ? `${base}/${versionFolder}/mod.info` : null, `${base}/common/mod.info`, `${base}/mod.info`]) {
      if (f && (text = await readText(ctx, root, f)) !== null) break;
    }
    if (text === null) continue;
    let info;
    try {
      info = parseModInfo(text);
    } catch {
      continue;
    }
    const compat = checkCompat(folders, gameVersion, info);
    const maps = new Set<string>();
    for (const r of [versionFolder, 'common']) if (r) for (const m of await subdirs(ctx, root, `${base}/${r}/media/maps`)) maps.add(m);
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

/** The Workshop as Project Zomboid's mod source; `fetch` is replaceable for tests. */
export function createWorkshopSource(o: { fetch?: Fetch } = {}): ModSource<PzMod> {
  return workshopSource<PzMod>({
    appId: PZ_WORKSHOP_APP_ID,
    fetch: o.fetch,
    scan: scanItem,
    fallbackGameVersion: FALLBACK_GAME_VERSION,
    toConfig(enabled, entries) {
      const maps = enabled.flatMap((e) => entries.get(e.modId)?.maps ?? []);
      return {
        fileId: 'ini',
        values: {
          Mods: formatModsLine(enabled.map((e) => e.modId)),
          WorkshopItems: formatWorkshopItems([...new Set(enabled.map((e) => e.itemId))]),
          Map: [...new Set([...maps, VANILLA_MAP])].join(';'),
        },
      };
    },
    fromConfig(values) {
      return { items: parseWorkshopItems(String(values.WorkshopItems ?? '')), enabled: parseModsLine(String(values.Mods ?? '')) };
    },
  });
}
