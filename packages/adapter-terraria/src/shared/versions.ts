/**
 * Version lists from the download services (UPD-02), as measured on
 * 2026-09-29 (docs/verification/terraria-1.4.5.8.md, "Install and
 * versions"), with nothing but a GET: the panel's create form asks them
 * before a server, and so an agent, exists. Pure: whoever calls brings the
 * GET (the panel's own; the agent's, through its cache, since GitHub allows
 * 60 anonymous calls an hour and counts 304s too). What only an install
 * reads (a release by tag, the download itself) is in `runtime/sources.ts`.
 */
import { DOWNLOAD_SOURCES, VANILLA_PINS, type TerrariaVersionInfo } from './install';
import { compareDotted, TML_TAG, TSHOCK_TAG, vanillaVersion } from './launch';

/** A GET; resolves with any status, rejects when nothing answered. */
export type Get = (url: string) => Promise<Response>;

export type SourceId = keyof typeof DOWNLOAD_SOURCES;

/** GitHub said the anonymous limit is used up; `resetAt` is when it frees up again (unix ms), when it said. */
export class RateLimitError extends Error {
  constructor(readonly resetAt: number | null) {
    super(`GitHub's limit for anonymous requests (60 an hour) is used up${resetAt ? ` until ${new Date(resetAt).toISOString().slice(11, 16)} UTC` : ''}; try again later`);
  }
}

const NAMES: Record<SourceId, string> = { terraria: 'terraria.org', github: 'GitHub' };

/** The base URL of each service: the environment's override (tests, the dev loop), else the real one. */
export function sourceUrls(env: Readonly<Record<string, string | undefined>>): Record<SourceId, string> {
  const out = {} as Record<SourceId, string>;
  for (const id of Object.keys(DOWNLOAD_SOURCES) as SourceId[]) {
    const s = DOWNLOAD_SOURCES[id];
    const v = env[s.env];
    if (v === undefined || v === '') {
      out[id] = s.url;
      continue;
    }
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new Error(`${s.env} is not a URL`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${s.env} must be an http(s) URL`);
    out[id] = v.replace(/\/+$/, '');
  }
  return out;
}

/** A service's JSON answer; null for a 404. GitHub's rate limit (403 or 429 with nothing left) is a `RateLimitError`. */
export async function getJson(get: Get, src: SourceId, url: string): Promise<unknown> {
  const res = await get(url);
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    await res.body?.cancel().catch(() => undefined);
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    throw new RateLimitError(Number.isFinite(reset) && reset > 0 ? reset * 1000 : null);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`${NAMES[src]} answered HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`${NAMES[src]} sent something that isn't JSON`);
  }
}

const unix = (iso: unknown) => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
};

// ------------------------------------------------------------------ vanilla

/**
 * Vanilla versions, newest first: what terraria.org's name API lists (only
 * the newest, measured) and every version measured to download, whose
 * SHA-256 is pinned (`VANILLA_PINS`). A listed version that isn't pinned
 * carries `warning: 'unverified-download'`. When the name API can't be read
 * the pinned ones are still offered (`unreachable` says why it failed).
 */
export async function vanillaVersions(get: Get, base: string): Promise<{ versions: TerrariaVersionInfo[]; unreachable: string | null }> {
  const ids = new Set(Object.keys(VANILLA_PINS));
  let unreachable: string | null = null;
  try {
    const names = await getJson(get, 'terraria', `${base}/api/get/dedicated-servers-names`);
    if (!Array.isArray(names)) throw new Error("terraria.org's version list has an unexpected shape");
    for (const n of names) {
      const m = typeof n === 'string' ? /^terraria-server-(\d+)\.zip$/.exec(n) : null;
      if (m && vanillaVersion(m[1]!) !== null) ids.add(m[1]!);
    }
  } catch (e) {
    unreachable = (e as Error).message;
  }
  const versions = [...ids]
    .map((id): TerrariaVersionInfo => ({ id: vanillaVersion(id)!, build: id, ...(VANILLA_PINS[id] ? {} : { warning: 'unverified-download' as const }) }))
    .sort((a, b) => compareDotted(b.id, a.id));
  return { versions, unreachable };
}

// ------------------------------------------------------------------ GitHub releases

export interface GithubAsset {
  name: string;
  size: number;
  url: string;
  /** Hex SHA-256 GitHub publishes (`digest: "sha256:…"`); older releases have none. */
  sha256: string | null;
}

export interface GithubRelease {
  tag: string;
  name: string;
  prerelease: boolean;
  publishedAt: string | null;
  assets: GithubAsset[];
}

function release(x: unknown): GithubRelease | null {
  if (typeof x !== 'object' || x === null) return null;
  const r = x as { tag_name?: unknown; name?: unknown; prerelease?: unknown; draft?: unknown; published_at?: unknown; assets?: unknown };
  if (typeof r.tag_name !== 'string' || r.draft === true) return null;
  const assets: GithubAsset[] = [];
  for (const a of Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]) : []) {
    if (typeof a?.name !== 'string' || typeof a.size !== 'number' || typeof a.browser_download_url !== 'string') continue;
    const d = typeof a.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(a.digest) : null;
    assets.push({ name: a.name, size: a.size, url: a.browser_download_url, sha256: d ? d[1]!.toLowerCase() : null });
  }
  return { tag: r.tag_name, name: typeof r.name === 'string' ? r.name : '', prerelease: r.prerelease === true, publishedAt: typeof r.published_at === 'string' ? r.published_at : null, assets };
}

/** A repository's releases (the newest 100), as GitHub lists them. */
export async function githubReleases(get: Get, base: string, repo: string): Promise<GithubRelease[]> {
  const list = await getJson(get, 'github', `${base}/repos/${repo}/releases?per_page=100`);
  if (!Array.isArray(list)) throw new Error(`GitHub's release list for ${repo} has an unexpected shape`);
  return list.map(release).filter((r): r is GithubRelease => r !== null);
}

/** One release by tag; null when there is none. */
export async function githubRelease(get: Get, base: string, repo: string, tag: string): Promise<GithubRelease | null> {
  const r = await getJson(get, 'github', `${base}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  return r === null ? null : release(r);
}

// ------------------------------------------------------------------ TShock

/** The Linux x86-64 build: `…-linux-x64-Release.zip` (6.x and pre-releases), `…-linux-amd64-Release.zip` (5.x). */
export const TSHOCK_ASSET = /-linux-(?:x64|amd64)-Release\.zip$/;

/** The Terraria version a TShock release is for: only its name says (`TShock 6.2.1 for Terraria 1.4.5.8`). */
export function tshockTerraria(name: string): string | null {
  return /\bfor Terraria (\d+(?:\.\d+){2,3})\b/.exec(name)?.[1] ?? null;
}

/** A TShock release the panel offers: a tag it takes and a Linux x86-64 build. */
export function tshockAsset(r: GithubRelease): GithubAsset | null {
  if (!TSHOCK_TAG.test(r.tag)) return null;
  return r.assets.find((a) => TSHOCK_ASSET.test(a.name)) ?? null;
}

/** TShock's releases, newest first; pre-releases carry `channel: 'prerelease'` and a warning. */
export function tshockVersions(releases: readonly GithubRelease[]): TerrariaVersionInfo[] {
  return releases
    .filter((r) => tshockAsset(r) !== null)
    .map((r): TerrariaVersionInfo => {
      const terraria = tshockTerraria(r.name);
      return {
        id: r.tag,
        channel: r.prerelease ? 'prerelease' : 'stable',
        ...(terraria ? { terraria, description: `for Terraria ${terraria}` } : {}),
        ...(unix(r.publishedAt) !== undefined ? { timeUpdated: unix(r.publishedAt) } : {}),
        ...(r.prerelease ? { warning: 'tshock-prerelease' as const } : {}),
      };
    })
    .sort((a, b) => (b.timeUpdated ?? 0) - (a.timeUpdated ?? 0));
}

// ------------------------------------------------------------------ tModLoader

/**
 * A tModLoader release's channel: stable ones are named `1.4.4-refs/heads/stable
 * Version Update: …` and are not pre-releases, previews `…/preview…` and are.
 * Null for anything else, such as the old legacy builds re-published as
 * pre-releases (`v2022.09.48.2` "1.4.3-Legacy", `v0.11.8.11`).
 */
export function tmlChannel(r: GithubRelease): 'stable' | 'preview' | null {
  if (!TML_TAG.test(r.tag) || !r.assets.some((a) => a.name === 'tModLoader.zip')) return null;
  if (!r.prerelease && /\/stable\b/.test(r.name)) return 'stable';
  if (r.prerelease && /\/preview\b/.test(r.name)) return 'preview';
  return null;
}

/** The Terraria line a tModLoader release is built on (`1.4.4` from `1.4.4-refs/heads/stable …`). */
export function tmlTerraria(name: string): string | null {
  return /^(\d+\.\d+\.\d+)-/.exec(name)?.[1] ?? null;
}

/** tModLoader's stable and preview releases, newest first; previews carry a warning. */
export function tmlVersions(releases: readonly GithubRelease[]): TerrariaVersionInfo[] {
  return releases
    .flatMap((r): TerrariaVersionInfo[] => {
      const channel = tmlChannel(r);
      if (!channel) return [];
      const terraria = tmlTerraria(r.name);
      return [
        {
          id: r.tag,
          channel,
          ...(terraria ? { terraria, description: `Terraria ${terraria}` } : {}),
          ...(unix(r.publishedAt) !== undefined ? { timeUpdated: unix(r.publishedAt) } : {}),
          ...(channel === 'preview' ? { warning: 'tml-preview' as const } : {}),
        },
      ];
    })
    .sort((a, b) => (b.timeUpdated ?? 0) - (a.timeUpdated ?? 0));
}
