/**
 * Minecraft's launch settings as the panel stores them, what they turn into
 * for the agent, and what the create form may pick from (UPD-02, UPD-05,
 * UPD-06, Q11, Q13). The loader is the server's flavour, picked when it is
 * created; the version never changes on its own.
 */
import type { ChoicesCtx, I18n, LaunchChoice, LaunchChoices, LaunchChoicesQuery, LaunchOption, SecretBag, ServerRef } from '@gsp/adapter-api';
import { channelRank, isPaperChannel, LOADERS, MIN_VERSION, PAPER_CHANNELS, parseMinecraftLaunch, type Loader, type MinecraftLaunch, type PaperChannel } from '../shared/launch';
import { MINECRAFT_META } from '../shared/meta';
import { fabricGames, fabricLoadersFor, fabricStableLoader, mojangReleases, paperVersions, sourceUrls } from '../shared/versions';

/** The launch settings the panel stores (the settings row `launch`). */
export interface MinecraftLaunchSettings {
  /** A Minecraft release, 1.16.5 or newer (Q11). */
  version: string;
  /** Paper only: the least stable build channel the server takes (UPD-05). */
  channel: PaperChannel;
  /** Fabric only: a pinned loader version; empty takes the newest stable one. */
  loaderVersion: string;
  /** Heap for -Xms and -Xmx, MiB. */
  memoryMb: number;
}

/**
 * The version a server gets when none is asked for (the create form always
 * picks one from the download services). Measured: 26.2 has STABLE Paper
 * builds (26.3 had only ALPHA ones), and it is a Minecraft release on Java 25.
 */
export const DEFAULT_VERSION = '26.2';

export const MINECRAFT_LAUNCH_DEFAULTS: Readonly<MinecraftLaunchSettings> = { version: DEFAULT_VERSION, channel: 'STABLE', loaderVersion: '', memoryMb: MINECRAFT_META.memory.defaultMb };

const MEMORY = { min: MINECRAFT_META.memory.minMb, max: 65_536, step: 256 };

const CHANNEL_LABELS: Record<PaperChannel, I18n> = {
  STABLE: { en: 'Stable', es: 'Estable' },
  BETA: { en: 'Beta (test builds)', es: 'Beta (versiones de prueba)' },
  ALPHA: { en: 'Alpha (early test builds)', es: 'Alfa (primeras versiones de prueba)' },
};

export const MINECRAFT_LAUNCH_SCHEMA: LaunchOption[] = [
  {
    key: 'version',
    type: 'string',
    role: 'version',
    default: MINECRAFT_LAUNCH_DEFAULTS.version,
    label: { en: 'Minecraft version', es: 'Versión de Minecraft' },
    description: {
      en: `The Minecraft release this server runs (${MIN_VERSION} or newer). It never changes by itself: updates only bring newer builds of this same version.`,
      es: `La versión de Minecraft que ejecuta este servidor (${MIN_VERSION} o más nueva). Nunca cambia sola: las actualizaciones solo traen compilaciones nuevas de esta misma versión.`,
    },
  },
  {
    key: 'channel',
    type: 'enum',
    flavours: ['paper'],
    default: MINECRAFT_LAUNCH_DEFAULTS.channel,
    options: PAPER_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] })),
    label: { en: 'Paper build channel', es: 'Canal de compilaciones de Paper' },
    description: {
      en: 'Which Paper builds the server accepts: this channel or a more stable one. Stable unless you need a version Paper is still testing.',
      es: 'Qué compilaciones de Paper acepta el servidor: las de este canal o uno más estable. Estable, salvo que necesites una versión que Paper todavía está probando.',
    },
  },
  {
    key: 'loaderVersion',
    type: 'string',
    flavours: ['fabric'],
    default: MINECRAFT_LAUNCH_DEFAULTS.loaderVersion,
    label: { en: 'Fabric Loader version', es: 'Versión de Fabric Loader' },
    description: {
      en: 'Empty: the newest stable loader when the server is installed, and newer stable ones as updates. A version number keeps that one.',
      es: 'Vacío: el loader estable más nuevo al instalar el servidor, y los estables más nuevos como actualizaciones. Un número de versión fija ese.',
    },
  },
  {
    key: 'memoryMb',
    type: 'integer',
    role: 'memory',
    unit: 'MiB',
    step: MEMORY.step,
    min: MEMORY.min,
    max: MEMORY.max,
    default: String(MINECRAFT_LAUNCH_DEFAULTS.memoryMb),
    label: { en: 'Java memory', es: 'Memoria de Java' },
    description: {
      en: `Java heap for the game, in MiB (a multiple of ${MEMORY.step}). The container gets about ${MINECRAFT_META.memory.overheadMb} MiB more; plugins, mods and many players need more of both.`,
      es: `Memoria de Java para el juego, en MiB (múltiplo de ${MEMORY.step}). El contenedor recibe unos ${MINECRAFT_META.memory.overheadMb} MiB más; los plugins, los mods y muchos jugadores necesitan más de las dos.`,
    },
  },
];

/** Why a choice deserves a second thought (`VersionInfo.warning`, `LaunchChoice.warning`). */
export const MINECRAFT_WARNINGS: Record<string, I18n> = {
  // Q13: offered, with this warning, and the server then needs that channel.
  'paper-no-stable-build': {
    en: 'Paper has no stable build of this version yet, only test builds. They can have bugs that damage a world: take backups often, or pick an older version.',
    es: 'Paper todavía no tiene una compilación estable de esta versión, solo de prueba. Pueden tener errores que dañen el mundo: hacé copias de seguridad seguido, o elegí una versión anterior.',
  },
  // UPD-05: BETA or ALPHA only when an admin picks them.
  'paper-unstable-channel': {
    en: 'Test builds come before Paper calls a version stable and can have bugs. The server takes builds of this channel or a more stable one.',
    es: 'Las compilaciones de prueba salen antes de que Paper declare estable una versión y pueden tener errores. El servidor toma compilaciones de este canal o de uno más estable.',
  },
  'paper-channel-empty': {
    en: 'This version has no build on this channel yet: the server can’t be installed until one comes out. Pick a less stable channel or another version.',
    es: 'Esta versión todavía no tiene compilaciones en este canal: el servidor no se puede instalar hasta que salga una. Elegí un canal menos estable u otra versión.',
  },
};

export function isLoader(x: unknown): x is Loader {
  return typeof x === 'string' && (LOADERS as readonly string[]).includes(x);
}

/** Stored or submitted launch settings, over the defaults; throws on values of the wrong type. */
export function parseMinecraftLaunchSettings(input: unknown): MinecraftLaunchSettings {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Launch settings must be an object');
  const s = { ...MINECRAFT_LAUNCH_DEFAULTS, ...(input as Partial<MinecraftLaunchSettings>) };
  if (typeof s.version !== 'string') throw new Error('version must be a Minecraft release such as 26.3');
  if (!isPaperChannel(s.channel)) throw new Error(`channel must be one of ${PAPER_CHANNELS.join(', ')}`);
  if (typeof s.loaderVersion !== 'string') throw new Error('loaderVersion must be text');
  if (!Number.isInteger(s.memoryMb) || s.memoryMb % MEMORY.step !== 0) throw new Error(`memoryMb must be a multiple of ${MEMORY.step}`);
  return { version: s.version.trim(), channel: s.channel, loaderVersion: s.loaderVersion.trim(), memoryMb: s.memoryMb };
}

/**
 * The agent's params (`parseMinecraftLaunch` checks them here and there):
 * the loader is the server's flavour; settings of other loaders are left
 * out; no Paper build is pinned (the newest qualifying one is installed,
 * and newer ones come as updates).
 */
export function minecraftToAgent(srv: ServerRef, s: MinecraftLaunchSettings, _secrets: SecretBag = {}): MinecraftLaunch {
  if (!isLoader(srv.flavour)) throw new Error(`A Minecraft server needs a loader: ${LOADERS.join(', ')}`);
  const v = parseMinecraftLaunchSettings(s);
  const loader = srv.flavour;
  return parseMinecraftLaunch({
    version: v.version,
    loader,
    channel: loader === 'paper' ? v.channel : null,
    build: null,
    loaderVersion: loader === 'fabric' && v.loaderVersion !== '' ? v.loaderVersion : null,
    memoryMb: v.memoryMb,
  });
}

const day = (iso: string | null) => (iso && /^\d{4}-\d\d-\d\d/.test(iso) ? iso.slice(0, 10) : undefined);

/**
 * What the create form (and a server's page) may pick, from the download
 * services: the versions of the loader, and for the version picked so far
 * Paper's channels or Fabric's loaders (UPD-02). Paper versions whose newest
 * build isn't STABLE carry the Q13 warning and imply that build's channel.
 */
export async function minecraftChoices(q: LaunchChoicesQuery, ctx: ChoicesCtx): Promise<LaunchChoices> {
  if (!isLoader(q.flavour)) throw new Error(`Unknown loader ${String(q.flavour)}`);
  const base = sourceUrls(ctx.env);
  const get = (url: string) => ctx.fetch(url);
  if (q.flavour === 'vanilla') {
    return { version: (await mojangReleases(get, base.mojang)).map((r) => ({ value: r.id, ...(day(r.time) ? { detail: day(r.time) } : {}) })) };
  }
  if (q.flavour === 'paper') {
    const versions = await paperVersions(get, base.paper);
    const version: LaunchChoice[] = versions.map((v) => ({
      value: v.id,
      detail: `#${v.build}`,
      channel: v.channel,
      ...(v.channel === 'STABLE' ? {} : { warning: 'paper-no-stable-build', implies: { channel: v.channel } }),
    }));
    // The picked version's newest channel says which channels have a build it qualifies for (builds only move forward).
    const picked = versions.find((v) => v.id === q.version);
    const channel: LaunchChoice[] = PAPER_CHANNELS.map((c) => {
      const empty = picked !== undefined && channelRank(picked.channel) < channelRank(c);
      const warning = empty ? 'paper-channel-empty' : c === 'STABLE' ? null : 'paper-unstable-channel';
      return { value: c, label: CHANNEL_LABELS[c], channel: c, ...(warning ? { warning } : {}) };
    });
    return { version, channel };
  }
  const [games, loader] = await Promise.all([fabricGames(get, base.fabric), fabricStableLoader(get, base.fabric)]);
  const out: LaunchChoices = { version: games.map((id) => ({ value: id, ...(loader ? { detail: loader } : {}) })) };
  if (q.version !== null && games.includes(q.version)) {
    const loaders = (await fabricLoadersFor(get, base.fabric, q.version)) ?? [];
    out.loaderVersion = [
      { value: '', label: { en: 'Newest stable, when installing', es: 'La estable más nueva, al instalar' }, ...(loader ? { detail: loader } : {}) },
      ...loaders.slice(0, 50).map((l) => ({ value: l.version, ...(l.stable ? { channel: 'stable' } : {}) })),
    ];
  }
  return out;
}
