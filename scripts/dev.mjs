#!/usr/bin/env node
// Local development without Docker, all on 127.0.0.1: the panel API, Vite
// serving the UI, the fake orchestrator (the real orchestrator API; each
// server it creates is a local agent driving its game's fake), and the agent
// of the `default` server driving the fake PZ server.
//
//   node scripts/dev.mjs            then open the URL it prints
//   node scripts/dev.mjs --help     show the ports and folders it would use
//   first login: owner / dev-owner-password (you'll be asked to change it)
//
// Ports come from .env.dev when it exists (written per worktree by
// `node scripts/worktree-env.mjs --slot N`), else from the environment, else
// the defaults below. State lives in DEV_STATE_DIR (default .tmp/dev);
// delete that folder to start over.
//
// The panel reaches the fake orchestrator as it reaches the real one, over a
// local socket (ORCH_SOCKET, ORCH_TOKEN): a named pipe on Windows (what Node
// listens on there), a socket file in the state folder elsewhere.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
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
const panelPort = port('DEV_PANEL_PORT', 8080);
const ports = {
  panel: panelPort,
  agent: port('DEV_AGENT_PORT', 8081),
  web: port('DEV_WEB_PORT', 5173),
  rcon: port('DEV_RCON_PORT', 27115),
  // Minecraft's fake download services (Mojang, PaperMC, Fabric): a port of the slot's block nothing else uses.
  downloads: port('DEV_DOWNLOADS_PORT', panelPort + 7),
};
/** What the panel (its version choices) and every server's agent (its installs) download Minecraft from. */
const downloadUrls = Object.fromEntries(['GAME_MC_MOJANG_URL', 'GAME_MC_PAPER_URL', 'GAME_MC_FABRIC_URL'].map((k) => [k, `http://127.0.0.1:${ports.downloads}`]));
const host = process.env.DEV_HOST || 'localhost';
const tmp = path.resolve(root, process.env.DEV_STATE_DIR || path.join('.tmp', 'dev'));
const url = `http://${host}:${ports.web}`;

/** Where the fake orchestrator listens: one name per checkout, so worktrees never share it. */
function orchSocket() {
  const tag = createHash('sha256').update(root).digest('hex').slice(0, 12);
  if (process.platform === 'win32') return `\\\\.\\pipe\\gsp-dev-orch-${tag}`;
  const inState = path.join(tmp, 'orch.sock');
  // Socket paths are limited to ~100 bytes.
  return Buffer.byteLength(inState) < 100 ? inState : path.join(os.tmpdir(), `gsp-dev-orch-${tag}.sock`);
}
const orch = {
  socket: process.env.DEV_ORCH_SOCKET || orchSocket(),
  agentPorts: process.env.DEV_ORCH_AGENT_PORTS || '8082-8084',
  controlPorts: process.env.DEV_ORCH_CONTROL_PORTS || '27116-27147',
  hostPorts: process.env.DEV_ORCH_HOST_PORTS || '16300-16349',
};

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`usage: node scripts/dev.mjs

repo root   ${root}
env file    ${existsSync(envDev) ? envDev : '(no .env.dev; defaults and environment)'}
state dir   ${tmp}
ports       panel ${ports.panel}, agent ${ports.agent}, web ${ports.web}, fake RCON ${ports.rcon}
orchestrator  fake, on ${orch.socket}; its servers: agents ${orch.agentPorts}, inside ports ${orch.controlPorts}, game ports ${orch.hostPorts}
downloads   fake Minecraft download services on ${ports.downloads}
open        ${url}`);
  process.exit(0);
}

mkdirSync(tmp, { recursive: true });
const node = process.execPath;
const token = 'dev-agent-token-0123456789abcdef0123456789';
const orchToken = 'dev-orch-token-0123456789abcdef01234567890';

const common = { ...process.env, FORCE_COLOR: '1' };
const procs = [
  {
    name: 'orch',
    color: 32,
    cmd: [node, '--import', 'tsx', 'tools/fake-orchestrator/main.ts'],
    env: {
      ORCH_SOCKET: orch.socket,
      ORCH_TOKEN: orchToken,
      ORCH_HOST_PORTS: orch.hostPorts,
      // The fake games use little memory: room for a server with the game's default memory (PZ: 8 GiB + 3 GiB).
      ORCH_MAX_MEM_MB: '16384',
      ORCH_MAX_SERVERS: '3',
      ORCH_ALLOW_FAKE: '1',
      FAKE_ORCH_STATE_DIR: path.join(tmp, 'orch'),
      FAKE_ORCH_AGENT_PORTS: orch.agentPorts,
      FAKE_ORCH_CONTROL_PORTS: orch.controlPorts,
      FAKE_PZ_BOOT_MS: '2500',
      FAKE_PZ_PLAYERS: process.env.FAKE_PZ_PLAYERS ?? 'Rick,Daryl',
      // Minecraft servers install from the fake download services and boot the fake server.
      ...downloadUrls,
      FAKE_MC_BOOT_MS: '2500',
    },
  },
  {
    name: 'downloads',
    color: 34,
    cmd: [node, 'tools/fake-minecraft/downloads.mjs', '--port', String(ports.downloads)],
    env: {},
  },
  {
    // The `default` server of today's single-server wiring (AGENT_URL below).
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
      ORCH_SOCKET: orch.socket,
      ORCH_TOKEN: orchToken,
      SERVER_IMAGE_VARIANT: 'fake',
      PANEL_HOST_BIND: '127.0.0.1',
      PANEL_PORT_BIND: String(ports.panel),
      PANEL_DATA_DIR: path.join(tmp, 'panel'),
      PANEL_PUBLIC_DIR: '',
      PANEL_ORIGINS: url,
      PANEL_OWNER_USERNAME: 'owner',
      PANEL_OWNER_PASSWORD: 'dev-owner-password',
      GAME_SECRET_ADMIN_PASSWORD: 'dev-admin-password',
      PZ_DATA_DIR: path.join(tmp, 'data'),
      PZ_INSTALL_DIR: path.join(tmp, 'install'),
      BACKUP_DIR: path.join(tmp, 'backups'),
      PZ_SERVER_NAME: 'zomboid',
      // The create form's Minecraft versions come from the same fake services.
      ...downloadUrls,
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
