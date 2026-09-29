/**
 * Terraria's launch settings as the panel stores them, what they turn into
 * for the agent (`parseTerrariaLaunch` checks them here and there), and what
 * the create form may pick from (UPD-02), from the download services the
 * runtime half reads (`shared/versions.ts`). The flavour is the server's,
 * picked when it is created; the world is named after the server
 * (`ServerRef.gameName`: fixed once created, and what backups and resets
 * name its files by).
 */
import type { ChoicesCtx, I18n, LaunchChoice, LaunchChoices, LaunchChoicesQuery, LaunchOption, SecretBag, ServerRef } from '@gsp/adapter-api';
import { REPOS, type TerrariaVersionInfo, type VersionWarning } from '../shared/install';
import { FLAVOURS, LARGE_WORLD_MIN_MB, MAX_PLAYERS, parseTerrariaLaunch, TML_CHANNELS, WORLD_SIZES, type TerrariaFlavour, type TerrariaLaunch, type TmlChannel, type WorldSize } from '../shared/launch';
import { TERRARIA_META } from '../shared/meta';
import { githubReleases, RateLimitError, sourceUrls, tmlVersions, tshockVersions, vanillaVersions, type Get } from '../shared/versions';

/** The launch settings the panel stores (the settings row `launch`). */
export interface TerrariaLaunchSettings {
  /**
   * What the server installs (UPD-02): a vanilla version (`1.4.5.8`), a
   * TShock or tModLoader release tag (`v6.2.1`, `v2026.07.3.0`); empty: the
   * newest (TShock's newest full release, tModLoader's newest of its
   * channel), and newer ones as updates (UPD-03).
   */
  version: string;
  /** tModLoader only: the least stable release channel it takes. */
  channel: TmlChannel;
  /** The size of the world the first start (or a world reset) creates. */
  worldSize: WorldSize;
  maxPlayers: number;
  /** A secret (`LaunchOption.secret`): the password players join with; empty: none. */
  password: string;
  /** The game's memory, MiB: the container's limit, less the adapter's overhead. */
  memoryMb: number;
}

const MEMORY = { min: TERRARIA_META.memory.minMb, max: 65_536, step: 256 };

export const TERRARIA_LAUNCH_DEFAULTS: Readonly<TerrariaLaunchSettings> = {
  version: '',
  channel: 'stable',
  // Medium: a world generated in about a minute and a half that most groups of friends fit in.
  worldSize: 2,
  maxPlayers: 8,
  password: '',
  memoryMb: TERRARIA_META.memory.defaultMb,
};

const CHANNEL_LABELS: Record<TmlChannel, I18n> = {
  stable: { en: 'Stable', es: 'Estable' },
  preview: { en: 'Preview (test releases)', es: 'Preview (versiones de prueba)' },
};

const SIZE_LABELS: Record<WorldSize, I18n> = {
  1: { en: 'Small (4200 × 1200)', es: 'Pequeño (4200 × 1200)' },
  2: { en: 'Medium (6400 × 1800)', es: 'Mediano (6400 × 1800)' },
  3: { en: 'Large (8400 × 2400, needs 2 GiB)', es: 'Grande (8400 × 2400, necesita 2 GiB)' },
};

export const TERRARIA_LAUNCH_SCHEMA: LaunchOption[] = [
  {
    key: 'version',
    type: 'string',
    role: 'version',
    default: TERRARIA_LAUNCH_DEFAULTS.version,
    label: { en: 'Version', es: 'Versión' },
    description: {
      en: 'What the server runs. "Newest" follows new releases (players’ games update themselves, and a server on an older version turns them away); a version keeps that one until you change it.',
      es: 'Lo que ejecuta el servidor. "La más nueva" sigue las versiones nuevas (el juego de los jugadores se actualiza solo, y un servidor con una versión anterior no los deja entrar); una versión fija esa hasta que la cambies.',
    },
  },
  {
    key: 'channel',
    type: 'enum',
    flavours: ['tmodloader'],
    default: TERRARIA_LAUNCH_DEFAULTS.channel,
    options: TML_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] })),
    label: { en: 'tModLoader release channel', es: 'Canal de versiones de tModLoader' },
    description: {
      en: 'Which tModLoader releases the server takes: stable ones, or test releases too. Players need the same tModLoader as the server.',
      es: 'Qué versiones de tModLoader acepta el servidor: las estables, o también las de prueba. Los jugadores necesitan el mismo tModLoader que el servidor.',
    },
  },
  {
    key: 'worldSize',
    type: 'enum',
    default: String(TERRARIA_LAUNCH_DEFAULTS.worldSize),
    options: WORLD_SIZES.map((s) => ({ value: s, label: SIZE_LABELS[s] })),
    label: { en: 'World size', es: 'Tamaño del mundo' },
    description: {
      en: 'The size of the world the first start creates (and a world reset). An existing world keeps its size. Bigger worlds take longer to create and more memory.',
      es: 'El tamaño del mundo que crea el primer inicio (y un reinicio del mundo). Un mundo que ya existe conserva su tamaño. Los mundos más grandes tardan más en crearse y usan más memoria.',
    },
  },
  {
    key: 'maxPlayers',
    type: 'integer',
    min: 1,
    max: MAX_PLAYERS,
    default: String(TERRARIA_LAUNCH_DEFAULTS.maxPlayers),
    label: { en: 'Player slots', es: 'Plazas de jugadores' },
    description: { en: 'How many players can be online at once.', es: 'Cuántos jugadores pueden estar conectados a la vez.' },
  },
  {
    key: 'password',
    type: 'string',
    secret: true,
    default: TERRARIA_LAUNCH_DEFAULTS.password,
    label: { en: 'Server password', es: 'Contraseña del servidor' },
    description: {
      en: 'What players type to join; empty lets anyone in. Up to 64 characters, without spaces at either end. It is kept hidden once saved.',
      es: 'Lo que escriben los jugadores para entrar; vacío deja entrar a cualquiera. Hasta 64 caracteres, sin espacios al principio ni al final. Queda oculta una vez guardada.',
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
    default: String(TERRARIA_LAUNCH_DEFAULTS.memoryMb),
    label: { en: 'Game memory', es: 'Memoria del juego' },
    description: {
      en: `Memory for the game, in MiB (a multiple of ${MEMORY.step}); the container gets ${TERRARIA_META.memory.overheadMb} MiB more. A large world needs at least ${LARGE_WORLD_MIN_MB}; tModLoader uses about 1 GiB before any mod, and mods and players add.`,
      es: `Memoria para el juego, en MiB (múltiplo de ${MEMORY.step}); el contenedor recibe ${TERRARIA_META.memory.overheadMb} MiB más. Un mundo grande necesita al menos ${LARGE_WORLD_MIN_MB}; tModLoader usa cerca de 1 GiB antes de cualquier mod, y los mods y los jugadores suman.`,
    },
  },
];

/** What each warning code of the version lists (and tModLoader's preview channel) means (`VersionInfo.warning`, `LaunchChoice.warning`). */
export const TERRARIA_WARNINGS: Record<VersionWarning | 'tml-preview-channel', I18n> = {
  'unverified-download': {
    en: 'terraria.org publishes no checksums, and this version is newer than the ones this panel checked: its download is taken as it comes. Pick a checked version if you want to be sure.',
    es: 'terraria.org no publica sumas de verificación, y esta versión es más nueva que las que este panel verificó: su descarga se toma tal como llega. Elegí una versión verificada si querés estar seguro.',
  },
  'tshock-prerelease': {
    en: 'A TShock test release: it can have bugs that break plugins or damage the world. Take backups often, or pick a full release.',
    es: 'Una versión de prueba de TShock: puede tener errores que rompan plugins o dañen el mundo. Hacé copias de seguridad seguido, o elegí una versión completa.',
  },
  'tml-preview': {
    en: 'A tModLoader test release: mods may not work with it yet, and players need the same preview. The server then takes preview releases.',
    es: 'Una versión de prueba de tModLoader: puede que los mods todavía no funcionen con ella, y los jugadores necesitan la misma preview. El servidor pasa a aceptar versiones preview.',
  },
  'tml-preview-channel': {
    en: 'The server takes tModLoader’s test releases too: mods may not work with them yet, and players need the same version as the server.',
    es: 'El servidor acepta también las versiones de prueba de tModLoader: puede que los mods todavía no funcionen con ellas, y los jugadores necesitan la misma versión que el servidor.',
  },
};

export function isFlavour(x: unknown): x is TerrariaFlavour {
  return typeof x === 'string' && (FLAVOURS as readonly string[]).includes(x);
}

/** Stored or submitted launch settings, over the defaults; throws on values of the wrong type. */
export function parseTerrariaLaunchSettings(input: unknown): TerrariaLaunchSettings {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Launch settings must be an object');
  const s = { ...TERRARIA_LAUNCH_DEFAULTS, ...(input as Partial<TerrariaLaunchSettings>) };
  if (typeof s.version !== 'string') throw new Error('version must be text');
  if (!(TML_CHANNELS as readonly unknown[]).includes(s.channel)) throw new Error(`channel must be one of ${TML_CHANNELS.join(', ')}`);
  if (typeof s.password !== 'string') throw new Error('password must be text');
  if (!Number.isInteger(s.memoryMb) || s.memoryMb % MEMORY.step !== 0) throw new Error(`memoryMb must be a multiple of ${MEMORY.step}`);
  return { version: s.version.trim(), channel: s.channel, worldSize: s.worldSize, maxPlayers: s.maxPlayers, password: s.password, memoryMb: s.memoryMb };
}

/**
 * The agent's params: the flavour is the server's, the world its game name
 * (a server id always is a world name the game takes), the password always
 * given (empty: none), so `serverconfig.txt`'s is the launch's.
 */
export function terrariaToAgent(srv: ServerRef, s: TerrariaLaunchSettings, _secrets: SecretBag = {}): TerrariaLaunch {
  if (!isFlavour(srv.flavour)) throw new Error(`A Terraria server needs a flavour: ${FLAVOURS.join(', ')}`);
  const v = parseTerrariaLaunchSettings(s);
  return parseTerrariaLaunch({
    flavour: srv.flavour,
    version: v.version === '' ? null : v.version,
    channel: srv.flavour === 'tmodloader' ? v.channel : null,
    world: srv.gameName,
    worldSize: v.worldSize,
    maxPlayers: v.maxPlayers,
    password: v.password,
    memoryMb: v.memoryMb,
  });
}

// ------------------------------------------------------------------ choices (UPD-02)

/**
 * How long the panel keeps a service's answer. GitHub allows 60 anonymous
 * calls an hour per address, and counts a 304 too (measured): the create
 * form asks again as someone picks, so the lists are kept here by time,
 * whatever else changes in the question.
 */
export const CHOICES_TTL_MS = 10 * 60_000;
const answers = new Map<string, { until: number; text: string }>();
/** GitHub said no more until then (unix ms). */
let githubBlockedUntil = 0;

/** Forgets what the choices kept (tests). */
export function clearChoicesCache(): void {
  answers.clear();
  githubBlockedUntil = 0;
}

/** The panel's GET, kept by time; a kept answer comes back as a fresh 200, and GitHub's limit is honoured until it resets. */
function keptGet(ctx: ChoicesCtx, githubBase: string): Get {
  return async (url) => {
    const hit = answers.get(url);
    if (hit && hit.until > Date.now()) return new Response(hit.text, { status: 200 });
    const github = url.startsWith(`${githubBase}/`);
    if (github && githubBlockedUntil > Date.now()) throw new RateLimitError(githubBlockedUntil);
    const res = await ctx.fetch(url);
    if (github && (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      githubBlockedUntil = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 3_600_000;
      return res;
    }
    if (!res.ok) return res;
    const text = await res.text();
    answers.set(url, { until: Date.now() + CHOICES_TTL_MS, text });
    return new Response(text, { status: 200 });
  };
}

const day = (unix: number | undefined) => (unix === undefined ? undefined : new Date(unix * 1000).toISOString().slice(0, 10));

function versionChoice(flavour: TerrariaFlavour, v: TerrariaVersionInfo): LaunchChoice {
  const facts = [v.description, day(v.timeUpdated)].filter((x): x is string => !!x);
  return {
    value: v.id,
    ...(facts.length ? { detail: facts.join(', ') } : {}),
    ...(v.channel && flavour !== 'vanilla' ? { channel: v.channel } : {}),
    ...(v.warning ? { warning: v.warning } : {}),
    // A tModLoader preview needs a server that takes previews.
    ...(flavour === 'tmodloader' ? { implies: { channel: v.channel === 'preview' ? 'preview' : 'stable' } } : {}),
  };
}

const NEWEST: I18n = { en: 'Newest (follows new releases)', es: 'La más nueva (sigue las versiones nuevas)' };

/**
 * What the create form (and a server's page) may pick (UPD-02): "newest"
 * first, naming what that is now (and warning when that one does), then
 * every version the flavour's download service offers, newest first; for
 * tModLoader, its channels.
 */
export async function terrariaChoices(q: LaunchChoicesQuery, ctx: ChoicesCtx): Promise<LaunchChoices> {
  if (!isFlavour(q.flavour)) throw new Error(`Unknown flavour ${String(q.flavour)}`);
  const base = sourceUrls(ctx.env);
  const get = keptGet(ctx, base.github);
  let versions: TerrariaVersionInfo[];
  if (q.flavour === 'vanilla') {
    const r = await vanillaVersions(get, base.terraria);
    versions = r.versions;
  } else if (q.flavour === 'tshock') versions = tshockVersions(await githubReleases(get, base.github, REPOS.tshock));
  else versions = tmlVersions(await githubReleases(get, base.github, REPOS.tmodloader));

  // What "newest" installs now: vanilla's newest listed, TShock's newest full release, tModLoader's newest stable.
  const newest = q.flavour === 'vanilla' ? versions[0] : versions.find((v) => v.channel === 'stable');
  const out: LaunchChoices = {
    version: [
      { value: '', label: NEWEST, ...(newest ? { detail: newest.id } : {}), ...(newest?.warning ? { warning: newest.warning } : {}), ...(q.flavour === 'tmodloader' ? { implies: { channel: 'stable' } } : {}) },
      ...versions.map((v) => versionChoice(q.flavour as TerrariaFlavour, v)),
    ],
  };
  if (q.flavour === 'tmodloader') out.channel = TML_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c], ...(c === 'preview' ? { warning: 'tml-preview-channel' } : {}) }));
  return out;
}
