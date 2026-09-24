import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// dev.mjs finds the repo root from its own URL. A checkout under a folder
// with spaces (or other characters URLs escape) must still resolve.
describe('scripts/dev.mjs --help', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'gsp-dev-'));
  const repo = path.join(base, 'my repos %20 x', 'game server');
  mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('./dev.mjs', import.meta.url)), path.join(repo, 'scripts', 'dev.mjs'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DEV_')));
  const help = () => {
    const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'dev.mjs'), '--help'], { encoding: 'utf8', env });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  };

  it('resolves the root of a checkout whose path has spaces and escapes', () => {
    const out = help();
    const root = /repo root\s+(.+)/.exec(out)?.[1]?.trim() ?? '';
    expect(realpathSync.native(root)).toBe(realpathSync.native(repo));
    expect(out).toMatch(/state dir\s+.*game server[\\/]\.tmp[\\/]dev/);
    expect(out).toContain('panel 8080, agent 8081, web 5173, fake RCON 27115');
    expect(out).toContain('http://localhost:5173');
  });

  it('takes its ports and host from .env.dev', () => {
    writeFileSync(path.join(repo, '.env.dev'), 'DEV_HOST=wt1.localhost\nDEV_PANEL_PORT=30100\nDEV_AGENT_PORT=30101\nDEV_WEB_PORT=30105\nDEV_RCON_PORT=30110\nDEV_STATE_DIR=.tmp/dev1\n');
    const out = help();
    expect(out).toContain('panel 30100, agent 30101, web 30105, fake RCON 30110');
    expect(out).toContain('http://wt1.localhost:30105');
    expect(out).toMatch(/state dir\s+.*game server[\\/]\.tmp[\\/]dev1/);
  });
});
