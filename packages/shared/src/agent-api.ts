/**
 * The contract between the panel and the agent that runs inside the `pz`
 * container. The agent owns the game process, RCON and steamcmd; the panel
 * only ever talks to it through these shapes.
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

export interface LaunchParams {
  /** `-servername`; names the ini, sandbox and save folder. Fixed per deployment. */
  serverName: string;
  adminUsername: string;
  adminPassword: string;
  /** Heap size for both -Xms and -Xmx, in MiB. */
  memoryMb: number;
  /** Steam branch of app 380870: `public`, `legacy41`, `42.19`, … */
  branch: string;
  /** Run steamcmd app_update before every start. */
  updateOnStart: boolean;
}

export type PublicLaunchParams = Omit<LaunchParams, 'adminPassword'>;

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
  /** From the `version=` log line of the current or last run. */
  gameVersion: string | null;
  installed: { buildId: string; branch: string } | null;
  players: { count: number; names: string[]; at: string } | null;
  rcon: { connected: boolean; lastError: string | null };
  lock: { holder: string; expiresAt: string } | null;
  job: JobInfo | null;
  /** Timestamps of crashes inside the crash-loop window. */
  recentCrashes: string[];
  launch: PublicLaunchParams | null;
  process: ProcessStats | null;
  disks: DiskStats[];
  /** Agent wall clock, so the panel can spot drift after the PC sleeps. */
  now: string;
}

export type AlertKind = 'crash' | 'crash-loop' | 'unresponsive' | 'admin-prompt' | 'fatal' | 'start-timeout' | 'start-failed';

export type AgentEvent =
  | { type: 'state'; status: AgentStatus }
  | { type: 'log'; stream: 'out' | 'err' | 'agent'; line: string }
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

export interface AppInfoResponse {
  installed: { buildId: string; branch: string } | null;
  branches: { name: string; buildId: string; timeUpdated?: number; description?: string; passwordRequired: boolean }[];
}

/** Error body for every non-2xx agent response. */
export interface AgentError {
  error: string;
  code: 'unauthorized' | 'bad-request' | 'not-found' | 'conflict' | 'locked' | 'unavailable' | 'internal';
}
