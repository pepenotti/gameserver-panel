/**
 * The contract between the panel and the orchestrator (PRD §10, D3, NFR-02,
 * NFR-03): the one component with Docker access. It creates, starts, stops
 * and removes server containers from the narrow `ServerSpec` below, and does
 * nothing else.
 *
 * What makes a container safe is not in the spec: the image (from the
 * orchestrator's allowlist, by `runtime` and `variant`), the user, dropped
 * capabilities, `no-new-privileges`, mounts (only the server's own volumes),
 * networks (one internal network per server) and every name are derived by
 * the orchestrator from `id`, never taken from the panel.
 *
 * Transport: HTTP/1.1 over a unix socket in a volume only the panel and the
 * orchestrator mount, `authorization: Bearer <token>` on every request, JSON
 * bodies. Every non-2xx answer is an `OrchestratorError`.
 *
 *   GET    /v1/health                     → HealthResponse
 *   GET    /v1/host                       → HostInfo
 *   GET    /v1/servers                    → ServerContainer[]   (only this stack's containers)
 *   PUT    /v1/servers/:id                ServerSpec → ServerContainer   (idempotent create or recreate; volumes kept)
 *   POST   /v1/servers/:id/start          → ServerContainer
 *   POST   /v1/servers/:id/stop           StopRequest → ServerContainer
 *   POST   /v1/servers/:id/restart        StopRequest → ServerContainer
 *   GET    /v1/servers/:id/stats          → ServerStats
 *   DELETE /v1/servers/:id?removeVolumes=false → DeleteResponse
 */

/** Version of this contract; `GET /v1/health` reports the one the orchestrator speaks. */
export const ORCHESTRATOR_API_VERSION = 1;

/**
 * A server id (the panel's `servers.id`): 2–24 characters, a lowercase
 * letter first, then lowercase letters, digits and dashes. Names of
 * containers, volumes and networks are derived from it.
 */
export const SERVER_ID_PATTERN = /^[a-z][a-z0-9-]{1,23}$/;

export function isServerId(x: unknown): x is string {
  return typeof x === 'string' && SERVER_ID_PATTERN.test(x);
}

/** Image family of a server (PRD §10 "Images per runtime family"); adapters declare theirs. */
export type RuntimeFamily = 'steam' | 'java' | 'native';

export type CpuArch = 'amd64' | 'arm64';

export interface HealthResponse {
  ok: true;
  /** Orchestrator build. */
  version: string;
  /** `ORCHESTRATOR_API_VERSION` it speaks. */
  api: number;
}

/** `GET /v1/host`: what the host can run (HST-05) and has (SRV-05). */
export interface HostInfo {
  arch: CpuArch;
  cpus: number;
  memBytes: number;
  dockerVersion: string;
  /** Docker's `OperatingSystem`, e.g. "Docker Desktop" or "Ubuntu 24.04 LTS". */
  os: string;
}

/**
 * Environment keys a spec may set besides the fixed ones: the agent's
 * adapter knobs (`GAME_*`) and panel-provided values (`GSP_*`), upper snake
 * case. `SPEC_ENV_DENIED` names the ones it may still not set.
 */
export const SPEC_ENV_KEY = /^(GAME|GSP)_[A-Z0-9]+(_[A-Z0-9]+)*$/;

/**
 * Keys the orchestrator sets or forbids itself: where the agent keeps files,
 * what it runs and where it listens are part of the image, not the spec.
 */
export const SPEC_ENV_DENIED = ['GAME_DATA_DIR', 'GAME_INSTALL_DIR', 'GAME_START_COMMAND'] as const;

export interface ServerSpecEnv {
  /** The panel ↔ agent token of this server (never logged). */
  AGENT_TOKEN: string;
  /** Runtime adapter id the agent loads. */
  GAME_ADAPTER: string;
  GAME_FLAVOUR?: string;
  /** tz database name for schedules and logs. */
  TZ: string;
  [key: `GAME_${string}` | `GSP_${string}`]: string | undefined;
}

export type PortProto = 'tcp' | 'udp';

/** One published port. The orchestrator refuses host ports another server or the host already uses. */
export interface PortMapping {
  container: number;
  host: number;
  proto: PortProto;
}

/**
 * `PUT /v1/servers/:id`: the whole wanted state of one server container.
 * Sending the same spec again changes nothing; a different one recreates the
 * container (stopping it first, with the default stop timeout) and keeps its
 * volumes.
 */
export interface ServerSpec {
  /** Must equal the `:id` in the path. */
  id: string;
  runtime: RuntimeFamily;
  /** An image variant of the runtime family (e.g. a Java version); resolved through the orchestrator's allowlist. */
  variant?: string;
  env: ServerSpecEnv;
  ports: PortMapping[];
  /** Hard memory limit of the container, MiB. */
  memoryMb: number;
  /** CPU limit in cores; omitted: no limit. */
  cpus?: number;
}

/** Docker's container states, plus `missing` for a server whose container is gone. */
export type ContainerState = 'created' | 'running' | 'paused' | 'restarting' | 'exited' | 'dead' | 'missing';

export interface ServerContainer {
  id: string;
  state: ContainerState;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  /** The image it runs (from the allowlist). */
  image: string;
  /** sha256 of the canonical JSON of the spec it was created from: equal means a PUT of that spec is a no-op. */
  specHash: string;
  /** Where the panel reaches the server's agent (on the server's own network). */
  agentUrl: string;
}

/** `POST /v1/servers/:id/stop` and `/restart`. */
export interface StopRequest {
  /** Seconds Docker waits after SIGTERM before SIGKILL; default 240, at most 600. */
  timeoutSec?: number;
}

export const MAX_STOP_TIMEOUT_SEC = 600;

/** `GET /v1/servers/:id/stats`: one sample of the container (HST-03, SRV-05). */
export interface ServerStats {
  id: string;
  at: string;
  /** Percent of one core. */
  cpuPercent: number;
  memBytes: number;
  memLimitBytes: number | null;
  netRxBytes: number;
  netTxBytes: number;
}

/** `DELETE /v1/servers/:id?removeVolumes=false`. Volumes stay unless asked (SRV-04). */
export interface DeleteResponse {
  removed: boolean;
  volumesRemoved: boolean;
}

export type OrchestratorErrorCode =
  | 'unauthorized'
  | 'bad-request'
  /** The spec asks for something outside the allowlist (NFR-02); `field` names what. */
  | 'refused'
  | 'not-found'
  /** A port is taken, or the server is being changed by another request. */
  | 'conflict'
  /** Docker is not reachable. */
  | 'unavailable'
  | 'internal';

/** Error body of every non-2xx orchestrator response. */
export interface OrchestratorError {
  error: string;
  code: OrchestratorErrorCode;
  /** The spec field a `refused` or `bad-request` is about (`ports[1].host`, `env.GAME_START_COMMAND`). */
  field?: string;
}
