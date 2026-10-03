import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { INSTALL_ID_PATTERN, ORCHESTRATOR_API_VERSION, SERVER_ID_PATTERN, type HealthResponse, type HostInfo } from '@gsp/shared';
import type { Backend } from './backend';
import { badRequest, notFound, OrchError } from './errors';
import type { Policy } from './policy';
import { parseEmpty, parseInstallJobSpec, parseInstallPutOptions, parseSpec, parseStop } from './spec';

const MAX_BODY = 64 * 1024;
/** `/v1/servers/:id` and `/v1/servers/:id/<action>`, matched on the raw path (no dot-segment folding). */
const SERVER_ROUTE = /^\/v1\/servers\/([^/]*)(?:\/([^/]*))?$/;
/** `/v1/installs/:id` and `/v1/installs/:id/job` (HST-09), matched the same way. */
const INSTALL_ROUTE = /^\/v1\/installs\/([^/]*)(?:\/([^/]*))?$/;
const ACTIONS: ReadonlySet<string> = new Set(['start', 'stop', 'restart', 'stats', 'install']);

export interface OrchestratorServerOptions {
  backend: Backend;
  /** `ORCH_TOKEN`: every request carries it as a bearer token. */
  token: string;
  /** This build, reported by `/v1/health`. */
  version: string;
  policy: Policy;
  /** One line per request (method, path, status, time); never bodies. */
  log?: (line: string) => void;
}

function sameToken(given: string, expected: string): boolean {
  // Hash both so the comparison is constant-time whatever the lengths.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new OrchError('bad-request', 'Body too large', undefined, 413);
    chunks.push(c as Buffer);
  }
  if (size === 0) return undefined;
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json(\s*;|$)/i.test(type)) throw new OrchError('bad-request', 'Expected application/json', undefined, 415);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw badRequest('Invalid JSON');
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const methodNotAllowed = () => new OrchError('bad-request', 'Method not allowed', undefined, 405);

/** A route's boolean query parameters (`true` or `false`, each at most once; default false), and nothing else. */
function flags<K extends string>(query: URLSearchParams, names: readonly K[]): Record<K, boolean> {
  for (const k of query.keys()) if (!(names as readonly string[]).includes(k)) throw badRequest(`Unknown query parameter ${k.slice(0, 40)}`);
  const out = {} as Record<K, boolean>;
  for (const name of names) {
    const v = query.getAll(name);
    if (v.length > 1 || (v[0] !== undefined && v[0] !== 'true' && v[0] !== 'false')) throw badRequest(`${name} must be true or false`, name);
    out[name] = v[0] === 'true';
  }
  return out;
}

/**
 * The orchestrator API (`@gsp/shared` orchestrator-api, D3): bearer token on
 * every request, strict JSON bodies, only the routes of the contract. Ids are
 * checked on the raw path, so `..`, encoded slashes, upper case and long ids
 * never reach the backend.
 */
export function createOrchestratorServer(o: OrchestratorServerOptions): http.Server {
  if (o.token.length < 32) throw new Error('The orchestrator token must be at least 32 characters');

  async function route(req: http.IncomingMessage): Promise<[number, unknown]> {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), o.token)) throw new OrchError('unauthorized', 'Unauthorized');

    const raw = req.url ?? '/';
    const q = raw.indexOf('?');
    const path = q < 0 ? raw : raw.slice(0, q);
    const query = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
    const method = req.method ?? 'GET';
    const body = await readBody(req);
    const noQuery = () => {
      if (query.size) throw badRequest('This route takes no query parameters');
    };
    const noBody = () => {
      if (body !== undefined) throw badRequest('This route takes no body');
    };

    if (path === '/v1/health' || path === '/v1/host' || path === '/v1/servers') {
      if (method !== 'GET') throw methodNotAllowed();
      noQuery();
      noBody();
      if (path === '/v1/health') {
        await o.backend.ping();
        const health: HealthResponse = { ok: true, version: o.version, api: ORCHESTRATOR_API_VERSION };
        return [200, health];
      }
      if (path === '/v1/host') {
        // What the host is, and what this install lets a server ask for (its own settings, never the caller's).
        const host: HostInfo = { ...(await o.backend.host()), hostPorts: o.policy.hostPorts.map(([from, to]) => ({ from, to })), maxMemMb: o.policy.maxMemMb };
        return [200, host];
      }
      return [200, await o.backend.list()];
    }

    if (path === '/v1/installs') {
      if (method !== 'GET') throw methodNotAllowed();
      noQuery();
      noBody();
      return [200, await o.backend.installs()];
    }
    const im = INSTALL_ROUTE.exec(path);
    if (im) {
      const [, iid = '', sub] = im;
      if (sub !== undefined && sub !== 'job') throw notFound('No such route');
      if (!INSTALL_ID_PATTERN.test(iid)) throw badRequest('The install id must be i, then 8-31 of a-z and 0-9', 'id');
      if (sub === 'job') {
        if (method !== 'DELETE') throw methodNotAllowed();
        noQuery();
        noBody();
        return [200, await o.backend.removeInstallJob(iid)];
      }
      if (method === 'PUT') {
        const src = parseInstallPutOptions(query, iid);
        return [200, await o.backend.putInstall(parseInstallJobSpec(body, iid, o.policy), src)];
      }
      if (method === 'DELETE') {
        noQuery();
        noBody();
        return [200, await o.backend.removeInstall(iid)];
      }
      throw methodNotAllowed();
    }

    const m = SERVER_ROUTE.exec(path);
    if (!m) throw notFound('No such route');
    const [, id = '', action] = m;
    if (action !== undefined && !ACTIONS.has(action)) throw notFound('No such route');
    if (!SERVER_ID_PATTERN.test(id)) throw badRequest('The server id must be 2-24 characters: a-z first, then a-z, 0-9 and -', 'id');

    if (action === undefined) {
      if (method === 'PUT') {
        const { keepImage, keepDerivation } = flags(query, ['keepImage', 'keepDerivation']);
        return [200, await o.backend.apply(parseSpec(body, id, o.policy), { keepImage, keepDerivation })];
      }
      if (method === 'DELETE') {
        noBody();
        return [200, await o.backend.remove(id, flags(query, ['removeVolumes']).removeVolumes)];
      }
      throw methodNotAllowed();
    }
    noQuery();
    if (action === 'install') {
      // HST-09: a server's own install volume, left over after it moved to a shared install.
      if (method !== 'DELETE') throw methodNotAllowed();
      noBody();
      return [200, await o.backend.removeOwnInstall(id)];
    }
    if (action === 'stats') {
      if (method !== 'GET') throw methodNotAllowed();
      noBody();
      return [200, await o.backend.stats(id)];
    }
    if (method !== 'POST') throw methodNotAllowed();
    if (action === 'start') {
      parseEmpty(body);
      return [200, await o.backend.start(id)];
    }
    const { timeoutSec } = parseStop(body);
    return [200, action === 'stop' ? await o.backend.stop(id, timeoutSec) : await o.backend.restart(id, timeoutSec)];
  }

  return http.createServer((req, res) => {
    const started = Date.now();
    void route(req)
      .then(([status, body]) => {
        send(res, status, body);
        return status;
      })
      .catch((e: unknown) => {
        if (e instanceof OrchError) {
          send(res, e.status, e.body());
          return e.status;
        }
        o.log?.(`internal error: ${(e as Error).stack ?? String(e)}`);
        send(res, 500, { error: 'Internal error', code: 'internal' });
        return 500;
      })
      .then((status) => {
        // The path only: the query holds nothing secret, but keep lines short and uniform.
        const path = (req.url ?? '').split('?')[0]?.slice(0, 80) ?? '';
        o.log?.(`${req.method ?? '?'} ${path} ${status} ${Date.now() - started}ms`);
      });
  });
}
