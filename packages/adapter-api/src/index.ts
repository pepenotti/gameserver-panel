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
  InstallKey,
  InstallRedirect,
  InstallSharing,
  InstallSharingMode,
  InstallWanted,
  JobKind,
  JobResult,
  PackRequest,
  Permission,
  RootId,
  RuntimeFamily,
  ServerFilesErrorCode,
  SharedInstallMarker,
  VersionInfo,
  VersionsResponse,
} from '@gsp/shared';

export type { AgentStatus, CommandResponse, FormatId, InstalledInfo, JobKind, JobResult, Lang, OptionMeta, Permission, Scalar, VersionInfo, VersionsResponse };
// The file shapes are the agent API's (`/v1/fs/*`, `/v1/archive/*`, D11), so the wire and the contract can't drift.
export type { DirEntry, FileKind, FileStat, PackRequest, RootId, RuntimeFamily, ServerFilesErrorCode };
// Shared installs (HST-09, D12): what an adapter declares and what an install job leaves.
export type { InstallKey, InstallRedirect, InstallSharing, InstallSharingMode, InstallWanted, SharedInstallMarker };

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
  /**
   * A port the game derives from another instead of taking its own
   * (Valheim's query port is always its game port + 1; a game port on both
   * UDP and TCP is two ports, the second following the first at 0): never
   * chosen, always the number of port `id` plus `offset`, inside the
   * container and on the host. The panel allocates it with the port it
   * follows (SRV-01 checks it too) and publishes it the same way; the agent
   * computes it when its environment doesn't name it. The port it follows
   * is declared before it, follows none itself, and is published when it is.
   */
  follows?: { id: string; offset: number };
}

export interface Flavour {
  id: string;
  name: I18n;
  /** Replaces the adapter's capabilities for servers of this flavour. */
  capabilities?: Capability[];
  /**
   * The image family servers of this flavour run in, when it isn't the
   * adapter's `AdapterMeta.runtime` (PRD §10: a flavour may name another
   * image). The panel's server spec asks the orchestrator for it, and the
   * agent (told the flavour by `GAME_FLAVOUR`) gives installs that family's
   * tools (the steamcmd driver for `steam`).
   */
  runtime?: RuntimeFamily;
  /**
   * How players join a server of this flavour where it differs from the
   * adapter's `AdapterMeta.join` (SRV-08): each field given replaces the
   * adapter's (a flavour whose players need another client, a flavour with
   * steps of its own; `steps` replaces the list whole).
   */
  join?: Partial<JoinDecl>;
  /**
   * How installs of this flavour are shared (HST-09, D12), when it isn't the
   * adapter's `AdapterMeta.install` (a flavour whose game writes into its
   * install somewhere the others don't: a log folder next to its binaries).
   */
  install?: InstallSharing;
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
  /** What people should know about the game before relying on a feature (UX-04), shown with its servers. */
  notes?: AdapterNote[];
  /**
   * How players join its servers (SRV-08), for every server's connection
   * info. Every adapter declares it: the panel adapter contract suite checks
   * it, flavour by flavour (`Flavour.join`).
   */
  join?: JoinDecl;
  /**
   * How its installs are shared (HST-09, D12), as measured
   * (docs/verification/shared-installs.md): `shared` once its servers were
   * run from a read-only install, with the paths it writes inside its
   * install redirected into the server's data; `own` until then. A flavour
   * may declare its own (`Flavour.install`). Every adapter declares it, for
   * itself or for each of its flavours: the contract suites check it.
   */
  install?: InstallSharing;
}

/**
 * A known limitation of a game (UX-04), as a server's pages show it:
 * `doc` names its entry in `docs/limitations.md` (`limitations.md#<anchor>`).
 */
export interface AdapterNote {
  id: string;
  text: I18n;
  doc?: string;
}

// ================================================================== joining

/**
 * How players join a server of a game (SRV-08), in the game's own words and
 * format: the port they type, how its client takes the address and the
 * port, the client they need, what else they do, and where the password
 * they type is kept. The panel adds the addresses (this PC, the home
 * network, the internet: HST-08) and the host port the server's `port` is
 * published on. Each fact is measured with a real client (D5) or says it
 * isn't: `verified`, with its `source`.
 */
export interface JoinDecl {
  /** The port players type: a published `PortDecl.id` that follows no other port. */
  port: string;
  /**
   * How the game's client takes the address and the port: `host:port`, in
   * one field, the address, `:` and the port (an IPv6 address in
   * brackets); `separate`, in fields of their own.
   */
  format: JoinFormat;
  /**
   * With `host:port`: the port the client uses when none is typed. On that
   * port the address alone is enough.
   */
  defaultPort?: number;
  /** Where in the game players type it: its menus and fields, as the game names them. */
  where: I18n;
  /**
   * The client players need, by name; `sameVersion`: it must be the version
   * the server runs, which the panel adds (`InstalledInfo.version`) when
   * it knows it.
   */
  client: { name: I18n; sameVersion: boolean };
  /** What players do besides typing the address (ask an admin for the whitelist, make an account in game). */
  steps?: JoinStep[];
  /** Where the password players type to join is kept; absent: the game has none. */
  password?: JoinSetting;
  /** A real client joined this way (D5); false: what this says is expected, not measured, and the panel says so. */
  verified: boolean;
  /** Where that is recorded (`docs/verification/<game>-<build>.md`), or what is still to be measured. */
  source: string;
  /** What players should know about joining that isn't measured yet (which port to try first), shown with it (UX-04). */
  note?: I18n;
}

/** How a game's client takes an address and a port (`JoinDecl.format`). */
export type JoinFormat = 'host:port' | 'separate';

/**
 * A value of a server's settings: a launch setting (`LaunchOption.key`), or
 * a key of one of its declared config files (`ConfigFileDecl.id`, read
 * through the server's agent).
 */
export type JoinSetting = { launch: string } | { file: string; key: string };

/**
 * A step players take to join. With `when`, shown only while that setting
 * equals `equals` (compared as text, case ignored); when the panel can't
 * read it (the server's agent is away), shown as one that may apply.
 */
export interface JoinStep {
  id: string;
  text: I18n;
  when?: JoinSetting & { equals: Scalar };
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
  /**
   * The install root is a shared install mounted read-only (HST-09, D12):
   * nothing may be written there, not even by `prepare` (the agent never
   * installs or updates it; install jobs do). Absent or false: the server's
   * own install, or an install job's.
   */
  sharedInstall?: boolean;
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
  /**
   * An HTTP GET for games installed from the web (UPD-01): the agent names
   * itself (`User-Agent: gameserver-panel/<version>`) and retries rate
   * limits (429, honouring `Retry-After`), server errors (5xx) and network
   * failures with backoff. Resolves with the first other response, or the
   * last one once the retries are spent, whatever its status: the adapter
   * reads `status`. Rejects when the network never answered.
   */
  fetch?(url: string): Promise<Response>;
  /** A file through `fetch`, with progress on the job, checked before it is kept (see `DownloadRequest`). */
  download?(req: DownloadRequest): Promise<void>;
  /**
   * Runs a tool (a game's installer) from an argument array, never a shell,
   * with the agent's environment minus its token plus `env`; each output
   * line goes to the job's log like steamcmd's. Resolves when it exits.
   */
  exec?(argv: string[], o?: ExecOptions): Promise<ExecResult>;
  /**
   * Unpacks an archive an install downloaded (UPD-01; the images have no
   * `unzip`): plain files and folders into `dest`, which must lie in the
   * install or data root. The whole archive is refused when an entry is a
   * link or any other special file, is absolute, climbs out with `..`, or
   * would land outside `dest`, and when it is corrupt (a size or CRC that
   * doesn't match). Files keep an exec bit the archive records (tar, zips
   * made on Unix) as 0755; the rest are 0644.
   */
  extract?(req: ExtractRequest): Promise<ExtractResult>;
}

/** What `InstallCtx.extract` unpacks, and where. */
export interface ExtractRequest {
  /** Absolute path of the archive, in the install or data root. */
  file: string;
  /** Absolute folder, in the install or data root, the entries land in; made when missing. */
  dest: string;
  format: 'zip' | 'tar' | 'tar.gz';
  /** Only entries under this folder of the archive (`1458/Linux`); the others are skipped. */
  only?: string;
  /** Leading folders dropped from each entry's path (after `only`); entries left without a name are skipped. */
  strip?: number;
  /**
   * For archives people bring (a plugin upload): the whole archive is
   * refused before anything is written when its entries add up to more
   * than `bytes` unpacked, or number more than `entries` (a zip's directory
   * says both; a tar's size bounds its bytes), with an error whose `code`
   * is `extract-too-large`. Not for gzipped tars.
   */
  limits?: { bytes?: number; entries?: number };
}

export interface ExtractResult {
  /** Files and folders written. */
  files: number;
  dirs: number;
}

/** What `InstallCtx.download` fetches and where it keeps it. */
export interface DownloadRequest {
  url: string;
  /** Absolute path; written to a temporary file next to it, renamed into place only once every check passed. */
  dest: string;
  /** How the job's progress names it (`paper-26.3-41.jar`). */
  what: string;
  /** Checked when given: a mismatch leaves nothing at `dest` and rejects. */
  size?: number;
  /** Hex digests, checked when given. */
  sha1?: string;
  sha256?: string;
  /**
   * Where the download may go, for an address people gave (a plugin's
   * release link): `url` and every redirect it is sent on to must pass,
   * or the download stops before asking that address (rejecting with an
   * error whose `code` is `download-refused`). Absent: any http(s) address,
   * redirects followed.
   */
  allowUrl?(url: URL): boolean;
  /** Refused, keeping nothing, once the file proves bigger than this (error `code` `download-too-large`). */
  maxBytes?: number;
}

export interface ExecOptions {
  /** Absolute; the install root when omitted. */
  cwd?: string;
  env?: Record<string, string>;
  /** Killed (SIGKILL) after this long; 10 minutes when omitted. */
  timeoutMs?: number;
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
}

/**
 * The agent's steamcmd driver (retries, progress parsing and output go to the
 * job). Adapters pass their own app ids; the agent knows none.
 */
export interface SteamCmd {
  /**
   * `app_update <appId> -beta <branch> [validate]` into the install root.
   * The branch is always named, `public` for null: steamcmd keeps an
   * install on the branch it was installed from when none is named
   * (measured: docs/verification/shared-installs.md, "Branch switches").
   */
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
   * "RCON: listening" ~50 ms later). A game that opens its channel before it
   * says it is ready marks its ready line with both.
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
  /**
   * The line is one step of a run of progress lines (a world being generated
   * can print a percentage per step: tens of thousands of lines). The live
   * log shows a run as its latest line (CON-01): each line of the same `key`
   * replaces the one before it in place, until the game prints a line that
   * is not progress (blank lines aside) or exits; lines of other keys run
   * alongside. `text`: what the log shows instead of the line. Everything
   * else about the line still counts (readiness, fatal lines, `waitForLine`).
   */
  progress?: { key: string; text?: string };
  /**
   * Something people should know about this run, though it isn't fatal
   * (the game can't reach Steam and runs without it): the agent says so in
   * the log, once per run and text (in English, like its own lines).
   */
  warning?: I18n;
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
  /**
   * Every line (its `LineSignal.message`) the game prints from the call on,
   * until `until` says the reply is complete: a RegExp the latest line
   * matches, or a test of all the lines so far. Null after `timeoutMs`, or
   * when the game exits first. For a console reply spread over several
   * lines (a player list over stdin); other output printed meanwhile is in
   * the lines too. Call it before sending what triggers the reply.
   */
  waitForLines?(until: RegExp | ((lines: readonly string[]) => boolean), timeoutMs: number): Promise<string[] | null>;
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
  /**
   * What is installed, as the identity of a shared install (HST-09, D12):
   * the flavour, version, build and branch, stable for as long as the files
   * are (a Steam game's own version line, learnt at its first boot, is no
   * part of it). Null when nothing whole is installed. The install job
   * writes it into the shared-install marker; the panel keeps it, so
   * servers asking for the same thing share one install.
   */
  installKey?(ctx: RuntimeCtx): InstallKey | null;
  /**
   * An install job's step after a successful `install()`, for what the game
   * does to its install on a first start and can't do read-only (Minecraft's
   * bundler unpacks its libraries into the install): run here, once, with
   * the install still writable. It never starts a server. Absent: nothing to
   * do.
   */
  warmUp?(ctx: InstallCtx, p: P): Promise<JobResult>;
  /** Versions the server can be pinned to (a job: steamcmd output goes to the log). */
  versions?(ctx: InstallCtx, p: P): Promise<VersionsResponse>;
  /** Before every start: files the agent owns (ports, the control secret) are enforced here. */
  prepare(ctx: RuntimeCtx, p: P): Promise<void>;
  command(ctx: RuntimeCtx, p: P): LaunchCommand;
  classify(line: string): LineSignal;
  /**
   * What people see of the game's output (CON-01, CON-02): a log line or a
   * control-channel reply without the game's own formatting codes
   * (Minecraft's `§` colour codes). The agent shows and serves only this,
   * redacted; `classify` and the adapter's own commands get the raw text.
   * Absent: shown as it is.
   */
  display?(text: string): string;
  /**
   * A console line people typed (`POST /v1/command`) as the game's console
   * takes it, when it goes to stdin: Avorion's wants every command to start
   * with `/`, which the panel strips. Absent: as typed.
   */
  consoleLine?(cmd: string): string;
  channel(ctx: RuntimeCtx, p: P): ChannelSpec;
  /** Ask the game to stop cleanly; the agent waits `budgetMs` for the exit, then escalates to signals. */
  stop(ctl: ControlHandle, o: { budgetMs: number }): Promise<void>;
  /** Save the running world and resolve once the game says it finished; the agent reports a failure after `budgetMs`, so stop waiting by then. */
  save?(ctl: ControlHandle, o: { budgetMs: number }): Promise<void>;
  /** Running-server backups: `before` makes the files consistent, `after` always runs. */
  hotCopy?: {
    before(ctl: ControlHandle): Promise<void>;
    after(ctl: ControlHandle): Promise<void>;
    sqlite?: string[];
    /**
     * Narrows a running backup of the data root to a consistent set of files
     * (Valheim: only its newest complete save), after `before`: given every
     * file the backup would copy (data-root paths, `/`-separated, the
     * request's folders walked), the ones to copy; paths not in `files` are
     * ignored. The agent takes the selected files as they are at that moment
     * (a file the game deletes or rewrites afterwards stays as it was, in the
     * backup); when one vanished before it could, it lists and asks again,
     * once, and fails the backup if one vanishes again.
     */
    select?(ctx: RuntimeCtx, files: string[]): Promise<string[]>;
  };
  /**
   * Null when the reply wasn't understood. The agent also passes the
   * server's context and launch params, for an adapter that asks some
   * flavours another way than its channel (TShock's REST API).
   *
   * The agent asks on its own, every few seconds, through a quiet `ctl`
   * (PLY-01): a line it writes to the console, and the reply the adapter
   * waits for with `waitForLine` or `waitForLines` (registered before the
   * line is written), stay out of the live log. A reply line with a meaning
   * (any `LineSignal` field besides `message`) is still shown, and so is
   * every line of a reply that never completed. People's console commands
   * never share that reply: the agent holds them until it is complete, and
   * doesn't ask while a person's command may still be answering.
   */
  listPlayers?(ctl: ControlHandle, ctx?: RuntimeCtx, p?: P): Promise<PlayerList | null>;
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
  /**
   * Set keys of a declared config file (`ConfigFileDecl.id`); history note
   * `note`. A file that doesn't exist yet is left alone. For a file the
   * game rewrites from memory (`reapplyAtStart`), these become the panel's
   * saved values, put back before the next start; with `live`, the running
   * game already holds them (it made the change itself, as Minecraft's
   * `whitelist on`), so there is nothing to put back for those keys.
   */
  set(fileId: string, values: Record<string, Scalar>, note: string, o?: { live?: boolean }): Promise<void>;
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
  /**
   * Dotted paths of objects in a JSON or JSON5 file that are secret whole,
   * their keys included (TShock keeps its REST tokens as the keys of an
   * object in its config). Forms, raw text, diffs and history show each
   * as a masked string, and every save keeps what is on disk there,
   * whatever the text says: the panel never shows or changes them (so they
   * are locked too; list them in `managedKeys` for the form's lock).
   */
  secretTrees?: string[];
  /**
   * What people should know about the file before they edit it, shown with
   * its form and in the text editor (the game rewrites it at every start and
   * drops keys it doesn't know).
   */
  note?: I18n;
  /** Keys that take effect only after a restart (CFG-05); `*` for every key. */
  restartKeys: string[] | '*';
  /** Written before the first start when the file is missing (the game completes the rest). */
  seed?: Record<string, Scalar>;
  /** The game executes this file: it must parse as plain data of this shape (CFG-02). */
  dataOnly?: { form: 'assign' | 'function'; name: string };
  /**
   * The running game keeps this file in memory and writes it back over any
   * edit (Minecraft's operator and ban lists): the panel changes it only
   * while the game is stopped (409 `config-stopped-only` otherwise).
   */
  stoppedOnly?: boolean;
  /**
   * The running game may write this file back from memory whenever someone
   * makes it (Minecraft's `server.properties` when an operator types
   * `whitelist on|off` in game), dropping what the panel saved since the
   * game started. The panel then puts the values it saved to the file since
   * its previous start back before each start it makes (CFG-05): the
   * panel's last saved values win over what the game wrote back, other keys
   * stay as the game wrote them. Values the game took live
   * (`ConfigAccess.set` with `live`) aren't put back, and a restore or reset
   * that replaces the file forgets them.
   */
  reapplyAtStart?: boolean;
  /**
   * What the game needs of the file beyond its format (CFG-02, CFG-08),
   * given a text that parses: the entries it couldn't load (Minecraft's
   * lists hold objects the game writes, not bare names). A save with any
   * issue is refused (400 `invalid-file`), and the editor shows the issues
   * of the file as it is on disk. Empty when the game can load it.
   */
  check?(text: string): ConfigIssue[];
}

/** A problem a declared file's own `check` found, for people: where it is, and what to do instead (EN/ES). */
export interface ConfigIssue {
  /** 1-based. */
  line: number;
  /** 1-based. */
  col?: number;
  message: I18n;
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
  /** The flavours this scope is for (a flavour that keeps players' accounts on the server); absent: all. */
  flavours?: string[];
  /** `backups.parts` ids deleted by this reset (after a safety backup). */
  removeParts: string[];
  /** The `ResetOptions` this scope uses (a new seed, a preset); the others are ignored. */
  options?: { newSeed?: boolean; preset?: boolean };
  after?(ctx: ServerCtx, o: ResetOptions): Promise<void>;
}

/** Why players are warned in game (the panel's countdowns). */
export type AnnounceKind = 'restart' | 'stop' | 'update' | 'restore' | 'reset';

/**
 * Who a ban names: a player's name (the game looks up its account: PZ's
 * `banuser`, Minecraft's `ban`), a SteamID, an IP address, the id a game
 * client sends (TShock's UUID), or an account the server keeps (TShock's
 * accounts, which players log in to). An adapter takes the ones its
 * `banTargets` lists.
 */
export interface PlayerTarget {
  username?: string;
  steamId?: string;
  ip?: string;
  uuid?: string;
  account?: string;
}

/** What a ban can name: `PlayerTarget`'s fields. */
export type BanTarget = 'username' | 'steamId' | 'ip' | 'uuid' | 'account';

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
  /**
   * Bans by player name, for games that ban names rather than Steam
   * accounts (Minecraft: the name, and the account id the game resolved it
   * to). Lifted with `unban({ username })`.
   */
  usernames?: { username: string; id: string | null; reason: string | null }[];
  /** Bans of the id a game client sends (TShock's UUIDs); lifted with `unban({ uuid })`. */
  uuids?: { uuid: string; reason: string | null }[];
  /** Bans of accounts the server keeps (TShock's); lifted with `unban({ account })`. */
  accounts?: { account: string; reason: string | null }[];
}

/** A game's whitelist as it stands. */
export interface WhitelistInfo {
  /** Whether the game enforces it now; null when that can't be told. */
  enabled: boolean | null;
  usernames: string[];
}

/** A player with an access level above the lowest, from the game's own list (Minecraft's operators). */
export interface LevelHolder {
  username: string;
  /** One of `PlayerOps.accessLevels`' ids. */
  level: string;
}

/** A `PlayerOps` command, as `PlayerOps.refused` is asked about its reply. */
export type PlayerOpKind = 'kick' | 'ban' | 'unban' | 'setAccess' | 'whitelistAdd' | 'whitelistRemove' | 'setWhitelistEnabled';

/**
 * Why the game didn't do a player command (PLY-03): it knows no player by
 * that name (`player-not-found`), the player isn't online (`player-not-online`,
 * a kick), it already was so (`no-change`: already banned, not an
 * operator, the whitelist already on…), or it tried and failed (`failed`:
 * TShock didn't store a ban).
 */
export type PlayerRefusal = 'player-not-found' | 'player-not-online' | 'no-change' | 'failed';

/**
 * Moderation. Each command resolves with the game's reply; arguments the game
 * can't take are refused with `RconProtocolError` from `@gsp/formats`.
 */
export interface PlayerOps {
  /**
   * What the game's reply to a command means when the game refused it
   * (Minecraft answers a name it can't look up with "That player does not
   * exist"): the panel then answers with an error instead of the reply.
   * Null when the game did it, or the reply doesn't say. Absent: every reply
   * is passed on as it is.
   */
  refused?(op: PlayerOpKind, reply: string): PlayerRefusal | null;
  /** Levels `setAccess` accepts, lowest first. */
  accessLevels?: readonly AccessLevel[];
  /** The `PlayerTarget` fields `ban` and `unban` accept; a UI offers only these. */
  banTargets?: readonly BanTarget[];
  /**
   * The game bans the address a player joined from, whatever the ban names
   * (vanilla Terraria bans an online player's IP): everyone who shares that
   * address is banned too, and behind Docker Desktop every player does. A
   * UI warns before such a ban, and lets bans be lifted by address.
   */
  banByAddress?: boolean;
  /**
   * Commands that work only while the game is stopped (vanilla Terraria's
   * unban edits the ban list the running game keeps in memory): the panel
   * refuses them otherwise (409 `server-running`), and a UI offers them then.
   */
  stoppedOnly?: readonly PlayerOpKind[];
  /**
   * Whether `whitelistAdd` takes a password (PZ: the whitelist is accounts
   * a player joins with); absent means it does. False: a name is enough.
   */
  whitelistPassword?: boolean;
  kick?(ctx: ServerCtx, username: string, reason?: string): Promise<string>;
  ban?(ctx: ServerCtx, target: PlayerTarget, reason?: string): Promise<string>;
  unban?(ctx: ServerCtx, target: PlayerTarget): Promise<string>;
  setAccess?(ctx: ServerCtx, username: string, level: string): Promise<string>;
  whitelistAdd?(ctx: ServerCtx, username: string, password?: string): Promise<string>;
  whitelistRemove?(ctx: ServerCtx, username: string): Promise<string>;
  /** Turns the whitelist on or off on the running game. */
  setWhitelistEnabled?(ctx: ServerCtx, on: boolean): Promise<string>;
  /** The whitelist as the game keeps it (read from its files). */
  whitelist?(ctx: ServerCtx): Promise<WhitelistInfo>;
  /** Who holds an access level above the lowest, as the game keeps them. */
  levelHolders?(ctx: ServerCtx): Promise<LevelHolder[]>;
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
  /**
   * The config values the enabled list (in load order) turns into; `entries`
   * by mod id. A game whose mod list isn't key/values (a JSON array of mod
   * names) gives the whole file as `text`: it is written as it is,
   * created when missing, and `values` only describe it (they may be empty).
   */
  toConfig(enabled: EnabledMod[], entries: ReadonlyMap<string, M>): { fileId: string; values: Record<string, Scalar>; text?: string };
  /** The reverse: adopt mods configured by hand or restored from a backup. */
  fromConfig?(values: Record<string, Scalar>): { items: string[]; enabled: string[] };
  /**
   * Whether the game server fetches its items, and their updates, itself
   * when it starts (some Steam games do, from the Workshop), so a restart
   * applies an update. False: the game reads only what is on disk (a game
   * server run without Steam), so before every start the panel makes,
   * it downloads through the agent the enabled items missing on the server
   * or known to have a newer version at the source. Absent: true.
   */
  serverFetches?: boolean;
}

// ------------------------------------------------------------- plugin files

/**
 * Why a plugin was not added, changed or removed (MOD-06), as a code the UI
 * words:
 *   - `link-invalid`: not a web address; `link-not-https`: not HTTPS;
 *     `link-host`: not on a host the source takes links from;
 *     `link-not-asset`: not a release's download link (a release page, a
 *     repository); `redirect-refused`: the download was sent on to a host
 *     the source doesn't allow; `download-failed`: the host gave no file;
 *   - `too-large`: bigger than the source's `maxBytes` (or, unpacked, than
 *     it allows a zip to hold);
 *   - `not-a-plugin`: neither a plugin file (`extensions`) nor a zip of
 *     them, or a plugin file that isn't one inside; `no-plugins`: a zip
 *     without any; `bad-archive`: a zip that can't be unpacked safely (a
 *     path outside its folder, a link, a corrupt entry); `bad-name`: a file
 *     name the server won't take; `name-taken`: the game's own install has
 *     a plugin of that name;
 *   - `not-found`: no such plugin on the server; `not-supported`: this
 *     server takes no plugins (its flavour).
 */
export type PluginRefusal =
  | 'link-invalid'
  | 'link-not-https'
  | 'link-host'
  | 'link-not-asset'
  | 'redirect-refused'
  | 'download-failed'
  | 'too-large'
  | 'not-a-plugin'
  | 'no-plugins'
  | 'bad-archive'
  | 'bad-name'
  | 'name-taken'
  | 'not-found'
  | 'not-supported';

/** One plugin file on a server. */
export interface PluginFile {
  /** Its file name (`MyPlugin.dll`): unique on the server, whatever the case. */
  name: string;
  enabled: boolean;
  /**
   * The server runs with this very file: it was put in place for the
   * game's last start and hasn't changed since, whatever `enabled` says
   * now. A plugin whose `active` differs from `enabled` (added, replaced,
   * enabled or disabled since) waits for a restart: MOD-06's badge.
   */
  active: boolean;
  size: number;
  /** Hex SHA-256 of the file. */
  sha256: string;
  /** Unix milliseconds of its last change. */
  mtimeMs: number;
}

/** A plugin source's answer: what it did, or why it didn't (`PluginRefusal`, with the details in `message`). */
export type PluginReply<T extends object = object> = ({ ok: true } & T) | { ok: false; reason: PluginRefusal; message: string };

/** What an add brought: the plugin files it put on the server (new or replacing one of the same name), and what else the upload held. */
export interface PluginAdded {
  added: PluginFile[];
  /** Names of `added` that replaced a plugin already there (it keeps being enabled or disabled). */
  replaced: string[];
  /** Files of a zip that aren't plugin files (a readme, debug symbols): left out. */
  skipped: string[];
}

/** Where an add takes its plugins from: an upload the panel wrote into `uploadDir`, or a release link the agent downloads. */
export type PluginOrigin = { upload: string; name: string } | { url: string };

/**
 * Plugin files people bring themselves (MOD-06: TShock's plugins). There is
 * no catalogue, so no search, dependencies or update checks: a plugin comes
 * as an upload (a plugin file, or a zip of them) or from a release link that
 * the server's agent downloads, never the panel (D11), from the hosts the
 * source allows (every redirect too) and up to `maxBytes`. Plugins are
 * enabled, disabled and removed; each change takes effect at the next
 * start. They run code inside the server: admins only, after `warning`.
 * The work happens next to the files, in the runtime's actions; the panel
 * keeps who added what (the audit log) and asks for the restart.
 */
export interface PluginSource {
  id: string;
  capability: ModCapability;
  label: I18n;
  /** Told to people before they add one: a plugin runs code inside the server. */
  warning: I18n;
  /** File name endings of a plugin, lower case (`.dll`). An upload is one of them, or a `.zip` holding them. */
  extensions: string[];
  /** Largest upload or download, in bytes (at most `FS_WRITE_MAX_BYTES`: an upload reaches the server through its agent's file API). */
  maxBytes: number;
  /** What a release link must be, in people's words; absent: only uploads are taken. */
  linkHint?: I18n;
  /**
   * The data-root folder the panel writes an upload into before `add` takes
   * it (then it is gone): nothing else lives there, and no backup part or
   * editable folder covers it.
   */
  uploadDir: string;
  /**
   * Null when the agent would download `url`; else why not. The panel asks
   * first, to answer at once without reaching the server; the agent checks
   * again, and checks every redirect. `env`: the panel's environment (tests
   * point the release host elsewhere).
   */
  checkLink(url: string, env: Readonly<Record<string, string | undefined>>): PluginRefusal | null;
  list(ctx: ServerCtx): Promise<PluginReply<{ plugins: PluginFile[] }>>;
  /** `upload`: a file name in `uploadDir`; `name`: the name people gave it. */
  add(ctx: ServerCtx, from: PluginOrigin): Promise<PluginReply<PluginAdded>>;
  setEnabled(ctx: ServerCtx, name: string, enabled: boolean): Promise<PluginReply<{ changed: boolean }>>;
  remove(ctx: ServerCtx, name: string): Promise<PluginReply>;
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
  /** The flavours whose console has it (TShock's console takes its own commands); absent: all. */
  flavours?: string[];
}

/** A secret `launch.toAgent` needs in its `SecretBag` (PZ: the admin password). The panel holds it and never shows it. */
export interface LaunchSecretDecl {
  /** Key in the `SecretBag`. */
  key: string;
  label: I18n;
}

/**
 * What `launch.toAgent` (and `RuntimeAdapter.parseLaunch`) may throw for a
 * launch setting it refuses beyond the form's types and ranges (a password
 * too short for a public server, CFG-01): an `Error` carrying these fields.
 * The panel answers 400 with them, and the web shows `text` next to the
 * setting, in the reader's language.
 */
export interface LaunchSettingRefusal {
  /** The launch setting's key. */
  field: string;
  text: I18n;
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
  /**
   * The flavours this setting is for (Paper's build channel); forms show it
   * only for those, and `toAgent` ignores it for the others. Absent: all.
   */
  flavours?: string[];
  /**
   * A value people choose that is kept hidden (a server password): a text
   * setting the panel never shows again once saved. It reads back masked,
   * a save that sends the mask keeps the stored value, and the audit log
   * never holds it.
   */
  secret?: boolean;
}

/** One value a launch setting may take right now, from the game's own download services (UPD-02). */
export interface LaunchChoice {
  value: string;
  /** How people read it, when the value alone doesn't say (an empty value: "the newest stable"). */
  label?: I18n;
  /** A short fact shown with it: its newest build, its release date. */
  detail?: string;
  /** The release channel of what picking it installs (`STABLE`, `ALPHA`). */
  channel?: string;
  /** A code `launch.warnings` words: picking it deserves a second thought (Q13). */
  warning?: string;
  /** Other launch settings that go with picking it (a version with only ALPHA builds: that channel). */
  implies?: Record<string, string>;
}

/** What the choices are asked for: before a server exists there is only its flavour and the version picked so far. */
export interface LaunchChoicesQuery {
  flavour: string | null;
  /** The value of the `role: 'version'` setting picked so far; null for the version list itself. */
  version: string | null;
}

/** Choices by launch setting key; a setting not listed takes what its schema allows. */
export type LaunchChoices = Record<string, LaunchChoice[]>;

/** What the panel gives `launch.choices`: its own way out to the web. */
export interface ChoicesCtx {
  /** An HTTP GET as the panel makes them (it names itself, gives up after a while). */
  fetch(url: string): Promise<Response>;
  /** The panel's environment, for adapter-specific knobs (download services a test or the dev loop points elsewhere). */
  env: Readonly<Record<string, string | undefined>>;
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
    /**
     * What the version and version-dependent settings may be set to, from
     * the game's download services, for a server that may not exist yet
     * (the create form has no agent to ask). The panel caches the answer
     * for a few minutes; rejects when the services can't be reached.
     */
    choices?(q: LaunchChoicesQuery, ctx: ChoicesCtx): Promise<LaunchChoices>;
    /** What each warning code of `VersionInfo.warning` and `LaunchChoice.warning` means, for people. */
    warnings?: Record<string, I18n>;
  };
  config: PanelAdapterConfig;
  backups: { parts: BackupPartDecl[] };
  resets: ResetDecl[];
  messages: {
    /** Countdown text in the players' language; `cancelled` says it was called off. Null: the game can't show it. */
    announce(kind: AnnounceKind | 'cancelled', secondsLeft: number, lang: Lang): string | null;
    broadcast?(text: string): AgentCommand;
    /**
     * Sends `text` to every player of a running server when the adapter
     * reaches them some other way than one console command (TShock's REST
     * API, through a runtime action; CON-04); `broadcast` is used otherwise.
     * Text the game can't take is refused with `RconProtocolError`.
     */
    send?(ctx: ServerCtx, text: string): Promise<void>;
  };
  players?: PlayerOps;
  /**
   * The moderation of a flavour, for adapters whose flavours moderate
   * differently (TShock's bans by name, IP, UUID or account against vanilla
   * Terraria's IP bans); `players` is used when this is absent or returns
   * undefined.
   */
  playersOf?(flavour: string | null): PlayerOps | undefined;
  /** Mod sources with a catalogue; a server uses those whose capability its flavour has. */
  mods?: ModSource[];
  /** Plugin files people bring (MOD-06); a server uses those whose capability its flavour has. */
  plugins?: PluginSource[];
  /** Whether a newer build of what `launch` pins exists; null when it can't tell. */
  updates?: { check(ctx: ServerCtx, launch: S): Promise<UpdateInfo | null> };
  consoleCatalog?: CommandDoc[];
  hooks?: { beforeStart?(ctx: ServerCtx): Promise<void> };
  /**
   * Shared installs (HST-09, D12), panel side: what a server's launch
   * settings want installed, known before any install job runs, so the
   * panel gives a server an install that already holds it (or waits for the
   * one being installed) instead of downloading it again. Required for a
   * game (or a flavour) whose installs are shared (`AdapterMeta.install`,
   * `Flavour.install`); the contract suite checks it.
   */
  install?: PanelInstall<S>;
}

/** How a panel adapter tells the panel which install a server needs (`PanelAdapter.install`). */
export interface PanelInstall<S = unknown> {
  /**
   * The install `launch` (stored or submitted launch settings, over the
   * defaults) wants for a server of `srv.flavour`: the flavour, and what the
   * launch pins of the version, build and branch, null where it takes the
   * newest (a Steam game names its branch; only an install job learns the
   * build). Throws on settings `launch.toAgent` would refuse.
   */
  wanted(launch: S, srv: Pick<ServerRef, 'flavour'>): InstallWanted;
}

/** The panel adapter minus `meta` and `config`: what an adapter's `panel/core` provides. */
export type PanelAdapterCore<S = unknown> = Omit<PanelAdapter<S>, 'meta' | 'config'>;
