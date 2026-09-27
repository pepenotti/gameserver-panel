// A runtime context for the adapter's own tests: temporary roots, the fake
// Minecraft server standing in for `java`, and plain download and tool-run
// helpers (the agent's own, with retries and progress, are tested in
// packages/agent and run this adapter in its contract test).
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InstallCtx } from '@gsp/adapter-api';

export const TOOLS = fileURLToPath(new URL('../../../tools/fake-minecraft/', import.meta.url));
export const FIXTURES = fileURLToPath(new URL('../../../fixtures/minecraft/26.3/', import.meta.url));
export const FAKE_JAVA = [process.execPath, path.join(TOOLS, 'server.mjs')];
export const fixture = (...p: string[]) => readFileSync(path.join(FIXTURES, ...p), 'utf8');
export const fixtureLines = (...p: string[]) => fixture(...p).split('\n');

export interface TestCtx extends InstallCtx {
  dir: string;
  logs: string[];
  lines: string[];
  cleanup(): void;
}

/** Temporary roots and the fake as `java`; `env` holds the download URLs. */
export function testCtx(o: { env?: Record<string, string>; eulaAccepted?: boolean; ports?: Record<string, number> } = {}): TestCtx {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-mc-'));
  const roots = { data: path.join(dir, 'data'), install: path.join(dir, 'install') };
  mkdirSync(roots.data, { recursive: true });
  mkdirSync(roots.install, { recursive: true });
  const logs: string[] = [];
  const lines: string[] = [];
  const env = { ...process.env, ...o.env };
  delete env.AGENT_TOKEN;
  const get = (url: string) => fetch(url, { headers: { 'user-agent': 'gameserver-panel/test' } });
  return {
    dir,
    logs,
    lines,
    roots,
    stateDir: path.join(dir, 'state'),
    ports: o.ports ?? { game: 25565, rcon: 25575 },
    state: { controlSecret: randomBytes(24).toString('hex'), gameVersion: null },
    tools: { launcher: FAKE_JAVA, home: path.join(dir, 'home') },
    env,
    ...(o.eulaAccepted === undefined ? {} : { eulaAccepted: o.eulaAccepted }),
    log: (l) => logs.push(l),
    onLine: (l) => lines.push(l),
    progress: () => undefined,
    fetch: get,
    async download(req) {
      const res = await get(req.url);
      if (!res.ok) throw new Error(`Could not download ${req.what}: HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      const bad =
        (req.size !== undefined && body.length !== req.size) ||
        (req.sha1 !== undefined && createHash('sha1').update(body).digest('hex') !== req.sha1) ||
        (req.sha256 !== undefined && createHash('sha256').update(body).digest('hex') !== req.sha256);
      if (bad) throw new Error(`The download of ${req.what} is not what was published`);
      mkdirSync(path.dirname(req.dest), { recursive: true });
      writeFileSync(req.dest, body);
    },
    exec: (argv, eo = {}) =>
      new Promise((resolve, reject) => {
        const child = spawn(argv[0]!, argv.slice(1), { cwd: eo.cwd ?? roots.install, env: { ...env, ...eo.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        const onData = (d: Buffer) => lines.push(...d.toString('utf8').split(/\r?\n/).filter(Boolean));
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      }),
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

/** The download URLs of a fake download server, as the agent's environment carries them. */
export const downloadEnv = (url: string): Record<string, string> => ({ GAME_MC_MOJANG_URL: url, GAME_MC_PAPER_URL: url, GAME_MC_FABRIC_URL: url });
