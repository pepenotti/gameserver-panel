import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AgentError as AgentErrorBody } from '@pz/shared';
import { AgentError, validateLaunch, type Agent } from './agent';
import type { EventHub } from './events';

const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: AgentErrorBody['code'],
    message: string,
  ) {
    super(message);
  }
}

const STATUS_FOR: Record<AgentError['code'], number> = {
  'bad-request': 400,
  'not-found': 404,
  conflict: 409,
  locked: 423,
  unavailable: 503,
};

function sameToken(given: string, expected: string): boolean {
  // Hash both so the comparison is constant-time regardless of length.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === 'GET' || req.method === 'DELETE') return {};
  const type = req.headers['content-type'] ?? '';
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'bad-request', 'Body too large');
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  if (!type.startsWith('application/json')) throw new HttpError(415, 'bad-request', 'Expected application/json');
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'bad-request', 'Invalid JSON');
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? {});
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function streamEvents(req: http.IncomingMessage, res: http.ServerResponse, hub: EventHub, since: number): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const { events, truncated } = hub.since(since);
  if (truncated) res.write(`event: truncated\ndata: {}\n\n`);
  for (const e of events) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
  const unsubscribe = hub.subscribe((e) => {
    if (!res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`)) {
      // Slow consumer: drop it rather than buffer without bound; it reconnects with Last-Event-ID.
      res.destroy();
    }
  });
  const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
}

export function createAgentServer(agent: Agent, hub: EventHub, token: string): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://agent');
      const route = `${req.method} ${url.pathname}`;
      try {
        if (route === 'GET /v1/health') return send(res, 200, { ok: true });
        const auth = req.headers.authorization ?? '';
        if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), token)) throw new HttpError(401, 'unauthorized', 'Unauthorized');
        const lockId = typeof req.headers['x-lock-id'] === 'string' ? req.headers['x-lock-id'] : undefined;
        const body = await readJson(req);

        switch (route) {
          case 'GET /v1/status':
            return send(res, 200, agent.status());
          case 'GET /v1/events': {
            const since = Number(url.searchParams.get('since') ?? req.headers['last-event-id'] ?? 0);
            return streamEvents(req, res, hub, Number.isFinite(since) ? since : 0);
          }
          case 'PUT /v1/launch':
            agent.setLaunch(validateLaunch(body));
            return send(res, 200, agent.status());
          case 'POST /v1/start':
            await agent.start(body.launch === undefined ? undefined : validateLaunch(body.launch), lockId);
            return send(res, 202, agent.status());
          case 'POST /v1/stop': {
            const timeoutMs = typeof body.timeoutMs === 'number' ? Math.min(Math.max(body.timeoutMs, 5_000), 600_000) : undefined;
            await agent.stop({ timeoutMs, reason: typeof body.reason === 'string' ? body.reason.slice(0, 100) : undefined }, lockId);
            return send(res, 200, agent.status());
          }
          case 'POST /v1/restart':
            await agent.restart(lockId);
            return send(res, 202, agent.status());
          case 'POST /v1/kill':
            agent.kill(lockId);
            return send(res, 202, agent.status());
          case 'POST /v1/command': {
            if (typeof body.command !== 'string') throw new HttpError(400, 'bad-request', 'command is required');
            const via = body.via === 'rcon' || body.via === 'stdin' ? body.via : undefined;
            return send(res, 200, await agent.command(body.command, via));
          }
          case 'POST /v1/steamcmd/install':
            return send(res, 200, await agent.install({ branch: typeof body.branch === 'string' ? body.branch : undefined, validate: body.validate === true }, lockId));
          case 'POST /v1/steamcmd/appinfo':
            return send(res, 200, await agent.appInfo());
          case 'POST /v1/steamcmd/workshop': {
            const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
            return send(res, 200, await agent.downloadWorkshop(ids));
          }
          case 'POST /v1/lock': {
            const holder = typeof body.holder === 'string' ? body.holder : '';
            const ttlMs = typeof body.ttlMs === 'number' ? body.ttlMs : 30 * 60_000;
            return send(res, 200, agent.acquireLock(holder, ttlMs));
          }
          case 'PUT /v1/lock':
            if (!lockId) throw new HttpError(400, 'bad-request', 'X-Lock-Id header required');
            agent.renewLock(lockId, typeof body.ttlMs === 'number' ? body.ttlMs : 30 * 60_000);
            return send(res, 200, { ok: true });
          case 'DELETE /v1/lock':
            if (lockId) agent.releaseLock(lockId);
            return send(res, 200, { ok: true });
          default:
            throw new HttpError(404, 'not-found', `No route ${route}`);
        }
      } catch (e) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code } satisfies AgentErrorBody);
        if (e instanceof AgentError) return send(res, STATUS_FOR[e.code], { error: e.message, code: e.code } satisfies AgentErrorBody);
        console.error(e);
        return send(res, 500, { error: 'Internal error', code: 'internal' } satisfies AgentErrorBody);
      }
    })();
  });
}
