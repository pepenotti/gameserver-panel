/**
 * Version lists from the download services (UPD-02), as measured on
 * 2026-09-25/27 (docs/verification/minecraft-26.3.md, "Install and pinning"
 * and "Paper's build channels"), with nothing but a GET: the panel's create
 * form asks them before a server, and so an agent, exists. Pure: whoever
 * calls brings the GET (the panel's own, with its User-Agent and timeout).
 * The agent's install and `versions()` read the same services in
 * `runtime/sources.ts`.
 */
import { DOWNLOAD_SOURCES } from './install';
import { compareVersions, isOffered, isPaperChannel, type PaperChannel } from './launch';

/** A GET; resolves with any status, rejects when nothing answered. */
export type Get = (url: string) => Promise<Response>;

export type SourceId = keyof typeof DOWNLOAD_SOURCES;

const NAMES: Record<SourceId, string> = { mojang: "Mojang's download service", paper: "PaperMC's download service", fabric: "Fabric's download service" };

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

/** A service's JSON answer; null for the statuses in `missing`. */
async function json(get: Get, src: SourceId, url: string, missing: number[] = [404]): Promise<unknown> {
  const res = await get(url);
  if (missing.includes(res.status)) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(res.status === 429 ? `${NAMES[src]} is limiting requests (HTTP 429); try again later` : `${NAMES[src]} answered HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`${NAMES[src]} sent something that isn't JSON`);
  }
}

const newestFirst = (a: string, b: string) => compareVersions(b, a);

/** Runs `fn` over `items`, `n` at a time, keeping their order. */
async function pool<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export interface Release {
  id: string;
  /** ISO time of the release, when Mojang says. */
  time: string | null;
}

/** Mojang's releases the panel offers (1.16.5 and newer, Q11), newest first. */
export async function mojangReleases(get: Get, base: string): Promise<Release[]> {
  const m = (await json(get, 'mojang', `${base}/mc/game/version_manifest_v2.json`)) as { versions?: unknown } | null;
  if (!m || !Array.isArray(m.versions)) throw new Error("Mojang's version list has an unexpected shape");
  const out: Release[] = [];
  for (const v of m.versions as Record<string, unknown>[]) {
    if (typeof v?.id !== 'string' || v.type !== 'release' || !isOffered(v.id)) continue;
    out.push({ id: v.id, time: typeof v.releaseTime === 'string' ? v.releaseTime : null });
  }
  return out.sort((a, b) => newestFirst(a.id, b.id));
}

export interface PaperVersion {
  id: string;
  /** The newest build of any channel (Fill's `/builds/latest`). */
  build: number;
  /**
   * Its channel. Measured on every version from 1.16.5 to 26.3: a version's
   * builds only move ALPHA, BETA, STABLE, so this is the most stable channel
   * the version has a build in.
   */
  channel: PaperChannel;
  time: string | null;
}

/** Paper's versions the panel offers, newest first, each with its newest build (one small request per version). */
export async function paperVersions(get: Get, base: string): Promise<PaperVersion[]> {
  const p = (await json(get, 'paper', `${base}/v3/projects/paper`)) as { versions?: unknown } | null;
  if (!p || typeof p.versions !== 'object' || p.versions === null) throw new Error("PaperMC's version list has an unexpected shape");
  const ids = new Set<string>();
  for (const group of Object.values(p.versions as Record<string, unknown>)) {
    if (Array.isArray(group)) for (const v of group) if (typeof v === 'string' && isOffered(v)) ids.add(v);
  }
  const offered = [...ids].sort(newestFirst);
  const latest = await pool(offered, 4, async (id): Promise<PaperVersion | null> => {
    const b = (await json(get, 'paper', `${base}/v3/projects/paper/versions/${encodeURIComponent(id)}/builds/latest`)) as { id?: unknown; channel?: unknown; time?: unknown } | null;
    if (!b || typeof b.id !== 'number' || !isPaperChannel(b.channel)) return null;
    return { id, build: b.id, channel: b.channel, time: typeof b.time === 'string' ? b.time : null };
  });
  return latest.filter((v): v is PaperVersion => v !== null);
}

export interface FabricVersion {
  version: string;
  stable: boolean;
}

function fabricList(x: unknown): FabricVersion[] {
  if (!Array.isArray(x)) throw new Error("Fabric's version list has an unexpected shape");
  return x.filter((v): v is FabricVersion => typeof v?.version === 'string' && typeof v?.stable === 'boolean').map((v) => ({ version: v.version, stable: v.stable }));
}

/** The releases Fabric supports that the panel offers, newest first. */
export async function fabricGames(get: Get, base: string): Promise<string[]> {
  const games = fabricList(await json(get, 'fabric', `${base}/v2/versions/game`));
  return [...new Set(games.filter((g) => g.stable && isOffered(g.version)).map((g) => g.version))].sort(newestFirst);
}

/** The newest stable Fabric Loader (only the newest is flagged stable). */
export async function fabricStableLoader(get: Get, base: string): Promise<string | null> {
  return fabricList(await json(get, 'fabric', `${base}/v2/versions/loader`)).find((l) => l.stable)?.version ?? null;
}

/** The loaders for one release, newest first; null when Fabric doesn't support it. */
export async function fabricLoadersFor(get: Get, base: string, game: string): Promise<FabricVersion[] | null> {
  const x = await json(get, 'fabric', `${base}/v2/versions/loader/${encodeURIComponent(game)}`, [400, 404]);
  if (x === null) return null;
  if (!Array.isArray(x)) throw new Error("Fabric's loader list has an unexpected shape");
  return fabricList(x.map((e: { loader?: unknown }) => e?.loader));
}
