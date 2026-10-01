import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_RELS, ServerFilesError, TarError } from '@gsp/archive';
import { FS_WRITE_MAX_BYTES, type AgentError as AgentErrorBody, type FsListResponse, type FsOkResponse, type FsStatResponse, type ServerFilesErrorCode, type StageResponse, type SwapResponse } from '@gsp/shared';
import { AgentError, type Agent } from './agent';
import type { EventHub } from './events';

const MAX_BODY = 64 * 1024;
const ACTION_ROUTE = /^\/v1\/actions\/([a-z][a-z0-9-]{0,39})$/;
/** Routes whose body is a stream (a file, an archive), not JSON. */
const STREAM_ROUTES = new Set(['PUT /v1/fs/write', 'POST /v1/archive/stage']);

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

const FILE_STATUS: Record<ServerFilesErrorCode, number> = {
  'invalid-path': 400,
  'outside-root': 403,
  'not-a-file': 400,
  'not-a-dir': 400,
  'too-large': 413,
  'unknown-root': 404,
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

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body ?? {});
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers });
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

// ------------------------------------------------------------ files (D11)

function str(body: Record<string, unknown>, key: string, max = 1024): string {
  const v = body[key];
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, 'bad-request', `${key} must be a string`);
  return v;
}

function strs(body: Record<string, unknown>, key: string): string[] {
  const v = body[key];
  if (!Array.isArray(v) || v.length > MAX_RELS || !v.every((x) => typeof x === 'string' && x.length <= 1024)) throw new HttpError(400, 'bad-request', `${key} must be a list of paths`);
  return v as string[];
}

/** Continues an iterator whose first step was taken already (to answer its errors as JSON); closing it closes the source. */
async function* resume<T>(first: IteratorResult<T>, it: AsyncIterator<T>): AsyncGenerator<T> {
  try {
    if (!first.done) yield first.value;
    for (;;) {
      const r = await it.next();
      if (r.done) return;
      yield r.value;
    }
  } finally {
    await it.return?.();
  }
}

/** `POST /v1/archive/pack`: errors before the first byte (a bad path, the game's hot-copy step) are JSON; later ones cut the stream. */
async function pack(agent: Agent, body: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
  const sqlite = body.sqlite === undefined ? undefined : strs(body, 'sqlite');
  const prefix = body.prefix === undefined ? undefined : str(body, 'prefix', 256);
  const stream = await agent.pack({ root: str(body, 'root', 64), rels: strs(body, 'rels'), sqlite, prefix });
  const it = stream[Symbol.asyncIterator]();
  const first = await it.next();
  res.writeHead(200, { 'content-type': 'application/x-tar', 'cache-control': 'no-store' });
  // A reader that goes away closes the pack: its `finally` (the hot copy's `after`) runs.
  await pipeline(Readable.from(resume(first, it)), res);
}

/** The streamed routes: a file's bytes, an archive. The rest of a refused body is read and dropped, so the reply gets through. */
async function streamRoute(agent: Agent, route: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = req.iterator({ destroyOnReturn: false }) as AsyncIterableIterator<Buffer>;
  try {
    if (route === 'PUT /v1/fs/write') {
      const root = url.searchParams.get('root');
      const rel = url.searchParams.get('rel');
      if (root === null || rel === null) throw new HttpError(400, 'bad-request', 'root and rel are required');
      if (!(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) throw new HttpError(415, 'bad-request', 'Expected application/octet-stream');
      if (Number(req.headers['content-length'] ?? 0) > FS_WRITE_MAX_BYTES) throw new ServerFilesError('too-large', `More than ${FS_WRITE_MAX_BYTES} bytes`);
      await agent.files.writeFrom(root, rel, body);
      return send(res, 200, { ok: true } satisfies FsOkResponse);
    }
    if (!(req.headers['content-type'] ?? '').startsWith('application/x-tar')) throw new HttpError(415, 'bad-request', 'Expected application/x-tar');
    return send(res, 200, (await agent.files.stage(body, url.searchParams.getAll('allow'))) satisfies StageResponse);
  } finally {
    // Whatever wasn't read (a refused archive): dropped, unless the client hangs up first.
    void (async () => {
      try {
        for await (const _ of body) {
          // discard
        }
      } catch {
        // the client went away
      }
    })();
  }
}

export function createAgentServer(agent: Agent, hub: EventHub, token: string): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://agent');
      const route = `${req.method} ${url.pathname}`;
      try {
        if (route === 'GET /v1/health') return send(res, 200, { ok: true });
        const auth = req.headers.authorization ?? '';
        if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), token)) throw new HttpError(401, 'unauthorized', 'Unauthorized');
        const lockId = typeof req.headers['x-lock-id'] === 'string' ? req.headers['x-lock-id'] : undefined;
        if (STREAM_ROUTES.has(route)) return await streamRoute(agent, route, url, req, res);
        const body = await readJson(req);

        const action = req.method === 'POST' ? ACTION_ROUTE.exec(url.pathname) : null;
        if (action) return send(res, 200, { result: await agent.action(action[1]!, body.input) });

        switch (route) {
          case 'GET /v1/status':
            return send(res, 200, agent.status());
          case 'GET /v1/events': {
            const since = Number(url.searchParams.get('since') ?? req.headers['last-event-id'] ?? 0);
            return streamEvents(req, res, hub, Number.isFinite(since) ? since : 0);
          }
          case 'PUT /v1/launch':
            // A LaunchEnvelope, or (deprecated) bare params of the agent's adapter.
            agent.setLaunch(body);
            return send(res, 200, agent.status());
          case 'POST /v1/start':
            await agent.start(body.launch, lockId);
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
          case 'POST /v1/install':
            return send(res, 200, await agent.install({ validate: body.validate === true, launch: body.launch }, lockId));
          case 'POST /v1/versions':
            return send(res, 200, await agent.versions({ launch: body.launch }));
          case 'POST /v1/save': {
            const timeoutMs = typeof body.timeoutMs === 'number' ? Math.min(Math.max(body.timeoutMs, 1_000), 600_000) : undefined;
            return send(res, 200, await agent.save(timeoutMs));
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

          // The server's files (D11): the panel reaches them only here.
          case 'POST /v1/fs/stat':
            return send(res, 200, { stat: await agent.files.stat(str(body, 'root', 64), str(body, 'rel')) } satisfies FsStatResponse);
          case 'POST /v1/fs/list':
            return send(res, 200, { entries: await agent.files.list(str(body, 'root', 64), str(body, 'rel')) } satisfies FsListResponse);
          case 'POST /v1/fs/read': {
            const max = body.maxBytes;
            if (max !== undefined && !(Number.isSafeInteger(max) && (max as number) >= 0)) throw new HttpError(400, 'bad-request', 'maxBytes must be a whole number');
            const data = await agent.files.read(str(body, 'root', 64), str(body, 'rel'), { maxBytes: max as number | undefined });
            if (!data) throw new HttpError(404, 'not-found', 'No such file');
            res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-length': data.length });
            return void res.end(data);
          }
          case 'POST /v1/fs/remove':
            await agent.files.remove(str(body, 'root', 64), strs(body, 'rels'));
            return send(res, 200, { ok: true } satisfies FsOkResponse);
          case 'POST /v1/archive/pack':
            return await pack(agent, body, res);
          case 'POST /v1/archive/swap':
            // Files swapped under a running game would be overwritten by it, or break it.
            if (agent.gameProcess()) throw new AgentError('conflict', 'Stop the server before swapping its files');
            return send(res, 200, (await agent.files.swap(str(body, 'stagingId', 64), strs(body, 'rels'))) satisfies SwapResponse);
          case 'POST /v1/archive/undo':
            if (agent.gameProcess()) throw new AgentError('conflict', 'Stop the server before putting its files back');
            await agent.files.undo(str(body, 'trashId', 64));
            return send(res, 200, { ok: true } satisfies FsOkResponse);
          case 'POST /v1/archive/purge':
            await agent.files.purgeTrash(body.trashId === undefined ? undefined : str(body, 'trashId', 64));
            return send(res, 200, { ok: true } satisfies FsOkResponse);
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
        if (e instanceof ServerFilesError) {
          return send(res, FILE_STATUS[e.code], { error: e.message, code: e.code === 'unknown-root' ? 'not-found' : 'bad-request', reason: e.code } satisfies AgentErrorBody);
        }
        // A damaged or hostile archive (`stage`).
        if (e instanceof TarError) return send(res, 400, { error: e.message, code: 'bad-request' } satisfies AgentErrorBody);
        console.error(e);
        return send(res, 500, { error: 'Internal error', code: 'internal' } satisfies AgentErrorBody);
      }
    })();
  });
  // An archive being restored can take longer to arrive than Node's default five minutes.
  server.requestTimeout = 0;
  return server;
}
