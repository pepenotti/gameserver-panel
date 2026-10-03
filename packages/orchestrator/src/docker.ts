import http from 'node:http';
import { unavailable } from './errors';

/**
 * Docker Engine API version this service speaks: 1.44 is Docker 25 (early
 * 2024), the oldest the current Docker Engine and Docker Desktop still accept.
 */
export const DOCKER_API_VERSION = 'v1.44';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** The Docker socket (production), or a plain-HTTP URL (tests: tools/fake-docker). */
export type DockerTarget = { socketPath: string } | { url: string };

/** Docker answered with a status the caller didn't expect. */
export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Labels = Record<string, string> | null;

export interface DockerContainerSummary {
  Id: string;
  Names: string[];
  Labels: Labels;
  State: string;
  Ports: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[] | null;
  /** What it mounts: a named volume's name (`Name`), where, and whether writable. */
  Mounts?: { Type: string; Name?: string; Destination: string; RW: boolean }[] | null;
}

export interface DockerContainer {
  Id: string;
  /** With a leading slash: `/gsp-s1-srv-pz`. */
  Name: string;
  /** Content id (`sha256:…`) of the image it was created from: what `Config.Image` resolved to then. */
  Image: string;
  Config: { Image: string; Labels: Labels; Env?: string[] | null };
  State: { Status: string; Running: boolean; StartedAt: string; FinishedAt: string; ExitCode: number };
  HostConfig: { PortBindings: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null };
  NetworkSettings: { Networks: Record<string, { NetworkID?: string }> | null };
}

export interface DockerNetwork {
  Id: string;
  Name: string;
  Labels: Labels;
  /** Attached containers by id (on inspect). */
  Containers?: Record<string, unknown> | null;
}

/** `GET /images/{name}/json`, the part this service reads. */
export interface DockerImage {
  /** Content id, `sha256:…`: a rebuild under the same tag gives a new one. */
  Id: string;
}

export interface DockerVolume {
  Name: string;
  Labels: Labels;
  CreatedAt?: string;
}

export interface DockerInfo {
  Architecture: string;
  NCPU: number;
  MemTotal: number;
  ServerVersion: string;
  OperatingSystem: string;
}

export interface DockerStats {
  read?: string;
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
}

export interface DockerCall {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

function messageOf(data: unknown): string | undefined {
  if (typeof data === 'object' && data !== null && typeof (data as { message?: unknown }).message === 'string') return (data as { message: string }).message;
  return typeof data === 'string' && data ? data.slice(0, 500) : undefined;
}

/** A minimal Docker Engine API client over the socket: only what the orchestrator uses. */
export class DockerClient {
  private readonly base: { socketPath: string } | { host: string; port: number };

  constructor(target: DockerTarget) {
    if ('url' in target) {
      const u = new URL(target.url);
      if (u.protocol !== 'http:') throw new Error('ORCH_DOCKER_URL must be an http:// URL');
      this.base = { host: u.hostname, port: Number(u.port || 80) };
    } else {
      this.base = { socketPath: target.socketPath };
    }
  }

  /** Status and parsed body; rejects only when Docker can't be reached (`unavailable`). */
  async raw(method: string, path: string, o: DockerCall = {}): Promise<{ status: number; data: unknown }> {
    const r = await this.bytes(method, path, o);
    const text = r.body.toString('utf8');
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: r.status, data };
  }

  /** Status and the body as it came (an archive); rejects only when Docker can't be reached (`unavailable`). */
  bytes(method: string, path: string, o: DockerCall = {}): Promise<{ status: number; body: Buffer }> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) params.set(k, String(v));
    const qs = params.size ? `?${params.toString()}` : '';
    const payload = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body));
    const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          ...this.base,
          method,
          path: `/${DOCKER_API_VERSION}${path}${qs}`,
          headers: { host: 'docker', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('Docker answered with too much data'));
            else chunks.push(c);
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on('error', (e) => reject(unavailable(`Docker connection failed: ${e.message}`)));
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)));
      req.on('error', (e) => reject(unavailable(`Docker is not reachable: ${e.message}`)));
      req.end(payload);
    });
  }

  /** The parsed body of a 2xx answer (or one of `ok`); anything else throws `DockerError`. */
  async call<T>(method: string, path: string, o: DockerCall & { ok?: number[] } = {}): Promise<T> {
    const r = await this.raw(method, path, o);
    const ok = o.ok ? o.ok.includes(r.status) : r.status >= 200 && r.status < 300;
    if (!ok) throw new DockerError(r.status, messageOf(r.data) ?? `Docker answered ${r.status}`);
    return r.data as T;
  }

  /** The object, or null on 404. */
  async find<T>(path: string): Promise<T | null> {
    const r = await this.raw('GET', path);
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) throw new DockerError(r.status, messageOf(r.data) ?? `Docker answered ${r.status}`);
    return r.data as T;
  }
}

/** `filters` query value for label filters. */
export const labelFilter = (...labels: string[]) => JSON.stringify({ label: labels });
