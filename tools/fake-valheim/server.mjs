#!/usr/bin/env node
// A stand-in for the Valheim dedicated server (valheim_server.x86_64), for agent/panel tests and the
// dev loop without the 2 GB download. It prints the lines, writes the files, binds the sockets and
// answers the Steam queries measured on 1.0.16 (docs/verification/valheim-1.0.16.md,
// fixtures/valheim/1.0.16/), and is a separate implementation from the code under test on purpose.
//
// It takes the place of the binary, so the adapter's own argument list works unchanged:
//   node server.mjs -nographics -batchmode -name "My server" -port 2456 -world w -password secret1 \
//     -public 0|1 -savedir /data [-saveinterval s] [-backups n -backupshort s -backuplong s] \
//     [-crossplay] [-preset p] [-modifier key value]… [-logfile file]
//
// Scenarios (FAKE_VALHEIM_SCENARIO): normal | crash-after-ready | crash-on-boot | never-ready | ignore-stop
//   crash-after-ready  the world fails to load: the fatal lines, the ready line, then a quit (exit 0), as measured
//   crash-on-boot      Steam's query socket can't be bound (as with a taken port): exit 0 before the ready line
//   never-ready        the save folder can't be written: the exception, then nothing more (until a signal)
//   ignore-stop        SIGINT and SIGTERM do nothing (the agent has to escalate)
// Tuning: FAKE_VALHEIM_BOOT_MS (300; a real boot takes 45 s), FAKE_VALHEIM_GEN_MS (200; generating a new
//   world takes 30 s more), FAKE_VALHEIM_STOP_MS (200), FAKE_VALHEIM_BIND_HOST (127.0.0.1),
//   FAKE_VALHEIM_CROSSPLAY_LIBS=1 (PlayFab's libraries are installed; the product image lacks them),
//   FAKE_VALHEIM_SAVE_MS_PER_S (1000: milliseconds per second of -saveinterval; tests shrink it),
//   FAKE_VALHEIM_SAVE_STEP_MS (0: how long each step of a save takes, so a test can catch one half written;
//   the real steps took 1-45 ms for a small world; saves never overlap: a timer's save is skipped while one runs).
// Test hooks on stdin (the real server ignores stdin entirely): fake-join <steamid>, fake-leave <steamid>,
//   fake-crash.
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const env = process.env;
const argv = process.argv.slice(2);
const scenario = env.FAKE_VALHEIM_SCENARIO ?? 'normal';
const bootMs = Number(env.FAKE_VALHEIM_BOOT_MS ?? 300);
const genMs = Number(env.FAKE_VALHEIM_GEN_MS ?? 200);
const stopMs = Number(env.FAKE_VALHEIM_STOP_MS ?? 200);
const bindHost = env.FAKE_VALHEIM_BIND_HOST ?? '127.0.0.1';
const saveMsPerS = Number(env.FAKE_VALHEIM_SAVE_MS_PER_S ?? 1000);
const saveStepMs = Number(env.FAKE_VALHEIM_SAVE_STEP_MS ?? 0);
const VERSION = 'l-1.0.16';
const NETWORK_VERSION = 40;

// ------------------------------------------------------------------ arguments
const flags = new Set(['-nographics', '-batchmode', '-crossplay', '-resetmodifiers']);
const opts = {};
const modifiers = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (flags.has(a)) opts[a] = true;
  else if (a === '-modifier') modifiers.push([argv[++i], argv[++i]]);
  else if (a.startsWith('-')) opts[a] = argv[++i];
}
const name = opts['-name'] ?? 'My server';
const port = Number(opts['-port'] ?? 2456);
const world = opts['-world'] ?? 'Dedicated';
const password = opts['-password'] ?? '';
// The real default was not measured: the adapter always passes -public.
const isPublic = (opts['-public'] ?? '1') === '1';
const saveDir = opts['-savedir'] ?? path.join(os.homedir(), '.config', 'unity3d', 'IronGate', 'Valheim');
const saveInterval = Number(opts['-saveinterval'] ?? 1800);
const backups = Number(opts['-backups'] ?? 4);
const backupShort = Number(opts['-backupshort'] ?? 7200);
const backupLong = Number(opts['-backuplong'] ?? 43200);
const crossplay = opts['-crossplay'] === true;
const crossplayLibs = env.FAKE_VALHEIM_CROSSPLAY_LIBS === '1';
const logFile = opts['-logfile'];

// ------------------------------------------------------------------ output
let sink = (l) => process.stdout.write(`${l}\n`);
const raw = (l) => sink(l);
const err = (l) => process.stderr.write(`${l}\n`);
const pad = (n) => String(n).padStart(2, '0');
const stamp = () => {
  const d = new Date();
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
/** A line of Valheim's own logger: "MM/DD/YYYY HH:MM:SS: text". */
const log = (l) => raw(`${stamp()}: ${l}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();

// ------------------------------------------------------------------ world files (the 1.0 save layout)
const worldDir = path.join(saveDir, 'worlds_local', world);
const HEADER = `FAKE VALHEIM WORLD ${world}`;
function saves() {
  try {
    return fs
      .readdirSync(worldDir)
      .map((f) => /^_main\.(\d+)\.ok$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}
let saveNumber = saves().at(-1) ?? 0;
let savingDisabled = false;
let saveTimer = null;

function writeFwl(n) {
  const mods = [...(opts['-preset'] ? [['preset', opts['-preset']]] : []), ...modifiers];
  fs.writeFileSync(path.join(worldDir, `_main.${n}.fwl2`), `${HEADER}\nseed=FakeSeed01\nmodifiers=${mods.map(([k, v]) => `${k}:${v}`).join(',')}\n`);
}

/** The save in progress, if any: saves never overlap (one every -saveinterval, measured at 0.1 s each). */
let saving = null;
/** One step of a save taking its time (FAKE_VALHEIM_SAVE_STEP_MS; the real steps took 1-45 ms for a small world). */
const step = () => (saveStepMs > 0 ? sleep(saveStepMs) : undefined);

/** A save, after the one in progress (a timer's save is skipped while one runs). */
function save(onStop) {
  if (saving && !onStop) return saving;
  const p = (saving ?? Promise.resolve()).then(() => writeSave(onStop)).finally(() => {
    if (saving === p) saving = null;
  });
  saving = p;
  return p;
}

/** One numbered save, in the order measured: chunk files, .chunks, .db2, .fwl2, the .ok marker, then the previous set goes. */
async function writeSave(onStop) {
  const s0 = Date.now();
  if (!onStop) log('Sending message to save player profiles');
  log('GetSaveClonePerChunk. Calculated number of actual chunk files: 1  Number of dirty chunks to save: 1 [1ms]');
  log('PrepareSave: ZDOExtraData.PrepareSave done [0ms]');
  log(' ### Save World Thread Started! ### ');
  log(`Considering autobackup for World. World time: ${((Date.now() - t0) / 1000).toFixed(2)}, short time: ${backupShort}, long time: ${backupLong}, backup count: ${backups}`);
  log('Skipping backup. World session not long enough.');
  const prev = saveNumber;
  const n = ++saveNumber;
  log(`World save (1/5) Cloud & Backup checks done [0ms] => Save number ${n}`);
  fs.mkdirSync(worldDir, { recursive: true });
  fs.writeFileSync(path.join(worldDir, `00_00__0_${n}.chunk`), `${HEADER} chunk save ${n}\n`);
  await step();
  fs.writeFileSync(path.join(worldDir, `_main.${n}.chunks`), `chunks ${n}\n`);
  log('World save (2/5) Chunks writing done [1ms]');
  await step();
  fs.writeFileSync(path.join(worldDir, `_main.${n}.db2`), `${HEADER} save ${n}\n`);
  log('World save (3/5) DB2 writing done [1ms]');
  await step();
  writeFwl(n);
  log('World save (4/5) FWL writing done [1ms]');
  await step();
  fs.writeFileSync(path.join(worldDir, `_main.${n}.ok`), String(n));
  await step();
  for (const f of [`_main.${prev}.fwl2`, `_main.${prev}.db2`, `_main.${prev}.chunks`, `_main.${prev}.ok`, `00_00__0_${prev}.chunk`]) fs.rmSync(path.join(worldDir, f), { force: true });
  log(`World save (5/5) done. Total time [${Date.now() - s0}ms]`);
}

function ensureLists() {
  const lists = { 'adminlist.txt': 'List admin players ID  ONE per line', 'bannedlist.txt': 'List banned players ID  ONE per line', 'permittedlist.txt': 'List permitted players ID ONE per line' };
  for (const [file, header] of Object.entries(lists)) {
    const f = path.join(saveDir, file);
    if (!fs.existsSync(f)) fs.writeFileSync(f, `// ${header}\n`);
  }
}
const readList = (file) => {
  try {
    return fs.readFileSync(path.join(saveDir, file), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
  } catch {
    return [];
  }
};

// ------------------------------------------------------------------ sockets
let gameSocket = null;
let querySocket = null;
const players = new Set();

function a2sInfo() {
  const parts = [Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17])];
  const str = (s) => parts.push(Buffer.from(`${s}\0`, 'utf8'));
  str(name);
  str(name);
  str('valheim');
  str('');
  parts.push(Buffer.from([0, 0, players.size, 10, 0, 'd'.charCodeAt(0), 'l'.charCodeAt(0), 1, 0]));
  str('1.0.0.0');
  const edf = Buffer.alloc(1 + 2 + 8);
  edf.writeUInt8(0x80 | 0x10 | 0x20 | 0x01, 0);
  edf.writeUInt16LE(port, 1);
  edf.writeBigUInt64LE(90000000000000001n, 3);
  parts.push(edf);
  str(`g=${VERSION.slice(2)},n=${NETWORK_VERSION},m=`);
  const gid = Buffer.alloc(8);
  gid.writeBigUInt64LE(892970n);
  parts.push(gid);
  return Buffer.concat(parts);
}
function a2sPlayers() {
  // Measured with nobody online: an empty list. Names of real players are unverified (no client).
  const parts = [Buffer.from([0xff, 0xff, 0xff, 0xff, 0x44, players.size])];
  let i = 0;
  for (const _p of players) {
    const b = Buffer.alloc(1 + 1 + 4 + 4);
    b.writeUInt8(i++, 0);
    b.writeUInt8(0, 1); // empty name
    b.writeInt32LE(0, 2);
    b.writeFloatLE(0, 6);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

function bind(sock, p) {
  return new Promise((resolve) => {
    sock.once('error', (e) => resolve(e));
    sock.bind(p, bindHost, () => resolve(null));
  });
}

// ------------------------------------------------------------------ stop
let stopping = false;
async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  if (saveTimer) clearInterval(saveTimer);
  log('Game - OnApplicationQuit');
  log('Available space to current user: 100000000000. Saving is blocked if below: 4489246 bytes. Warnings are given if below: 8978492');
  log('Shutting down');
  log('ZNet Shutdown');
  if (savingDisabled) log('Skipping world save');
  else if (reason !== 'no-world') await save(true);
  log('Unloading unused assets');
  log('Sending disconnect msg');
  raw(`ZPlayFabMatchmaking::UnregisterServer - unregistering server now. State: ${crossplay ? 'Active' : 'Uninitialized'}`);
  if (gameSocket || !crossplay) {
    log('Disposing socket');
    if (gameSocket) log('Stopping listening socket');
    log('Last socket, unregistering callback');
    log('ZSteamSocket  UnregisterGlobalCallbacks, existing sockets:0');
  }
  log('Stopping build thread');
  await sleep(stopMs);
  log('ZNet OnDestroy');
  log('Net scene destroyed');
  log('Steam manager on destroy');
  raw('Input System module state changed to: Shutdown.');
  gameSocket?.close();
  querySocket?.close();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (scenario === 'ignore-stop') return;
    void shutdown(sig);
  });
}

// ------------------------------------------------------------------ test hooks (stdin)
// The real server reads nothing from stdin: everything else typed there is ignored without a word.
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const id = rest[0] ?? '';
  // Expected from the game's own strings; no real client joined in the fact-finding.
  if (cmd === 'fake-join' && id) {
    log(`Got connection SteamID ${id}`);
    if (readList('bannedlist.txt').includes(id) || (readList('permittedlist.txt').length > 0 && !readList('permittedlist.txt').includes(id))) {
      log(`Peer ${id} is blacklisted or not in whitelist.`);
      log(`Closing socket ${id}`);
      return;
    }
    log(`Got handshake from client ${id}`);
    log('Server: New peer connected,sending global keys');
    players.add(id);
  } else if (cmd === 'fake-leave' && id && players.delete(id)) {
    log(`Closing socket ${id}`);
  } else if (cmd === 'fake-crash') {
    process.exit(3);
  }
});

// ------------------------------------------------------------------ boot
raw('[UnityMemory] Configuration Parameters - Can be set up in boot.config');
const installDir = env.GAME_INSTALL_DIR ?? '/opt/game';
raw(`Mono path[0] = '${installDir}/valheim_server_Data/Managed'`);
if (!crossplayLibs) raw(`Failed to open plugin: ${installDir}/valheim_server_Data/Plugins/libparty.so`);
raw('Forcing GfxDevice: Null');
raw('Initialize engine version: 6000.0.75f1 (26349cd2a5c8)');
await sleep(bootMs / 2);
log('Loading first scene!');
log(`Setting -savedir to: ${saveDir}`);
if (logFile) {
  log(`Setting -logfile to: ${logFile}`);
  // Measured: from here on the game writes its log to the file, and stdout gets nothing more.
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  sink = (l) => out.write(`${l}\n`);
}
if (opts['-preset']) log(`Setting world modifier preset: ${opts['-preset']}`);
for (const [k, v] of modifiers) log(`Setting world modifier: ${k}->${v}`);
log(`Get create world ${world}`);

// An unwritable save folder (measured with a read-only one): an exception, then the game never gets ready.
let writable = true;
try {
  fs.mkdirSync(worldDir, { recursive: true });
  fs.accessSync(worldDir, fs.constants.W_OK);
} catch {
  writable = false;
}
if (scenario === 'never-ready' || !writable) {
  log(' creating');
  raw('IOException: Read-only file system');
  raw('  at System.IO.FileSystem.CreateDirectory (System.String fullPath) [0x00191] in <fake>:0 ');
  raw('  at World.GetCreateWorld (System.String name, FileHelpers+FileSource source) [0x00078] in <fake>:0 ');
  for (let i = 0; i < 3; i++) {
    log('The WorldGenerator instance was null');
    raw('NullReferenceException: The WorldGenerator instance was null');
  }
  // Running, never ready, until a signal.
  setInterval(() => undefined, 1 << 30);
} else {
  const existing = saves().length > 0;
  if (!existing) {
    log(' creating');
    writeFwl(0);
  }
  log(`Using environment steamid 892970`);
  log('Using steam APPID:892970');
  err("[S_API] SteamAPI_Init(): Loaded local 'steamclient.so' OK.");

  // Steam binds the query port (game port + 1) first; a taken one ends the start (measured, exit 0).
  querySocket = dgram.createSocket('udp4');
  const qErr = scenario === 'crash-on-boot' ? new Error('EADDRINUSE') : await bind(querySocket, port + 1);
  if (qErr) {
    raw(`CreateBoundSocket: ::bind couldn't find an open port between ${port + 1} and ${port + 1}`);
    raw('[Steamworks.NET] GameServer.Init() failed.');
    log('Steam is not initialized');
    log('Awake of network backend failed');
    querySocket = null;
    await sleep(stopMs);
    log('Steam manager on destroy');
    log('ZNet OnDestroy');
    raw('NullReferenceException: Object reference not set to an instance of an object');
    log('Net scene destroyed');
    process.exit(0);
  }
  if (isPublic) {
    querySocket.on('message', (m, rinfo) => {
      if (m.length < 5 || m.readUInt32LE(0) !== 0xffffffff) return;
      const type = m.readUInt8(4);
      // Measured: answered at once, without the challenge step; A2S_RULES got no answer.
      if (type === 0x54) querySocket.send(a2sInfo(), rinfo.port, rinfo.address);
      else if (type === 0x55) querySocket.send(a2sPlayers(), rinfo.port, rinfo.address);
    });
  }
  log('Server ID 90071992547409920');
  log('Authentication:k_ESteamNetworkingAvailability_Waiting');
  log('Steam game server initialized');
  log(`Valheim version: ${VERSION} (network version ${NETWORK_VERSION})`);
  log(`Console: Valheim ${VERSION} (network version ${NETWORK_VERSION})`);

  // Password rules, measured: only a public server checks them; the failed start leaves a DevWorld behind.
  if (isPublic && (password.length < 5 || name.toLowerCase().includes(password.toLowerCase()))) {
    log(`Error bad password:${password.length < 5 ? 'The password is too short' : 'Invalid password'}`);
    fs.mkdirSync(path.join(saveDir, 'worlds_local', 'DevWorld'), { recursive: true });
    fs.writeFileSync(path.join(saveDir, 'worlds_local', 'DevWorld', '_main.0.fwl2'), 'FAKE VALHEIM WORLD DevWorld\n');
    await sleep(stopMs);
    log('Steam manager on destroy');
    log('ZNet OnDestroy');
    log('Net scene destroyed');
    process.exit(0);
  }
  if (crossplay) {
    log('Sending PlayFab login request (attempt 1)');
    if (!crossplayLibs) raw('DllNotFoundException: libParty.so assembly:<unknown assembly> type:<unknown type> member:(null)');
  }
  await sleep(bootMs / 2);
  ensureLists();
  log('Zonesystem Awake 17604');
  log('Loading: ZNet Start');

  const db = (() => {
    try {
      return fs.readFileSync(path.join(worldDir, `_main.${saveNumber}.db2`), 'utf8');
    } catch {
      return '';
    }
  })();
  if (scenario === 'crash-after-ready' || (existing && !db.startsWith(HEADER))) {
    // A world that fails to load (measured with a torn .db2): the game still opens, then quits.
    log(`ZNet.LoadWorld: ${world} (${world}), save number ${saveNumber}`);
    log(`Exception while loading world ${path.join(worldDir, `_main.${saveNumber}.db2`)}:System.IO.EndOfStreamException: Unable to read beyond the end of the stream.`);
    log('World load failed mid-file. Exiting without save. Check backups!');
    savingDisabled = true;
  } else if (existing) {
    log(`ZNet.LoadWorld: ${world} (${world}), save number ${saveNumber}`);
  } else {
    log(`Load world: ${world} (${world})`);
    log(`  missing ${path.join(saveDir, 'worlds_local', `${world}.db`)}`);
    log('Loading: Generating locations');
    // World generation: one line per location that was slow to place (dozens on a real first boot).
    for (const loc of ['StoneTowerRuins04', 'TrollCave02', 'Crypt4', 'SunkenCrypt4', 'MountainWell1']) {
      await sleep(genMs / 5);
      log(`Location ${loc} took more than 0.5 seconds to place, check spawn conditions to improve! (placed 17 out of 25 with 0)`);
    }
    log('There are 5 that take a long time to generate (over 0.5 sec). Total slow location time is 3.1 seconds that could be saved on world gen!');
  }

  // A taken game port is silent (measured): the server goes on without its listening socket.
  if (!crossplay) {
    gameSocket = dgram.createSocket('udp4');
    if (await bind(gameSocket, port)) gameSocket = null;
  }
  if (crossplay) {
    log(`PlayFab custom ID set to "PlayFab_${name}_${port}_<hash>"`);
    log('Sending PlayFab login request (attempt 2)');
    log('Opened PlayFab server');
    log('Game server connected');
    log(`New session server "${name}" that has join code , now 0 player(s)`);
    log(`Register PlayFab server "${name}" with IP 192.0.2.1:${port}`);
    log(`Server '${name}' begin PlayFab create and join network for server `);
    if (crossplayLibs) {
      log(`Session "${name}" registered with join code 123456`);
      log(`Session "${name}" with join code 123456 and IP 192.0.2.1:${port} is active with 0 player(s)`);
    }
  } else {
    log('Registering lobby');
    log('Opened Steam server');
    if (savingDisabled) log('World db couldn\'t load correctly, saving has been disabled to prevent .old file from being overwritten.');
    log('Game server connected');
  }
  if (savingDisabled) void shutdown('load-failed');
  else saveTimer = setInterval(() => void save(false), Math.max(1, saveInterval * saveMsPerS));
}
