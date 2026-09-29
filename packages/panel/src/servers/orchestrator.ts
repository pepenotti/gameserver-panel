import type { ApplyOptions, DeleteResponse, HealthResponse, HostInfo, OrchestratorErrorCode, ServerContainer, ServerSpec, ServerStats } from '@gsp/shared';

/** A refused or failed orchestrator call: its `OrchestratorError` code, and `field` for refusals. */
export class OrchestratorCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: OrchestratorErrorCode | 'unreachable' | 'not-implemented',
    message: string,
    readonly field?: string,
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
  /** This stack's server containers. */
  list(): Promise<ServerContainer[]>;
  /**
   * Create or recreate (volumes kept); the same spec again changes nothing,
   * unless its runtime image was rebuilt since and `keepImage` isn't asked.
   */
  apply(spec: ServerSpec, o?: ApplyOptions): Promise<ServerContainer>;
  start(id: string): Promise<ServerContainer>;
  stop(id: string, o?: { timeoutSec?: number }): Promise<ServerContainer>;
  restart(id: string, o?: { timeoutSec?: number }): Promise<ServerContainer>;
  stats(id: string): Promise<ServerStats>;
  remove(id: string, o: { removeVolumes: boolean }): Promise<DeleteResponse>;
}

/** Until M2-A: every call fails with `not-implemented`, so nothing pretends to have a container. */
export class NoOrchestrator implements OrchestratorClient {
  private fail(): Promise<never> {
    return Promise.reject(new OrchestratorCallError(501, 'not-implemented', 'No orchestrator in this build yet'));
  }
  health = () => this.fail();
  host = () => this.fail();
  list = () => this.fail();
  apply = (_spec: ServerSpec, _o?: ApplyOptions) => this.fail();
  start = (_id: string) => this.fail();
  stop = (_id: string) => this.fail();
  restart = (_id: string) => this.fail();
  stats = (_id: string) => this.fail();
  remove = (_id: string, _o: { removeVolumes: boolean }) => this.fail();
}
