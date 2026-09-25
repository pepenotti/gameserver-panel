import http from 'node:http';
import https from 'node:https';
import type { DirEntry, FileKind, FileStat, PackRequest, RootId, ServerFiles, ServerFilesErrorCode } from '@gsp/adapter-api';
import { READ_MAX_BYTES, ServerFilesError } from '@gsp/archive';
import { FS_WRITE_MAX_BYTES, type AgentError as AgentErrorBody, type FsListResponse, type FsStatResponse, type StageResponse, type SwapResponse } from '@gsp/shared';
import { AgentCallError } from '../agent/client';

/** Where a server's agent answers, and its token (the server's `AGENT_TOKEN`). */
export interface AgentFilesTarget {
  baseUrl: string;
  token: string;
  /** Quick calls (stat, list, read, write); default 30 s. */
  timeoutMs?: number;
  /** How long a pack or a stage may go without a byte either way; default 30 min (a game's hot-copy step can take minutes). */
  idleMs?: number;
}

const REASONS: ReadonlySet<string> = new Set<ServerFilesErrorCode>(['invalid-path', 'outside-root', 'not-a-file', 'not-a-dir', 'too-large', 'unknown-root']);
const KINDS: ReadonlySet<string> = new Set<FileKind>(['file', 'dir', 'symlink', 'other']);
/** Calls that move or delete whole folders (a world): longer than the quick ones. */
const BULK_TIMEOUT_MS = 10 * 60_000;
const MAX_ERROR_BODY = 64 * 1024;

const unreachable = (e: unknown) => new AgentCallError(503, 'unreachable', `Game server agent unreachable: ${(e as Error).message}`);

/** An error reply as `ServerFiles` callers expect it: `ServerFilesError` for a refused path, `AgentCallError` for the rest. */
function replyError(status: number, text: string): Error {
  let body: Partial<AgentErrorBody> = {};
  try {
    body = JSON.parse(text) as Partial<AgentErrorBody>;
  } catch {
    // not JSON: a proxy or a crash
  }
  if (typeof body.reason === 'string' && REASONS.has(body.reason)) return new ServerFilesError(body.reason, typeof body.error === 'string' ? body.error : body.reason);
  return new AgentCallError(status, body.code ?? 'internal', typeof body.error === 'string' ? body.error : `Agent error ${status}`);
}

function isStat(x: unknown): x is FileStat {
  const s = x as FileStat;
  return typeof s === 'object' && s !== null && KINDS.has(s.kind) && Number.isFinite(s.size) && Number.isFinite(s.mtimeMs);
}

/** At most `max` bytes of a body; more is `too-large` (an agent that ignored the cap). */
async function readCapped(body: AsyncIterable<Uint8Array> | null, max: number, what: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of body ?? []) {
    n += c.length;
    if (n > max) throw new ServerFilesError('too-large', `${what} is larger than ${max} bytes`);
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

/** A reply body as an archive stream; closing it early hangs up (the agent's pack then runs its hot-copy `after`). */
async function* replyChunks(res: http.IncomingMessage): AsyncGenerator<Buffer> {
  try {
    for await (const c of res) yield c as Buffer;
  } finally {
    res.destroy();
  }
}

/** Writes an archive into a request, waiting while it is full; stops when the request is gone (the agent answered early). */
async function pump(src: AsyncIterable<Buffer>, req: http.ClientRequest): Promise<void> {
  for await (const chunk of src) {
    if (req.destroyed) return;
    if (!req.write(chunk)) {
      await new Promise<void>((resolve) => {
        req.once('drain', resolve);
        req.once('close', resolve);
      });
    }
  }
  req.end();
}

/**
 * A server's files through its agent (D11): each method is one of the
 * agent's `/v1/fs/*` and `/v1/archive/*` routes (`@gsp/shared` agent-api).
 * Refused paths come back as `ServerFilesError` with the agent's reason;
 * anything else (unreachable, a bad token, a busy game) as `AgentCallError`.
 * Archives stream both ways; nothing of a game's files lands on the panel's
 * disk except the backups it writes itself.
 */
export class AgentServerFiles implements ServerFiles {
  constructor(readonly target: AgentFilesTarget) {}

  /**
   * Read on every call: an orchestrator-run server's agent address is known
   * only once the orchestrator answered (the panel's registry fills it in).
   */
  private get base(): string {
    return this.target.baseUrl.replace(/\/+$/, '');
  }

  private get headers(): Record<string, string> {
    return { authorization: `Bearer ${this.target.token}` };
  }

  private async post(path: string, body: unknown, timeoutMs = this.target.timeoutMs ?? 30_000): Promise<Response> {
    try {
      return await fetch(`${this.base}${path}`, { method: 'POST', headers: { ...this.headers, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw unreachable(e);
    }
  }

  private async json<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    const res = await this.post(path, body, timeoutMs);
    const text = (await readCapped(res.body, res.ok ? 64 * 1024 * 1024 : MAX_ERROR_BODY, 'The reply')).toString('utf8');
    if (!res.ok) throw replyError(res.status, text);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AgentCallError(502, 'internal', `The agent's reply to ${path} is not JSON`);
    }
  }

  /** A request whose body or reply is a stream, over node:http; resolves with the reply once its headers arrive. */
  private stream(path: string, type: string, body: Buffer | AsyncIterable<Buffer>): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
    const url = new URL(`${this.base}${path}`);
    const idleMs = this.target.idleMs ?? 30 * 60_000;
    return new Promise((resolve, reject) => {
      let settled = false;
      let sourceError: unknown = null;
      const req = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers: { ...this.headers, 'content-type': type } });
      req.setTimeout(idleMs, () => req.destroy(new Error(`nothing from the agent for ${Math.round(idleMs / 1000)} s`)));
      req.on('response', (res) => {
        settled = true;
        resolve({ req, res });
      });
      req.on('error', (e) => {
        if (settled) return;
        settled = true;
        // The archive we were sending failed: that is the error, not the connection.
        reject(sourceError ?? unreachable(e));
      });
      if (Buffer.isBuffer(body)) req.end(body);
      else {
        pump(body, req).catch((e: unknown) => {
          sourceError = e;
          req.destroy(e as Error);
        });
      }
    });
  }

  async stat(root: RootId, rel: string): Promise<FileStat | null> {
    const { stat } = await this.json<FsStatResponse>('/v1/fs/stat', { root, rel });
    if (stat === null) return null;
    if (!isStat(stat)) throw new AgentCallError(502, 'internal', 'The agent sent an invalid stat');
    return { kind: stat.kind, size: stat.size, mtimeMs: stat.mtimeMs };
  }

  async list(root: RootId, rel: string): Promise<DirEntry[]> {
    const { entries } = await this.json<FsListResponse>('/v1/fs/list', { root, rel });
    if (!Array.isArray(entries)) throw new AgentCallError(502, 'internal', 'The agent sent an invalid listing');
    return entries.filter((e) => isStat(e) && typeof e.name === 'string' && e.name !== '' && !e.name.includes('/')).map((e) => ({ name: e.name, kind: e.kind, size: e.size, mtimeMs: e.mtimeMs }));
  }

  async read(root: RootId, rel: string, o: { maxBytes?: number } = {}): Promise<Buffer | null> {
    const cap = Math.min(o.maxBytes ?? READ_MAX_BYTES, READ_MAX_BYTES);
    const res = await this.post('/v1/fs/read', o.maxBytes === undefined ? { root, rel } : { root, rel, maxBytes: o.maxBytes });
    if (!res.ok) {
      const err = replyError(res.status, (await readCapped(res.body, MAX_ERROR_BODY, 'The reply')).toString('utf8'));
      // 404 without a reason: no such file. (An agent without the route is an error, not a missing file.)
      if (res.status === 404 && err instanceof AgentCallError && !/^No route/.test(err.message)) return null;
      throw err;
    }
    return readCapped(res.body, cap, rel);
  }

  async writeAtomic(root: RootId, rel: string, data: Buffer | string): Promise<void> {
    const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (body.length > FS_WRITE_MAX_BYTES) throw new ServerFilesError('too-large', `${rel}: more than ${FS_WRITE_MAX_BYTES} bytes`);
    const q = new URLSearchParams({ root, rel });
    let res: Response;
    try {
      res = await fetch(`${this.base}/v1/fs/write?${q}`, { method: 'PUT', headers: { ...this.headers, 'content-type': 'application/octet-stream' }, body, signal: AbortSignal.timeout(this.target.timeoutMs ?? 30_000) });
    } catch (e) {
      throw unreachable(e);
    }
    const text = (await readCapped(res.body, MAX_ERROR_BODY, 'The reply')).toString('utf8');
    if (!res.ok) throw replyError(res.status, text);
  }

  async remove(root: RootId, rels: string[]): Promise<void> {
    await this.json('/v1/fs/remove', { root, rels }, BULK_TIMEOUT_MS);
  }

  async pack(req: PackRequest): Promise<AsyncIterable<Buffer>> {
    const { res } = await this.stream('/v1/archive/pack', 'application/json', Buffer.from(JSON.stringify(req)));
    if (res.statusCode !== 200) {
      const text = (await readCapped(res, MAX_ERROR_BODY, 'The reply')).toString('utf8');
      throw replyError(res.statusCode ?? 502, text);
    }
    return replyChunks(res);
  }

  async stage(archive: AsyncIterable<Buffer>, allow: string[]): Promise<{ stagingId: string; entries: number }> {
    const q = new URLSearchParams(allow.map((a): [string, string] => ['allow', a]));
    const { req, res } = await this.stream(`/v1/archive/stage?${q}`, 'application/x-tar', archive);
    try {
      const text = (await readCapped(res, MAX_ERROR_BODY, 'The reply')).toString('utf8');
      if (res.statusCode !== 200) throw replyError(res.statusCode ?? 502, text);
      const r = JSON.parse(text) as StageResponse;
      if (typeof r.stagingId !== 'string' || !Number.isInteger(r.entries)) throw new AgentCallError(502, 'internal', 'The agent sent an invalid stage reply');
      return { stagingId: r.stagingId, entries: r.entries };
    } finally {
      // An early refusal: stop sending the rest.
      if (!req.writableFinished) req.destroy();
    }
  }

  async swap(stagingId: string, rels: string[]): Promise<{ trashId: string }> {
    const r = await this.json<SwapResponse>('/v1/archive/swap', { stagingId, rels }, BULK_TIMEOUT_MS);
    if (typeof r.trashId !== 'string') throw new AgentCallError(502, 'internal', 'The agent sent an invalid swap reply');
    return { trashId: r.trashId };
  }

  async undo(trashId: string): Promise<void> {
    await this.json('/v1/archive/undo', { trashId }, BULK_TIMEOUT_MS);
  }

  async purgeTrash(trashId?: string): Promise<void> {
    await this.json('/v1/archive/purge', trashId === undefined ? {} : { trashId }, BULK_TIMEOUT_MS);
  }
}
