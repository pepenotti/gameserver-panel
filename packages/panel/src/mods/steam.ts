/**
 * Steam's keyless Workshop endpoints (ISteamRemoteStorage). Used to look up
 * titles, thumbnails, update times and collection contents.
 */

export interface WorkshopDetails {
  id: string;
  ok: boolean;
  title: string;
  previewUrl: string | null;
  timeUpdated: number;
  fileSize: number;
  appId: number;
  /** True for a collection (its children are separate items). */
  isCollection: boolean;
}

const BASE = 'https://api.steampowered.com/ISteamRemoteStorage';
export const PZ_APP_ID = 108600;

type Fetch = typeof fetch;

function form(ids: string[], countKey: string): URLSearchParams {
  const p = new URLSearchParams({ [countKey]: String(ids.length) });
  ids.forEach((id, i) => p.set(`publishedfileids[${i}]`, id));
  return p;
}

export class SteamWorkshop {
  constructor(private readonly doFetch: Fetch = fetch) {}

  async details(ids: string[]): Promise<WorkshopDetails[]> {
    if (ids.length === 0) return [];
    const out: WorkshopDetails[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const res = await this.doFetch(`${BASE}/GetPublishedFileDetails/v1/`, { method: 'POST', body: form(chunk, 'itemcount'), signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`Steam Workshop API: HTTP ${res.status}`);
      const body = (await res.json()) as { response?: { publishedfiledetails?: Record<string, unknown>[] } };
      for (const d of body.response?.publishedfiledetails ?? []) {
        out.push({
          id: String(d.publishedfileid),
          ok: d.result === 1,
          title: typeof d.title === 'string' ? d.title : String(d.publishedfileid),
          previewUrl: typeof d.preview_url === 'string' && /^https:\/\//.test(d.preview_url) ? d.preview_url : null,
          timeUpdated: Number(d.time_updated ?? 0),
          fileSize: Number(d.file_size ?? 0),
          appId: Number(d.consumer_app_id ?? 0),
          // Collections have no file of their own.
          isCollection: Number(d.file_type ?? 0) === 2 || (Number(d.file_size ?? 0) === 0 && d.result === 1 && !d.file_url && !d.hcontent_file),
        });
      }
    }
    return out;
  }

  /** The workshop items inside a collection (empty for a normal item). */
  async collectionChildren(id: string): Promise<string[]> {
    const res = await this.doFetch(`${BASE}/GetCollectionDetails/v1/`, { method: 'POST', body: form([id], 'collectioncount'), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Steam Workshop API: HTTP ${res.status}`);
    const body = (await res.json()) as { response?: { collectiondetails?: { result?: number; children?: { publishedfileid: string; filetype?: number }[] }[] } };
    const c = body.response?.collectiondetails?.[0];
    if (!c || c.result !== 1) return [];
    return (c.children ?? []).filter((x) => (x.filetype ?? 0) === 0).map((x) => String(x.publishedfileid));
  }
}
