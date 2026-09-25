/**
 * Steam Workshop mods as a mod source (MOD-01, MOD-03, D4), for any game
 * whose server downloads Workshop items with steamcmd: Steam's keyless
 * Workshop endpoints (ISteamRemoteStorage) for titles, thumbnails, update
 * times and collections, and the agent's steamcmd for downloads (the
 * `workshop-download` action, `./runtime`). What an item holds and how the
 * enabled mods reach the game's config are the game's own: the adapter
 * passes them in (`WorkshopSourceOptions`).
 *
 * The panel half (this module) and the runtime half (`./runtime`) agree on
 * the action's name and input, below.
 */
import type { EnabledMod, I18n, JobResult, ModDetails, ModEntry, ModSource, RootId, Scalar, ServerCtx } from '@gsp/adapter-api';

/** The agent action that downloads Workshop items with steamcmd, as a `workshop` job. Replies with a `JobResult`. */
export const WORKSHOP_DOWNLOAD = 'workshop-download';

export interface WorkshopDownloadInput {
  /** 1-100 workshop ids. */
  ids: string[];
}

/** Ids per steamcmd download (the action's limit). */
export const WORKSHOP_DOWNLOAD_BATCH = 100;

/** A Workshop id as the runtime action takes it. */
export const WORKSHOP_ID = /^\d{5,20}$/;

const API = 'https://api.steampowered.com/ISteamRemoteStorage';

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

/** Steam's keyless Workshop API, for the items of one game (`appId`: the app the items belong to, not the dedicated server's). */
export class SteamWorkshopApi {
  constructor(
    private readonly appId: number,
    private readonly doFetch: Fetch = (input, init) => fetch(input, init),
  ) {}

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
          // Exists and is an item of this game.
          ok: d.result === 1 && appId === this.appId,
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

/** Workshop id from an id or a steamcommunity URL (`…/filedetails/?id=123`). */
export function parseWorkshopRef(input: string): string | null {
  const s = input.trim();
  if (WORKSHOP_ID.test(s)) return s;
  try {
    const url = new URL(s);
    if (!/(^|\.)steamcommunity\.com$/.test(url.hostname)) return null;
    const id = url.searchParams.get('id');
    return id && WORKSHOP_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Where a downloaded item's files can be: where the game server downloads
 * its items itself when it starts (under the install), or the agent's
 * steamcmd cache (`.workshop` in the data root).
 */
export function workshopItemLocations(appId: number, workshopId: string): { root: RootId; rel: string }[] {
  const rel = `steamapps/workshop/content/${appId}/${workshopId}`;
  return [
    { root: 'install', rel },
    { root: 'data', rel: `.workshop/${rel}` },
  ];
}

function jobResult(x: unknown): JobResult {
  if (x === null || typeof x !== 'object' || typeof (x as JobResult).ok !== 'boolean') return { ok: false, error: 'Unexpected reply from the agent' };
  const r = x as JobResult;
  return r.ok ? { ok: true } : { ok: false, error: typeof r.error === 'string' ? r.error.slice(0, 500) : 'download failed' };
}

/** What a game adds to the Workshop source: its app id, what an item holds, and how enabled mods reach its config. */
export interface WorkshopSourceOptions<M extends ModEntry> {
  /** The game's app id on the Workshop (the items' consumer app), not its dedicated server's. */
  appId: number;
  /** The mods inside one downloaded item (under `root`/`itemRel`), for `gameVersion`. */
  scan(ctx: ServerCtx, root: RootId, itemRel: string, gameVersion: string): Promise<M[]>;
  /** What items are checked against until the agent reports the game's version. */
  fallbackGameVersion: string;
  toConfig: ModSource<M>['toConfig'];
  fromConfig?: ModSource<M>['fromConfig'];
  /** Replaces `fetch` (tests). */
  fetch?: Fetch;
  /** Default `steam-workshop`. */
  id?: string;
  /** Default "Steam Workshop". */
  label?: I18n;
}

/** The Workshop as a mod source for one game. */
export function createWorkshopSource<M extends ModEntry>(o: WorkshopSourceOptions<M>): ModSource<M> {
  const api = new SteamWorkshopApi(o.appId, o.fetch);
  return {
    id: o.id ?? 'steam-workshop',
    capability: 'mods:workshop',
    label: o.label ?? { en: 'Steam Workshop', es: 'Steam Workshop' },
    parseRef: parseWorkshopRef,
    expand: (id) => api.collectionChildren(id),
    details: (ids) => api.details(ids),

    async download(ctx, ids) {
      for (const id of ids) if (!/^\d{1,20}$/.test(id)) return { ok: false, error: `Invalid Workshop id ${id}` };
      for (let i = 0; i < ids.length; i += WORKSHOP_DOWNLOAD_BATCH) {
        const input: WorkshopDownloadInput = { ids: ids.slice(i, i + WORKSHOP_DOWNLOAD_BATCH) };
        const r = jobResult(await ctx.action(WORKSHOP_DOWNLOAD, input));
        if (!r.ok) return r;
      }
      return { ok: true };
    },

    async scan(ctx, id, gameVersion) {
      if (!/^\d{1,20}$/.test(id)) return null;
      for (const at of workshopItemLocations(o.appId, id)) {
        if ((await ctx.files.stat(at.root, at.rel))?.kind === 'dir') return o.scan(ctx, at.root, at.rel, gameVersion || o.fallbackGameVersion);
      }
      return null;
    },

    toConfig: (enabled: EnabledMod[], entries: ReadonlyMap<string, M>): { fileId: string; values: Record<string, Scalar> } => o.toConfig(enabled, entries),
    ...(o.fromConfig ? { fromConfig: o.fromConfig } : {}),
  };
}
