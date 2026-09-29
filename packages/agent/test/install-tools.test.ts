// The agent's helpers for installs from the web (UPD-01): `InstallCtx.fetch`
// (names the panel, retries rate limits and server errors), `download`
// (progress, size and digests checked before the file is kept) and `exec`
// (argument arrays, output lines to the job's log).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstallCtx, JobResult } from '@gsp/adapter-api';
import { makeZip } from '../../../tools/fake-terraria/downloads.mjs';
import { makeDownload, makeExec, makeExtract, makeFetch, retryAfterMs } from '../src/install-tools';
import { envelope, freePort, makeHarness, type Harness } from './helpers';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A local HTTP server; `n` counts the requests to each path. */
async function serve(handler: Handler): Promise<{ url: string; seen: { path: string; ua: string | undefined }[] }> {
  const seen: { path: string; ua: string | undefined }[] = [];
  const counts = new Map<string, number>();
  const srv = http.createServer((req, res) => {
    const p = req.url ?? '/';
    seen.push({ path: p, ua: req.headers['user-agent'] });
    const n = (counts.get(p) ?? 0) + 1;
    counts.set(p, n);
    handler(req, res, n);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
  return { url: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, seen };
}

function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'gsp-install-tools-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

const quick = (extra: Partial<Parameters<typeof makeFetch>[0]> = {}) => makeFetch({ userAgent: 'gameserver-panel/1.2.3', baseDelayMs: 10, ...extra });

describe('InstallCtx.fetch (UPD-01)', () => {
  it('names the panel and its version in the User-Agent', async () => {
    const s = await serve((_q, res) => res.end('{}'));
    const res = await quick()(`${s.url}/a`);
    expect(res.status).toBe(200);
    expect(s.seen).toEqual([{ path: '/a', ua: 'gameserver-panel/1.2.3' }]);
  });

  it('retries 429 (honouring Retry-After) and 5xx, then returns the answer', async () => {
    const s = await serve((req, res, n) => {
      if (req.url === '/limited' && n <= 2) return res.writeHead(429, { 'retry-after': '0' }).end();
      if (req.url === '/broken' && n === 1) return res.writeHead(503).end();
      res.end('ok');
    });
    const logs: string[] = [];
    const get = quick({ log: (l) => logs.push(l) });
    expect(await (await get(`${s.url}/limited`)).text()).toBe('ok');
    expect(await (await get(`${s.url}/broken`)).text()).toBe('ok');
    expect(s.seen.map((x) => x.path)).toEqual(['/limited', '/limited', '/limited', '/broken', '/broken']);
    expect(logs.some((l) => /HTTP 429; trying again in 0 s/.test(l))).toBe(true);
  });

  it('does not retry other statuses, and gives the last answer once the retries are spent', async () => {
    const s = await serve((req, res) => res.writeHead(req.url === '/missing' ? 404 : 429, { 'retry-after': '0' }).end());
    expect((await quick()(`${s.url}/missing`)).status).toBe(404);
    expect((await quick({ attempts: 3 })(`${s.url}/always-limited`)).status).toBe(429);
    expect(s.seen.map((x) => x.path)).toEqual(['/missing', '/always-limited', '/always-limited', '/always-limited']);
  });

  it('retries network failures, then rejects; refuses schemes other than http(s)', async () => {
    const port = await freePort();
    await expect(quick({ attempts: 2 })(`http://127.0.0.1:${port}/nobody`)).rejects.toThrow(/did not answer/);
    await expect(quick()('file:///etc/passwd')).rejects.toThrow(/Only http/);
  });

  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });
});

describe('InstallCtx.download (UPD-01)', () => {
  const body = Buffer.from('a fake server jar\n'.repeat(1000));
  const sha1 = createHash('sha1').update(body).digest('hex');
  const sha256 = createHash('sha256').update(body).digest('hex');

  it('keeps the file once its size and digests match, with progress on the job', async () => {
    const s = await serve((_q, res) => res.writeHead(200, { 'content-length': body.length }).end(body));
    const dir = tmp();
    const progress: (number | null)[] = [];
    const dl = makeDownload({ fetch: quick(), progress: (p) => progress.push(p) });
    const dest = path.join(dir, 'sub', 'server.jar');
    await dl({ url: `${s.url}/server.jar`, dest, what: 'server.jar', size: body.length, sha1, sha256 });
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(progress.at(-1)).toBe(100);
    expect(readdirSync(path.dirname(dest))).toEqual(['server.jar']);
  });

  it.each([
    ['size', { size: body.length + 1 }, /bytes instead of/],
    ['SHA-1', { sha1: '0'.repeat(40) }, /SHA-1 does not match/],
    ['SHA-256', { sha256: '0'.repeat(64) }, /SHA-256 does not match/],
  ])('leaves nothing behind when the %s is not what was published', async (_what, check, error) => {
    const s = await serve((_q, res) => res.end(body));
    const dir = tmp();
    const dest = path.join(dir, 'server.jar');
    await expect(makeDownload({ fetch: quick() })({ url: `${s.url}/x`, dest, what: 'server.jar', ...check })).rejects.toThrow(error);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('fails on an HTTP error, and takes only absolute destinations', async () => {
    const s = await serve((_q, res) => res.writeHead(404).end());
    const dir = tmp();
    await expect(makeDownload({ fetch: quick() })({ url: `${s.url}/x`, dest: path.join(dir, 'a.jar'), what: 'a.jar' })).rejects.toThrow(/HTTP 404/);
    await expect(makeDownload({ fetch: quick() })({ url: `${s.url}/x`, dest: 'a.jar', what: 'a.jar' })).rejects.toThrow(/absolute/);
    expect(existsSync(path.join(dir, 'a.jar'))).toBe(false);
  });
});

describe('InstallCtx.exec (UPD-01, NFR-01)', () => {
  it('runs an argument array without a shell, with every output line in the log and the exit code', async () => {
    const lines: string[] = [];
    const dir = tmp();
    const exec = makeExec({ env: { KEEP: 'kept' }, onLine: (l) => lines.push(l), cwd: dir });
    const script = 'console.log(process.argv[1]); console.error(process.cwd()); console.log(process.env.KEEP + " " + process.env.EXTRA); process.exit(3)';
    const r = await exec([process.execPath, '-e', script, 'x; echo injected'], { env: { EXTRA: 'extra' } });
    expect(r).toEqual({ code: 3, signal: null });
    expect(lines).toContain('x; echo injected');
    expect(lines).toContain(dir);
    expect(lines).toContain('kept extra');
    expect(lines).not.toContain('injected');
  });

  it('kills a tool that runs past its time limit, and fails when the tool does not exist', async () => {
    const exec = makeExec({ env: {}, onLine: () => undefined, cwd: tmp() });
    const r = await exec([process.execPath, '-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 });
    expect(r.signal).toBe('SIGKILL');
    await expect(exec([path.join(tmp(), 'no-such-tool')])).rejects.toThrow(/Could not run/);
    await expect(exec([])).rejects.toThrow(/Empty/);
  });
});

describe('InstallCtx.extract (UPD-01)', () => {
  it("unpacks an archive in the server's folders, and refuses archives and destinations anywhere else", async () => {
    const dir = tmp();
    const install = path.join(dir, 'install');
    const data = path.join(dir, 'data');
    mkdirSync(install);
    mkdirSync(data);
    const extract = makeExtract(() => [install, data]);
    const file = path.join(install, 'dl.zip');
    writeFileSync(file, makeZip([{ name: 'game/run', data: 'x' }]));
    expect(await extract({ file, dest: path.join(install, 'game-1'), format: 'zip', only: 'game', strip: 1 })).toEqual({ files: 1, dirs: 0 });
    expect(readFileSync(path.join(install, 'game-1', 'run'), 'utf8')).toBe('x');

    const elsewhere = path.join(dir, 'elsewhere');
    await expect(extract({ file, dest: elsewhere, format: 'zip' })).rejects.toThrow(/install or data folder/);
    await expect(extract({ file, dest: path.join(install, '..', 'elsewhere'), format: 'zip' })).rejects.toThrow(/install or data folder/);
    await expect(extract({ file: path.join(dir, 'x.zip'), dest: data, format: 'zip' })).rejects.toThrow(/install or data folder/);
    await expect(extract({ file: 'dl.zip', dest: data, format: 'zip' })).rejects.toThrow(/absolute/);
    expect(existsSync(elsewhere)).toBe(false);
  });
});

describe("the agent's install jobs get the helpers (UPD-01)", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });

  it("names the agent's version, streams tool lines to the log without its token, and reports download progress on the job", async () => {
    const body = Buffer.from('x'.repeat(50_000));
    const s = await serve((_q, res) => res.writeHead(200, { 'content-length': body.length }).end(body));
    let ran: JobResult | null = null;
    h = await makeHarness(
      {},
      {
        adapter: (a) => ({
          ...a,
          async install(ctx: InstallCtx): Promise<JobResult> {
            await ctx.download!({ url: `${s.url}/game.jar`, dest: path.join(ctx.roots.install, 'game.jar'), what: 'game.jar', size: body.length });
            const r = await ctx.exec!([process.execPath, '-e', 'console.log("installer says hi " + (process.env.AGENT_TOKEN ?? "no token"))']);
            writeFileSync(path.join(ctx.roots.install, 'game.zip'), makeZip([{ name: 'lib/a.txt', data: 'a' }]));
            await ctx.extract!({ file: path.join(ctx.roots.install, 'game.zip'), dest: path.join(ctx.roots.install, 'game'), format: 'zip' });
            ran = { ok: r.code === 0 };
            return ran;
          },
        }),
      },
    );
    process.env.AGENT_TOKEN = h.cfg.token;
    try {
      expect(await h.agent.install({ validate: false, launch: envelope() }, undefined)).toEqual({ ok: true });
    } finally {
      delete process.env.AGENT_TOKEN;
    }
    expect(ran).toEqual({ ok: true });
    expect(s.seen[0]!.ua).toBe('gameserver-panel/test');
    expect(h.logs()).toContain('installer says hi no token');
    expect(h.events.some((e) => e.event.type === 'job' && e.event.job.message === 'Downloading game.jar')).toBe(true);
    expect(existsSync(path.join(h.cfg.installDir!, 'game.jar'))).toBe(true);
    expect(readFileSync(path.join(h.cfg.installDir!, 'game', 'lib', 'a.txt'), 'utf8')).toBe('a');
  });
});
