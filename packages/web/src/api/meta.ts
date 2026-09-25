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
  launch: { schema: OptionMeta[] };
  backupParts: { id: string; label: I18n }[];
  resets: { id: string; label: I18n; permission: Permission; removeParts: string[]; options?: { newSeed?: boolean; preset?: boolean } }[];
  /** Lowest first. */
  accessLevels: { id: string; label: I18n }[];
  /** What a ban can name. */
  banTargets?: ('username' | 'steamId' | 'ip')[];
  modSources: { id: string; capability: Capability; label: I18n }[];
  consoleCatalog: CommandDoc[];
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
