/**
 * What the panel half sends the runtime half on every start
 * (`LaunchEnvelope.params` for adapter `terraria`), and how it is checked.
 */
import { TERRARIA_META } from './meta';

export const FLAVOURS = ['vanilla', 'tshock', 'tmodloader'] as const;
export type TerrariaFlavour = (typeof FLAVOURS)[number];

/** tModLoader's release channels, most stable first (its GitHub releases: `…/stable…` and `…/preview…`). */
export const TML_CHANNELS = ['stable', 'preview'] as const;
export type TmlChannel = (typeof TML_CHANNELS)[number];

/** `-autocreate`: 1 small (4200×1200), 2 medium (6400×1800), 3 large (8400×2400), as measured. */
export const WORLD_SIZES = [1, 2, 3] as const;
export type WorldSize = (typeof WORLD_SIZES)[number];

export interface TerrariaLaunch {
  flavour: TerrariaFlavour;
  /**
   * What the server is pinned to (UPD-02): vanilla, a game version
   * (`1.4.5.8`); TShock and tModLoader, a GitHub release tag (`v6.2.1`,
   * `v2026.07.3.0`). Null: the newest (tModLoader: of `channel`; TShock: the
   * newest full release), looked up when installing.
   */
  version: string | null;
  /** tModLoader: the least stable channel it takes (stable unless an admin picks preview); null for the others. */
  channel: TmlChannel | null;
  /**
   * The world's name, and its file (`<data>/Worlds/<world>.wld`); fixed once
   * the world exists (the server's `gameName`). Letters, digits, `_` and `-`:
   * tModLoader names the file after it, and turns other characters into
   * something else.
   */
  world: string;
  /** Size of the world the first start creates (`-autocreate`); an existing world is loaded as it is. */
  worldSize: WorldSize;
  maxPlayers: number;
  /**
   * The server password (a secret): written to `serverconfig.txt`, never on
   * the command line (`/proc/*\/cmdline`). `''`: no password. Null: the
   * file's `password` stays as it is.
   */
  password: string | null;
  /** Memory for the game, MiB: the container limit (with `meta.memory.overheadMb`); Terraria takes no heap flag. */
  memoryMb: number;
}

export const WORLD_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
/** Vanilla versions as terraria.org names its downloads (`1458` = 1.4.5.8): four single digits. */
export const VANILLA_VERSION = /^\d\.\d\.\d\.\d$/;
/** TShock's release tags (`v6.2.1`, `v5.2.4`, `v6.0.0-pre3`). */
export const TSHOCK_TAG = /^v\d{1,3}\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?(?:-[0-9A-Za-z.]{1,20})?$/;
/** tModLoader's release tags (`v2026.07.3.0`). */
export const TML_TAG = /^v\d{4}\.\d{2}\.\d{1,3}\.\d{1,3}$/;
/** Terraria's own limit on players. */
export const MAX_PLAYERS = 255;
const MAX_MEMORY_MB = 65_536;
/** A large world peaked at 1.23 GiB idle with nobody online: less than this is refused. */
export const LARGE_WORLD_MIN_MB = 2048;

/** The download id of a vanilla version (`1.4.5.8` → `1458`). */
export const vanillaId = (version: string) => version.replace(/\./g, '');

/** The version a vanilla download id stands for (`1458` → `1.4.5.8`); null for ids that aren't four digits. */
export function vanillaVersion(id: string): string | null {
  return /^\d{4}$/.test(id) ? id.split('').join('.') : null;
}

/** Orders dotted numbers part by part; negative when `a` is older. */
export function compareDotted(a: string, b: string): number {
  const x = a.replace(/^v/, '').split(/[.-]/).map(Number);
  const y = b.replace(/^v/, '').split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (Number.isNaN(x[i]) ? -1 : (x[i] ?? 0)) - (Number.isNaN(y[i]) ? -1 : (y[i] ?? 0));
    if (d !== 0) return d;
  }
  return 0;
}

function asObject(x: unknown): Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new Error('Launch params must be an object');
  return x as Record<string, unknown>;
}

const absent = (v: unknown) => v === undefined || v === null;

/** Checks the panel's launch params; throws with a message naming the field. */
export function parseTerrariaLaunch(input: unknown): TerrariaLaunch {
  const o = asObject(input);
  const bad = (m: string): never => {
    throw new Error(m);
  };
  if (typeof o.flavour !== 'string' || !(FLAVOURS as readonly string[]).includes(o.flavour)) bad(`flavour must be one of ${FLAVOURS.join(', ')}`);
  const flavour = o.flavour as TerrariaFlavour;

  let version: string | null = null;
  if (!absent(o.version)) {
    if (typeof o.version !== 'string') bad('version must be text');
    const v = o.version as string;
    const [re, example] = flavour === 'vanilla' ? [VANILLA_VERSION, '1.4.5.8'] : flavour === 'tshock' ? [TSHOCK_TAG, 'v6.2.1'] : [TML_TAG, 'v2026.07.3.0'];
    if (!re.test(v)) bad(`version must be a ${flavour === 'vanilla' ? 'Terraria version' : 'release tag'} such as ${example}`);
    version = v;
  }

  let channel: TmlChannel | null = null;
  if (flavour === 'tmodloader') {
    if (!absent(o.channel) && !(TML_CHANNELS as readonly unknown[]).includes(o.channel)) bad(`channel must be one of ${TML_CHANNELS.join(', ')}`);
    channel = absent(o.channel) ? 'stable' : (o.channel as TmlChannel);
  } else if (!absent(o.channel)) bad('channel is only for tModLoader');

  if (typeof o.world !== 'string' || !WORLD_NAME.test(o.world)) bad('world must be 1-32 letters, digits, _ or -, starting with a letter or digit');
  if (typeof o.worldSize !== 'number' || !(WORLD_SIZES as readonly number[]).includes(o.worldSize)) bad('worldSize must be 1 (small), 2 (medium) or 3 (large)');
  if (typeof o.maxPlayers !== 'number' || !Number.isInteger(o.maxPlayers) || o.maxPlayers < 1 || o.maxPlayers > MAX_PLAYERS) bad(`maxPlayers must be a whole number from 1 to ${MAX_PLAYERS}`);

  let password: string | null = null;
  if (!absent(o.password)) {
    if (typeof o.password !== 'string' || o.password.length > 64 || /[\x00-\x1f\x7f]/.test(o.password) || o.password !== o.password.trim()) bad('password must be up to 64 characters, without line breaks or spaces around it');
    password = o.password as string;
  }

  const minMb = TERRARIA_META.memory.minMb;
  if (typeof o.memoryMb !== 'number' || !Number.isInteger(o.memoryMb) || o.memoryMb < minMb || o.memoryMb > MAX_MEMORY_MB) bad(`memoryMb must be a whole number from ${minMb} to ${MAX_MEMORY_MB}`);
  if (o.worldSize === 3 && (o.memoryMb as number) < LARGE_WORLD_MIN_MB) bad(`a large world (worldSize 3) needs memoryMb of at least ${LARGE_WORLD_MIN_MB}: one took 1.2 GiB with nobody online`);

  return { flavour, version, channel, world: o.world as string, worldSize: o.worldSize as WorldSize, maxPlayers: o.maxPlayers as number, password, memoryMb: o.memoryMb as number };
}
