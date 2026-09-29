// What a server's game adapter supports (`GET /api/servers/:sid/meta`, AST-04): pages
// read every game-specific list and label from it (through `useMeta`), so the
// web itself stays game-neutral (NFR-08, PRD §6 "Capability"). Types mirror
// packages/panel/src/routes/meta.ts and packages/adapter-api/src/index.ts.
// Pure: no React, so tests can import it.
import type { OptionMeta } from '@gsp/formats';
import type { Permission } from '@gsp/shared';

/** The adapter contract's capabilities (a web test keeps this list in step with it). */
export const CAPABILITIES = [
  'rcon',
  'stdinConsole',
  'restApi',
  'broadcast',
  'save',
  'hotBackup',
  'players',
  'playerHistory',
  'kick',
  'ban',
  'whitelist',
  'accessLevels',
  'accounts',
  'mods:workshop',
  'mods:modrinth',
  'mods:tshock',
  'settingsForms',
  'presets',
  'liveReload',
  'branches',
  'versionPin',
  'loaders',
  'updateCheck',
  'eula',
  'worldCreate',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Every mod source's capability: a server with any of them has a Mods page. */
export const MOD_CAPABILITIES = CAPABILITIES.filter((c): c is Extract<Capability, `mods:${string}`> => c.startsWith('mods:'));

/** Raw consoles (CON-02): the command box needs one of them. */
export const CONSOLE_CAPABILITIES: readonly Capability[] = ['rcon', 'stdinConsole'];

export type I18n = { en: string; es: string };

export interface CommandDoc {
  name: string;
  syntax: string;
  description: I18n;
  permission?: Permission;
}

/** A launch setting (the contract's `LaunchOption`): an option, plus what it is for. */
export interface LaunchOption extends OptionMeta {
  /** `version`: pins what gets installed; `memory`: sizes the game (the container adds `memory.overheadMb`). */
  role?: 'version' | 'memory';
  /** Unit of a number, shown next to it (`MiB`). */
  unit?: string;
  /** Increment a number must be a multiple of. */
  step?: number;
  /** The flavours this setting is for; absent: every one. */
  flavours?: string[];
  /** A value people choose that is kept hidden (a password): it reads back masked, and sending the mask keeps it. */
  secret?: boolean;
}

/** One value a launch setting may take right now, from the game's download services (the contract's `LaunchChoice`). */
export interface LaunchChoice {
  value: string;
  /** How people read it when the value alone doesn't say. */
  label?: I18n;
  /** A short fact shown with it (its newest build, its date). */
  detail?: string;
  /** The release channel of what it installs. */
  channel?: string;
  /** A code the adapter's `warnings` word: picking it deserves a second thought. */
  warning?: string;
  /** Other launch settings that go with picking it. */
  implies?: Record<string, string>;
}

/** Choices by launch setting key (`GET /api/adapters/:id/choices`, `GET /api/servers/:sid/server/launch/choices`). */
export type LaunchChoices = Record<string, LaunchChoice[]>;

/** Whether a launch setting is for a server of `flavour`. */
export function forFlavour(o: Pick<LaunchOption, 'flavours'>, flavour: string | null): boolean {
  return !o.flavours || (flavour !== null && o.flavours.includes(flavour));
}

/** What a version list starts on (Q13): the newest one without a warning, else the newest. */
export function preferredChoice(list: readonly LaunchChoice[] | undefined): LaunchChoice | undefined {
  return list?.find((c) => !c.warning) ?? list?.[0];
}

/**
 * The settings picking `choice` of a list brings along (`implies`): its
 * values, and for every setting another choice of the list would set, its
 * default again (a channel another version needed goes back to stable).
 */
export function impliedBy(choice: LaunchChoice, list: readonly LaunchChoice[], schema: readonly LaunchOption[]): Record<string, string> {
  const keys = new Set(list.flatMap((c) => Object.keys(c.implies ?? {})));
  const out: Record<string, string> = {};
  for (const k of keys) {
    const dflt = schema.find((o) => o.key === k)?.default;
    const v = choice.implies?.[k] ?? dflt;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** A group of a settings form (the contract's `OptionGroup`, CFG-10); options name theirs in `OptionMeta.group`. */
export interface OptionGroup {
  id: string;
  label: I18n;
  /** Shown behind "Advanced" rather than with the common settings. */
  advanced?: boolean;
}

/** A port a game uses (the contract's `PortDecl`). */
export interface PortDecl {
  id: string;
  proto: 'tcp' | 'udp';
  default: number;
  /** Published on the host (players connect to it); false for ports only the agent uses. */
  publish: boolean;
  sameInsideOut: boolean;
  label: I18n;
}

/** What a ban can name (the contract's `BanTarget`): a name, a SteamID, an address, the id a game client sends, an account the server keeps. */
export type BanTarget = 'username' | 'steamId' | 'ip' | 'uuid' | 'account';

export interface Meta {
  adapter: {
    id: string;
    name: I18n;
    runtime: string;
    memory: { minMb: number; defaultMb: number; overheadMb: number };
    capabilities: Capability[];
  };
  server: { id?: string; name?: string; gameName: string; flavour: string | null };
  capabilities: Capability[];
  /** `choices`: its versions can be listed; `warnings`: what their warning codes mean. */
  launch: { schema: LaunchOption[]; choices?: boolean; warnings?: Record<string, I18n> };
  backupParts: { id: string; label: I18n }[];
  /** `options`: what the scope takes (a new seed, a preset); the others are ignored. */
  resets: { id: string; label: I18n; permission: Permission; removeParts: string[]; options?: { newSeed?: boolean; preset?: boolean } }[];
  /** Lowest first. */
  accessLevels: { id: string; label: I18n }[];
  /** What a ban can name. */
  banTargets?: BanTarget[];
  /** The game bans the address a player joined from, whatever the ban names: everyone sharing it is banned too (warn first). */
  banByAddress?: boolean;
  /** Player commands that work only while the game is stopped (lifting a ban the game keeps in memory). */
  stoppedOnly?: string[];
  /** How the whitelist works: a password per entry (accounts), switched on and off live, listed. */
  whitelist?: { password: boolean; toggle: boolean; list: boolean };
  /** Who holds a level above the lowest can be listed. */
  levelHolders?: boolean;
  modSources: { id: string; capability: Capability; label: I18n }[];
  consoleCatalog: CommandDoc[];
}

/** A game a server can be created from (`GET /api/adapters`, mirrors `AdapterSummary` in packages/panel/src/routes/servers.ts). */
export interface AdapterSummary {
  id: string;
  name: I18n;
  runtime: string;
  arch: string[];
  /** Whether this host runs it natively (HST-05); null when the host couldn't be asked. */
  supported: boolean | null;
  flavours: { id: string; name: I18n }[];
  ports: PortDecl[];
  memory: { minMb: number; defaultMb: number; overheadMb: number };
  capabilities: string[];
  /** Its license must be accepted before a server of it runs (by the owner, D6). */
  eula: boolean;
  /** That license: its name and where to read it; null without one. */
  agreement: { name: I18n; url: string } | null;
  /** `choices`: its versions can be listed before a server exists; `warnings`: what their warning codes mean. */
  launch: { schema: LaunchOption[]; secrets: { key: string; label: I18n }[]; choices?: boolean; warnings?: Record<string, I18n> };
}

/** An inclusive range of host ports. */
export interface PortRange {
  from: number;
  to: number;
}

/** The host in `GET /api/adapters` (mirrors `HostSummary` in packages/panel/src/routes/servers.ts). */
export interface HostSummary {
  arch: string;
  cpus: number;
  memBytes: number;
  /** Where servers may publish ports; null when the host doesn't say (then anywhere from 1024 up). */
  hostPorts: PortRange[] | null;
  /** The most memory one server's container may have, MiB; null when the host doesn't say. */
  maxMemMb: number | null;
}

export interface AdaptersResponse {
  /** Null when the host couldn't be asked. */
  host: HostSummary | null;
  adapters: AdapterSummary[];
}

/** A capability, or any one of several. */
export type CapabilityNeed = Capability | readonly Capability[];

/** What a page or control needs from the adapter: capabilities, or data only meta has (e.g. resets). */
export interface Need {
  capability?: CapabilityNeed;
  when?: (m: Meta) => boolean;
  /** Translation key naming the feature when it isn't unsupported ("mods", "resets"); default: the capabilities' names. */
  feature?: string;
}

/** A Mods page needs a mod source. */
export const NEED_MODS: Need = { capability: MOD_CAPABILITIES, when: (m) => m.modSources.length > 0, feature: 'capabilities.mods' };
/** A Reset page needs reset scopes. */
export const NEED_RESETS: Need = { when: (m) => m.resets.length > 0, feature: 'capabilities.resets' };

export function hasCapability(m: Meta, need: CapabilityNeed): boolean {
  const list: readonly Capability[] = typeof need === 'string' ? [need] : need;
  return list.some((c) => m.capabilities.includes(c));
}

/** Whether the adapter has what `need` asks for; nothing asked means yes. */
export function supports(m: Meta, need: Need): boolean {
  if (need.capability !== undefined && !hasCapability(m, need.capability)) return false;
  return need.when ? need.when(m) : true;
}

/** An adapter-provided label in the UI language. */
export function localize(v: Partial<I18n> | undefined, lang: string): string {
  if (!v) return '';
  return (lang.startsWith('en') ? v.en : v.es) ?? v.en ?? v.es ?? '';
}

/** Translation key of a capability's name (i18next reads ':' as a namespace separator). */
export function capabilityKey(c: string): string {
  return `capabilities.${c.replace(/:(\w)/g, (_, x: string) => x.toUpperCase())}`;
}
