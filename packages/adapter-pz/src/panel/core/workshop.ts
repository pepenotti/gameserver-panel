/**
 * Project Zomboid mods from the Steam Workshop (MOD-01): Steam's keyless
 * Workshop endpoints (ISteamRemoteStorage) for titles, thumbnails, update
 * times and collections; the agent's steamcmd for downloads; the items'
 * mod.info files for what they contain; the ini's Mods / WorkshopItems / Map
 * lines for what is enabled.
 */
import type { EnabledMod, JobResult, ModDetails, ModEntry, ModSource, RootId, Scalar, ServerCtx } from '@gsp/adapter-api';
import { WORKSHOP_DOWNLOAD, type WorkshopDownloadInput } from '../../shared/actions';
import { checkCompat, formatModsLine, formatWorkshopItems, parseModInfo, parseModsLine, parseWorkshopItems, parseWorkshopRef, selectVersionFolder } from '../../shared/modinfo';

/** The game's app id on the Workshop (the dedicated server is 380870). */
export const PZ_WORKSHOP_APP_ID = 108600;
/** Last on the Map= line: map mods go before the vanilla map. */
export const VANILLA_MAP = 'Muldraugh, KY';
/** Build the mods are checked against until the agent reports the real one (the fixtures' build). */
export const FALLBACK_GAME_VERSION = '42.20.4';

const API = 'https://api.steampowered.com/ISteamRemoteStorage';
/** Ids per steamcmd download (the action's limit). */
const DOWNLOAD_BATCH = 100;
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

export interface WorkshopDetails extends ModDetails {
  fileSize: number;
  appId: number;
  isCollection: boolean;
}

type Fetch = typeof fetch;

function form(ids: string[], countKey: string): URLSearchParams {
  const p = new URLSearchParams({ [countKey]: String(ids.length) });
  ids.forEach((id, i) => p.set(`publishedfileids[${i}]`, id));
  return p;
}

/** Steam's keyless Workshop API. */
export class SteamWorkshopApi {
  constructor(private readonly doFetch: Fetch = (input, init) => fetch(input, init)) {}

  async details(ids: string[]): Promise<WorkshopDetails[]> {
    const out: WorkshopDetails[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const res = await this.doFetch(`${API}/GetPublishedFileDetails/v1/`, { method: 'POST', body: form(chunk, 'itemcount'), signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`Steam Workshop API: HTTP ${res.status}`);
      const body = (await res.json()) as { response?: { publishedfiledetails?: Record<string, unknown>[] } };
      for (const d of body.response?.publishedfiledetails ?? []) {
        const appId = Number(d.consumer_app_id ?? 0);
        out.push({
          id: String(d.publishedfileid),
          // Exists and is a Project Zomboid item.
          ok: d.result === 1 && appId === PZ_WORKSHOP_APP_ID,
          title: typeof d.title === 'string' ? d.title : String(d.publishedfileid),
          previewUrl: typeof d.preview_url === 'string' && /^https:\/\//.test(d.preview_url) ? d.preview_url : null,
          timeUpdated: Number(d.time_updated ?? 0),
          fileSize: Number(d.file_size ?? 0),
          appId,
          // Collections have no file of their own.
          isCollection: Number(d.file_type ?? 0) === 2 || (Number(d.file_size ?? 0) === 0 && d.result === 1 && !d.file_url && !d.hcontent_file),
        });
      }
    }
    return out;
  }

  /** The Workshop items inside a collection (empty for a normal item). */
  async collectionChildren(id: string): Promise<string[]> {
    const res = await this.doFetch(`${API}/GetCollectionDetails/v1/`, { method: 'POST', body: form([id], 'collectioncount'), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Steam Workshop API: HTTP ${res.status}`);
    const body = (await res.json()) as { response?: { collectiondetails?: { result?: number; children?: { publishedfileid: string; filetype?: number }[] }[] } };
    const c = body.response?.collectiondetails?.[0];
    if (!c || c.result !== 1) return [];
    return (c.children ?? []).filter((x) => (x.filetype ?? 0) === 0).map((x) => String(x.publishedfileid));
  }
}

/** Where an item's files can be: the server's own download (at start) or the agent's steamcmd cache. */
export function itemLocations(workshopId: string): { root: RootId; rel: string }[] {
  const rel = `steamapps/workshop/content/${PZ_WORKSHOP_APP_ID}/${workshopId}`;
  return [
    { root: 'install', rel },
    { root: 'data', rel: `.workshop/${rel}` },
  ];
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

function jobResult(x: unknown): JobResult {
  if (x === null || typeof x !== 'object' || typeof (x as JobResult).ok !== 'boolean') return { ok: false, error: 'Unexpected reply from the agent' };
  const r = x as JobResult;
  return r.ok ? { ok: true } : { ok: false, error: typeof r.error === 'string' ? r.error.slice(0, 500) : 'download failed' };
}

/** The Workshop as a mod source; `fetch` is replaceable for tests. */
export function createWorkshopSource(o: { fetch?: Fetch } = {}): ModSource<PzMod> {
  const api = new SteamWorkshopApi(o.fetch);
  return {
    id: 'steam-workshop',
    capability: 'mods:workshop',
    label: { en: 'Steam Workshop', es: 'Steam Workshop' },
    parseRef: parseWorkshopRef,
    expand: (id) => api.collectionChildren(id),
    details: (ids) => api.details(ids),

    async download(ctx, ids) {
      for (const id of ids) if (!/^\d{1,20}$/.test(id)) return { ok: false, error: `Invalid Workshop id ${id}` };
      for (let i = 0; i < ids.length; i += DOWNLOAD_BATCH) {
        const input: WorkshopDownloadInput = { ids: ids.slice(i, i + DOWNLOAD_BATCH) };
        const r = jobResult(await ctx.action(WORKSHOP_DOWNLOAD, input));
        if (!r.ok) return r;
      }
      return { ok: true };
    },

    async scan(ctx, id, gameVersion) {
      if (!/^\d{1,20}$/.test(id)) return null;
      for (const at of itemLocations(id)) {
        if ((await ctx.files.stat(at.root, at.rel))?.kind === 'dir') return scanItem(ctx, at.root, at.rel, gameVersion || FALLBACK_GAME_VERSION);
      }
      return null;
    },

    toConfig(enabled: EnabledMod[], entries: ReadonlyMap<string, PzMod>): { fileId: string; values: Record<string, Scalar> } {
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
  };
}
