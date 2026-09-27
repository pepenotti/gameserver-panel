/**
 * What the panel half sends the runtime half on every start
 * (`LaunchEnvelope.params` for adapter `minecraft`), and how it is checked.
 */
import { MINECRAFT_META } from './meta';

/** The loaders picked per server (UPD-06); Forge and NeoForge come in M4 (UPD-07). */
export const LOADERS = ['vanilla', 'paper', 'fabric'] as const;
export type Loader = (typeof LOADERS)[number];

/** Paper's build channels, most stable first (Fill v3; the filter is case-sensitive). */
export const PAPER_CHANNELS = ['STABLE', 'BETA', 'ALPHA'] as const;
export type PaperChannel = (typeof PAPER_CHANNELS)[number];

/** The oldest Minecraft offered (Q11): Temurin 17, 21 and 25 run it and everything newer. */
export const MIN_VERSION = '1.16.5';

export interface MinecraftLaunch {
  /** A Minecraft release, `MIN_VERSION` or newer: `26.3`, `1.21.11`. Never changes on its own (UPD-05). */
  version: string;
  loader: Loader;
  /**
   * Paper: the least stable build channel the server takes (UPD-05): STABLE
   * unless an admin picks BETA or ALPHA. Builds of that channel or a more
   * stable one qualify. Null for the other loaders.
   */
  channel: PaperChannel | null;
  /** Paper: one exact build; null takes the newest qualifying build when installing. */
  build: number | null;
  /** Fabric: one exact loader version; null takes the newest stable loader when installing. */
  loaderVersion: string | null;
  /** Heap size for both -Xms and -Xmx, in MiB. */
  memoryMb: number;
}

const RELEASE = /^\d{1,4}(?:\.\d{1,4}){1,3}$/;
const LOADER_VERSION = /^\d[0-9A-Za-z.+-]{0,63}$/;
const MAX_MEMORY_MB = 65_536;

/** A release id (`26.3`, `1.21.11`), not a snapshot, pre-release or release candidate. */
export function isRelease(id: string): boolean {
  return RELEASE.test(id);
}

/** Orders release ids numerically, part by part (`1.21.11` < `26.1` < `26.1.2`); negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** A release the panel may offer (Q11). */
export function isOffered(id: string): boolean {
  return isRelease(id) && compareVersions(id, MIN_VERSION) >= 0;
}

/** How much a channel's builds are trusted: STABLE 2, BETA 1, ALPHA 0. */
export function channelRank(c: PaperChannel): number {
  return PAPER_CHANNELS.length - 1 - PAPER_CHANNELS.indexOf(c);
}

/** Whether a build of channel `build` may be installed on a server pinned to `pinned` (UPD-05). */
export function channelAllows(pinned: PaperChannel, build: PaperChannel): boolean {
  return channelRank(build) >= channelRank(pinned);
}

export function isPaperChannel(x: unknown): x is PaperChannel {
  return typeof x === 'string' && (PAPER_CHANNELS as readonly string[]).includes(x);
}

function asObject(x: unknown): Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new Error('Launch params must be an object');
  return x as Record<string, unknown>;
}

const absent = (v: unknown) => v === undefined || v === null;

/** Checks the panel's launch params; throws with a message naming the field. */
export function parseMinecraftLaunch(input: unknown): MinecraftLaunch {
  const o = asObject(input);
  const bad = (m: string): never => {
    throw new Error(m);
  };
  if (typeof o.loader !== 'string' || !(LOADERS as readonly string[]).includes(o.loader)) bad(`loader must be one of ${LOADERS.join(', ')}`);
  const loader = o.loader as Loader;
  if (typeof o.version !== 'string' || !isRelease(o.version)) bad(`version must be a Minecraft release such as 26.3 (${MIN_VERSION} or newer)`);
  const version = o.version as string;
  if (!isOffered(version)) bad(`version must be ${MIN_VERSION} or newer`);
  const minMb = MINECRAFT_META.memory.minMb;
  if (typeof o.memoryMb !== 'number' || !Number.isInteger(o.memoryMb) || o.memoryMb < minMb || o.memoryMb > MAX_MEMORY_MB) bad(`memoryMb must be a whole number from ${minMb} to ${MAX_MEMORY_MB}`);

  let channel: PaperChannel | null = null;
  let build: number | null = null;
  let loaderVersion: string | null = null;
  if (loader === 'paper') {
    if (!absent(o.channel) && !isPaperChannel(o.channel)) bad(`channel must be one of ${PAPER_CHANNELS.join(', ')}`);
    channel = absent(o.channel) ? 'STABLE' : (o.channel as PaperChannel);
    if (!absent(o.build) && (typeof o.build !== 'number' || !Number.isInteger(o.build) || o.build < 1 || o.build > 1_000_000)) bad('build must be a Paper build number');
    build = absent(o.build) ? null : (o.build as number);
  } else {
    if (!absent(o.channel)) bad('channel is only for Paper');
    if (!absent(o.build)) bad('build is only for Paper');
  }
  if (loader === 'fabric') {
    if (!absent(o.loaderVersion) && (typeof o.loaderVersion !== 'string' || !LOADER_VERSION.test(o.loaderVersion))) bad('loaderVersion must be a Fabric Loader version such as 0.19.5');
    loaderVersion = absent(o.loaderVersion) ? null : (o.loaderVersion as string);
  } else if (!absent(o.loaderVersion)) bad('loaderVersion is only for Fabric');

  return { version, loader, channel, build, loaderVersion, memoryMb: o.memoryMb as number };
}
