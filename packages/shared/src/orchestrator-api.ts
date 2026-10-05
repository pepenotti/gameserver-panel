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
 *   GET    /v1/host                       → HostInfo            (with the host's traits, HST-07)
 *   GET    /v1/host/usage                 → HostUsage           (this stack's servers and volumes now, HST-03)
 *   GET    /v1/servers                    → ServerContainer[]   (only this stack's containers)
 *   PUT    /v1/servers/:id?keepImage=false&keepDerivation=false ServerSpec → ServerContainer   (idempotent create or recreate; volumes kept; `ApplyOptions`)
 *   POST   /v1/servers/:id/start          → ServerContainer
 *   POST   /v1/servers/:id/stop           StopRequest → ServerContainer
 *   POST   /v1/servers/:id/restart        StopRequest → ServerContainer
 *   GET    /v1/servers/:id/stats          → ServerStats
 *   DELETE /v1/servers/:id?removeVolumes=false → DeleteResponse
 *
 * Shared installs (HST-09, D12): an install is a volume of this stack named
 * by its install id, filled by an install job (the runtime image with the
 * agent in install-job mode, or the orchestrator's own copy command) and
 * mounted read-only by the servers whose spec names it (`ServerSpec.install`).
 *
 *   GET    /v1/installs                   → InstallInfo[]       (only this stack's installs)
 *   PUT    /v1/installs/:id               InstallJobSpec → InstallInfo   (the install job; `InstallPutOptions` for a copy job)
 *   DELETE /v1/installs/:id/job           → InstallDeleteResponse   (the job, its network and HOME; the install stays)
 *   DELETE /v1/installs/:id               → InstallDeleteResponse   (the install; refused while anything mounts it or a job exists)
 *   DELETE /v1/servers/:id/install        → InstallDeleteResponse   (a server's own install volume, left over once it moved to a shared install; refused while mounted)
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

/**
 * An install id (HST-09, D12): `i`, then 8–31 lowercase letters and digits.
 * The panel makes it (e.g. `i` and 16 hex digits of a hash of the install's
 * key); the install's volume and job are named from it.
 */
export const INSTALL_ID_PATTERN = /^i[a-z0-9]{8,31}$/;

export function isInstallId(x: unknown): x is string {
  return typeof x === 'string' && INSTALL_ID_PATTERN.test(x);
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

/** An inclusive range of host ports, e.g. `{ from: 16261, to: 16299 }`. */
export interface PortRangeInfo {
  from: number;
  to: number;
}

/**
 * `GET /v1/host`: what the host can run (HST-05) and has (SRV-05), and what
 * this install lets a server ask for. The last two come from the
 * orchestrator's own settings; an orchestrator older than them leaves them
 * out, and then only its refusals tell.
 */
export interface HostInfo {
  arch: CpuArch;
  cpus: number;
  memBytes: number;
  dockerVersion: string;
  /** Docker's `OperatingSystem`, e.g. "Docker Desktop" or "Ubuntu 24.04 LTS". */
  os: string;
  /** `ORCH_HOST_PORTS`: the only host ports a server may publish (SRV-01), low to high as configured. */
  hostPorts?: PortRangeInfo[];
  /** `ORCH_MAX_MEM_MB`: the most memory one server may be given, MiB (SRV-05). */
  maxMemMb?: number;
  /** What the host can't do, as far as Docker tells (HST-07); an orchestrator older than this field leaves it out. */
  traits?: HostTraits;
}

/** How Docker runs on the host: Docker Desktop (a virtual machine behind a port relay) or Docker Engine. */
export type DockerKind = 'desktop' | 'engine';

/** The host's operating system, as Docker shows it. */
export type HostPlatform = 'windows' | 'macos' | 'linux';

/**
 * The host's traits (HST-07), derived by the orchestrator from Docker's
 * `/info` alone, never from the caller. Only these words are reported:
 * none of Docker's own values (its labels may name the owner's account).
 */
export interface HostTraits {
  /** Docker Desktop when `/info` says so (its operating system, or its own label); Docker Engine otherwise. */
  docker: DockerKind;
  /**
   * `windows` for a WSL 2 kernel (Docker Desktop's backend, or Docker
   * Engine inside WSL) or Docker Desktop's Windows pipe; `macos` for Docker
   * Desktop's macOS socket; `linux` for Docker Engine elsewhere (or Docker
   * Desktop's Linux socket); null when Docker Desktop's doesn't say.
   */
  platform: HostPlatform | null;
  /**
   * Whether players' addresses reach the games (and the panel's visitors'
   * the panel): `false` behind Docker Desktop's port relay (measured on
   * Windows, docs/limitations.md); `'expected'` on Docker Engine, whose
   * port forwarding is expected to keep them but isn't measured yet (M7);
   * `true` only once measured on this kind of host. Never guessed true.
   */
  addressesVisible: boolean | 'expected';
}

/**
 * `GET /v1/host/usage`: what this stack's servers use now (HST-03, SRV-05),
 * and never anything of another stack. Taking it reads Docker only: one
 * stats sample per running server, and the disk use of this stack's
 * volumes (Docker's `/system/df`, which walks every file, so its answer is
 * kept a little while).
 */
export interface HostUsage {
  at: string;
  /** Every server container of this stack, by id (no `missing` ones: a server without a container has nothing to measure). */
  servers: ServerUsage[];
  /**
   * The disk each volume of this stack takes, filtered by this stack's
   * labels and names; null when Docker couldn't measure it now (another
   * disk-usage run in progress, an answer it couldn't give).
   */
  volumes: VolumeUsage[] | null;
  /** When `volumes` were measured; null with them. */
  volumesAt: string | null;
}

export interface ServerUsage {
  id: string;
  state: Exclude<ContainerState, 'missing'>;
  /** One sample while it runs (CPU, memory); null otherwise, or when Docker couldn't take one. */
  stats: ServerStats | null;
}

/**
 * What a volume of this stack holds: a server's own `data`, `install` (its
 * own install, before or without shared installs) or `steam` (its HOME);
 * a `shared-install` (HST-09); an install job's `job-home`; or the stack's
 * own (`stack`: the Compose project's volumes, the panel's database and the
 * proxy's certificates among them).
 */
export type VolumeUse = 'data' | 'install' | 'steam' | 'shared-install' | 'job-home' | 'stack';

export interface VolumeUsage {
  /** Its Docker volume. */
  name: string;
  use: VolumeUse;
  /** Its server (`data`, `install`, `steam`); null otherwise. */
  server: string | null;
  /** Its install (`shared-install`, `job-home`); null otherwise. */
  install: string | null;
  /** Bytes Docker measured; null when it didn't. */
  bytes: number | null;
}

/** The port every server's agent listens on inside its container: never published, and no game port may take it. */
export const AGENT_CONTAINER_PORT = 8081;

/**
 * Environment keys a spec may set besides the fixed ones: the agent's
 * adapter knobs (`GAME_*`) and panel-provided values (`GSP_*`), upper snake
 * case. `SPEC_ENV_DENIED` names the ones it may still not set.
 */
export const SPEC_ENV_KEY = /^(GAME|GSP)_[A-Z0-9]+(_[A-Z0-9]+)*$/;

/**
 * Keys the orchestrator sets or forbids itself: where the agent keeps files,
 * what it runs and where it listens are part of the image, not the spec;
 * whether the agent runs an install job (`GSP_AGENT_MODE`) or a server on a
 * shared install (`GSP_INSTALL_SHARED`) follows from the route and the
 * spec's `install` (HST-09).
 */
export const SPEC_ENV_DENIED = ['GAME_DATA_DIR', 'GAME_INSTALL_DIR', 'GAME_START_COMMAND', 'GSP_AGENT_MODE', 'GSP_INSTALL_SHARED'] as const;

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
 * volumes. The runtime image is part of that state: once it was rebuilt under
 * its tag (a product upgrade), the same spec recreates the container with the
 * newer image too, unless the request keeps it (`ApplyOptions.keepImage`).
 * So is the way the orchestrator derives the container: once another
 * orchestrator release derives the same spec differently, the same spec
 * recreates the container, unless the request keeps it
 * (`ApplyOptions.keepDerivation`) and the change is no security fix.
 * The orchestrator never pulls: an image that isn't built on the host is
 * refused (`unavailable`) before anything changes.
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
  /**
   * A shared install of this stack (HST-09, D12) to run from: mounted
   * read-only where the game's install goes, instead of the server's own
   * install volume, and the agent told so. Refused for an install of
   * another stack, of another game, flavour or image, one whose job still
   * exists, or one no job finished (no shared-install marker). Omitted: the
   * server's own install volume, derived exactly as before shared installs.
   */
  install?: string;
}

/** `PUT /v1/servers/:id` query parameters. */
export interface ApplyOptions {
  /**
   * `keepImage=true`: a container that already matches the spec is kept even
   * when its runtime image was rebuilt since (`newerImage`). The panel asks
   * this while the server's game runs, so a newer image waits for the game's
   * next start (SRV-05, SRV-06). It never keeps a container whose spec
   * differs. Default false: the image the tag names now.
   */
  keepImage?: boolean;
  /**
   * `keepDerivation=true`: a container created from the same spec is kept
   * even when this orchestrator derives it differently now (`derivation`
   * `changed`: a product upgrade changed how containers are built). The
   * panel asks this while the server's game runs, so the change waits for
   * the game's next start (SRV-05, SRV-06). It never keeps a container whose
   * spec differs, nor one derived before a security fix (`derivation`
   * `security-fix`): that one is recreated at once (NFR-02). Default false.
   */
  keepDerivation?: boolean;
}

/**
 * How the orchestrator derives a container's spec now, against how it was
 * derived when the container was created (the same spec):
 * - `current`: the same way;
 * - `changed`: another orchestrator release built it (a product upgrade
 *   changed how containers are built): a PUT of its spec recreates it unless
 *   the request keeps it (`ApplyOptions.keepDerivation`);
 * - `security-fix`: changed, and a change since closes a security gap: a PUT
 *   recreates it at once, even while its game runs and even when asked to
 *   keep it (NFR-02).
 */
export type DerivationState = 'current' | 'changed' | 'security-fix';

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
  /**
   * sha256 of the canonical JSON of the spec it was created from: equal (and
   * no `newerImage`, no `changedDerivation`) means a PUT of that spec is a no-op.
   */
  specHash: string;
  /** Where the panel reaches the server's agent (on the server's own network). */
  agentUrl: string;
  /**
   * Content id (`sha256:…`) of the image it was created from, as Docker
   * recorded it; '' when `missing`. An orchestrator older than this field
   * leaves it out.
   */
  imageId?: string;
  /**
   * Content id `image` names on the host now; '' when it names none (the
   * image was removed). It differs from `imageId` once the runtime image was
   * rebuilt under its tag: see `newerImage`.
   */
  latestImageId?: string;
  /**
   * How this orchestrator derives the container now against how it was
   * derived (`DerivationState`, SRV-06, NFR-02): see `changedDerivation`.
   * Absent when `missing`, and from an orchestrator older than this field.
   */
  derivation?: DerivationState;
}

/**
 * Whether a container's image tag names another image than the one it runs:
 * the runtime image was rebuilt since (a product upgrade). A PUT without
 * `keepImage` recreates it with the newer one. False when either id is
 * unknown or the image is gone (nothing to move to).
 */
export function newerImage(c: Pick<ServerContainer, 'imageId' | 'latestImageId'>): boolean {
  return !!c.imageId && !!c.latestImageId && c.imageId !== c.latestImageId;
}

/**
 * Whether the orchestrator would build a container differently now, for the
 * same spec (`derivation` `changed` or `security-fix`): a PUT without
 * `keepDerivation` recreates it. False when it can't tell.
 */
export function changedDerivation(c: Pick<ServerContainer, 'derivation'>): boolean {
  return c.derivation === 'changed' || c.derivation === 'security-fix';
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

/**
 * Why an install request was refused or clashed (HST-09, D12), besides its
 * `code`:
 * - `install-in-use`: a container mounts the install (a server, even a
 *   stopped one): it can't be removed, and no job writes into it;
 * - `install-busy`: a job of the install exists: no server mounts a
 *   half-written install, and only one job runs per install;
 * - `install-not-ready`: no job finished the install (no shared-install
 *   marker): no server mounts it and nothing copies it;
 * - `server-running`: a copy from a server's own install waits until that
 *   server's container is stopped.
 */
export type InstallRefusal = 'install-in-use' | 'install-busy' | 'install-not-ready' | 'server-running';

/** Error body of every non-2xx orchestrator response. */
export interface OrchestratorError {
  error: string;
  code: OrchestratorErrorCode;
  /** The spec field a `refused` or `bad-request` is about (`ports[1].host`, `env.GAME_START_COMMAND`). */
  field?: string;
  /** For install routes and specs with `install`: why, when it is one of `InstallRefusal`. */
  reason?: InstallRefusal;
}

// ------------------------------------------------------------ shared installs (HST-09, D12)

/**
 * `PUT /v1/installs/:id`: the job that fills install `id` (its volume is
 * created when missing, labelled with the game it holds). Like a server
 * spec, it names only what: the image family (and variant) of the game's
 * servers and the agent's environment. Everything else is derived by the
 * orchestrator (NFR-02): the job runs as hardened as a server (user 1000,
 * every capability dropped, `no-new-privileges`, a read-only root), on a
 * bridge network of its own that only the panel joins, publishes no ports,
 * gets a fixed memory limit, `/data` on a small tmpfs and, for the steam
 * family, a HOME volume of its own seeded from the image and removed with
 * the job. Its agent runs in install-job mode (it installs, warms up, links
 * the redirects and writes the shared-install marker; it never starts the
 * game). The panel drives it at `InstallJob.agentUrl` like a server's agent
 * (`PUT /v1/launch`, `POST /v1/install`), then removes it
 * (`DELETE /v1/installs/:id/job`).
 *
 * Refused: another stack's volume of that name; an existing install of
 * another game, flavour or image; a job of the install that exists already
 * (the same spec again answers it as it is); an install a container mounts
 * (a job never writes an install servers read). A copy job
 * (`InstallPutOptions`) also refuses an install that exists already.
 */
export interface InstallJobSpec {
  /** Must equal the `:id` in the path. */
  id: string;
  /** The image family the install's servers run in, and its variant, as their specs name them. */
  runtime: RuntimeFamily;
  variant?: string;
  /** As a server spec's: the job agent's token, the game (`GAME_ADAPTER`, `GAME_FLAVOUR`), TZ, `GAME_*`/`GSP_*` knobs. */
  env: ServerSpecEnv;
}

/**
 * `PUT /v1/installs/:id` query parameters, at most one: a copy job instead
 * of an install job. It runs the orchestrator's own fixed command (`cp -a`)
 * in the runtime image, with no network, the source read-only and the new
 * install's volume as the target, then exits (`InstallJob.exitCode` 0:
 * copied). An update starts from a copy of the install it replaces (steamcmd
 * then downloads only what changed); a server's own install is adopted by a
 * copy (migration). Either way an install job runs on the copy next, for
 * the finishing steps (redirects, warm-up, marker).
 */
export interface InstallPutOptions {
  /** Copy a ready install of this stack (same game, flavour and image). */
  from?: string;
  /** Copy a server's own install volume (same game, flavour and image); refused while its container runs. */
  fromServer?: string;
}

export type InstallJobKind = 'install' | 'copy';

/** An install's job container. */
export interface InstallJob {
  kind: InstallJobKind;
  /** Docker's state of the job container (never `missing`). */
  state: Exclude<ContainerState, 'missing'>;
  startedAt: string | null;
  finishedAt: string | null;
  /** Once it exited: a copy job's 0 means copied. */
  exitCode: number | null;
  image: string;
  /** An install job's agent, on the job's own network (a copy job runs no agent: null). */
  agentUrl: string | null;
  /** A copy job's source: an install id, or `server:<id>` for a server's own install. */
  from: string | null;
}

/** `GET /v1/installs`: one install of this stack. */
export interface InstallInfo {
  id: string;
  /** The game it holds, from its volume's labels (set when it was created). */
  adapter: string;
  flavour: string | null;
  runtime: RuntimeFamily;
  variant: string | null;
  /** Its Docker volume (`<stack>-inst-<id>`). */
  volume: string;
  /** When the volume was created, as Docker says; null when it doesn't. */
  createdAt: string | null;
  /** Servers of this stack whose container mounts it (running or not), read from Docker; sorted. */
  mountedBy: string[];
  /** Its job, while one exists; null otherwise. */
  job: InstallJob | null;
}

/** `DELETE /v1/installs/:id/job` and `DELETE /v1/installs/:id`. */
export interface InstallDeleteResponse {
  /** Something was there and is gone (false: nothing to remove). */
  removed: boolean;
}
