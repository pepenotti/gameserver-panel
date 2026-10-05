import type {
  ApplyOptions,
  DeleteResponse,
  HealthResponse,
  HostInfo,
  HostUsage,
  InstallDeleteResponse,
  InstallInfo,
  InstallJobSpec,
  InstallPutOptions,
  InstallRefusal,
  OrchestratorErrorCode,
  ServerContainer,
  ServerSpec,
  ServerStats,
} from '@gsp/shared';

/** A refused or failed orchestrator call: its `OrchestratorError` code, `field` for refusals, and `reason` for an install's state (HST-09). */
export class OrchestratorCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: OrchestratorErrorCode | 'unreachable' | 'not-implemented',
    message: string,
    readonly field?: string,
    readonly reason?: InstallRefusal,
  ) {
    super(message);
  }
}

/**
 * The panel's side of the orchestrator API (`@gsp/shared` orchestrator-api,
 * D3): one method per route. The HTTP client over the orchestrator's unix
 * socket comes with the orchestrator (M2-A); tests use fakes.
 */
export interface OrchestratorClient {
  health(): Promise<HealthResponse>;
  host(): Promise<HostInfo>;
  /** What this stack's servers and volumes take now (HST-03); an orchestrator without it answers `not-found` (no such route). */
  usage(): Promise<HostUsage>;
  /** This stack's server containers. */
  list(): Promise<ServerContainer[]>;
  /**
   * Create or recreate (volumes kept); the same spec again changes nothing,
   * unless its runtime image was rebuilt since and `keepImage` isn't asked,
   * or the orchestrator now derives it another way and `keepDerivation`
   * isn't asked (or the change is a security fix).
   */
  apply(spec: ServerSpec, o?: ApplyOptions): Promise<ServerContainer>;
  start(id: string): Promise<ServerContainer>;
  stop(id: string, o?: { timeoutSec?: number }): Promise<ServerContainer>;
  restart(id: string, o?: { timeoutSec?: number }): Promise<ServerContainer>;
  stats(id: string): Promise<ServerStats>;
  remove(id: string, o: { removeVolumes: boolean }): Promise<DeleteResponse>;

  // Shared installs (HST-09, D12). An orchestrator without them answers `not-found` (no such route).
  /** This stack's installs: the game each holds, the servers mounting it, its job. */
  installs(): Promise<InstallInfo[]>;
  /** The install job (or, with `from`/`fromServer`, a copy job) that fills install `spec.id`; its volume is made when missing. */
  putInstall(spec: InstallJobSpec, o?: InstallPutOptions): Promise<InstallInfo>;
  /** The install's job, its network and HOME; the install stays. */
  removeInstallJob(id: string): Promise<InstallDeleteResponse>;
  /** The install itself; refused while anything mounts it or a job exists. */
  removeInstall(id: string): Promise<InstallDeleteResponse>;
  /** A server's own install volume, left over once it moved to a shared install; refused while mounted. */
  removeOwnInstall(serverId: string): Promise<InstallDeleteResponse>;
}

/** Until M2-A: every call fails with `not-implemented`, so nothing pretends to have a container. */
export class NoOrchestrator implements OrchestratorClient {
  private fail(): Promise<never> {
    return Promise.reject(new OrchestratorCallError(501, 'not-implemented', 'No orchestrator in this build yet'));
  }
  health = () => this.fail();
  host = () => this.fail();
  usage = () => this.fail();
  list = () => this.fail();
  apply = (_spec: ServerSpec, _o?: ApplyOptions) => this.fail();
  start = (_id: string) => this.fail();
  stop = (_id: string) => this.fail();
  restart = (_id: string) => this.fail();
  stats = (_id: string) => this.fail();
  remove = (_id: string, _o: { removeVolumes: boolean }) => this.fail();
  installs = () => this.fail();
  putInstall = (_spec: InstallJobSpec, _o?: InstallPutOptions) => this.fail();
  removeInstallJob = (_id: string) => this.fail();
  removeInstall = (_id: string) => this.fail();
  removeOwnInstall = (_id: string) => this.fail();
}
