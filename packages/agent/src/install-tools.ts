/**
 * The agent's download, unpacking and tool-running helpers for installs from
 * the web (`InstallCtx.fetch`, `download`, `extract`, `exec`; UPD-01): the
 * adapter says what to fetch, unpack and run, the agent does it the same way
 * for every game.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { DownloadRequest, ExecOptions, ExecResult, ExtractRequest, ExtractResult } from '@gsp/adapter-api';
import { extractArchive, readZipDirectory } from '@gsp/archive';
import { lineSplitter } from './process';

export interface FetchOptions {
  /** Sent with every request. */
  userAgent: string;
  /** Tries in all, the first included. */
  attempts?: number;
  /** First backoff when the server gives no `Retry-After`; doubles each try. */
  baseDelayMs?: number;
  /** Longest wait between tries, `Retry-After` included. */
  maxDelayMs?: number;
  /** One request's own time limit. */
  requestTimeoutMs?: number;
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `Retry-After` in milliseconds: seconds, or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Whether a response is worth asking again: rate limits and server errors. */
const retryable = (status: number) => status === 429 || status >= 500;

/** How a GET treats redirects: followed (the default), or answered as they are for the caller to check. */
export interface GetInit {
  redirect?: 'follow' | 'manual';
}

/** `InstallCtx.fetch`: a GET that names the panel and retries 429, 5xx and network failures. */
export function makeFetch(o: FetchOptions): (url: string, init?: GetInit) => Promise<Response> {
  const attempts = Math.max(1, o.attempts ?? 5);
  const base = o.baseDelayMs ?? 1_000;
  const max = o.maxDelayMs ?? 30_000;
  const timeout = o.requestTimeoutMs ?? 60_000;
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`Only http(s) downloads are allowed: ${u.protocol}`);
    let lastError: Error | null = null;
    for (let i = 1; i <= attempts; i++) {
      let res: Response | null = null;
      try {
        res = await fetch(u, { headers: { 'user-agent': o.userAgent }, redirect: init.redirect ?? 'follow', signal: AbortSignal.timeout(timeout) });
      } catch (e) {
        lastError = e as Error;
      }
      if (res && (!retryable(res.status) || i === attempts)) return res;
      if (!res && i === attempts) break;
      const wait = Math.min(max, (res && retryAfterMs(res.headers.get('retry-after'))) ?? base * 2 ** (i - 1));
      // Nobody reads the body of a response we give up on.
      await res?.body?.cancel().catch(() => undefined);
      o.log?.(`${u.host}: ${res ? `HTTP ${res.status}` : (lastError?.message ?? 'no answer')}; trying again in ${Math.round(wait / 100) / 10} s (${i}/${attempts - 1})`);
      await sleep(wait);
    }
    throw new Error(`${u.host} did not answer: ${lastError?.message ?? 'unknown error'}`);
  };
}

export interface DownloadOptions {
  fetch: (url: string, init?: GetInit) => Promise<Response>;
  /** Job progress (percent null when the size is unknown). */
  progress?: (percent: number | null, message: string) => void;
}

/** An error with the `code` a `DownloadRequest` documents. */
function codedError(code: 'download-refused' | 'download-too-large', message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Redirects a download with `allowUrl` follows, each checked. */
const MAX_REDIRECTS = 5;

/**
 * GET `url` following redirects one by one, each address checked by
 * `allow` before it is asked (a link people gave may go only where its
 * source allows, redirects included).
 */
async function getAllowed(o: DownloadOptions, url: string, allow: (u: URL) => boolean, what: string): Promise<Response> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw codedError('download-refused', `Not a web address for ${what}`);
  }
  for (let hop = 0; ; hop++) {
    if (!allow(u)) throw codedError('download-refused', hop === 0 ? `Refusing to download ${what} from ${u.origin}` : `The download of ${what} was sent on to ${u.origin}, which is not allowed`);
    const res = await o.fetch(u.href, { redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    await res.body?.cancel().catch(() => undefined);
    const next = res.headers.get('location');
    if (!next) throw new Error(`Could not download ${what}: a redirect without a location`);
    if (hop >= MAX_REDIRECTS) throw new Error(`Could not download ${what}: more than ${MAX_REDIRECTS} redirects`);
    u = new URL(next, u);
  }
}

/** `InstallCtx.download`: fetch to `dest.part`, check size and digests, then rename. */
export function makeDownload(o: DownloadOptions): (req: DownloadRequest) => Promise<void> {
  return async (req) => {
    if (!path.isAbsolute(req.dest)) throw new Error(`Download destination must be absolute: ${req.dest}`);
    const res = req.allowUrl ? await getAllowed(o, req.url, (u) => req.allowUrl!(u), req.what) : await o.fetch(req.url);
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Could not download ${req.what}: HTTP ${res.status}`);
    }
    const max = req.maxBytes;
    const announced = Number(res.headers.get('content-length')) || null;
    if (max !== undefined && announced !== null && announced > max) {
      await res.body.cancel().catch(() => undefined);
      throw codedError('download-too-large', `${req.what} is ${announced} bytes, more than the ${max} allowed`);
    }
    const total = req.size ?? announced;
    const part = `${req.dest}.part`;
    await mkdir(path.dirname(req.dest), { recursive: true });
    const sha1 = createHash('sha1');
    const sha256 = createHash('sha256');
    let got = 0;
    let shown: number | null | undefined;
    const source = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    source.on('data', (chunk: Buffer) => {
      got += chunk.length;
      if (max !== undefined && got > max) {
        source.destroy(codedError('download-too-large', `${req.what} is more than the ${max} bytes allowed`));
        return;
      }
      sha1.update(chunk);
      sha256.update(chunk);
      const percent = total ? Math.min(100, Math.floor((got / total) * 100)) : null;
      if (percent !== shown) {
        shown = percent;
        o.progress?.(percent, `Downloading ${req.what}`);
      }
    });
    try {
      await pipeline(source, createWriteStream(part));
      const problems: string[] = [];
      if (req.size !== undefined && got !== req.size) problems.push(`${got} bytes instead of ${req.size}`);
      if (req.sha1 !== undefined && sha1.digest('hex') !== req.sha1.toLowerCase()) problems.push('its SHA-1 does not match');
      if (req.sha256 !== undefined && sha256.digest('hex') !== req.sha256.toLowerCase()) problems.push('its SHA-256 does not match');
      if (problems.length) throw new Error(`The download of ${req.what} is not what was published: ${problems.join(', ')}`);
      await rename(part, req.dest);
    } catch (e) {
      await rm(part, { force: true });
      throw e;
    }
  };
}

/** `inner` is `outer` or inside it (absolute paths). */
function within(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/** An archive's size unpacked and its number of entries, checked against `ExtractRequest.limits` before anything is written. */
async function checkLimits(req: ExtractRequest): Promise<void> {
  const l = req.limits;
  if (!l || (l.bytes === undefined && l.entries === undefined)) return;
  if (req.format === 'tar.gz') throw new Error('Limits apply to zip and tar archives only');
  let bytes: number;
  let entries: number | null = null;
  if (req.format === 'zip') {
    const fh = await open(req.file, 'r');
    try {
      const list = await readZipDirectory(fh);
      entries = list.length;
      bytes = list.reduce((n, e) => n + (e.dir ? 0 : e.size), 0);
    } catch (e) {
      throw new Error(`${path.basename(req.file)}: ${(e as Error).message}`, { cause: e });
    } finally {
      await fh.close();
    }
  } else {
    // A tar holds its files uncompressed: its size bounds what it unpacks to.
    bytes = (await stat(req.file)).size;
  }
  if (l.bytes !== undefined && bytes > l.bytes) throw new Error(`The archive unpacks to ${bytes} bytes, more than the ${l.bytes} allowed`);
  if (l.entries !== undefined && entries !== null && entries > l.entries) throw new Error(`The archive has ${entries} entries, more than the ${l.entries} allowed`);
}

/**
 * `InstallCtx.extract`: `@gsp/archive`'s extraction, for archives and
 * destinations in the server's install or data root only (`roots()`: the
 * adapter's, as the agent relocated them), within the request's limits.
 */
export function makeExtract(roots: () => string[]): (req: ExtractRequest) => Promise<ExtractResult> {
  return async (req) => {
    const allowed = roots().map((r) => path.resolve(r));
    for (const [what, p] of [
      ['archive', req.file],
      ['destination', req.dest],
    ] as const) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`The ${what} to unpack must be an absolute path`);
      if (!allowed.some((r) => within(r, path.resolve(p)))) throw new Error(`The ${what} to unpack must be in the server's install or data folder: ${p}`);
    }
    await checkLimits(req);
    return extractArchive(req);
  };
}

export interface ExecToolOptions {
  /** The environment tools see (the agent's without its token). */
  env: Record<string, string | undefined>;
  /** Each output line (to the job's log). */
  onLine: (line: string) => void;
  /** Working directory when a call names none. */
  cwd: string;
}

/** `InstallCtx.exec`: an argument array, never a shell; output lines to the log. */
export function makeExec(o: ExecToolOptions): (argv: string[], opts?: ExecOptions) => Promise<ExecResult> {
  return (argv, opts = {}) =>
    new Promise((resolve, reject) => {
      const [file, ...args] = argv;
      if (!file) return reject(new Error('Empty command'));
      if (argv.some((a) => typeof a !== 'string' || a.includes('\0'))) return reject(new Error('Command arguments must be strings without NUL'));
      const cwd = opts.cwd ?? o.cwd;
      if (!path.isAbsolute(cwd)) return reject(new Error(`Working directory must be absolute: ${cwd}`));
      const child = spawn(file, args, { cwd, env: { ...o.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const out = lineSplitter(o.onLine);
      const err = lineSplitter(o.onLine);
      child.stdout.on('data', (c: Buffer) => out.push(c));
      child.stderr.on('data', (c: Buffer) => err.push(c));
      const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 10 * 60_000);
      child.once('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`Could not run ${path.basename(file)}: ${e.message}`));
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        out.flush();
        err.flush();
        resolve({ code, signal });
      });
    });
}
