/**
 * The adapter contract (PRD §6, §10, D4). A game adapter is two halves that
 * share one `AdapterMeta`:
 *   - `RuntimeAdapter`, run by the agent next to the game: install, launch,
 *     readiness, control channel, stop, saves and player queries;
 *   - `PanelAdapter`, run by the panel: launch settings, config files and
 *     their schemas, backups, resets, messages, players, mods and updates.
 * The core (shared, formats, agent, panel, web) depends only on this package,
 * never on a game's package (NFR-08, enforced by lint).
 *
 * Types only; the test suites every adapter must pass live under `testing/`.
 */

import type { FormatId, Lang, OptionMeta, Scalar } from '@gsp/formats';
import type {
  AgentStatus,
  CommandRequest,
  CommandResponse,
  CpuArch,
  DirEntry,
  FileKind,
  FileStat,
  InstalledInfo,
  JobKind,
  JobResult,
  PackRequest,
  Permission,
  RootId,
  RuntimeFamily,
  ServerFilesErrorCode,
  VersionInfo,
  VersionsResponse,
} from '@gsp/shared';

export type { AgentStatus, CommandResponse, FormatId, InstalledInfo, JobKind, JobResult, Lang, OptionMeta, Permission, Scalar, VersionInfo, VersionsResponse };
// The file shapes are the agent API's (`/v1/fs/*`, `/v1/archive/*`, D11), so the wire and the contract can't drift.
export type { DirEntry, FileKind, FileStat, PackRequest, RootId, RuntimeFamily, ServerFilesErrorCode };

// =================================================================== common

export type Arch = CpuArch;
export type I18n = { en: string; es: string };

export type Capability =
  | 'rcon'
  | 'stdinConsole'
  | 'restApi'
  | 'broadcast'
  | 'save'
  | 'hotBackup'
  | 'players'
  | 'playerHistory'
  | 'kick'
  | 'ban'
  | 'whitelist'
  | 'accessLevels'
  | 'accounts'
  | 'mods:workshop'
  | 'mods:modrinth'
  | 'mods:tshock'
  | 'settingsForms'
  | 'presets'
  | 'liveReload'
  | 'branches'
  | 'versionPin'
  | 'loaders'
  | 'updateCheck'
  | 'eula'
  | 'worldCreate';

export type ModCapability = Extract<Capability, `mods:${string}`>;

export interface PortDecl {
  /** Stable id (`game`, `rcon`); keys `RuntimeCtx.ports`. */
  id: string;
  proto: 'tcp' | 'udp';
  default: number;
  /** Published on the host (players connect to it); false for ports only the agent uses. */
  publish: boolean;
  /** The game must listen on the same port number it is published on (it tells clients or Steam its port). */
  sameInsideOut: boolean;
  label: I18n;
}

export interface Flavour {
  id: string;
  name: I18n;
  /** Replaces the adapter's capabilities for servers of this flavour. */
  capabilities?: Capability[];
}

/** A license the owner must accept before a game may run (D6): what the `eula` capability means. */
export interface Agreement {
  /** What it is called (the game maker's end-user license). */
  name: I18n;
  /** Where people read it before accepting (https). */
  url: string;
}

export interface AdapterMeta {
  /** Stable id (`pz`); stored with every server. */
  id: string;
  name: I18n;
  runtime: RuntimeFamily;
  arch: Arch[];
  flavours: Flavour[];
  ports: PortDecl[];
  memory: { minMb: number; defaultMb: number; overheadMb: number };
  capabilities: Capability[];
  /** Time a clean stop may take before the agent escalates to signals (NFR-04). */
  stopBudgetMs: number;
  /** The agreement behind the `eula` capability (the adapter's or a flavour's); required with it (D6). */
  eula?: Agreement;
}

// ============================================================== server files

/** Absolute, in-container folders a server's files live in. */
export interface FileRoots {
  /** World, configs, logs: everything backups cover. */
  data: string;
  /** The game install. Never edited except by `install()` (a validate would overwrite it). */
  install: string;
  extra?: Record<string, string>;
}

/**
 * A server's files as the panel reaches them (D11: through that server's
 * agent, `/v1/fs/*` and `/v1/archive/*` in `@gsp/shared`'s agent API, one
 * route per method). Paths are always relative to a root; absolute paths,
 * `..` and symlinks leading out are refused with a `ServerFilesErrorCode`.
 * Staging, swap and trash work in the `data` root; an uncompressed tar
 * stream is what `pack` produces and `stage` consumes.
 */
export interface ServerFiles {
  /** Null when nothing is there. */
  stat(root: RootId, rel: string): Promise<FileStat | null>;
  /** Entries of a folder, sorted by name; empty when it doesn't exist. */
  list(root: RootId, rel: string): Promise<DirEntry[]>;
  /** Null when the file doesn't exist; `too-large` beyond `maxBytes`. */
  read(root: RootId, rel: string, o?: { maxBytes?: number }): Promise<Buffer | null>;
  /** Write through a temporary file and rename, creating folders as needed. */
  writeAtomic(root: RootId, rel: string, data: Buffer | string): Promise<void>;
  /** Delete files or folders (recursively); missing ones are fine. */
  remove(root: RootId, rels: string[]): Promise<void>;
  pack(req: PackRequest): Promise<AsyncIterable<Buffer>>;
  /** Unpack an archive into a staging folder; entries outside `allow` (data-root paths) are refused. */
  stage(archive: AsyncIterable<Buffer>, allow: string[]): Promise<{ stagingId: string; entries: number }>;
  /** Move staged `rels` into place; what they replace goes to a trash folder. */
  swap(stagingId: string, rels: string[]): Promise<{ trashId: string }>;
  /** Put a trash folder's files back. */
  undo(trashId: string): Promise<void>;
  /** Drop one trash folder, or all of them. */
  purgeTrash(trashId?: string): Promise<void>;
}

// ================================================================ agent side

/** What the agent keeps for a server across restarts and hands to its adapter. */
export interface RuntimeState {
  /** Generated once by the agent (today's `rconPassword`); the adapter puts it in the game's config. */
  controlSecret: string;
  /** From the game's version line, of the current or last run. */
  gameVersion: string | null;
}

export interface RuntimeTools {
  /** steamcmd invocation (steam family); tests point it at the fake. */
  steamcmd?: string[];
  /** Replaces the adapter's own launcher when set (tests and the dev loop start the fake server). */
  launcher?: string[];
  /** HOME for tools that keep state there (steamcmd). */
  home: string;
}

export interface RuntimeCtx {
  /** The adapter's `roots()` after the agent's own overrides (dev loop, tests). */
  roots: FileRoots;
  /** The agent's private folder. Never reachable through `ServerFiles`. */
  stateDir: string;
  /** Port numbers by `PortDecl.id`. */
  ports: Record<string, number>;
  state: Readonly<RuntimeState>;
  tools: RuntimeTools;
  /** The agent's environment without its token, for adapter-specific knobs. */
  env: Readonly<Record<string, string | undefined>>;
  /**
   * The owner accepted the game's agreement (`AdapterMeta.eula`, D6), as the
   * panel's launch said (`LaunchEnvelope.eulaAccepted`). A runtime adapter
   * writes the game's own acceptance only when this is true; absent or false
   * otherwise, and for games without an agreement.
   */
  eulaAccepted?: boolean;
  /** A line in the server's agent log (redacted by the agent). */
  log(line: string): void;
}

/** Context of a long job (install, validate, version listing, download actions). */
export interface InstallCtx extends RuntimeCtx {
  /** A tool's output line (steamcmd), shown in the log. */
  onLine(line: string): void;
  /** Job progress; `percent` null when unknown. */
  progress(percent: number | null, message: string): void;
  /** The agent's steamcmd driver, for adapters of the `steam` runtime family. */
  steam?: SteamCmd;
}

/**
 * The agent's steamcmd driver (retries, progress parsing and output go to the
 * job). Adapters pass their own app ids; the agent knows none.
 */
export interface SteamCmd {
  /** `app_update <appId> [-beta <branch>] [validate]` into the install root. */
  appUpdate(o: { appId: string; branch: string | null; validate: boolean }): Promise<JobResult>;
  /** Branches and build ids from `app_info_print` (what is installed is the adapter's `installed()`). */
  branches(o: { appId: string }): Promise<VersionInfo[]>;
  /** `workshop_download_item <workshopAppId> <id>` for each id, into the data root's workshop cache. */
  workshopDownload(o: { workshopAppId: string; ids: string[] }): Promise<JobResult>;
}

/** What one line of game output means. Everything but `message` is optional. */
export interface LineSignal {
  /** The line's text without the game's header; what `waitForLine` matches. */
  message: string;
  /** The game says it is up. */
  ready?: boolean;
  /**
   * The control channel says it is listening. When the adapter has a channel,
   * the agent treats the server as ready after `ready` plus this line, or a
   * short grace period after `ready` alone (PZ: "SERVER STARTED", then
   * "RCON: listening" ~50 ms later).
   */
  channelReady?: boolean;
  /** Game version announced by this line. */
  version?: string;
  /** The game is waiting for console input nobody will type; the agent kills it and says why (alert `blocking-prompt`). */
  blockingPrompt?: string;
  /** The process is doomed even if it hasn't exited yet. */
  fatal?: boolean;
  /** A player joined or left (name). */
  join?: string;
  leave?: string;
  /** A save finished. */
  saved?: boolean;
}

export type ChannelSpec =
  | { kind: 'rcon'; port: number; password: string }
  | { kind: 'stdin' }
  | { kind: 'rest'; baseUrl: string; token: string }
  | { kind: 'none' };

/** `channel`: the control channel (RCON, REST); `stdin`: the game's console. */
export type CommandVia = 'channel' | 'stdin';

/** The running game, as the agent lets an adapter drive it. */
export interface ControlHandle {
  /** False while the game is still starting: its console and channel may not be read yet. */
  readonly ready: boolean;
  /**
   * A console command. Without `via` the channel is tried first and stdin is
   * the fallback. Resolves with the reply text, or null when it went through
   * stdin (which only echoes into the log).
   */
  command(cmd: string, via?: CommandVia): Promise<string | null>;
  /** One line to the game's stdin; false when it can't be written. */
  stdin(line: string): boolean;
  /** Signals the game's whole process group. */
  signal(sig: NodeJS.Signals): void;
  /** The first line whose `LineSignal.message` matches, or null after `timeoutMs`. Call it before sending what triggers the line. */
  waitForLine(re: RegExp, timeoutMs: number): Promise<RegExpExecArray | null>;
}

export interface LaunchCommand {
  argv: string[];
  cwd: string;
  /** Added to the agent's environment (which never includes its token). */
  env?: Record<string, string>;
}

/** Who is online; `count` comes from the game and may exceed the names it listed. */
export interface PlayerList {
  count: number;
  names: string[];
}

export interface RuntimeAction {
  /** Job kind the agent reports while it runs; omit for quick actions. */
  job?: JobKind;
  /** Validates the request input; throws on bad input. */
  parse(x: unknown): unknown;
  /** `ctl` is null when the game isn't running. */
  run(ctx: InstallCtx, ctl: ControlHandle | null, input: unknown): Promise<unknown>;
}

export interface RuntimeAdapter<P = unknown> {
  meta: AdapterMeta;
  /** Validates launch params from the panel; throws on bad input. */
  parseLaunch(input: unknown): P;
  /** Values the agent redacts from every log line (the agent adds its own token). */
  secrets(p: P, st: RuntimeState): string[];
  /** What is installed, or null when nothing is. */
  installed(ctx: RuntimeCtx): InstalledInfo | null;
  install?(ctx: InstallCtx, p: P, o: { validate: boolean }): Promise<JobResult>;
  /**
   * Asked before every start (panel starts, crash restarts, resumed starts):
   * 'required' = install first and fail the start if that fails (nothing
   * installed, or a different branch/version); 'update' = try to update, and
   * start the installed build if that fails; null = start as is.
   */
  installOnStart?(ctx: RuntimeCtx, p: P): 'required' | 'update' | null;
  /** Versions the server can be pinned to (a job: steamcmd output goes to the log). */
  versions?(ctx: InstallCtx, p: P): Promise<VersionsResponse>;
  /** Before every start: files the agent owns (ports, the control secret) are enforced here. */
  prepare(ctx: RuntimeCtx, p: P): Promise<void>;
  command(ctx: RuntimeCtx, p: P): LaunchCommand;
  classify(line: string): LineSignal;
  channel(ctx: RuntimeCtx, p: P): ChannelSpec;
  /** Ask the game to stop cleanly; the agent waits `budgetMs` for the exit, then escalates to signals. */
  stop(ctl: ControlHandle, o: { budgetMs: number }): Promise<void>;
  /** Save the running world and resolve once the game says it finished; the agent reports a failure after `budgetMs`, so stop waiting by then. */
  save?(ctl: ControlHandle, o: { budgetMs: number }): Promise<void>;
  /** Running-server backups: `before` makes the files consistent, `after` always runs. */
  hotCopy?: { before(ctl: ControlHandle): Promise<void>; after(ctl: ControlHandle): Promise<void>; sqlite?: string[] };
  /** Null when the reply wasn't understood. */
  listPlayers?(ctl: ControlHandle): Promise<PlayerList | null>;
  /** Default roots (absolute, in-container); the agent may relocate them (see `RuntimeCtx.roots`). */
  roots(p: P): FileRoots;
  actions?: Record<string, RuntimeAction>;
}

// ================================================================ panel side

/** A server as the panel knows it. */
export interface ServerRef {
  /** Panel id of the server (one server until M2). */
  id: string;
  /** Name the game uses for this server's files (PZ `-servername`); fixed once created. */
  gameName: string;
  /** Flavour id, or null for adapters without flavours. */
  flavour: string | null;
}

/** Secrets the panel holds for a server (PZ: the admin password), by name. */
export type SecretBag = Readonly<Record<string, string>>;

/** A console command for the agent (`POST /v1/command`). */
export type AgentCommand = CommandRequest;

/**
 * The server's config files through the panel's settings service, acting for
 * `ServerCtx.actor`: every write lands in the file's history (CFG-03). For
 * resets and hooks, which run while the server is stopped: no managed-key or
 * busy checks, and the running game isn't asked to re-read anything.
 */
export interface ConfigAccess {
  /** Set keys of a declared config file (`ConfigFileDecl.id`); history note `note`. A file that doesn't exist yet is left alone. */
  set(fileId: string, values: Record<string, Scalar>, note: string): Promise<void>;
  /** Write each declared file's `seed` where that file doesn't exist yet; true if one was written. */
  seedIfMissing(): Promise<boolean>;
  /** Apply one of `config.presets` to the file it names (`presets.fileId`). */
  applyPreset(name: string): Promise<void>;
}

/** A server at run time, for panel-side adapter code. */
export interface ServerCtx {
  srv: ServerRef;
  files: ServerFiles;
  /** Who the operation runs for (a panel user, `scheduler`), for settings history and the audit log; null for the panel itself. */
  actor: string | null;
  /** Latest agent status; null while unknown. */
  status(): AgentStatus | null;
  command(cmd: AgentCommand): Promise<CommandResponse>;
  /** `POST /v1/actions/:name`. */
  action(name: string, input: unknown): Promise<unknown>;
  /** `POST /v1/versions` for the server's stored launch settings. */
  versions(): Promise<VersionsResponse>;
  /** The launch settings the panel stores for the server (the adapter's `S`, over `launch.defaults()`). */
  launchSettings(): unknown;
  config: ConfigAccess;
  /** Each log line the server prints from now on (redacted); returns an unsubscribe. */
  onLog(listener: (line: string) => void): () => void;
}

export interface ConfigFileDecl {
  /** Stable id (`ini`, `sandbox`); history and forms use it. */
  id: string;
  /** What the editor and forms call the file; without it, the file name. */
  label?: I18n;
  root: RootId;
  rel: string;
  format: FormatId;
  /** Key into `config.schemas` for the file's form. */
  schemaId?: string;
  /** Keys the panel or agent owns (ports, RCON, mods); locked in forms and re-applied on raw saves (CFG-04). */
  managedKeys: string[];
  /** Shown masked in forms, raw text and history. */
  secretKeys: string[];
  /** Keys that take effect only after a restart (CFG-05); `*` for every key. */
  restartKeys: string[] | '*';
  /** Written before the first start when the file is missing (the game completes the rest). */
  seed?: Record<string, Scalar>;
  /** The game executes this file: it must parse as plain data of this shape (CFG-02). */
  dataOnly?: { form: 'assign' | 'function'; name: string };
}

/** A folder the text editor may browse (CFG-07, CFG-08). */
export interface EditableRoot {
  id: string;
  root: RootId;
  rel: string;
  /** Globs relative to `rel`. */
  include: string[];
  exclude: string[];
  label: I18n;
}

export interface AfterWriteResult {
  /** `live`: the running server re-read the file; `restart`: takes effect at the next start. */
  applied: 'live' | 'restart';
  /** Values the game rejected when it re-read the file (from its log). */
  warnings: string[];
}

/** A group of a settings form (CFG-10); options name theirs in `OptionMeta.group`. */
export interface OptionGroup {
  id: string;
  label: I18n;
  /** Shown behind "Advanced" rather than with the common settings. */
  advanced?: boolean;
}

export interface PanelAdapterConfig {
  files(srv: ServerRef): ConfigFileDecl[];
  roots(srv: ServerRef): EditableRoot[];
  /** Form schemas by `ConfigFileDecl.schemaId`. */
  schemas: Record<string, OptionMeta[]>;
  /** Each schema's groups, in the order forms show them (by schema id); options without a known group go last. */
  groups?: Record<string, OptionGroup[]>;
  /** Values the panel sets for managed keys, by file id then key; managed keys not listed keep what is on disk. */
  managedValues(srv: ServerRef): Record<string, Record<string, string>>;
  /** After the panel wrote a file of a running server (e.g. the game's reload command, then its log). */
  afterWrite?(ctx: ServerCtx, fileId: string, keys: string[]): Promise<AfterWriteResult>;
  /** Settings presets (CFG-06): values for keys of the declared file `fileId`. */
  presets?: { fileId: string; list(ctx: ServerCtx): Promise<string[]>; load(ctx: ServerCtx, name: string): Promise<Record<string, Scalar>> };
}

export interface BackupPartDecl {
  id: string;
  label: I18n;
  /** Paths relative to the data root. */
  paths(srv: ServerRef): string[];
  /**
   * Globs of SQLite databases, relative to the data root like `paths` (e.g.
   * `**` + `/*.db`), matched against the files those paths hold: copied as
   * consistent snapshots while the game runs.
   */
  sqlite?: string[];
}

export interface ResetOptions {
  newSeed: boolean;
  /** A settings preset to apply to the new world. */
  preset?: string;
}

export interface ResetDecl {
  id: string;
  label: I18n;
  permission: Permission;
  /** `backups.parts` ids deleted by this reset (after a safety backup). */
  removeParts: string[];
  /** The `ResetOptions` this scope uses (a new seed, a preset); the others are ignored. */
  options?: { newSeed?: boolean; preset?: boolean };
  after?(ctx: ServerCtx, o: ResetOptions): Promise<void>;
}

/** Why players are warned in game (the panel's countdowns). */
export type AnnounceKind = 'restart' | 'stop' | 'update' | 'restore' | 'reset';

export interface PlayerTarget {
  username?: string;
  steamId?: string;
  ip?: string;
}

/** What a ban can name: `PlayerTarget`'s fields. */
export type BanTarget = 'username' | 'steamId' | 'ip';

/** An access level `setAccess` takes, with its name for people. */
export interface AccessLevel {
  id: string;
  label: I18n;
}

export interface PlayerAccount {
  username: string;
  displayName: string | null;
  role: string;
  lastConnection: string | null;
  steamId: string | null;
}

export interface BanList {
  steamIds: { steamId: string; reason: string | null }[];
  ips: { ip: string; username: string | null; reason: string | null }[];
}

/**
 * Moderation. Each command resolves with the game's reply; arguments the game
 * can't take are refused with `RconProtocolError` from `@gsp/formats`.
 */
export interface PlayerOps {
  /** Levels `setAccess` accepts, lowest first. */
  accessLevels?: readonly AccessLevel[];
  /** The `PlayerTarget` fields `ban` and `unban` accept; a UI offers only these. */
  banTargets?: readonly BanTarget[];
  kick?(ctx: ServerCtx, username: string, reason?: string): Promise<string>;
  ban?(ctx: ServerCtx, target: PlayerTarget, reason?: string): Promise<string>;
  unban?(ctx: ServerCtx, target: PlayerTarget): Promise<string>;
  setAccess?(ctx: ServerCtx, username: string, level: string): Promise<string>;
  whitelistAdd?(ctx: ServerCtx, username: string, password?: string): Promise<string>;
  whitelistRemove?(ctx: ServerCtx, username: string): Promise<string>;
  accounts?(ctx: ServerCtx): Promise<PlayerAccount[]>;
  bans?(ctx: ServerCtx): Promise<BanList>;
}

/** An item as the mod source's catalogue describes it. */
export interface ModDetails {
  id: string;
  /** Exists and is for this game. */
  ok: boolean;
  title: string;
  previewUrl: string | null;
  /** Unix seconds; newer than at the last scan means an update. */
  timeUpdated: number;
  isCollection?: boolean;
}

/** One mod found inside a downloaded item. */
export interface ModEntry {
  modId: string;
  name: string;
  require: string[];
  incompatible: string[];
  compatible: boolean;
  /** Why not compatible: a stable code the UI translates. */
  reason: string | null;
}

export interface EnabledMod {
  modId: string;
  /** Item (workshop id, project id) the mod comes from. */
  itemId: string;
}

export interface ModSource<M extends ModEntry = ModEntry> {
  id: string;
  capability: ModCapability;
  label: I18n;
  /** An item id from what a person pasted (an id or a page URL); null when it isn't one. */
  parseRef(input: string): string | null;
  /** Items inside a collection or modpack; empty for a normal item. */
  expand?(id: string): Promise<string[]>;
  details(ids: string[]): Promise<ModDetails[]>;
  /** Download items onto the server (through its agent). */
  download(ctx: ServerCtx, ids: string[]): Promise<JobResult>;
  /** What a downloaded item contains, for the game version; null while it isn't downloaded. */
  scan(ctx: ServerCtx, id: string, gameVersion: string): Promise<M[] | null>;
  /** The config values the enabled list (in load order) turns into; `entries` by mod id. */
  toConfig(enabled: EnabledMod[], entries: ReadonlyMap<string, M>): { fileId: string; values: Record<string, Scalar> };
  /** The reverse: adopt mods configured by hand or restored from a backup. */
  fromConfig?(values: Record<string, Scalar>): { items: string[]; enabled: string[] };
}

export interface UpdateInfo {
  available: boolean;
  /** Installed and latest, in the source's terms (Steam build ids). */
  current: string | null;
  latest: string;
  channel?: string;
}

/** One console command, for the console's help and AST-04. */
export interface CommandDoc {
  name: string;
  /** Usage, e.g. `kick "<user>" [-r "<reason>"]`. */
  syntax: string;
  description: I18n;
  /** Lowest permission the panel asks for before sending it raw. */
  permission?: Permission;
  /** Its arguments can hold secrets (passwords): the audit log keeps only the command name. */
  secretArgs?: boolean;
}

/** A secret `launch.toAgent` needs in its `SecretBag` (PZ: the admin password). The panel holds it and never shows it. */
export interface LaunchSecretDecl {
  /** Key in the `SecretBag`. */
  key: string;
  label: I18n;
}

export interface ToAgentOptions {
  /** The start follows an install the panel just ran: skip the pre-start update. */
  afterInstall?: boolean;
}

/** A launch setting (memory, version…): an option plus what the server pages need to know about it. */
export interface LaunchOption extends OptionMeta {
  /** `version`: pins what gets installed (UPD-02); `memory`: sizes the game (SRV-05 adds `meta.memory.overheadMb` for the container). */
  role?: 'version' | 'memory';
  /** Unit of a number, shown next to it (`MiB`). */
  unit?: string;
  /** Increment a number must be a multiple of. */
  step?: number;
}

export interface PanelAdapter<S = unknown> {
  meta: AdapterMeta;
  launch: {
    /** Launch settings form (memory, branch…). */
    schema: LaunchOption[];
    /** Secrets `toAgent` needs; not part of the form or of `S`. */
    secrets?: LaunchSecretDecl[];
    defaults(): S;
    /** Params for the agent (`LaunchEnvelope.params`), validated there by `RuntimeAdapter.parseLaunch`. */
    toAgent(srv: ServerRef, s: S, secrets: SecretBag, o?: ToAgentOptions): unknown;
  };
  config: PanelAdapterConfig;
  backups: { parts: BackupPartDecl[] };
  resets: ResetDecl[];
  messages: {
    /** Countdown text in the players' language; `cancelled` says it was called off. Null: the game can't show it. */
    announce(kind: AnnounceKind | 'cancelled', secondsLeft: number, lang: Lang): string | null;
    broadcast?(text: string): AgentCommand;
  };
  players?: PlayerOps;
  mods?: ModSource[];
  /** Whether a newer build of what `launch` pins exists; null when it can't tell. */
  updates?: { check(ctx: ServerCtx, launch: S): Promise<UpdateInfo | null> };
  consoleCatalog?: CommandDoc[];
  hooks?: { beforeStart?(ctx: ServerCtx): Promise<void> };
}

/** The panel adapter minus `meta` and `config`: what an adapter's `panel/core` provides. */
export type PanelAdapterCore<S = unknown> = Omit<PanelAdapter<S>, 'meta' | 'config'>;
