#!/usr/bin/env node
// A stand-in for a Minecraft Java server (vanilla, Paper or Fabric), for agent/panel tests and the
// dev loop without Java or a download. It speaks the console, log lines, files and RCON measured
// on 26.3 (docs/verification/minecraft-26.3.md, fixtures/minecraft/26.3/) — and is a separate
// implementation from the code under test on purpose.
//
// It takes the place of `java` itself, so the adapter's own argument list works unchanged:
//   node server.mjs [JVM args…] -jar <jar> [nogui]              a server, in the working directory
//   node server.mjs -Dpaperclip.patchonly=true -jar paper.jar     Paper's patch-only install step
//   node server.mjs -jar fabric-installer-<v>.jar server -mcversion <v> -loader <v> -dir <dir> [-downloadMinecraft]
//
// Loader: FAKE_MC_LOADER (vanilla | paper | fabric), else GAME_FLAVOUR, else guessed from the jar name.
// Scenarios (FAKE_MC_SCENARIO): normal | crash-after-ready | crash-on-boot | blocking-prompt |
//   never-ready | ignore-stop
// Tuning: FAKE_MC_BOOT_MS (default 300), FAKE_MC_CRASH_MS (500), FAKE_MC_VERSION (26.3),
//   FAKE_MC_PLAYERS ("a,b": online at boot), FAKE_MC_PROFILES ("Name=uuid,…": accounts an
//   online-mode lookup finds), FAKE_MC_BIND_HOST (127.0.0.1), FAKE_MC_BIND_GAME_PORT=1 (also
//   listen on server-port, so a taken port fails like the real server), FAKE_MC_INSTALL_FAIL=1.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';

const env = process.env;
const argv = process.argv.slice(2);
const jarAt = argv.indexOf('-jar');
const jvm = jarAt >= 0 ? argv.slice(0, jarAt) : argv;
const jar = jarAt >= 0 ? (argv[jarAt + 1] ?? '') : '';
const gameArgs = jarAt >= 0 ? argv.slice(jarAt + 2) : [];
const prop = (name) => jvm.find((a) => a.startsWith(`-D${name}=`))?.slice(name.length + 3);

const VERSION = env.FAKE_MC_VERSION ?? '26.3';
const scenario = env.FAKE_MC_SCENARIO ?? 'normal';
const bootMs = Number(env.FAKE_MC_BOOT_MS ?? 300);
const bindHost = env.FAKE_MC_BIND_HOST ?? '127.0.0.1';
const loader = (() => {
  const v = env.FAKE_MC_LOADER ?? env.GAME_FLAVOUR;
  if (v === 'vanilla' || v === 'paper' || v === 'fabric') return v;
  const b = path.basename(jar).toLowerCase();
  return b.startsWith('paper') ? 'paper' : b.includes('fabric') ? 'fabric' : 'vanilla';
})();
const cwd = process.cwd();
const repoDir = prop('bundlerRepoDir');
/** Where the bundler unpacks (`-DbundlerRepoDir`, else the working directory) and how it prints it. */
const repo = (rel) => ({ abs: path.join(repoDir ?? cwd, rel), shown: repoDir ? `${repoDir.replace(/\/$/, '')}/${rel}` : rel });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (l) => process.stdout.write(`${l}\n`);
const err = (l) => process.stderr.write(`${l}\n`);

// ------------------------------------------------------------------- log lines
const hhmmss = () => new Date().toTimeString().slice(0, 8);
let logFile = null;
/** One log line in the loader's console format: vanilla and Fabric name the thread, Paper doesn't. */
function log(msg, level = 'INFO', thread = 'Server thread') {
  const line = loader === 'paper' ? `[${hhmmss()} ${level}]: ${msg}` : `[${hhmmss()}] [${thread}/${level}]: ${msg}`;
  out(line);
  if (logFile) fs.appendFileSync(logFile, `${line}\n`);
}
/** Command feedback on the console: 26.3 prefixes it with "System chat: ". */
const chat = (msg) => log(`System chat: ${msg}`);

// ------------------------------------------------------------------- install modes
if (/fabric-installer/i.test(path.basename(jar)) && gameArgs[0] === 'server') {
  const arg = (n) => gameArgs[gameArgs.indexOf(n) + 1];
  const mc = arg('-mcversion') ?? VERSION;
  const fl = arg('-loader') ?? '0.19.5';
  const dir = path.resolve(arg('-dir') ?? cwd);
  const iv = /fabric-installer-([\w.]+)\.jar$/i.exec(path.basename(jar))?.[1] ?? '1.1.2';
  out(`Loading Fabric Installer: ${iv}`);
  out(`Installing Fabric Loader ${fl}(${mc}) on the server`);
  out('Downloading required files');
  if (env.FAKE_MC_INSTALL_FAIL === '1') {
    err('FAKE: the install failed (the real installer\'s failure output was not captured)');
    process.exit(1);
  }
  const libs = ['org.ow2.asm:asm:9.10.1', 'org.ow2.asm:asm-analysis:9.10.1', 'org.ow2.asm:asm-commons:9.10.1', 'org.ow2.asm:asm-tree:9.10.1', 'org.ow2.asm:asm-util:9.10.1', 'net.fabricmc:sponge-mixin:0.17.4+mixin.0.8.7', `net.fabricmc:fabric-loader:${fl}`];
  for (const l of libs) {
    out(`Downloading library ${l}`);
    const [g, a, v] = l.split(':');
    const f = path.join(dir, 'libraries', ...g.split('.'), a, v, `${a}-${v}.jar`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `FAKE ${l}\n`);
  }
  out('Generating server launch JAR');
  fs.writeFileSync(path.join(dir, 'fabric-server-launch.jar'), `FAKE fabric-server-launch for ${mc} / ${fl}\n`);
  if (gameArgs.includes('-downloadMinecraft')) {
    out('Downloading Minecraft server');
    // The same bytes downloads.mjs serves as Mojang's jar, so a check against Mojang's SHA-1 passes.
    fs.writeFileSync(path.join(dir, 'server.jar'), `FAKE-MINECRAFT minecraft server ${mc}\n`);
  }
  out('Done');
  out('Done, start server by running fabric-server-launch.jar');
  process.exit(0);
}

/** Paperclip: fetch Mojang's jar and patch it, into the repo dir, unless that was done before. */
function paperclip() {
  const patched = repo(path.join('versions', VERSION, `paper-${VERSION}.jar`));
  if (fs.existsSync(patched.abs)) return;
  out(`Downloading mojang_${VERSION}.jar`);
  const cache = repo(path.join('cache', `mojang_${VERSION}.jar`)).abs;
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, `FAKE mojang ${VERSION}\n`);
  out('Applying patches');
  fs.mkdirSync(path.dirname(patched.abs), { recursive: true });
  fs.writeFileSync(patched.abs, `FAKE paper ${VERSION}\n`);
  fs.mkdirSync(repo('libraries').abs, { recursive: true });
}
if (loader === 'paper' && prop('paperclip.patchonly') === 'true') {
  paperclip();
  process.exit(0);
}

// ------------------------------------------------------------------- the jar itself
// The fake needs no jar. With FAKE_MC_REQUIRE_JAR=1 the jars must exist, and a missing one fails as
// measured (the JVM's own message, exit 1).
const requireJars = env.FAKE_MC_REQUIRE_JAR === '1';
if (requireJars && !fs.existsSync(path.resolve(cwd, jar))) {
  err(`Error: Unable to access jarfile ${jar}`);
  process.exit(1);
}
/** The thread of the first log lines: `main` under Fabric's launcher, `ServerMain` otherwise. */
const MAIN = loader === 'fabric' ? 'main' : 'ServerMain';

// A shared install (HST-09): an install an install job finished carries the shared-install marker,
// and servers mount it read-only, so the fake treats an install with the marker as read-only (a real
// read-only mount, as in the fake images, fails the same way).
const SHARED_MARKER = '.gsp-shared-install.json';
function readOnlyAt(target) {
  let p = path.resolve(target);
  for (;;) {
    try {
      fs.lstatSync(p);
      break;
    } catch {
      const up = path.dirname(p);
      if (up === p) return false;
      p = up;
    }
  }
  let real;
  try {
    real = fs.realpathSync(p);
  } catch {
    return false;
  }
  for (let d = real; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, SHARED_MARKER))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/**
 * The vanilla bundler (also under Fabric): unpack the libraries the first time, into the repo
 * dir (the install). Read-only, it can't (measured on 26.3, docs/verification/shared-installs.md):
 * vanilla exits 0, Fabric's launcher 1, and the agent sees a crash loop. The install job's warm-up
 * (`--help`) unpacks them once instead.
 */
function bundler() {
  // What it unpacks first (Fabric's installer puts its own libraries in the same folder before).
  const v = repo(path.join('versions', VERSION, `server-${VERSION}.jar`));
  if (fs.existsSync(v.abs)) return;
  out(`Unpacking ${VERSION}/server-${VERSION}.jar (versions:${VERSION}) to ${v.shown}`);
  if (readOnlyAt(repo('versions').abs)) {
    out(`java.nio.file.FileSystemException: ${repo('versions').shown}: Read-only file system`);
    out('\tat net.minecraft.bundler.Main.extractJar(Main.java:105)');
    out('\tat net.minecraft.bundler.Main.main(Main.java:25)');
    out('Failed to extract server libraries, exiting');
    if (loader === 'fabric') {
      err('[00:00:00] [ERROR] [FabricLoader/]: Uncaught exception in thread "main"');
      err('java.lang.RuntimeException: An exception occurred when launching the server!');
      process.exit(1);
    }
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(v.abs), { recursive: true });
  fs.writeFileSync(v.abs, `FAKE server ${VERSION}\n`);
  for (const [p, coords] of [
    ['com/google/code/gson/gson/2.14.0/gson-2.14.0.jar', 'com.google.code.gson:gson:2.14.0'],
    ['com/mojang/brigadier/1.3.11/brigadier-1.3.11.jar', 'com.mojang:brigadier:1.3.11'],
    ['io/netty/netty-common/4.2.16.Final/netty-common-4.2.16.Final.jar', 'io.netty:netty-common:4.2.16.Final'],
  ]) {
    const l = repo(path.join('libraries', p));
    out(`Unpacking ${p} (libraries:${coords}) to ${l.shown.replace(/\\/g, '/')}`);
    fs.mkdirSync(path.dirname(l.abs), { recursive: true });
    fs.writeFileSync(l.abs, `FAKE ${coords}\n`);
  }
}

// `--help` on Mojang's jar (the install job's warm-up, measured on 26.3): the bundler unpacks, the
// server prints its option list and exits 0, without starting a server or writing anything else.
if (gameArgs.includes('--help')) {
  bundler();
  out('Starting net.minecraft.server.Main');
  out('Option                 Description');
  out('------                 -----------');
  for (const o of ['--bonusChest', '--demo', '--eraseCache', '--forceUpgrade', '--help', '--initSettings', '--nogui', '--port <Integer>', '--safeMode', '--serverId <String>', '--universe <String>', '--world <String>']) out(o);
  process.exit(0);
}

// ------------------------------------------------------------------- server.properties (26.3 defaults)
const DEFAULTS = {
  'accepts-transfers': 'false', 'allow-flight': 'false', 'broadcast-console-to-ops': 'true', 'broadcast-rcon-to-ops': 'true',
  'bug-report-link': '', 'chat-spam-threshold-seconds': '10', 'command-spam-threshold-seconds': '10', difficulty: 'easy',
  'enable-code-of-conduct': 'false', 'enable-jmx-monitoring': 'false', 'enable-query': 'false', 'enable-rcon': 'false',
  'enable-status': 'true', 'enforce-secure-profile': 'true', 'enforce-whitelist': 'false', 'entity-broadcast-range-percentage': '100',
  'force-gamemode': 'false', 'function-permission-level': '2', gamemode: 'survival', 'generate-structures': 'true',
  'generator-settings': '{}', hardcore: 'false', 'hide-online-players': 'false', 'initial-disabled-packs': '',
  'initial-enabled-packs': 'vanilla', 'level-name': 'world', 'level-seed': '', 'level-type': 'minecraft:normal', 'log-ips': 'true',
  'management-server-allowed-origins': '', 'management-server-enabled': 'false', 'management-server-host': 'localhost',
  'management-server-port': '0', 'management-server-secret': '', 'management-server-tls-enabled': 'true',
  'management-server-tls-keystore': '', 'management-server-tls-keystore-password': '', 'max-chained-neighbor-updates': '1000000',
  'max-players': '20', 'max-tick-time': '60000', 'max-world-size': '29999984', motd: 'A Minecraft Server',
  'network-compression-threshold': '256', 'online-mode': 'true', 'op-permission-level': '4', 'pause-when-empty-seconds': '60',
  'player-idle-timeout': '0', 'prevent-proxy-connections': 'false', 'query.port': '25565', 'rate-limit': '0', 'rcon.password': '',
  'rcon.port': '25575', 'region-file-compression': 'deflate', 'require-resource-pack': 'false', 'resource-pack': '',
  'resource-pack-id': '', 'resource-pack-prompt': '', 'resource-pack-sha1': '', 'server-ip': '', 'server-port': '25565',
  'simulation-distance': '10', 'spawn-protection': '16', 'status-heartbeat-interval': '0', 'sync-chunk-writes': 'true',
  'text-filtering-config': '', 'text-filtering-version': '0', 'use-native-transport': 'true', 'view-distance': '10', 'white-list': 'true',
};
// Paper adds `debug` and turns pausing off.
if (loader === 'paper') Object.assign(DEFAULTS, { debug: 'false', 'pause-when-empty-seconds': '-1' });

/** Java properties, the subset the game writes and reads: key=value lines, # and ! comments, escapes. */
function parseProps(text) {
  const map = {};
  const unescape = (s) => s.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_m, u, c) => (u ? String.fromCharCode(parseInt(u, 16)) : ({ t: '\t', n: '\n', r: '\r', f: '\f' })[c] ?? c));
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (!line || line[0] === '#' || line[0] === '!') continue;
    const m = /^((?:\\.|[^=:\s\\])*)\s*[=:\s]\s*(.*)$/.exec(line) ?? [line, line, ''];
    map[unescape(m[1])] = unescape(m[2]);
  }
  return map;
}
/** Like java.util.Properties.store: escapes, UTF-8 as it is, a header and the date, then the keys sorted. */
function storeProps(map, header) {
  const esc = (s, key) => s.replace(/[\\=:#!]|\t|\n|\r|\f|^ | /g, (c, i) => ({ '\t': '\\t', '\n': '\\n', '\r': '\\r', '\f': '\\f' })[c] ?? (c === ' ' ? (key || i === 0 ? '\\ ' : ' ') : `\\${c}`));
  const date = new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, (_m, d, day, mon, y, t) => `${d} ${mon} ${day.padStart(2, '0')} ${t} UTC ${y}`);
  return `#${header}\n#${date}\n${Object.keys(map).sort().map((k) => `${esc(k, true)}=${esc(map[k], false)}`).join('\n')}\n`;
}

const propsFile = path.join(cwd, 'server.properties');
let props;
function loadProps() {
  let onDisk = {};
  if (fs.existsSync(propsFile)) onDisk = parseProps(fs.readFileSync(propsFile, 'utf8'));
  else {
    log('Failed to load properties from file: server.properties', 'ERROR', MAIN);
    out('java.nio.file.NoSuchFileException: server.properties');
  }
  props = { ...DEFAULTS, ...onDisk };
  if (!props['management-server-secret']) props['management-server-secret'] = crypto.randomBytes(30).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 40).padEnd(40, 'x');
  saveProps();
}
/** The game rewrites the whole file from memory (at boot and on `whitelist on|off`): edits made on disk meanwhile are lost. */
const saveProps = () => fs.writeFileSync(propsFile, storeProps(props, 'Minecraft server properties'));

// ------------------------------------------------------------------- EULA
function eulaAccepted() {
  const file = path.join(cwd, 'eula.txt');
  if (!fs.existsSync(file)) {
    log('Failed to load eula.txt', 'WARN', MAIN);
    fs.writeFileSync(file, storeProps({ eula: 'false' }, 'By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).'));
    return false;
  }
  return /^true$/i.test(parseProps(fs.readFileSync(file, 'utf8')).eula ?? '');
}

// ------------------------------------------------------------------- players and their files
const lists = { ops: [], whitelist: [], 'banned-players': [], 'banned-ips': [], usercache: [] };
const listFile = (n) => path.join(cwd, `${n}.json`);
function readList(n) {
  try {
    const v = JSON.parse(fs.readFileSync(listFile(n), 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
/** Pretty JSON without a final newline; the user cache on one line. */
const writeList = (n) => fs.writeFileSync(listFile(n), n === 'usercache' ? JSON.stringify(lists[n]) : JSON.stringify(lists[n], null, 2));
const stamp = () => new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000');

function offlineUuid(name) {
  const b = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const accounts = new Map(
  (env.FAKE_MC_PROFILES ?? '').split(',').filter(Boolean).map((p) => {
    const [name, uuid] = p.split('=');
    return [name.toLowerCase(), { name, uuid }];
  }),
);
/** online players by lower-case name */
const online = new Map();
let entityId = 12;

/**
 * A name to a profile, as the 26.3 commands resolve it: an online player, the user cache, then an
 * account lookup; offline servers fall back to an offline profile (vanilla and Fabric lower-case
 * the name first, Paper keeps it as typed).
 */
function resolve(name) {
  const k = name.toLowerCase();
  if (online.has(k)) return online.get(k);
  const cached = lists.usercache.find((e) => e.name.toLowerCase() === k);
  if (cached) return { name: cached.name, uuid: cached.uuid };
  let p = accounts.get(k) ?? null;
  if (!p && props['online-mode'] === 'false') {
    const n = loader === 'paper' ? name : k;
    p = { name: n, uuid: offlineUuid(n) };
  }
  if (!p) {
    log(`Couldn't find profile with name: ${k}`, 'WARN');
    return null;
  }
  remember(p);
  return p;
}
function remember(p) {
  lists.usercache = [{ uuid: p.uuid, name: p.name, expiresOn: stamp().replace(/^(\d+)-(\d+)/, (_m, y, mo) => (Number(mo) === 12 ? `${Number(y) + 1}-01` : `${y}-${String(Number(mo) + 1).padStart(2, '0')}`)) }, ...lists.usercache.filter((e) => e.uuid !== p.uuid)];
  writeList('usercache');
}

/** A client logs in: its own profile (the account's, or offline the name it sent, as sent). */
function join(name, ip = '127.0.0.1') {
  const p = accounts.get(name.toLowerCase()) ?? { name, uuid: offlineUuid(name) };
  remember(p);
  online.set(p.name.toLowerCase(), p);
  const port = 30000 + Math.floor(Math.random() * 30000);
  const at = loader === 'paper' ? '([minecraft:overworld]-5.5, 78.0, 28.5)' : '(-6.5, 63.0, 23.5)';
  const loggedIn = `${p.name}[/${ip}:${port}] logged in with entity id ${(entityId += 7)} at ${at}`;
  if (loader === 'paper') {
    log(`UUID of player ${p.name} is ${p.uuid}`);
    chat(`${p.name} joined the game`);
    log(loggedIn);
  } else {
    log(loggedIn);
    chat(`${p.name} joined the game`);
  }
}
function leave(name, reason = 'Disconnected') {
  const p = online.get(name.toLowerCase());
  if (!p) return false;
  online.delete(name.toLowerCase());
  log(`${p.name} lost connection: ${reason}`);
  chat(`${p.name} left the game`);
  return true;
}

// ------------------------------------------------------------------- commands
let saving = true;
let stopping = false;
const worldDir = () => path.join(cwd, props['level-name'] || 'world');
function saveWorld() {
  const f = path.join(worldDir(), 'level.dat');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `FAKE level ${Date.now()}\n`);
}

const PAPER_HELP = [
  '§e--------- §fHelp: §rIndex (1/23) §e--------------------------',
  '§7Use /help [n] to get page n of help.',
  '§7§6Aliases: §fLists command aliases',
  '§f§6Bukkit: §fAll commands for Bukkit',
  '§f§6Minecraft: §fAll commands for Minecraft',
  '§f§6Paper: §fAll commands for Paper',
];
const HELP = ['/advancement (grant|revoke)', '/ban <targets> [<reason>]', '/ban-ip <target> [<reason>]', '/banlist [ips|players]', '/deop <targets>', '/help [<command>]', '/kick <targets> [<reason>]', '/list [uuids]', '/op <targets>', '/pardon <targets>', '/pardon-ip <target>', '/save-all [flush]', '/save-off', '/save-on', '/say <message>', '/stop', '/version', '/whitelist (on|off|list|add|remove|reload)'];

/**
 * Runs one command. Returns its feedback lines; `src` is 'console' or 'rcon' (RCON feedback is also
 * echoed to the log as "[Rcon: …]" when broadcast-rcon-to-ops is on).
 */
function run(line, src) {
  const [cmd = '', ...rest] = line.trim().replace(/^\//, '').split(/\s+/);
  const a = rest[0];
  const tail = (from) => rest.slice(from).join(' ');
  /** A success: RCON's is also echoed to the log as "[Rcon: …]" while broadcast-rcon-to-ops is on. */
  const ok = (msg, reply = [msg]) => {
    if (src === 'rcon' && props['broadcast-rcon-to-ops'] !== 'false') chat(`[Rcon: ${msg}]`);
    return reply;
  };
  /** A failure: only the sender sees it. */
  const fail = (msg) => [msg];
  const toggle = (key, on, msg, already) => {
    if ((props[key] === 'true') === on) return fail(already);
    props[key] = String(on);
    saveProps();
    return ok(msg);
  };
  const listEntry = (list, p) => lists[list].find((e) => e.uuid === p.uuid);
  const source = src === 'rcon' ? 'Rcon' : 'Server';
  switch (cmd) {
    case 'list': {
      const names = [...online.values()].map((p) => (a === 'uuids' ? `${p.name} (${p.uuid})` : p.name));
      return [`There are ${online.size} of a max of ${props['max-players']} players online: ${names.join(', ')}`];
    }
    case 'say': {
      // Measured: longer messages are refused, counted in characters of the message.
      const text = line.trim().replace(/^\/?say\s?/, '');
      if (text.length > 256) return fail(`Chat message was too long (${text.length} > maximum 256 characters)`);
      log(`[Not Secure] [${source}] ${text}`);
      return [''];
    }
    case 'save-all':
      // Saves even while saving is off; only "Saved the game" is echoed to the log for RCON.
      saveWorld();
      return ok('Saved the game', ['Saving the game (this may take a moment!)', 'Saved the game']);
    case 'save-off':
      if (!saving) return fail('Saving is already turned off');
      saving = false;
      return ok('Automatic saving is now disabled');
    case 'save-on':
      if (saving) return fail('Saving is already turned on');
      saving = true;
      return ok('Automatic saving is now enabled');
    case 'stop':
      setImmediate(stop);
      return ok('Stopping the server');
    case 'kick': {
      const p = a && online.get(a.toLowerCase());
      if (!p) return fail('No player was found');
      const reason = tail(1) || 'Kicked by an operator';
      const reply = ok(`Kicked ${p.name}: ${reason}`);
      leave(p.name, reason);
      return reply;
    }
    case 'ban': {
      const p = a && resolve(a);
      if (!p) return fail('That player does not exist');
      if (listEntry('banned-players', p)) return fail('Nothing changed. The player is already banned');
      const reason = tail(1) || 'Banned by an operator.';
      lists['banned-players'].push({ uuid: p.uuid, name: p.name, created: stamp(), source, expires: 'forever', reason });
      writeList('banned-players');
      const reply = ok(`Banned ${p.name}: ${reason}`);
      if (online.has(p.name.toLowerCase())) leave(p.name, 'You are banned from this server');
      return reply;
    }
    case 'pardon': {
      const p = a && resolve(a);
      if (!p) return fail('That player does not exist');
      if (!listEntry('banned-players', p)) return fail('Nothing changed. The player isn\'t banned');
      lists['banned-players'] = lists['banned-players'].filter((e) => e.uuid !== p.uuid);
      writeList('banned-players');
      return ok(`Unbanned ${p.name}`);
    }
    case 'ban-ip': {
      if (!a || !net.isIP(a)) return fail('Invalid IP address or unknown player');
      if (lists['banned-ips'].some((e) => e.ip === a)) return fail('Nothing changed. That IP is already banned');
      const reason = tail(1) || 'Banned by an operator.';
      lists['banned-ips'].push({ ip: a, created: stamp(), source, expires: 'forever', reason });
      writeList('banned-ips');
      return ok(`Banned IP ${a}: ${reason}`);
    }
    case 'pardon-ip':
      if (!a || !net.isIP(a)) return fail('Invalid IP address');
      if (!lists['banned-ips'].some((e) => e.ip === a)) return fail('Nothing changed. That IP isn\'t banned');
      lists['banned-ips'] = lists['banned-ips'].filter((e) => e.ip !== a);
      writeList('banned-ips');
      return ok(`Unbanned IP ${a}`);
    case 'banlist': {
      const players = a === 'ips' ? [] : lists['banned-players'];
      const ips = a === 'players' ? [] : lists['banned-ips'];
      const all = [...players.map((e) => `${e.name} was banned by ${e.source}: ${e.reason}`), ...ips.map((e) => `${e.ip} was banned by ${e.source}: ${e.reason}`)];
      return all.length ? [`There are ${all.length} ban(s):`, ...all] : ['There are no bans'];
    }
    case 'op': {
      const p = a && resolve(a);
      if (!p) return fail('That player does not exist');
      if (listEntry('ops', p)) return fail('Nothing changed. The player is already an operator');
      lists.ops.push({ uuid: p.uuid, name: p.name, level: Number(props['op-permission-level']) || 4, bypassesPlayerLimit: false });
      writeList('ops');
      return ok(`Made ${p.name} a server operator`);
    }
    case 'deop': {
      const p = a && resolve(a);
      if (!p) return fail('That player does not exist');
      if (!listEntry('ops', p)) return fail('Nothing changed. The player is not an operator');
      lists.ops = lists.ops.filter((e) => e.uuid !== p.uuid);
      writeList('ops');
      return ok(`Made ${p.name} no longer a server operator`);
    }
    case 'whitelist': {
      const b = rest[1];
      switch (a) {
        case 'on':
          return toggle('white-list', true, 'Whitelist is now turned on', 'Whitelist is already turned on');
        case 'off':
          return toggle('white-list', false, 'Whitelist is now turned off', 'Whitelist is already turned off');
        case 'list': {
          const names = lists.whitelist.map((e) => e.name);
          return [names.length ? `There are ${names.length} whitelisted player(s): ${names.join(', ')}` : 'There are no whitelisted players'];
        }
        case 'reload':
          // Measured: re-reads whitelist.json only (ops.json edits made on disk are not picked up).
          lists.whitelist = readList('whitelist');
          return ok('Reloaded the whitelist');
        case 'add': {
          const p = b && resolve(b);
          if (!p) return fail('That player does not exist');
          if (listEntry('whitelist', p)) return fail('Player is already whitelisted');
          lists.whitelist.push({ uuid: p.uuid, name: p.name });
          writeList('whitelist');
          return ok(`Added ${p.name} to the whitelist`);
        }
        case 'remove': {
          const p = b && resolve(b);
          if (!p) return fail('That player does not exist');
          if (!listEntry('whitelist', p)) return fail('Player is not whitelisted');
          lists.whitelist = lists.whitelist.filter((e) => e.uuid !== p.uuid);
          writeList('whitelist');
          return ok(`Removed ${p.name} from the whitelist`);
        }
        default:
          return unknown(line);
      }
    }
    case 'help':
      // Vanilla's is over 4096 characters (its RCON reply comes in two packets); Paper's is paged, and
      // coloured with § codes (the first lines of fixtures/minecraft/26.3/paper/rcon/long.json).
      return loader === 'paper' ? PAPER_HELP : Array.from({ length: 300 }, (_, i) => HELP[i % HELP.length]);
    case 'version':
      return loader === 'paper' ? [`This server is running Paper version ${VERSION}-41-main@a15fed9 (FAKE) (Implementing API version ${VERSION}.build.41-alpha)`, 'You are running the latest version'] : ['Server version info:', `id = ${VERSION}`, `name = ${VERSION}`, 'protocol = 777 (0x309)', 'stable = yes'];
    // Test hooks, like the PZ fake's.
    case 'fake-join':
      join(tail(0));
      return ['ok'];
    case 'fake-leave':
      return [leave(tail(0)) ? 'ok' : 'not online'];
    case 'fake-crash':
      setImmediate(() => crash('java.lang.IllegalStateException: FAKE crash requested'));
      return ['ok'];
    default:
      return unknown(line);
  }
}
const unknown = (line) => ['Unknown or incomplete command. See below for error', `${line.trim()}<--[HERE]`];

/** Console feedback: one "System chat:" line each (Paper prints the error marker line bare). */
function consoleReply(lines) {
  for (const [i, l] of lines.entries()) {
    if (l === '') continue;
    if (loader === 'paper' && i === 1 && l.endsWith('<--[HERE]')) out(l);
    else chat(l);
  }
}
/** RCON feedback: vanilla and Fabric join the lines with nothing between them, Paper with newlines. */
const rconReply = (lines) => lines.join(loader === 'paper' ? '\n' : '');

// ------------------------------------------------------------------- RCON (as 26.3 frames it)
function packet(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}
const rconClients = new Set();
let rconServer = null;
let clientNo = 0;
/** Resolves once RCON listens (or failed to). */
function startRcon() {
  log('Starting remote control listener');
  const port = Number(props['rcon.port']) || 25575;
  const password = props['rcon.password'] ?? '';
  if (!password) {
    log('No rcon password set in server.properties, rcon disabled!', 'WARN');
    return Promise.resolve();
  }
  rconServer = net.createServer((sock) => {
    rconClients.add(sock);
    const n = ++clientNo;
    const who = `RCON Client /${sock.remoteAddress?.replace(/^::ffff:/, '')}`;
    log(`Thread ${who} started`, 'INFO', 'RCON Listener #1');
    let authed = false;
    sock.on('error', () => undefined);
    sock.on('close', () => {
      rconClients.delete(sock);
      if (!stopping) log(`Thread ${who} shutting down`, 'INFO', `${who} #${n}`);
    });
    // The real server reads at most 1460 bytes at a time and drops the connection unless that read
    // holds exactly one packet: two packets in one TCP write, or one split across reads, end it.
    sock.on('data', (d) => {
      if (d.length < 14 || d.length > 1460 || d.readInt32LE(0) !== d.length - 4) {
        sock.destroy();
        return;
      }
      const id = d.readInt32LE(4);
      const type = d.readInt32LE(8);
      const body = d.subarray(12, d.length - 2).toString('utf8');
      if (type === 3) {
        authed = body === password;
        sock.write(packet(authed ? id : -1, 2, ''));
      } else if (!authed) {
        sock.write(packet(-1, 2, ''));
      } else if (type === 2) {
        const reply = rconReply(run(body, 'rcon'));
        // Split every 4096 characters, as the game does (characters, not bytes).
        let rest = reply;
        do {
          sock.write(packet(id, 0, rest.slice(0, 4096)));
          rest = rest.slice(4096);
        } while (rest.length);
      } else {
        sock.write(packet(id, 0, `Unknown request ${type.toString(16)}`));
      }
    });
  });
  return new Promise((resolve) => {
    rconServer.on('error', (e) => {
      // Measured: the server goes on without RCON.
      log(`Unable to initialise RCON on 0.0.0.0:${port}`, 'WARN');
      out(`java.net.BindException: ${e.code === 'EADDRINUSE' ? 'Address already in use' : e.message}`);
      rconServer = null;
      resolve();
    });
    rconServer.listen(port, bindHost, () => {
      log('Thread RCON Listener started');
      log(`RCON running on 0.0.0.0:${port}`);
      resolve();
    });
  });
}

// ------------------------------------------------------------------- lifecycle
function crash(exception) {
  log('Encountered an unexpected exception', 'ERROR');
  out(exception);
  const name = `crash-${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '.')}-server.txt`;
  const dir = path.join(cwd, 'crash-reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `---- Minecraft Crash Report ----\n// FAKE\n\nDescription: Exception in server tick loop\n\n${exception}\n`);
  log(`This crash report has been saved to: ${path.join(dir, name).replace(/\\/g, '/')}`, 'ERROR');
  log('Stopping server');
  log('Saving worlds');
  // Measured: the process exits 0 after a crash report.
  setTimeout(() => process.exit(0), 50);
}

let gameServer = null;
function stop() {
  if (stopping) return;
  if (scenario === 'ignore-stop') return; // acknowledged, and then nothing: the agent must escalate to signals
  stopping = true;
  log('Stopping server');
  log('Saving players');
  for (const p of [...online.values()]) {
    online.delete(p.name.toLowerCase());
    if (loader === 'paper') {
      log(`${p.name} lost connection: Server closed`);
      chat(`${p.name} left the game`);
    }
  }
  log('Saving worlds');
  saveWorld();
  for (const dim of ['overworld', 'the_end', 'the_nether']) log(`Saving chunks for level 'ServerLevel[world]'/minecraft:${dim}`);
  if (rconServer) {
    log('Thread RCON Listener stopped');
    for (const s of rconClients) s.destroy();
    rconServer.close();
  }
  gameServer?.close();
  setTimeout(() => process.exit(0), 150);
}

process.on('SIGTERM', () => {
  // Measured: the JVM's shutdown hook saves the world and the process exits 143. Vanilla and
  // Fabric print nothing (their logging is already shut down); Paper logs its whole stop.
  if (loader === 'paper' && !stopping) {
    stopping = true;
    log('Stopping server');
    log('Saving players');
    log('Saving worlds');
  }
  saveWorld();
  process.exit(143);
});

const rl = readline.createInterface({ input: process.stdin });
let ready = false;
const early = [];
rl.on('line', (line) => {
  // Commands typed before the server is up wait for its first tick.
  if (!ready) return void early.push(line);
  consoleReply(run(line, 'console'));
});
// Measured: stdin reaching its end changes nothing; the server keeps running.

// ------------------------------------------------------------------- boot
if (loader === 'paper') {
  paperclip();
  out('Starting org.bukkit.craftbukkit.Main');
  err(`${new Date().toISOString()} ServerMain WARN Advanced terminal features are not available in this environment`);
  log(`[bootstrap] Running Java 25 (FAKE; ${process.version}) on ${process.platform} (${process.arch})`);
  log(`[bootstrap] Loading Paper ${VERSION}-41-main@a15fed9 (FAKE) for Minecraft ${VERSION}`);
} else if (loader === 'fabric') {
  const gameJar = prop('fabric.gameJarPath') ?? path.join(cwd, 'server.jar');
  if (requireJars && !fs.existsSync(gameJar)) {
    // Measured: the launcher writes its properties file to the working directory and stops.
    fs.writeFileSync(path.join(cwd, 'fabric-server-launcher.properties'), `#${new Date().toString()}\nserverJar=server.jar\n`);
    out(`The Minecraft server .JAR is missing (${gameJar.replace(/\\/g, '/')})!`);
    out('');
    out('Fabric\'s server-side launcher expects the server .JAR to be provided.');
    out('You can edit its location in fabric-server-launcher.properties.');
    out('');
    out('Without the official Minecraft server .JAR, Fabric Loader cannot launch.');
    err('Exception in thread "main" java.lang.RuntimeException: Failed to setup Fabric server environment!');
    process.exit(1);
  }
  out('Starting net.fabricmc.loader.impl.game.minecraft.BundlerClassPathCapture');
  bundler();
  log(`Loading Minecraft ${VERSION} with Fabric Loader 0.19.5`, 'INFO', 'main');
} else {
  bundler();
  out('Starting net.minecraft.server.Main');
}
err('WARNING: A terminally deprecated method in sun.misc.Unsafe has been called');
fs.mkdirSync(path.join(cwd, 'logs'), { recursive: true });
logFile = path.join(cwd, 'logs', 'latest.log');
fs.writeFileSync(logFile, '');
if (loader === 'paper') fs.mkdirSync(path.join(cwd, 'plugins'), { recursive: true });
if (loader === 'fabric') fs.mkdirSync(path.join(cwd, 'mods'), { recursive: true });

loadProps();
if (!eulaAccepted()) {
  log('You need to agree to the EULA in order to run the server. Go to eula.txt for more info.', 'INFO', MAIN);
  process.exit(0); // measured: it neither waits nor fails
}
for (const n of Object.keys(lists)) {
  lists[n] = readList(n);
  if (!fs.existsSync(listFile(n))) writeList(n);
}
const fresh = !fs.existsSync(path.join(worldDir(), 'level.dat'));
log('Environment: Environment[discoveryUrl=https://discovery.minecraftservices.com/minecraft/client, name=PROD]', 'INFO', MAIN);
if (fresh) log('No existing world data, creating new world', 'INFO', 'Worker-Main-2');
log(`Starting minecraft server version ${VERSION}`);
log('Loading properties');
if (loader === 'paper') log(`This server is running Paper version ${VERSION}-41-main@a15fed9 (FAKE) (Implementing API version ${VERSION}.build.41-alpha)`);
log('Default game type: SURVIVAL');
log('Generating keypair');
const gamePort = Number(props['server-port']) || 25565;
log(`Starting Minecraft server on ${props['server-ip'] || '*'}:${gamePort}`);

function bindFailure(message) {
  log('**** FAILED TO BIND TO PORT!', 'WARN');
  log(`The exception was: ${message}`, 'WARN');
  log('Perhaps a server is already running on that port?', 'WARN');
  crash('java.lang.IllegalStateException: Failed to initialize server');
}
if (scenario === 'crash-on-boot') {
  bindFailure('io.netty.channel.unix.Errors$NativeIoException: bind(..) failed with error(-98): Address already in use');
} else {
  if (env.FAKE_MC_BIND_GAME_PORT === '1') {
    gameServer = net.createServer((s) => s.destroy());
    const bound = await new Promise((r) => {
      gameServer.once('error', (e) => r(e));
      gameServer.listen(gamePort, bindHost, () => r(null));
    });
    if (bound) {
      bindFailure(`io.netty.channel.unix.Errors$NativeIoException: bind(..) failed with error(-98): ${bound.code === 'EADDRINUSE' ? 'Address already in use' : bound.message}`);
      await sleep(1000);
    }
  }
  if (props['online-mode'] === 'false') {
    log('**** SERVER IS RUNNING IN OFFLINE/INSECURE MODE!', 'WARN');
    log('The server will make no attempt to authenticate usernames. Beware.', 'WARN');
  }
  log(`Preparing level "${props['level-name'] || 'world'}"`);
  if (scenario === 'blocking-prompt') {
    // No 26.3 loader was seen waiting for console input (without the EULA it exits); this models a
    // server stuck before readiness on something nobody will type, for the agent's generic path.
    log('FAKE: waiting for console input that nobody will type (no real 26.3 server does this)', 'WARN');
  } else if (scenario !== 'never-ready') {
    await sleep(bootMs);
    for (const d of ['overworld', 'the_nether', 'the_end']) fs.mkdirSync(path.join(worldDir(), 'dimensions', 'minecraft', d, 'region'), { recursive: true });
    fs.writeFileSync(path.join(worldDir(), 'session.lock'), '☃');
    if (fresh) saveWorld();
    log('Loading 0 persistent chunks...');
    log('Preparing spawn area: 100%');
    log(`Time elapsed: ${bootMs} ms`);
    // Measured: Paper opens RCON before its ready line, vanilla and Fabric right after it.
    if (loader === 'paper' && props['enable-rcon'] === 'true') await startRcon();
    log(`Done (${(bootMs / 1000 + 0.01).toFixed(3)}s)! For help, type "help"`);
    ready = true;
    if (loader !== 'paper' && props['enable-rcon'] === 'true') void startRcon();
    for (const name of (env.FAKE_MC_PLAYERS ?? '').split(',').filter(Boolean)) join(name);
    for (const line of early.splice(0)) consoleReply(run(line, 'console'));
    if (scenario === 'crash-after-ready') setTimeout(() => crash('java.lang.IllegalStateException: FAKE crash after ready'), Number(env.FAKE_MC_CRASH_MS ?? 500));
  }
}
