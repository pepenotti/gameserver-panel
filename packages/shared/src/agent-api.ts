/**
 * The contract between the panel and the agent that runs inside each
 * server's container. The agent owns the game process, its control channel
 * and its installer; the panel only ever talks to it through these shapes.
 */

export type ServerState =
  /** Not running and not supposed to be. */
  | 'stopped'
  /** steamcmd is installing, updating or validating the game. */
  | 'installing'
  /** Process spawned, waiting for `*** SERVER STARTED ****`. */
  | 'starting'
  | 'running'
  /** `quit` sent, waiting for the process to exit. */
  | 'stopping'
  /** Exited unexpectedly; the watchdog restarts it after a short delay. */
  | 'crashed'
  /** Gave up (crash loop, start failure, blocking prompt); needs a manual start. */
  | 'failed';

/**
 * The launch params the agent keeps, as its status shows them: the
 * adapter's own shape (`LaunchEnvelope.params`) without the values the
 * runtime adapter's `secrets()` names.
 */
export type PublicLaunch = Readonly<Record<string, unknown>>;

export type JobKind = 'install' | 'validate' | 'appinfo' | 'workshop';

export interface JobInfo {
  id: string;
  kind: JobKind;
  startedAt: string;
  /** 0–100 when steamcmd reports it. */
  progress: number | null;
  message: string;
}

export interface JobResult {
  ok: boolean;
  error?: string;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  at: string;
  /** True when the agent asked for it (stop, restart, kill). */
  expected: boolean;
}

export interface ProcessStats {
  /** Resident memory of the whole process group, bytes. */
  rssBytes: number;
  /** CPU use since the previous sample, percent of one core. */
  cpuPercent: number;
  /** Container memory use and limit from cgroup v2, bytes (limit null = unlimited). */
  cgroupBytes: number | null;
  cgroupLimitBytes: number | null;
}

export interface DiskStats {
  path: string;
  totalBytes: number;
  freeBytes: number;
}

export interface AgentStatus {
  agentVersion: string;
  /** Changes every time the agent process starts; event sequence numbers restart with it. */
  bootId: string;
  state: ServerState;
  desired: 'running' | 'stopped';
  pid: number | null;
  startedAt: string | null;
  readyAt: string | null;
  lastExit: ExitInfo | null;
  /** Why the state is `failed`. */
  failure: string | null;
  players: { count: number; names: string[]; at: string } | null;
  /** The adapter's control channel. */
  control: { kind: ControlKind; connected: boolean; lastError: string | null };
  /** What is installed, in adapter-neutral terms (`version` once the game has announced it); null when nothing is. */
  installedInfo: InstalledInfo | null;
  lock: { holder: string; expiresAt: string } | null;
  job: JobInfo | null;
  /** Timestamps of crashes inside the crash-loop window. */
  recentCrashes: string[];
  launch: PublicLaunch | null;
  process: ProcessStats | null;
  disks: DiskStats[];
  /** Agent wall clock, so the panel can spot drift after the PC sleeps. */
  now: string;
}

export type AlertKind =
  | 'crash'
  | 'crash-loop'
  | 'unresponsive'
  /** The game waited for console input nobody will type (a runtime adapter's `blockingPrompt`); the agent killed it. */
  | 'blocking-prompt'
  | 'fatal'
  | 'start-timeout'
  | 'start-failed';

export type AgentEvent =
  | { type: 'state'; status: AgentStatus }
  | {
      type: 'log';
      stream: 'out' | 'err' | 'agent';
      line: string;
      /**
       * A run of progress lines (a runtime adapter's `LineSignal.progress`,
       * CON-01): the seq of the run's first line. A later log event of the
       * same `run` (a new seq: the run's latest line) replaces this one where
       * it is shown, and in the agent's backlog. Absent on ordinary lines.
       */
      run?: number;
    }
  | { type: 'players'; count: number; names: string[] }
  | { type: 'job'; job: JobInfo; result?: JobResult }
  | { type: 'alert'; kind: AlertKind; message: string };

export interface SeqEvent {
  seq: number;
  at: string;
  event: AgentEvent;
}

export interface CommandRequest {
  command: string;
  /** Default `rcon`, falling back to stdin when RCON is down. */
  via?: 'rcon' | 'stdin';
}

export interface CommandResponse {
  via: 'rcon' | 'stdin';
  /** RCON reply text; stdin commands only echo into the log stream. */
  output: string | null;
}

// ------------------------------------------------ adapter-neutral (M1, D4)

/** What is installed, in any game's terms (a runtime adapter's `installed()`). */
export interface InstalledInfo {
  /** Game version when known (PZ reports it only once it runs). */
  version: string | null;
  /** Steam branch, Minecraft release channel, loader… */
  channel?: string;
  /** Build of that version when the source has one (Steam build id). */
  build?: string;
}

/** One version a server can be pinned to (UPD-02). */
export interface VersionInfo {
  /** What gets pinned: a Steam branch, a Minecraft version, a loader version. */
  id: string;
  build?: string;
  /** Unix seconds. */
  timeUpdated?: number;
  description?: string;
  /** Steam branches behind a password are listed but can't be picked. */
  passwordRequired?: boolean;
  /** The release channel of `build` (Paper's `STABLE`, `BETA`, `ALPHA`). */
  channel?: string;
  /**
   * Why picking this version deserves a second thought, as a code the
   * panel adapter words (`PanelAdapter.launch.warnings`; Q13: Paper has no
   * STABLE build of it yet).
   */
  warning?: string;
}

/** How the agent talks to the game besides stdin (a runtime adapter's `channel()`). */
export type ControlKind = 'rcon' | 'stdin' | 'rest' | 'none';

/**
 * Launch body for `PUT /v1/launch` and `POST /v1/start` once the agent runs
 * adapters: the adapter id and that adapter's params (its `parseLaunch`
 * validates them).
 */
export interface LaunchEnvelope {
  adapter: string;
  params: unknown;
  /**
   * For games with an agreement the owner must accept (the adapter's `eula`
   * capability, D6): whether the owner has. The agent hands it to the runtime
   * adapter (`RuntimeCtx.eulaAccepted`), which writes the game's own
   * acceptance only when it is true. Absent for other games.
   */
  eulaAccepted?: boolean;
}

/** `POST /v1/install`: install, update or validate while the server is stopped. */
export interface InstallRequest {
  validate?: boolean;
  /** Install for these params (a new branch or version); default: the stored launch. */
  launch?: LaunchEnvelope;
}
export type InstallResponse = JobResult;

/** `POST /v1/versions`: what the server could be pinned to. */
export interface VersionsRequest {
  /** List for these params (another flavour or loader); default: the stored launch. */
  launch?: LaunchEnvelope;
}
export interface VersionsResponse {
  installed: InstalledInfo | null;
  versions: VersionInfo[];
}

/** `POST /v1/save`: save the running world and wait for the game to finish. */
export interface SaveRequest {
  timeoutMs?: number;
}
export type SaveResponse = JobResult;

/** `POST /v1/actions/:name`: an adapter-specific action (a runtime adapter's `actions`). */
export interface ActionRequest {
  input: unknown;
}
export interface ActionResponse {
  result: unknown;
}

/** Error body for every non-2xx agent response. */
export interface AgentError {
  error: string;
  code: 'unauthorized' | 'bad-request' | 'not-found' | 'conflict' | 'locked' | 'unavailable' | 'internal';
  /** Why a file or archive request was refused (`/v1/fs/*`, `/v1/archive/*`). */
  reason?: ServerFilesErrorCode;
}

// ------------------------------------------ server files through the agent (D11)
//
// The panel reaches a server's files only through that server's agent (D11):
// these routes mirror `ServerFiles` in the adapter contract one to one, and
// the adapter contract re-exports the shapes below. Paths are always relative
// to a root (`data`, `install`, or an adapter's extra root); absolute paths,
// `..`, and symlinks leading out of the root are refused (`reason`
// `outside-root` or `invalid-path`). The agent's own state folder is never a
// root. JSON bodies unless noted; file contents travel as
// `application/octet-stream`, archives as an uncompressed tar
// (`application/x-tar`).
//
//   POST /v1/fs/stat        FsPathRequest → FsStatResponse
//   POST /v1/fs/list        FsPathRequest → FsListResponse
//   POST /v1/fs/read        FsReadRequest → 200 octet-stream | 404 not-found (no such file)
//   PUT  /v1/fs/write?root=&rel=    octet-stream body (≤ FS_WRITE_MAX_BYTES) → FsOkResponse
//   POST /v1/fs/remove      FsRemoveRequest → FsOkResponse
//   POST /v1/archive/pack   PackRequest → 200 x-tar stream
//   POST /v1/archive/stage?allow=<rel>&allow=<rel>…   x-tar body → StageResponse
//   POST /v1/archive/swap   SwapRequest → SwapResponse
//   POST /v1/archive/undo   UndoRequest → FsOkResponse
//   POST /v1/archive/purge  PurgeRequest → FsOkResponse

/** A file root of a server: `data` and `install`, plus any adapter-declared extra root. */
export type RootId = 'data' | 'install' | (string & Record<never, never>);

export type FileKind = 'file' | 'dir' | 'symlink' | 'other';

export interface FileStat {
  kind: FileKind;
  size: number;
  mtimeMs: number;
}

export interface DirEntry extends FileStat {
  name: string;
}

/**
 * Why a `ServerFiles` call was refused: the `code` of the errors
 * implementations throw, and `AgentError.reason` over HTTP.
 */
export type ServerFilesErrorCode = 'invalid-path' | 'outside-root' | 'not-a-file' | 'not-a-dir' | 'too-large' | 'unknown-root';

/** `POST /v1/archive/pack`: an uncompressed tar of files under one root. */
export interface PackRequest {
  root: RootId;
  /** Files or folders under `root`; folders are walked, missing paths skipped, symlinks never followed. */
  rels: string[];
  /** Globs (relative to `root`) of SQLite databases, copied as consistent snapshots while the game runs. */
  sqlite?: string[];
  /** Path prefix inside the archive (today's backups use `data/`). */
  prefix?: string;
}

/** Largest body `PUT /v1/fs/write` takes. */
export const FS_WRITE_MAX_BYTES = 16 * 1024 * 1024;

export interface FsPathRequest {
  root: RootId;
  rel: string;
}

export interface FsStatResponse {
  /** Null when nothing is there. */
  stat: FileStat | null;
}

export interface FsListResponse {
  /** Sorted by name; empty when the folder doesn't exist. */
  entries: DirEntry[];
}

export interface FsReadRequest extends FsPathRequest {
  /** Refuse (`reason: too-large`) a file bigger than this. */
  maxBytes?: number;
}

export interface FsRemoveRequest {
  root: RootId;
  /** Files or folders (removed recursively); missing ones are fine. */
  rels: string[];
}

export interface FsOkResponse {
  ok: true;
}

/** `POST /v1/archive/stage`: the tar was unpacked into a staging folder of the data root. */
export interface StageResponse {
  stagingId: string;
  entries: number;
}

/** `POST /v1/archive/swap`: move staged `rels` (data-root paths) into place; what they replace goes to a trash folder. */
export interface SwapRequest {
  stagingId: string;
  rels: string[];
}

export interface SwapResponse {
  trashId: string;
}

/** `POST /v1/archive/undo`: put a trash folder's files back. */
export interface UndoRequest {
  trashId: string;
}

/** `POST /v1/archive/purge`: drop one trash folder, or all of them. */
export interface PurgeRequest {
  trashId?: string;
}
