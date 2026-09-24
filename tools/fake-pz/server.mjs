#!/usr/bin/env node
// A stand-in for the PZ dedicated server, for agent/panel tests without the
// 5 GB download. It speaks the same console and RCON behaviour measured on
// 42.20.4 (docs/verification-log.md) — and is a separate implementation from
// the code under test on purpose.
//
//   node server.mjs [JVM args…] -- -servername n -cachedir=/data -adminusername a -adminpassword p
//
// Scenarios (FAKE_PZ_SCENARIO): normal | crash-after-ready | crash-on-boot | admin-prompt |
// never-ready | ignore-quit | ignore-term
// Tuning: FAKE_PZ_BOOT_MS (default 300), FAKE_PZ_CRASH_MS (500), FAKE_PZ_PLAYERS ("a,b")
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';

const scenario = process.env.FAKE_PZ_SCENARIO ?? 'normal';
const bootMs = Number(process.env.FAKE_PZ_BOOT_MS ?? 300);
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const jvm = sep >= 0 ? argv.slice(0, sep) : [];
const game = sep >= 0 ? argv.slice(sep + 1) : argv;
const arg = (name) => {
  const i = game.indexOf(name);
  return i >= 0 ? game[i + 1] : undefined;
};
const serverName = arg('-servername') ?? 'servertest';
const cacheDir = (game.find((a) => a.startsWith('-cachedir=')) ?? '-cachedir=.').slice('-cachedir='.length);
const adminPassword = arg('-adminpassword');
let players = (process.env.FAKE_PZ_PLAYERS ?? '').split(',').filter(Boolean);

const log = (cat, msg) => process.stdout.write(`LOG  : ${cat.padEnd(12)} f:0 st:1,000> ${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readIni() {
  const file = path.join(cacheDir, 'Server', `${serverName}.ini`);
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    // no ini yet
  }
  return out;
}

function ensureFiles() {
  // Like PZ: complete the ini with defaults, keeping existing values.
  const dir = path.join(cacheDir, 'Server');
  fs.mkdirSync(dir, { recursive: true });
  const ini = readIni();
  const defaults = { PVP: 'true', PauseEmpty: 'true', Open: 'true', PublicName: 'My PZ Server', MaxPlayers: '32', Mods: '', WorkshopItems: '', Map: 'Muldraugh, KY', ResetID: '4237584', RCONPort: '27015', RCONPassword: '' };
  const merged = { ...defaults, ...ini };
  fs.writeFileSync(path.join(dir, `${serverName}.ini`), Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n'));
  const sandbox = path.join(dir, `${serverName}_SandboxVars.lua`);
  if (!fs.existsSync(sandbox)) fs.writeFileSync(sandbox, 'SandboxVars = {\n    VERSION = 6,\n    Zombies = 4,\n    ZombieLore = {\n        Speed = 2,\n    },\n}\n');
  fs.mkdirSync(path.join(cacheDir, 'Saves', 'Multiplayer', serverName), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'Saves', 'Multiplayer', serverName, 'map_t.bin'), 'fake');
  fs.mkdirSync(path.join(cacheDir, 'db'), { recursive: true });
  return merged;
}

// ---------------------------------------------------------------- commands
function run(cmdline) {
  const [cmd, ...rest] = cmdline.trim().split(' ');
  switch (cmd) {
    case 'players':
      return `Players connected (${players.length}): \n${players.map((p) => `-${p}\n`).join('')}`;
    case 'save':
      log('General', 'World saved');
      log('General', 'Saving finish');
      return 'World saved';
    case 'servermsg':
      return 'Message sent.';
    case 'quit':
      quit();
      return 'Quit';
    case 'help':
      // Long enough to force RCON splitting (> 4086 bytes), with multi-byte text.
      return `List of server commands : \n${Array.from({ length: 150 }, (_, i) => `* comando${i} : Descripción número ${i} — ñandú\n`).join('')}`;
    case 'fake-join':
      players.push(rest.join(' '));
      return 'ok';
    case 'fake-leave':
      players = players.filter((p) => p !== rest.join(' '));
      return 'ok';
    case 'fake-crash':
      process.exit(3);
      return '';
    default:
      return `Unknown command ${cmd}`;
  }
}

let quitting = false;
function quit() {
  if (scenario === 'ignore-quit' || scenario === 'ignore-term' || quitting) return;
  quitting = true;
  log('General', 'Quit');
  setTimeout(() => {
    log('General', 'Shutdown handling started');
    log('General', 'Saving finish');
    log('General', 'Shutdown handling finished');
    process.exit(0);
  }, 150);
}

// ------------------------------------------------------------------- RCON
function packet(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}

function startRcon(port, password) {
  const server = net.createServer((sock) => {
    let pending = Buffer.alloc(0);
    let authed = false;
    sock.on('error', () => undefined);
    sock.on('data', (d) => {
      pending = Buffer.concat([pending, d]);
      while (pending.length >= 4) {
        const size = pending.readInt32LE(0);
        if (pending.length < size + 4) break;
        const id = pending.readInt32LE(4);
        const type = pending.readInt32LE(8);
        const body = pending.subarray(12, size + 2).toString('utf8');
        pending = pending.subarray(size + 4);
        if (type === 3) {
          authed = body === password;
          sock.write(packet(id, 0, ''));
          sock.write(packet(authed ? id : -1, 2, ''));
        } else if (!authed) {
          sock.destroy();
        } else if (type === 0) {
          // Sentinel: PZ echoes it twice.
          sock.write(Buffer.concat([packet(id, 0, ''), packet(id, 0, '')]));
        } else {
          const reply = Buffer.from(run(body), 'utf8');
          // Split like PZ: bodies of at most 4086 bytes, same id.
          for (let i = 0; i < Math.max(reply.length, 1); i += 4086) {
            const part = reply.subarray(i, i + 4086);
            const buf = Buffer.alloc(14 + part.length);
            buf.writeInt32LE(10 + part.length, 0);
            buf.writeInt32LE(id, 4);
            buf.writeInt32LE(0, 8);
            part.copy(buf, 12);
            sock.write(buf);
          }
        }
      }
    });
  });
  server.listen(port, '127.0.0.1', () => log('General', `RCON: listening on port ${port}`));
}

// ------------------------------------------------------------------- boot
process.on('SIGTERM', () => {
  if (scenario === 'ignore-term') return;
  process.exit(143);
});

const rl = readline.createInterface({ input: process.stdin });
let promptMode = false;
rl.on('line', (line) => {
  if (promptMode) return; // waiting for a password nobody will type
  log('General', `command entered via server console (System.in): "${line}"`);
  const out = run(line);
  for (const l of out.split('\n')) if (l) process.stdout.write(`${l}\n`);
});

log('General', 'version=42.20.4 b0bbce05d5 demo=false');
log('General', `JVM args: ${jvm.join(' ')}`);
if (scenario === 'crash-on-boot') {
  process.stderr.write('Exception in thread "main" java.lang.IllegalStateException: boom\n');
  process.exit(1);
}
const dbFile = path.join(cacheDir, 'db', `${serverName}.db`);
if (scenario === 'admin-prompt' || (!adminPassword && !fs.existsSync(dbFile))) {
  log('General', "User 'admin' not found, creating it ");
  log('General', 'Command line admin password: null');
  log('General', 'Enter new administrator password: ');
  promptMode = true;
} else {
  const ini = ensureFiles();
  // Real SQLite files with PZ's table names, like the game's own.
  const { DatabaseSync } = await import('node:sqlite');
  for (const [file, ddl] of [
    [dbFile, 'CREATE TABLE IF NOT EXISTS whitelist (id INTEGER PRIMARY KEY, world TEXT, username TEXT, password TEXT, lastConnection TEXT, role INTEGER NOT NULL DEFAULT 2, steamid TEXT)'],
    [path.join(cacheDir, 'Saves', 'Multiplayer', serverName, 'players.db'), 'CREATE TABLE IF NOT EXISTS networkPlayers (id INTEGER PRIMARY KEY, world TEXT, username TEXT, name TEXT, steamid TEXT, x REAL, y REAL, z REAL, isDead BOOLEAN)'],
  ]) {
    const db = new DatabaseSync(file);
    db.exec(ddl);
    db.close();
  }
  if (adminPassword) log('General', 'admin password changed via -adminpassword option');
  await sleep(bootMs);
  if (scenario !== 'never-ready') {
    log('Network', '*** SERVER STARTED ****');
    if (ini.RCONPassword) startRcon(Number(ini.RCONPort || 27015), ini.RCONPassword);
    if (scenario === 'crash-after-ready') setTimeout(() => process.exit(1), Number(process.env.FAKE_PZ_CRASH_MS ?? 500));
  }
}
