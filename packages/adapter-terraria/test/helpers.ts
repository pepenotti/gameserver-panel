// A runtime context for the adapter's own tests: temporary roots, the fake
// Terraria server standing in for the game binary (and for dotnet), plain
// download helpers and the archive package's extraction (the agent's own,
// with retries, progress and root checks, are tested in packages/agent,
// which runs this adapter in its contract test).
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InstallCtx } from '@gsp/adapter-api';
import { afterAll } from 'vitest';
import { open } from 'node:fs/promises';
import { extractArchive, readZipDirectory } from '@gsp/archive';

export const TOOLS = fileURLToPath(new URL('../../../tools/fake-terraria/', import.meta.url));
export const FIXTURES = fileURLToPath(new URL('../../../fixtures/terraria/1.4.5.8/', import.meta.url));
export const FAKE_SERVER = [process.execPath, path.join(TOOLS, 'server.mjs')];
export const fixture = (...p: string[]) => readFileSync(path.join(FIXTURES, ...p), 'utf8');
/** A captured log's lines, without the fixture's own notes (`# …`) and what was typed (`> …`). */
export const fixtureLines = (...p: string[]) =>
  fixture(...p)
    .split('\n')
    .filter((l) => !l.startsWith('# ') && !l.startsWith('> '));

export const TIME_SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
/** The byte-order mark vanilla's first line starts with (twice). */
export const BOM = String.fromCharCode(0xfeff);

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** Every folder `testCtx` made, removed when the test file ends even if a test never called `cleanup` (NFR-07). */
const made = new Set<string>();
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  made.clear();
});

export interface TestCtx extends InstallCtx {
  dir: string;
  logs: string[];
  cleanup(): void;
}

/** Temporary roots and the fake as the game; `env` holds the download URLs and the fake's knobs. */
export function testCtx(o: { env?: Record<string, string>; ports?: Record<string, number> } = {}): TestCtx {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-tr-'));
  made.add(dir);
  const roots = { data: path.join(dir, 'data'), install: path.join(dir, 'install') };
  mkdirSync(roots.data, { recursive: true });
  mkdirSync(roots.install, { recursive: true });
  const logs: string[] = [];
  const env = { ...process.env, ...o.env };
  delete env.AGENT_TOKEN;
  const get = (url: string) => fetch(url, { headers: { 'user-agent': 'gameserver-panel/test' } });
  return {
    dir,
    logs,
    roots,
    stateDir: path.join(dir, 'state'),
    ports: o.ports ?? { game: 7777, rest: 7878 },
    state: { controlSecret: randomBytes(24).toString('hex'), gameVersion: null },
    tools: { launcher: FAKE_SERVER, home: path.join(dir, 'home') },
    env,
    log: (l) => logs.push(l),
    onLine: () => undefined,
    progress: () => undefined,
    fetch: get,
    async download(req) {
      // As the agent's: with `allowUrl`, each address (redirects too) is checked before it is asked; `maxBytes` caps the file.
      let res: Response;
      if (req.allowUrl) {
        let u = new URL(req.url);
        for (;;) {
          if (!req.allowUrl(u)) throw Object.assign(new Error(`Refusing to download ${req.what} from ${u.origin}`), { code: 'download-refused' });
          res = await fetch(u, { headers: { 'user-agent': 'gameserver-panel/test' }, redirect: 'manual' });
          if (res.status < 300 || res.status > 399) break;
          u = new URL(res.headers.get('location')!, u);
        }
      } else res = await get(req.url);
      if (!res.ok) throw new Error(`Could not download ${req.what}: HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (req.maxBytes !== undefined && body.length > req.maxBytes) throw Object.assign(new Error(`${req.what} is more than the ${req.maxBytes} bytes allowed`), { code: 'download-too-large' });
      const bad = (req.size !== undefined && body.length !== req.size) || (req.sha256 !== undefined && createHash('sha256').update(body).digest('hex') !== req.sha256);
      if (bad) throw new Error(`The download of ${req.what} is not what was published`);
      mkdirSync(path.dirname(req.dest), { recursive: true });
      writeFileSync(req.dest, body);
    },
    // The archive package's extraction; the agent checks `limits` first (from a zip's directory), as here.
    async extract(req) {
      if (req.limits?.bytes !== undefined && req.format === 'zip') {
        const fh = await open(req.file, 'r');
        try {
          const list = await readZipDirectory(fh);
          const bytes = list.reduce((n, e) => n + e.size, 0);
          if (bytes > req.limits.bytes || (req.limits.entries !== undefined && list.length > req.limits.entries)) throw Object.assign(new Error('The archive is bigger than allowed'), { code: 'extract-too-large' });
        } finally {
          await fh.close();
        }
      }
      return extractArchive(req);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

/** The download URLs of a fake download server, as the agent's environment carries them. */
export const downloadEnv = (url: string): Record<string, string> => ({ GAME_TERRARIA_ORG_URL: url, GAME_TERRARIA_GITHUB_URL: url });
