/**
 * A Steam game described by a manifest (G4, D4, PRD §10 "Declarative
 * adapters"): one JSON file per game in `manifests/<id>.json`, checked
 * against `manifest.schema.json` (and the rules `loadManifest` adds) when it
 * is loaded. Each manifest becomes an adapter of its own id, both halves,
 * through `manifestRuntimeAdapter` and `manifestPanelAdapter`. A game a
 * manifest can't fully describe adds code hooks (`ManifestHooks`).
 *
 * Patterns are JavaScript regular expressions (no flags), matched against a
 * line of the game's output once `log.stripAnsi` and `log.strip` took off
 * what isn't the message. Templates are text with placeholders:
 *   {installDir} {dataDir}  the server's install and data folders (absolute, in its container)
 *   {name}                  the name the game uses for the server's files (`ServerRef.gameName`)
 *   {port:<id>}             the number of a port of `ports`
 *   {setting:<id>}          a launch setting's value (a boolean as `onValue`/`offValue`, else true/false)
 *   {secret:<id>}           a secret of `secrets` (redacted from every log line)
 *   {arg}                   console templates only: the player or message, checked first
 * Where each may be used is checked at load (docs/manifests.md).
 */
import type { Agreement, Arch, BanTarget, FormatId, I18n, Permission, PlayerRefusal } from '@gsp/adapter-api';

export type Pattern = string;
export type Template = string;

export interface SteamGameManifest {
  $schema?: string;
  manifestVersion: 1;
  /** The adapter id servers store: /^[a-z][a-z0-9-]{1,30}$/. */
  id: string;
  name: I18n;
  steam: {
    /** The dedicated server's app; it must install anonymously. */
    appId: string;
    /** The branches offered besides `defaultBranch`: those Steam lists, or a fixed list. */
    branches: 'listed' | string[];
    defaultBranch: string;
  };
  /** Every steamcmd game is x86-64 only (HST-05). */
  arch: Arch[];
  eula?: Agreement;
  /** The container's memory (SRV-05): the game's (a launch setting, `memoryMb`) plus `overheadMb`. */
  memory: { minMb: number; defaultMb: number; overheadMb: number };
  ports: ManifestPort[];
  /** Launch settings people choose: forms, checks, EN/ES. */
  settings: ManifestSetting[];
  /** Secrets the panel generates and keeps for the server (`{secret:<id>}`). */
  secrets?: { id: string; label: I18n }[];
  launch: {
    /** `{installDir}/…`: never anything outside the install. */
    executable: Template;
    args: ArgItem[];
    cwd: Template;
    env?: Record<string, Template>;
  };
  /** Before every start: data folders the game expects to exist (data-root paths, `{name}` only). */
  prepare?: { dirs?: Template[] };
  log?: {
    /** The game colours its lines (ANSI codes): taken off before matching and in the live log. */
    stripAnsi?: boolean;
    /** Taken off the start of each line before matching and in the live log (a timestamp). */
    strip?: Pattern;
    /** Runs of progress lines, each shown as its latest line (CON-01). */
    progress?: { key: string; pattern: Pattern; text?: string }[];
  };
  readiness: {
    ready: Pattern;
    /** Group 1: the game's version. */
    version?: Pattern;
    /** The process is doomed; the crash watchdog names the line (SRV-07). */
    fatal?: Pattern[];
    /** Worth saying once in the log, not fatal (no Steam). */
    warnings?: { id: string; pattern: Pattern; message: I18n }[];
  };
  console: { kind: 'stdin'; prefix?: string; commands?: ManifestCommand[] } | { kind: 'none' };
  /** A clean stop: the console command once the game is up, else the signal; the agent escalates after `budgetMs`. */
  stop: { command?: string; signal: 'SIGINT' | 'SIGTERM'; budgetMs: number };
  /** Asking the game to save: the command and the line that says it finished. */
  save?: { command: string; done: Pattern; budgetMs: number };
  /** The game's own saves on its timer, so a running copy waits one out (`copy-between-saves`). */
  autosave?: { start: Pattern; done: Pattern; budgetMs?: number };
  backups: {
    parts: { id: string; label: I18n; paths: Template[] }[];
    /** How a running server is copied (BAK-02). */
    running: 'save-then-copy' | 'copy-between-saves' | 'stopped-only';
  };
  resets?: { id: string; label: I18n; permission: Permission; removeParts: string[] }[];
  config?: { files: ManifestConfigFile[]; roots?: ManifestRoot[] };
  players?: {
    /** Group 1: the player who joined or left. */
    join?: Pattern;
    leave?: Pattern;
    /** A console command whose reply is a count line (group 1), then one line per player (`item` group 1, or the line). */
    list?: { command: string; count: Pattern; item?: Pattern };
    /** Steam's server queries on a port, when a condition holds: needs the `steamQuery` hook. */
    steamQuery?: { port: string; when?: Condition };
  };
  moderation?: {
    kick?: Template;
    ban?: Template;
    unban?: Template;
    banTargets?: BanTarget[];
    /** Replies that say the game didn't do it (PLY-03). */
    refusals?: { pattern: Pattern; refusal: PlayerRefusal }[];
    /** Moderation by editing list files (config file ids) instead of the console. */
    listFiles?: { ban?: string; allow?: string; admin?: string; target: 'steamId' | 'username'; stoppedOnly: boolean };
  };
  /** A message to every player (`{arg}`). */
  broadcast?: Template;
  notes?: { id: string; text: I18n; doc?: string }[];
  /** How players join (SRV-08): the adapter contract's `JoinDecl`, with settings named as in `settings`. */
  join?: ManifestJoin;
}

/** A launch setting (`settings`), or a key of a config file (`config.files`). */
export type ManifestJoinSetting = { setting: string } | { file: string; key: string };

/** `JoinDecl` in a manifest: a step's condition and the password name a setting by its id, or a config file's key. */
export interface ManifestJoin {
  /** A published port that follows no other. */
  port: string;
  format: 'host:port' | 'separate';
  defaultPort?: number;
  where: I18n;
  client: { name: I18n; sameVersion: boolean };
  steps?: { id: string; text: I18n; when?: ManifestJoinSetting & { equals: string | number | boolean } }[];
  /** A secret setting, or a secret key of a config file. */
  password?: ManifestJoinSetting;
  verified: boolean;
  source: string;
  note?: I18n;
}

export interface ManifestPort {
  /** Lowercase letters and digits: the agent reads `GAME_PORT_<ID>` back in lowercase. */
  id: string;
  proto: 'udp' | 'tcp';
  default: number;
  publish: boolean;
  sameInsideOut: boolean;
  /** Never chosen: always the number of port `id` plus `offset` (a port on both protocols: two ports, offset 0). */
  follows?: { id: string; offset: number };
  label: I18n;
}

export interface Condition {
  setting: string;
  equals?: string | number | boolean;
  notEmpty?: true;
}

export type ArgItem = Template | { if: Condition; args: Template[] };

export type SettingType = 'string' | 'integer' | 'boolean' | 'enum' | 'secret';

export interface ManifestSetting {
  id: string;
  type: SettingType;
  label: I18n;
  description: I18n;
  /** Required, except for a secret (empty: none). */
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: Pattern;
  choices?: { value: string; label: I18n }[];
  onValue?: string;
  offValue?: string;
  advanced?: boolean;
  /** Checks across settings, by the panel before saving and by the agent before a start. */
  rules?: SettingRule[];
}

export interface SettingRule {
  if?: Condition;
  minLength?: number;
  required?: boolean;
  /** The value can't be part of this other setting's (case ignored). */
  notIn?: string;
  message: I18n;
}

export interface ManifestCommand {
  /** As typed after the prefix (`players`), which is how the panel names it. */
  name: string;
  syntax: string;
  description: I18n;
  permission?: Permission;
  secretArgs?: boolean;
}

export interface ManifestConfigFile {
  id: string;
  label?: I18n;
  /** Data-root path (`{name}` only). */
  path: Template;
  format: FormatId;
  /** Keys the agent sets before every start (when the file exists); locked for people (CFG-04). */
  managed?: Record<string, Template>;
  secretKeys?: string[];
  /** The game writes it back from memory: edited only while stopped. */
  stoppedOnly?: boolean;
  restartKeys: '*' | string[];
  /** Written when missing, before a start (the game completes it). */
  seed?: Template;
  note?: I18n;
}

export interface ManifestRoot {
  id: string;
  label: I18n;
  /** Data-root folder (`{name}` only). */
  path: Template;
  include: string[];
  exclude?: string[];
}
