#!/usr/bin/env node
// Local development without Docker: the agent drives the fake PZ server,
// the panel API and Vite serve the UI, all on 127.0.0.1.
//
//   node scripts/dev.mjs            then open the URL it prints
//   node scripts/dev.mjs --help     show the ports and folders it would use
//   first login: owner / dev-owner-password (you'll be asked to change it)
//
// Ports come from .env.dev when it exists (written per worktree by
// `node scripts/worktree-env.mjs --slot N`), else from the environment, else
// the defaults below. State lives in DEV_STATE_DIR (default .tmp/dev);
// delete that folder to start over.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: the repo may live under a path with spaces.
const root = fileURLToPath(new URL('..', import.meta.url));
const envDev = path.join(root, '.env.dev');
if (existsSync(envDev)) process.loadEnvFile(envDev);

const port = (/** @type {string} */ key, /** @type {number} */ dflt) => {
  const v = process.env[key];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${key} must be a port number, got ${v}`);
  return n;
};
const ports = {
  panel: port('DEV_PANEL_PORT', 8080),
  agent: port('DEV_AGENT_PORT', 8081),
  web: port('DEV_WEB_PORT', 5173),
  rcon: port('DEV_RCON_PORT', 27115),
};
const host = process.env.DEV_HOST || 'localhost';
const tmp = path.resolve(root, process.env.DEV_STATE_DIR || path.join('.tmp', 'dev'));
const url = `http://${host}:${ports.web}`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`usage: node scripts/dev.mjs

repo root   ${root}
env file    ${existsSync(envDev) ? envDev : '(no .env.dev; defaults and environment)'}
state dir   ${tmp}
ports       panel ${ports.panel}, agent ${ports.agent}, web ${ports.web}, fake RCON ${ports.rcon}
open        ${url}`);
  process.exit(0);
}

mkdirSync(tmp, { recursive: true });
const node = process.execPath;
const token = 'dev-agent-token-0123456789abcdef0123456789';

const common = { ...process.env, FORCE_COLOR: '1' };
const procs = [
  {
    name: 'agent',
    color: 33,
    cmd: [node, '--import', 'tsx', 'packages/agent/src/main.ts'],
    env: {
      AGENT_TOKEN: token,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(ports.agent),
      GAME_ADAPTER: 'pz',
      GAME_INSTALL_DIR: path.join(tmp, 'install'),
      GAME_DATA_DIR: path.join(tmp, 'data'),
      GAME_PORT_RCON: String(ports.rcon),
      STEAMCMD_COMMAND: JSON.stringify([node, path.join(root, 'tools/fake-pz/steamcmd.mjs')]),
      GAME_START_COMMAND: JSON.stringify([node, path.join(root, 'tools/fake-pz/server.mjs')]),
      FAKE_PZ_BOOT_MS: '2500',
      FAKE_PZ_PLAYERS: process.env.FAKE_PZ_PLAYERS ?? 'Rick,Daryl',
    },
  },
  {
    name: 'panel',
    color: 36,
    cmd: [node, '--import', 'tsx', 'packages/panel/src/main.ts'],
    env: {
      AGENT_TOKEN: token,
      AGENT_URL: `http://127.0.0.1:${ports.agent}`,
      PANEL_HOST_BIND: '127.0.0.1',
      PANEL_PORT_BIND: String(ports.panel),
      PANEL_DATA_DIR: path.join(tmp, 'panel'),
      PANEL_PUBLIC_DIR: '',
      PANEL_ORIGINS: url,
      PANEL_OWNER_USERNAME: 'owner',
      PANEL_OWNER_PASSWORD: 'dev-owner-password',
      PZ_ADMIN_PASSWORD: 'dev-admin-password',
      PZ_DATA_DIR: path.join(tmp, 'data'),
      PZ_INSTALL_DIR: path.join(tmp, 'install'),
      BACKUP_DIR: path.join(tmp, 'backups'),
      PZ_SERVER_NAME: 'zomboid',
    },
  },
  {
    name: 'web',
    color: 35,
    cmd: [node, path.join(root, 'node_modules/vite/bin/vite.js')],
    cwd: path.join(root, 'packages/web'),
    // Read by packages/web/vite.config.ts.
    env: { DEV_WEB_PORT: String(ports.web), DEV_PANEL_PORT: String(ports.panel) },
  },
];

const children = procs.map((p) => {
  const [file, ...args] = p.cmd;
  const child = spawn(file, args, { cwd: p.cwd ?? root, env: { ...common, ...p.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${p.color}m[${p.name}]\x1b[0m `;
  for (const s of [child.stdout, child.stderr]) {
    let rest = '';
    s.on('data', (d) => {
      rest += d.toString();
      const lines = rest.split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const l of lines) process.stdout.write(prefix + l + '\n');
    });
  }
  child.on('exit', (code) => process.stdout.write(`${prefix}exited (${code})\n`));
  return child;
});
console.log(`\nOpen ${url}  (first login: owner / dev-owner-password)\n`);

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
