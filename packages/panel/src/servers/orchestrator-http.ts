import http from 'node:http';
import { isServerId, type ApplyOptions, type DeleteResponse, type HealthResponse, type HostInfo, type OrchestratorError, type ServerContainer, type ServerSpec, type ServerStats } from '@gsp/shared';
import { OrchestratorCallError, type OrchestratorClient } from './orchestrator';

export interface OrchestratorHttpOptions {
  /** `ORCH_SOCKET`: the orchestrator's unix socket (a named pipe `\\.\pipe\…` on Windows development machines). */
  socket: string;
  /** `ORCH_TOKEN`: the bearer token it expects. */
  token: string;
  /** Budget of a quick call, ms (default 60 s). Calls that may stop a container get its stop timeout on top. */
  timeoutMs?: number;
}

/** What Docker waits for a server to stop when nobody says otherwise (the orchestrator's default). */
const DEFAULT_STOP_SEC = 240;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * The panel's orchestrator client (D3, NFR-03): the contract's routes over
 * the orchestrator's unix socket, one connection per call, the bearer token
 * on each. Every failure is an `OrchestratorCallError` with the
 * orchestrator's code and `field`, or `unreachable` when it can't be reached
 * or doesn't answer in time.
 */
export class OrchestratorHttp implements OrchestratorClient {
  private readonly timeoutMs: number;

  constructor(private readonly o: OrchestratorHttpOptions) {
    if (!o.socket) throw new Error('The orchestrator socket (ORCH_SOCKET) must be set');
    if (o.token.length < 32) throw new Error('The orchestrator token (ORCH_TOKEN) must be at least 32 characters');
    this.timeoutMs = o.timeoutMs ?? 60_000;
  }

  private call<T>(method: string, path: string, body?: unknown, extraMs = 0): Promise<T> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const timeoutMs = this.timeoutMs + extraMs;
    return new Promise<T>((resolve, reject) => {
      const headers: Record<string, string | number> = { authorization: `Bearer ${this.o.token}` };
      if (payload) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = payload.length;
      }
      const req = http.request({ socketPath: this.o.socket, method, path, headers, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('the answer is too large'));
          else chunks.push(c);
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          let data: unknown;
          try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            reject(new OrchestratorCallError(502, 'internal', `The orchestrator answered ${status} without JSON`));
            return;
          }
          if (status >= 200 && status < 300) {
            resolve(data as T);
            return;
          }
          const err = (typeof data === 'object' && data !== null ? data : {}) as Partial<OrchestratorError>;
          reject(new OrchestratorCallError(status, err.code ?? 'internal', err.error ?? `Orchestrator error ${status}`, err.field));
        });
        res.on('error', (e) => reject(new OrchestratorCallError(503, 'unreachable', `Orchestrator connection failed: ${e.message}`)));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)));
      req.on('error', (e) => reject(new OrchestratorCallError(503, 'unreachable', `Orchestrator unreachable: ${e.message}`)));
      req.end(payload);
    });
  }

  /** `/v1/servers/<id>[/<action>]`; an id outside the contract never makes a request. */
  private server(id: string, action?: string): string {
    if (!isServerId(id)) throw new OrchestratorCallError(400, 'bad-request', 'Not a server id', 'id');
    return action ? `/v1/servers/${id}/${action}` : `/v1/servers/${id}`;
  }

  async health(): Promise<HealthResponse> {
    return this.call('GET', '/v1/health');
  }

  async host(): Promise<HostInfo> {
    return this.call('GET', '/v1/host');
  }

  async list(): Promise<ServerContainer[]> {
    return this.call('GET', '/v1/servers');
  }

  /** May stop the old container first (the default stop timeout). */
  async apply(spec: ServerSpec, o: ApplyOptions = {}): Promise<ServerContainer> {
    return this.call('PUT', `${this.server(spec.id)}${o.keepImage ? '?keepImage=true' : ''}`, spec, DEFAULT_STOP_SEC * 1000);
  }

  async start(id: string): Promise<ServerContainer> {
    return this.call('POST', this.server(id, 'start'));
  }

  async stop(id: string, o: { timeoutSec?: number } = {}): Promise<ServerContainer> {
    const body = o.timeoutSec === undefined ? {} : { timeoutSec: o.timeoutSec };
    return this.call('POST', this.server(id, 'stop'), body, (o.timeoutSec ?? DEFAULT_STOP_SEC) * 1000);
  }

  async restart(id: string, o: { timeoutSec?: number } = {}): Promise<ServerContainer> {
    const body = o.timeoutSec === undefined ? {} : { timeoutSec: o.timeoutSec };
    return this.call('POST', this.server(id, 'restart'), body, (o.timeoutSec ?? DEFAULT_STOP_SEC) * 1000);
  }

  async stats(id: string): Promise<ServerStats> {
    return this.call('GET', this.server(id, 'stats'));
  }

  /** Stops a running container first (the default stop timeout). */
  async remove(id: string, o: { removeVolumes: boolean }): Promise<DeleteResponse> {
    return this.call('DELETE', `${this.server(id)}?removeVolumes=${o.removeVolumes ? 'true' : 'false'}`, undefined, DEFAULT_STOP_SEC * 1000);
  }
}

/**
 * The client the environment describes: `ORCH_SOCKET` and `ORCH_TOKEN`
 * (compose.yaml and scripts/dev.mjs set both); null when neither is set.
 */
export function orchestratorFromEnv(env: NodeJS.ProcessEnv = process.env): OrchestratorHttp | null {
  const socket = env.ORCH_SOCKET ?? '';
  const token = env.ORCH_TOKEN ?? '';
  if (!socket && !token) return null;
  if (!socket || !token) throw new Error('ORCH_SOCKET and ORCH_TOKEN must be set together');
  return new OrchestratorHttp({ socket, token });
}
