#!/usr/bin/env node
// Local development without Docker: the agent drives the fake PZ server,
// the panel API runs on :8080 and Vite serves the UI on :5173.
//
//   node scripts/dev.mjs            then open http://localhost:5173
//   first login: owner / dev-owner-password (you'll be asked to change it)
//
// State lives in .tmp/dev; delete that folder to start over.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const tmp = path.join(root, '.tmp', 'dev');
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
      AGENT_PORT: '8081',
      PZ_INSTALL_DIR: path.join(tmp, 'install'),
      PZ_DATA_DIR: path.join(tmp, 'data'),
      PZ_RCON_PORT: '27115',
      STEAMCMD_COMMAND: JSON.stringify([node, path.join(root, 'tools/fake-pz/steamcmd.mjs')]),
      PZ_START_COMMAND: JSON.stringify([node, path.join(root, 'tools/fake-pz/server.mjs')]),
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
      AGENT_URL: 'http://127.0.0.1:8081',
      PANEL_HOST_BIND: '127.0.0.1',
      PANEL_PORT_BIND: '8080',
      PANEL_DATA_DIR: path.join(tmp, 'panel'),
      PANEL_PUBLIC_DIR: '',
      PANEL_ORIGINS: 'http://localhost:5173',
      PANEL_OWNER_USERNAME: 'owner',
      PANEL_OWNER_PASSWORD: 'dev-owner-password',
      PZ_ADMIN_PASSWORD: 'dev-admin-password',
      PZ_DATA_DIR: path.join(tmp, 'data'),
      PZ_INSTALL_DIR: path.join(tmp, 'install'),
      BACKUP_DIR: path.join(tmp, 'backups'),
      PZ_SERVER_NAME: 'zomboid',
    },
  },
  { name: 'web', color: 35, cmd: [node, path.join(root, 'node_modules/vite/bin/vite.js')], cwd: path.join(root, 'packages/web'), env: {} },
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

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
