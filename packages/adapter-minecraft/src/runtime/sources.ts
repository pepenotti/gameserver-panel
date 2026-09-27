/**
 * The download services a Minecraft install reads (UPD-01, UPD-02), as
 * measured on 2026-09-25/27: Mojang's version manifest and version files,
 * PaperMC's Fill v3 API, Fabric's meta API. Answers are cached for as long
 * as each service says (`Cache-Control`), so a version list and the install
 * right after it ask once.
 */
import { createHash } from 'node:crypto';
import type { InstallCtx, RuntimeCtx } from '@gsp/adapter-api';
import { DOWNLOAD_SOURCES } from '../shared/install';
import { isPaperChannel, type PaperChannel } from '../shared/launch';

type SourceId = keyof typeof DOWNLOAD_SOURCES;

/** Measured `max-age`s: piston-meta 120 s, Fill 1800 s (project) and 300 s (builds), Fabric meta 1800 s. */
const TTL_MS = { manifest: 120_000, versionFile: 24 * 3_600_000, paperProject: 1_800_000, paperBuilds: 300_000, fabric: 1_800_000 };
const cache = new Map<string, { until: number; text: string }>();

/** A base URL from the environment (tests, the dev loop) or the real service. */
export function sourceBase(ctx: RuntimeCtx, id: SourceId): { url: string; overridden: boolean } {
  const s = DOWNLOAD_SOURCES[id];
  const v = ctx.env[s.env];
  if (v === undefined || v === '') return { url: s.url, overridden: false };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${s.env} is not a URL`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${s.env} must be an http(s) URL`);
  return { url: v.replace(/\/+$/, ''), overridden: true };
}

/**
 * A URL a service's answer points at (a version file, a jar, an installer):
 * HTTPS, or on a service the environment points elsewhere.
 */
export function checkUrl(ctx: RuntimeCtx, url: unknown, what: string): string {
  if (typeof url !== 'string') throw new Error(`No download address for ${what}`);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Bad download address for ${what}`);
  }
  if (u.protocol === 'https:') return url;
  const local = (Object.keys(DOWNLOAD_SOURCES) as SourceId[]).map((id) => sourceBase(ctx, id)).filter((s) => s.overridden);
  if (local.some((s) => new URL(s.url).origin === u.origin)) return url;
  throw new Error(`Refusing a download of ${what} that isn't HTTPS: ${u.origin}`);
}

const hosts: Record<SourceId, string> = { mojang: "Mojang's download service", paper: "PaperMC's download service", fabric: "Fabric's download service" };

/** GETs through the agent's `InstallCtx.fetch`, cached; `null` for the statuses `missing` lists. */
export class Api {
  constructor(private readonly ctx: InstallCtx) {}

  private get fetch(): (url: string) => Promise<Response> {
    if (!this.ctx.fetch) throw new Error('This agent cannot download: InstallCtx.fetch is missing');
    return this.ctx.fetch;
  }

  base(id: SourceId): string {
    return sourceBase(this.ctx, id).url;
  }

  /** The body as text; null when the status is one of `missing`. */
  async text(src: SourceId, url: string, ttlMs: number, missing: number[] = [404]): Promise<string | null> {
    const hit = cache.get(url);
    if (hit && hit.until > Date.now()) return hit.text;
    const res = await this.fetch(url);
    if (missing.includes(res.status)) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(res.status === 429 ? `${hosts[src]} is limiting requests (HTTP 429); try again later` : `${hosts[src]} answered HTTP ${res.status}`);
    }
    const text = await res.text();
    cache.set(url, { until: Date.now() + ttlMs, text });
    return text;
  }

  async json<T>(src: SourceId, url: string, ttlMs: number, missing?: number[]): Promise<T | null> {
    const text = await this.text(src, url, ttlMs, missing);
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${hosts[src]} sent something that isn't JSON`);
    }
  }
}

// ------------------------------------------------------------------- Mojang

export interface ManifestEntry {
  id: string;
  type: string;
  url: string;
  releaseTime: string;
  sha1: string;
}

export async function mojangVersions(api: Api): Promise<ManifestEntry[]> {
  const m = await api.json<{ versions?: unknown }>('mojang', `${api.base('mojang')}/mc/game/version_manifest_v2.json`, TTL_MS.manifest);
  if (!m || !Array.isArray(m.versions)) throw new Error("Mojang's version list has an unexpected shape");
  return (m.versions as Record<string, unknown>[]).filter((v): v is Record<string, unknown> & ManifestEntry => typeof v.id === 'string' && typeof v.type === 'string' && typeof v.url === 'string' && typeof v.sha1 === 'string');
}

export interface VersionFile {
  javaMajor: number;
  server: { url: string; sha1: string; size: number } | null;
}

/** A version file, checked against the SHA-1 the manifest gives for it. */
export async function mojangVersionFile(ctx: RuntimeCtx, api: Api, entry: ManifestEntry): Promise<VersionFile> {
  const url = checkUrl(ctx, entry.url, `Minecraft ${entry.id}'s version file`);
  const text = await api.text('mojang', url, TTL_MS.versionFile);
  if (text === null) throw new Error(`Mojang has no version file for Minecraft ${entry.id}`);
  if (createHash('sha1').update(text, 'utf8').digest('hex') !== entry.sha1.toLowerCase()) throw new Error(`Minecraft ${entry.id}'s version file does not match Mojang's version list`);
  const v = JSON.parse(text) as { javaVersion?: { majorVersion?: unknown }; downloads?: { server?: { url?: unknown; sha1?: unknown; size?: unknown } } };
  const major = v.javaVersion?.majorVersion;
  if (typeof major !== 'number' || !Number.isInteger(major)) throw new Error(`Minecraft ${entry.id} doesn't say which Java it needs`);
  const s = v.downloads?.server;
  const server = s && typeof s.url === 'string' && typeof s.sha1 === 'string' && typeof s.size === 'number' ? { url: s.url, sha1: s.sha1, size: s.size } : null;
  return { javaMajor: major, server };
}

// ------------------------------------------------------------------- Paper (Fill v3)

export interface PaperBuild {
  id: number;
  /** ISO time. */
  time: string;
  channel: PaperChannel;
  download: { name: string; url: string; sha256: string; size: number } | null;
}

function paperBuild(x: unknown): PaperBuild | null {
  if (typeof x !== 'object' || x === null) return null;
  const b = x as { id?: unknown; time?: unknown; channel?: unknown; downloads?: Record<string, { name?: unknown; url?: unknown; size?: unknown; checksums?: { sha256?: unknown } }> };
  if (typeof b.id !== 'number' || !isPaperChannel(b.channel)) return null;
  const d = b.downloads?.['server:default'];
  const download =
    d && typeof d.name === 'string' && typeof d.url === 'string' && typeof d.size === 'number' && typeof d.checksums?.sha256 === 'string'
      ? { name: d.name, url: d.url, size: d.size, sha256: d.checksums.sha256 }
      : null;
  return { id: b.id, time: typeof b.time === 'string' ? b.time : '', channel: b.channel, download };
}

const paperVersionPath = (api: Api, version: string) => `${api.base('paper')}/v3/projects/paper/versions/${encodeURIComponent(version)}`;

/** Every version Paper has (pre-releases included). */
export async function paperVersions(api: Api): Promise<string[]> {
  const p = await api.json<{ versions?: Record<string, unknown> }>('paper', `${api.base('paper')}/v3/projects/paper`, TTL_MS.paperProject);
  if (!p || typeof p.versions !== 'object' || p.versions === null) throw new Error("PaperMC's version list has an unexpected shape");
  return Object.values(p.versions).flatMap((g) => (Array.isArray(g) ? g.filter((v): v is string => typeof v === 'string') : []));
}

/** A version's builds, newest first (every channel); null when Paper has no such version. */
export async function paperBuilds(api: Api, version: string): Promise<PaperBuild[] | null> {
  const list = await api.json<unknown[]>('paper', `${paperVersionPath(api, version)}/builds`, TTL_MS.paperBuilds);
  if (list === null) return null;
  if (!Array.isArray(list)) throw new Error("PaperMC's build list has an unexpected shape");
  return list.map(paperBuild).filter((b): b is PaperBuild => b !== null);
}

/** One build (`latest`: the newest of any channel); null when there is none. */
export async function paperBuildById(api: Api, version: string, build: number | 'latest'): Promise<PaperBuild | null> {
  const b = await api.json<unknown>('paper', `${paperVersionPath(api, version)}/builds/${build}`, TTL_MS.paperBuilds);
  return b === null ? null : paperBuild(b);
}

// ------------------------------------------------------------------- Fabric

export interface FabricVersion {
  version: string;
  stable: boolean;
}

function fabricEntries(x: unknown): (FabricVersion & Record<string, unknown>)[] {
  if (!Array.isArray(x)) throw new Error("Fabric's version list has an unexpected shape");
  return x.filter((v): v is FabricVersion & Record<string, unknown> => typeof v?.version === 'string' && typeof v?.stable === 'boolean');
}

function fabricList(x: unknown): FabricVersion[] {
  return fabricEntries(x).map((v) => ({ version: v.version, stable: v.stable }));
}

/** Minecraft versions Fabric supports (`stable` marks releases). */
export async function fabricGames(api: Api): Promise<FabricVersion[]> {
  return fabricList(await api.json('fabric', `${api.base('fabric')}/v2/versions/game`, TTL_MS.fabric));
}

/** Every Fabric Loader, newest first (only the newest is flagged stable). */
export async function fabricLoaders(api: Api): Promise<FabricVersion[]> {
  return fabricList(await api.json('fabric', `${api.base('fabric')}/v2/versions/loader`, TTL_MS.fabric));
}

/** The loaders for one Minecraft version, newest first; null when Fabric doesn't support it (a 400). */
export async function fabricLoadersFor(api: Api, game: string): Promise<FabricVersion[] | null> {
  const x = await api.json<{ loader?: unknown }[]>('fabric', `${api.base('fabric')}/v2/versions/loader/${encodeURIComponent(game)}`, TTL_MS.fabric, [400, 404]);
  if (x === null) return null;
  if (!Array.isArray(x)) throw new Error("Fabric's loader list has an unexpected shape");
  return fabricList(x.map((e) => e.loader));
}

export interface FabricInstaller extends FabricVersion {
  url: string;
}

export async function fabricInstallers(api: Api): Promise<FabricInstaller[]> {
  const x = await api.json<unknown>('fabric', `${api.base('fabric')}/v2/versions/installer`, TTL_MS.fabric);
  return fabricEntries(x).flatMap((v) => (typeof v.url === 'string' ? [{ version: v.version, stable: v.stable, url: v.url }] : []));
}

/** The SHA-256 maven publishes next to a file (`<url>.sha256`). */
export async function mavenSha256(api: Api, url: string): Promise<string> {
  const text = await api.text('fabric', `${url}.sha256`, TTL_MS.fabric);
  const hex = text?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) throw new Error("Fabric's installer has no SHA-256 to check it against");
  return hex;
}

/** Forgets every cached answer (tests). */
export function clearSourceCache(): void {
  cache.clear();
}
