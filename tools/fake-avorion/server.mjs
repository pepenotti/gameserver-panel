#!/usr/bin/env node
// A stand-in for the Avorion dedicated server (bin/AvorionServer), the game the M6 fact-finding
// measured for the manifest-only path, for agent/panel tests and the dev loop without Steam. It
// prints the lines, answers the console, writes the galaxy's files and answers the Steam queries
// measured on 2.5.13 (docs/verification/avorion-2.5.13.md, fixtures/avorion/2.5.13/), and is a
// separate implementation from the code under test on purpose.
//
//   node server.mjs --galaxy-name g --datapath /data [--server-name n] [--port 27000] [--query-port 27003]
//     [--steam-query-port 27020] [--steam-master-port 27021] [--max-players n] [--save-interval s]
//     [--send-crash-reports false] [--listed true] [--use-steam-networking 1] [--admin <steamid>]…
//     [--seed s] [--difficulty n] [--rcon-password p] [--rcon-port n]
//
// Scenarios (FAKE_AVORION_SCENARIO): normal | crash-after-ready | crash-on-boot | never-ready | ignore-stop
//   crash-after-ready  an exception and exit 1 a while after the ready line (not measured: no crash was seen)
//   crash-on-boot      the galaxy folder can't be written: the measured exception line, exit 0
//   never-ready        Steam never answers: "Server failed to connect to Steam" forever (the real server
//                      gives up after 30 s and falls back to TCP/UDP, which the fake doesn't)
//   ignore-stop        /stop, SIGINT and SIGTERM do nothing
// Tuning: FAKE_AVORION_BOOT_MS (300; a real boot takes 3-4 s), FAKE_AVORION_SAVE_MS (100; /save took
//   2 s), FAKE_AVORION_CRASH_MS (500), FAKE_AVORION_BIND_HOST (127.0.0.1), FAKE_AVORION_INTERVAL_MS_PER_S
//   (1000: milliseconds per second of --save-interval), FAKE_AVORION_INSTALL_DIR (when set, the working
//   directory must be it, as the real server's must be its install folder).
// Test hooks on stdin (not real commands): fake-join <name>, fake-leave <name>, fake-crash (with or without
// the slash: the panel's console adds it).
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const env = process.env;
const scenario = env.FAKE_AVORION_SCENARIO ?? 'normal';
const bootMs = Number(env.FAKE_AVORION_BOOT_MS ?? 300);
const saveMs = Number(env.FAKE_AVORION_SAVE_MS ?? 100);
const crashMs = Number(env.FAKE_AVORION_CRASH_MS ?? 500);
const bindHost = env.FAKE_AVORION_BIND_HOST ?? '127.0.0.1';
const intervalMsPerS = Number(env.FAKE_AVORION_INTERVAL_MS_PER_S ?? 1000);
const VERSION = '2.5.13';
const COMMIT = '0417ab29738c';
const PUBLIC_VERSION = '2.5.13.44140';

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const opt = {};
const admins = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  if (key === 'admin') admins.push(argv[++i]);
  else opt[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
}
const galaxy = path.join(opt.datapath ?? path.join(env.HOME ?? '.', '.avorion', 'galaxies'), opt['galaxy-name'] ?? 'avorion_galaxy');
const ports = { query: Number(opt['query-port'] ?? 27003), steamQuery: Number(opt['steam-query-port'] ?? 27020), steamMaster: Number(opt['steam-master-port'] ?? 27021) };
const bool = (v) => (v === 'true' || v === '1' ? 'true' : v === 'false' || v === '0' ? 'false' : undefined);

// ------------------------------------------------------------------ server.ini: the game keeps it in memory
// Sections and keys in the order the game writes them, with its defaults (fixtures/…/config/server.ini.*).
const INI = [
  ['Game', { Scenario: '1', Seed: '', Difficulty: '0', HardcoreEnabled: 'false', InfiniteResources: 'false', PlayTutorial: 'false', CollisionDamage: '1', SafePlayerInput: 'false', PlayerToPlayerDamage: 'true', LogoutInvincibility: 'true', LogoutInvincibilityDelay: '30', Version: VERSION, sameStartSector: 'true', motd: '' }],
  ['System', { MaxTimeStep: '1', saveInterval: '600', sectorUpdateTimeLimit: '300', workerThreads: '9', generatorThreads: '2', scriptBackgroundThreads: '2', aliveSectorsPerPlayer: '5', weakUpdate: 'true', profiling: 'false', sendCrashReports: 'true', hangDetection: 'true', backups: 'true', backupsPath: '', statsLogging: 'true', commandsFile: '' }],
  ['Networking', { port: '27000', broadcastInterval: '5', isMultiplayer: 'true', isListed: 'false', vacSecure: 'true', sendStatsToAdmins: 'true', useSteam: 'true', forceSteam: 'false', rconIp: '', rconPassword: '', rconPort: '27015' }],
  ['Administration', { maxPlayers: '10', name: 'Avorion Server', description: 'An Avorion Server', password: '', pausable: 'false', accessListMode: 'Blacklist', steamIdOverride: '0' }],
  ['Meta', { branch: '' }],
];
const settings = new Map(INI.map(([s, kv]) => [s, { ...kv }]));
const iniFile = path.join(galaxy, 'server.ini');

function readIni() {
  let section = null;
  for (const line of fs.readFileSync(iniFile, 'utf8').split(/\r?\n/)) {
    const s = /^\[(\w+)\]$/.exec(line);
    if (s) {
      section = settings.get(s[1]) ?? null;
      continue;
    }
    const kv = /^([^=;#]+)=(.*)$/.exec(line);
    // Unknown keys and comments are dropped: the game writes back only what it knows (measured).
    if (kv && section && kv[1] in section) section[kv[1]] = kv[2];
  }
}
function writeIni() {
  const out = [];
  for (const [name, kv] of settings) {
    out.push(`[${name}]`);
    for (const [k, v] of Object.entries(kv)) out.push(`${k}=${v}`);
  }
  fs.writeFileSync(iniFile, `${out.join('\n')}\n`);
  // The game also writes a commented copy for people; its own words aren't reproduced here.
  fs.writeFileSync(path.join(galaxy, 'server.ini - readme.txt'), `${out.join('\n')}\n; (fake) the real file explains each key in a comment\n`);
}
const set = (section, key, value) => {
  if (value !== undefined) settings.get(section)[key] = value;
};

// ------------------------------------------------------------------ output
let serverLog = null;
const write = (stream, l) => {
  stream.write(`${l}\n`);
  serverLog?.write(`${l}\n`);
};
const out = (l) => write(process.stdout, l);
const err = (l) => write(process.stderr, l);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ galaxy files
let rotation = 0;
const players = new Map();
let playerIndex = 0;
function saveFiles() {
  writeIni();
  writeAdmin();
  for (const f of ['whitelist.txt', 'group-whitelist.txt', 'blacklist.txt', 'ipblacklist.txt']) if (!fs.existsSync(path.join(galaxy, f))) fs.writeFileSync(path.join(galaxy, f), '');
  // Saves rotate through numbered copies (server.dat.0-2, sectors/meta.db.0-2), measured.
  fs.writeFileSync(path.join(galaxy, `server.dat.${rotation}`), `FAKE AVORION server data ${Date.now()}\n`);
  fs.writeFileSync(path.join(galaxy, 'sectors', `meta.db.${rotation}`), `FAKE AVORION sector meta ${Date.now()}\n`);
  rotation = (rotation + 1) % 3;
  for (const f of ['index', 'globals', 'galaxyscripts.dat', 'groups.dat']) fs.writeFileSync(path.join(galaxy, f), `FAKE AVORION ${f}\n`);
}
function writeAdmin() {
  const file = path.join(galaxy, 'admin.xml');
  const known = fs.existsSync(file) ? [...fs.readFileSync(file, 'utf8').matchAll(/<administrator steamid="(\d+)"/g)].map((m) => m[1]) : [];
  const all = [...new Set([...known, ...admins])];
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="utf-8"?>\n<Administration>\n\t<administration>\n\t\t<defaultAuthorizationGroup>\n\t\t\t<commands>\n\t\t\t\t<command name="help"/>\n\t\t\t\t<command name="players"/>\n\t\t\t</commands>\n\t\t</defaultAuthorizationGroup>\n\t\t<authorizationGroups>\n\t\t\t<group name="Moderators">\n\t\t\t\t<commands>\n\t\t\t\t\t<command name="kick"/>\n\t\t\t\t\t<command name="ban"/>\n\t\t\t\t\t<command name="save"/>\n\t\t\t\t</commands>\n\t\t\t\t<users/>\n\t\t\t</group>\n\t\t</authorizationGroups>\n\t\t${all.length ? `<administrators>\n${all.map((id) => `\t\t\t<administrator steamid="${id}"/>`).join('\n')}\n\t\t</administrators>` : '<administrators/>'}\n\t</administration>\n</Administration>\n`,
  );
}

// ------------------------------------------------------------------ Steam queries
let steamQuerySocket = null;
let querySocket = null;
function a2sInfo() {
  const parts = [Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17])];
  const str = (s) => parts.push(Buffer.from(`${s}\0`, 'utf8'));
  const adm = settings.get('Administration');
  str(adm.name);
  str(settings.get('Game').Seed);
  str('avorion');
  str('Avorion');
  parts.push(Buffer.from([0, 0, players.size, Number(adm.maxPlayers), 0, 'l'.charCodeAt(0), 'l'.charCodeAt(0), adm.password ? 1 : 0, 1]));
  str(PUBLIC_VERSION);
  const edf = Buffer.alloc(11);
  edf.writeUInt8(0x80 | 0x10 | 0x20 | 0x01, 0);
  edf.writeUInt16LE(Number(settings.get('Networking').port), 1);
  edf.writeBigUInt64LE(90000000000000001n, 3);
  parts.push(edf);
  str(settings.get('Game').Scenario === '0' ? 'Creative' : 'Normal');
  const gid = Buffer.alloc(8);
  gid.writeBigUInt64LE(445220n);
  parts.push(gid);
  return Buffer.concat(parts);
}
function a2sPlayers() {
  const parts = [Buffer.from([0xff, 0xff, 0xff, 0xff, 0x44, players.size])];
  let i = 0;
  for (const name of players.keys()) {
    const b = Buffer.alloc(9);
    parts.push(Buffer.from([i++]), Buffer.from(`${name}\0`, 'utf8'));
    b.writeInt32LE(0, 0);
    b.writeFloatLE(0, 4);
    parts.push(b.subarray(0, 8));
  }
  return Buffer.concat(parts);
}
function a2sRules() {
  const g = settings.get('Game');
  const rules = { collision_damage: 'Full', description: settings.get('Administration').description, difficulty: 'Veteran', mods: '0', mod_achievements: 'yes', same_start_sector: g.sameStartSector === 'true' ? 'yes' : 'no', scenario: g.Scenario === '0' ? 'Creative' : 'Normal', tutorial: 'no', version: PUBLIC_VERSION };
  const n = Buffer.alloc(2);
  n.writeUInt16LE(Object.keys(rules).length);
  return Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x45]), n, ...Object.entries(rules).map(([k, v]) => Buffer.from(`${k}\0${v}\0`, 'utf8'))]);
}
function bind(sock, p) {
  return new Promise((resolve) => {
    sock.once('error', (e) => resolve(e));
    sock.bind(p, bindHost, () => resolve(null));
  });
}

// ------------------------------------------------------------------ stop
let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (autosave) clearInterval(autosave);
  out('Cleaning up entity transfers ...');
  saveFiles();
  for (const l of ['Server is shutting down.', 'Saving settings...', 'Saving script values...', 'Saving factions...', 'Saving sectors...', 'Saving groups...', 'Saving galaxy script data...', 'Saving settings...', 'waiting for unfinished sector generation jobs...', 'waiting for unfinished sector save jobs...', 'shutting down rcon...', 'shutting down networking...']) out(l);
  await sleep(50);
  for (const l of ['cleaning up communicators...', 'waiting for sector database termination...', 'waiting for faction database termination...', 'shutting down galaxy...', 'shutting down faction database...', 'shutting down sector database...', 'cleaning up timers...', 'Server shutdown successful.']) out(l);
  steamQuerySocket?.close();
  querySocket?.close();
  serverLog?.end();
  setTimeout(() => process.exit(code), 20);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (scenario === 'ignore-stop') return;
    void shutdown(0);
  });
}

// ------------------------------------------------------------------ console
const HELP = [
  ['addcrew', 'Sets the current crew of a ship to the minimum required crew'], ['admin', 'Add/remove administrators'], ['ban', 'Ban a player from the server'], ['banip', "Ban a player's ip from the server"],
  ['behemoths', 'Enable/disable the Behemoths Event Series'], ['benchmark', 'Records performance stats for some time and saves it to a file.'], ['blacklist', 'Restrict access via Blacklist'], ['colldamage', 'Set game/server collision damage'],
  ['destroy', 'Destroys your current target or the object with the given id'], ['devmode', 'Toggle server dev-mode'], ['difficulty', 'Set game/server difficulty'], ['echo', 'Echoes all given parameters to console'],
  ['give', 'Gives resources/money to a player'], ['ground', 'Block a player from using hyperspace'], ['groups', 'Manages users of groups'], ['help', 'Lists commands and provides help on commands'],
  ['invite', 'Invite players to join your group'], ['join', 'Confirm an invitation to a group or join an existing one'], ['kick', 'Kick a player from the server'], ['knowledge', 'Gives building knowledge to a player or resets it.'],
  ['leader', 'Promote another player to be the leader of the group'], ['leave', 'Leave your current group'], ['mute', 'Mute a player'], ['pause', 'Pauses the server'], ['playerinfo', 'Print players and their details'],
  ['players', 'List all online players'], ['profile', 'Records performance stats for some time and saves it to a file.'], ['run', 'Run a lua script command'], ['save', 'Save the current state of the server; Write all data to disk'],
  ['say', 'Send chat message to all players on the server'], ['seed', 'Display the seed of the server'], ['selfinfo', 'Prints administrative information about yourself'], ['status', 'Display status data of the server'], ['stop', 'Stops the server'],
  ['suicide', 'Destroys your current ship'], ['teleport', 'Teleports a player'], ['teleporttoship', 'Teleport to a sector with a ship you own'], ['trade', 'Initiate trading with another player'], ['unban', 'Unban a player from the server'],
  ['unbanip', 'Unban an ip from the server'], ['unground', 'Re-enable hyperspace for a player'], ['unmute', 'Unmute a player'], ['version', 'Retrieve the version of the server'], ['w', 'Send a private message to a player'],
  ['whisper', 'Send a private message to a player'], ['whitelist', 'Restrict access via Whitelist'], ['workers', 'Set the amount of worker threads on the server'],
];
const LIST_USAGE = ['Allowed options:', '  -s [ --status ]       checks if this list mode is active', '  --activate            sets the login filter to this list mode', '  --id arg              The steam Id of the player as 64bit number', '  --name arg            The nick name of the player', '  -a [ --add ]          add user to list', '  -r [ --remove ]       remove user from list', '  -c [ --check ]        check for user in list', '  -l [ --list ]         print all players in this list'];
const listFile = (f) => path.join(galaxy, f);
const listHas = (f, v) => (fs.existsSync(listFile(f)) ? fs.readFileSync(listFile(f), 'utf8').split('\n').includes(v) : false);

async function save() {
  out('Saving all server data.');
  await sleep(saveMs);
  saveFiles();
  out('Triggered saving of all server data.');
  out('All sectors saved successfully.');
}

let ready = false;
const queued = [];
async function command(line) {
  if (!line.startsWith('/')) {
    if (line.startsWith('fake-')) return hook(line);
    if (line.trim()) out("Invalid command formatting. Commands must begin with a '/' character.");
    return;
  }
  const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');
  // The test hooks, typed through a console that adds the slash Avorion's commands need (the panel's).
  if (cmd.startsWith('fake-')) return hook(line.slice(1));
  switch (cmd) {
    case 'help':
      for (const [n, d] of HELP) out(`/${n}: ${d}`);
      return;
    case 'version':
      return out(`Server Version: ${VERSION} ${COMMIT}`);
    case 'seed':
      return out(settings.get('Game').Seed);
    case 'players':
      out(`online players (${players.size}):`);
      for (const n of players.keys()) out(n); // with players online: not measured (no client)
      return;
    case 'status':
      out(`${players.size} players online, in 0 sectors`);
      out(`${players.size} players in memory, 0 registered`);
      out('0 factions in memory, 0 registered');
      out('0 sectors in memory, 0 sectors in total');
      out('avg. server load: 4%');
      return;
    case 'save':
      return save();
    case 'stop':
      if (scenario === 'ignore-stop') return;
      return shutdown(0);
    case 'say':
      return out(`<Server> ${arg} `);
    case 'kick':
      if (!players.has(arg)) return out(`Player ${arg} is not online.`);
      out(`${arg} has been kicked.`); // from the game's strings, not measured
      players.delete(arg);
      return out(`Player logged off: ${arg}`);
    case 'ban':
      if (!players.has(arg)) return out(`Player ${arg} not found.`);
      fs.appendFileSync(listFile('blacklist.txt'), `${arg}\n`); // the list's real format is unverified
      players.delete(arg);
      return out(`Player logged off: ${arg}`);
    case 'unban':
      if (!listHas('blacklist.txt', arg)) return out(`Player ${arg} not found.`);
      fs.writeFileSync(listFile('blacklist.txt'), fs.readFileSync(listFile('blacklist.txt'), 'utf8').split('\n').filter((l) => l && l !== arg).map((l) => `${l}\n`).join(''));
      return out(`Removed ${arg} from blacklist`);
    case 'banip':
      // Measured quirk: an address of nobody online answers like a player name.
      return out(`Player ${arg} not found`);
    case 'unbanip':
      if (!listHas('ipblacklist.txt', arg)) return out(`Ip ${arg} was not blacklisted`);
      return out(`Removed ${arg}'s ip from blacklist`);
    case 'whitelist':
    case 'blacklist':
      for (const l of LIST_USAGE) out(l);
      return;
    case 'admin':
      out('Invalid usage');
      out('Example: /admin -a [Player] for adding a player as administrator.');
      return;
    default:
      return out(`Unknown command: "${cmd}". To see all available commands type "/help"`);
  }
}
function hook(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const name = rest.join(' ');
  // Expected from the game's own strings; no real client joined in the fact-finding.
  if (cmd === 'fake-join' && name) {
    if (listHas('blacklist.txt', name)) return out(`Connection refused: Player ${name} is banned.`);
    players.set(name, ++playerIndex);
    out(`Player logged in: ${name}, index: ${playerIndex}`);
  } else if (cmd === 'fake-leave' && players.delete(name)) out(`Player logged off: ${name}`);
  else if (cmd === 'fake-crash') process.exit(3);
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  // Lines typed before the server is up wait for it.
  if (!ready) queued.push(line);
  else void command(line);
});

// ------------------------------------------------------------------ boot
let autosave = null;
out('Enabled Traces: ');
out(`Avorion server ${VERSION} ${COMMIT} running on Debian GNU/Linux 13 (trixie) starting up in "${galaxy}"`);
out('Version Hash: 5381909983546055243');
out('CPU: <host CPU>');
out('RAM: <host RAM>');
out('');
out(`Server version, as listed publicly: ${PUBLIC_VERSION}`);

const installDir = env.FAKE_AVORION_INSTALL_DIR;
if (installDir && path.resolve(process.cwd()) !== path.resolve(installDir)) {
  // Measured with the working directory in the data volume: Steam can't start and the game's scripts aren't found.
  err("[S_API] SteamAPI_Init(): Loaded local 'steamclient.so' OK.");
  err('SteamGameServer_Init call failed');
  out('Error starting steam-based networking. Falling back to standard TCP/UDP protocols.');
  out("An exception occurred: N3lua16stacktrace_errorE: invalid type 'nil' at stack position -1, expected table");
  err("include error: module 'generator' not found");
  process.exit(0);
}
try {
  if (scenario === 'crash-on-boot') throw new Error('crash-on-boot');
  fs.mkdirSync(path.join(galaxy, 'sectors'), { recursive: true });
  fs.accessSync(galaxy, fs.constants.W_OK);
} catch {
  out(`An exception occurred: N5boost10wrapexceptINS_13property_tree10ini_parser16ini_parser_errorEEE: ${iniFile}: cannot open file`);
  process.exit(0);
}
for (const d of ['alliances', 'factions', 'moddata', 'players']) fs.mkdirSync(path.join(galaxy, d), { recursive: true });
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19).replace(/:/g, '-');
serverLog = fs.createWriteStream(path.join(galaxy, `serverlog ${stamp}.txt`));
if (fs.existsSync(iniFile)) readIni();
// Command-line values win, and are written back into server.ini (measured).
set('Administration', 'name', opt['server-name']);
set('Networking', 'port', opt.port);
set('Administration', 'maxPlayers', opt['max-players']);
set('System', 'saveInterval', opt['save-interval']);
set('System', 'sendCrashReports', bool(opt['send-crash-reports']));
set('Networking', 'isListed', bool(opt.listed));
set('Networking', 'isMultiplayer', bool(opt.multiplayer ?? opt.public));
set('Networking', 'useSteam', bool(opt['use-steam-networking']));
set('Networking', 'rconPassword', opt['rcon-password']);
set('Networking', 'rconPort', opt['rcon-port']);
set('Game', 'Difficulty', opt.difficulty);
if (!settings.get('Game').Seed) settings.get('Game').Seed = opt.seed ?? 'FakeSeed01';
await sleep(bootMs / 3);
err("[S_API] SteamAPI_Init(): Loaded local 'steamclient.so' OK.");
err('Setting breakpad minidump AppID = 445220');

if (scenario === 'never-ready') {
  out('Server failed to connect to Steam');
  setInterval(() => out('Server failed to connect to Steam'), 2000);
} else {
  const net = settings.get('Networking');
  let steamOk = net.useSteam === 'true';
  if (steamOk) {
    steamQuerySocket = dgram.createSocket('udp4');
    if (await bind(steamQuerySocket, ports.steamQuery)) {
      steamQuerySocket = null;
      steamOk = false;
      out(`CreateBoundSocket: ::bind couldn't find an open port between ${ports.steamQuery} and ${ports.steamQuery}`);
      err('SteamGameServer_Init call failed');
      out('Error starting steam-based networking. Falling back to standard TCP/UDP protocols.');
    }
  }
  if (steamOk) {
    out('Server connected to Steam successfully');
    out('Server is VAC Secure!');
    out('Game Server Steam ID: 90000000000000001');
    out(`Game Port: ${net.port}`);
    out(`Steam Port: ${ports.steamMaster}`);
    out(`Steam Query Port: ${ports.steamQuery}`);
    out(`Query Port: ${ports.query}`);
    out('');
    out('Steam Networking initialized.');
    if (net.isListed === 'true') {
      steamQuerySocket.on('message', (m, rinfo) => {
        if (m.length < 5 || m.readUInt32LE(0) !== 0xffffffff) return;
        // Measured: answered at once, without the challenge step.
        const t = m.readUInt8(4);
        const reply = t === 0x54 ? a2sInfo() : t === 0x55 ? a2sPlayers() : t === 0x56 ? a2sRules() : null;
        if (reply) steamQuerySocket.send(reply, rinfo.port, rinfo.address);
      });
    }
  } else {
    out("The server will not be authenticated via Steam and won't show up in public server lists.");
    out('WARNING: The fallback TCP/UDP protocols are deprecated and potentially UNSAFE!');
    out("         If you're running a dedicated server, this is HIGHLY discouraged!");
    out('         Use steam networking instead; Enable with --use-steam-networking 1');
  }
  out(net.rconPassword ? `RCON listening on port ${net.rconPort}` : 'Warning: No RCON password set. RCON disabled.');
  out(`Found 0 mods in "${path.join(galaxy, 'modconfig.lua')}".`);
  await sleep(bootMs / 3);
  const s = (k, sec = 'Administration') => settings.get(sec)[k];
  const sys = settings.get('System');
  for (const l of [
    `name: ${s('name')}`,
    `seed: ${settings.get('Game').Seed}`,
    `port: ${net.port}`,
    `max online players: ${s('maxPlayers')}`,
    `save interval: ${sys.saveInterval}`,
    `multiplayer: ${net.isMultiplayer === 'true' ? 'yes' : 'no'}`,
    `listed: ${net.isListed === 'true' ? 'yes' : 'no'}`,
    `steam networking: ${net.useSteam === 'true' ? 'yes' : 'no'}`,
    `send crash reports: ${sys.sendCrashReports === 'true' ? 'yes' : 'no'}`,
    sys.backups === 'true' ? `Backup creation enabled. Path: "${sys.backupsPath || path.join(env.HOME ?? '~', '.avorion', 'backups')}"` : 'Backup creation disabled. ',
    `administrators: ${admins.join(', ')}`,
  ])
    out(l);
  if (!admins.length) out('Warning: Your server does not have an administrator assigned.');
  out(`Commands file: ${path.join(galaxy, 'commands.txt')}`);
  out('Initializing sector database...');
  saveFiles();
  fs.writeFileSync(path.join(galaxy, `server-stats ${stamp}.csv`), 'Local Time, UTC, Online Players, Server Load (Avg %), Memory (MB), Notes\n');
  await sleep(bootMs / 3);
  out('Galaxy initialized.');
  // The internal query port is bound last: a taken one fails the start (measured with it and the Steam query port taken).
  querySocket = dgram.createSocket('udp4');
  if (await bind(querySocket, ports.query)) {
    querySocket = null;
    err('ERROR accepting connections: bind: Address already in use [system:98 at reactive_socket_service.hpp:161 in function \'bind\']');
    out('Server startup FAILED.');
    await shutdown(0);
  } else {
    out('Server startup complete.');
    ready = true;
    for (const l of queued.splice(0)) await command(l);
    // Autosaves are silent: the files change, nothing is printed (measured).
    autosave = setInterval(saveFiles, Math.max(1, Number(sys.saveInterval) * intervalMsPerS));
    if (scenario === 'crash-after-ready') {
      setTimeout(() => {
        out('An exception occurred: fake crash after the ready line');
        process.exit(1);
      }, crashMs);
    }
  }
}
