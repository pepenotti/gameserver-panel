/**
 * The agent's download and tool-running helpers for installs from the web
 * (`InstallCtx.fetch`, `download`, `exec`; UPD-01): the adapter says what to
 * fetch and run, the agent does it the same way for every game.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { DownloadRequest, ExecOptions, ExecResult } from '@gsp/adapter-api';
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

/** `InstallCtx.fetch`: a GET that names the panel and retries 429, 5xx and network failures. */
export function makeFetch(o: FetchOptions): (url: string) => Promise<Response> {
  const attempts = Math.max(1, o.attempts ?? 5);
  const base = o.baseDelayMs ?? 1_000;
  const max = o.maxDelayMs ?? 30_000;
  const timeout = o.requestTimeoutMs ?? 60_000;
  return async (url) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`Only http(s) downloads are allowed: ${u.protocol}`);
    let lastError: Error | null = null;
    for (let i = 1; i <= attempts; i++) {
      let res: Response | null = null;
      try {
        res = await fetch(u, { headers: { 'user-agent': o.userAgent }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
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
  fetch: (url: string) => Promise<Response>;
  /** Job progress (percent null when the size is unknown). */
  progress?: (percent: number | null, message: string) => void;
}

/** `InstallCtx.download`: fetch to `dest.part`, check size and digests, then rename. */
export function makeDownload(o: DownloadOptions): (req: DownloadRequest) => Promise<void> {
  return async (req) => {
    if (!path.isAbsolute(req.dest)) throw new Error(`Download destination must be absolute: ${req.dest}`);
    const res = await o.fetch(req.url);
    if (!res.ok || !res.body) throw new Error(`Could not download ${req.what}: HTTP ${res.status}`);
    const total = req.size ?? (Number(res.headers.get('content-length')) || null);
    const part = `${req.dest}.part`;
    await mkdir(path.dirname(req.dest), { recursive: true });
    const sha1 = createHash('sha1');
    const sha256 = createHash('sha256');
    let got = 0;
    let shown: number | null | undefined;
    const source = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    source.on('data', (chunk: Buffer) => {
      got += chunk.length;
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
