#!/usr/bin/env node
// A stand-in for a Terraria dedicated server (vanilla, TShock or tModLoader), for agent/panel tests
// and the dev loop without the game, Mono or .NET. It prints the lines, answers the console
// commands, writes the files and (TShock) serves the REST API measured on 1.4.5.8, TShock 6.2.1
// and tModLoader v2026.07.3.0 (docs/verification/terraria-1.4.5.8.md, fixtures/terraria/1.4.5.8/),
// and is a separate implementation from the code under test on purpose.
//
// It takes the place of the game binary, so the adapter's own argument list works unchanged:
//   node server.mjs -port 7777 -world /data/worlds/w.wld -autocreate 1 -worldname w -savedirectory /data …
//   node server.mjs … -configpath /data/tshock --rest-enabled true --rest-port 7878       (TShock)
//   node server.mjs [/opt/game/…/tModLoader.dll] -server -nosteam -tmlsavedirectory /data/tml …  (tModLoader)
//
// Flavour: FAKE_TERRARIA_FLAVOUR (vanilla | tshock | tmodloader), else GAME_FLAVOUR, else guessed
// from the arguments (-configpath or --rest-* → TShock; -server, -tmlsavedirectory or a
// tModLoader.dll → tModLoader).
// Scenarios (FAKE_TERRARIA_SCENARIO): normal | crash-after-ready | crash-on-boot | blocking-prompt |
//   never-ready | ignore-stop
// Tuning: FAKE_TERRARIA_BOOT_MS (default 300), FAKE_TERRARIA_CRASH_MS (500), FAKE_TERRARIA_PLAYERS
//   ("a,b": online at boot), FAKE_TERRARIA_BIND_HOST (127.0.0.1), FAKE_TERRARIA_BIND_GAME_PORT=1
//   (also listen on the game port, so a taken port fails like the real server).
// Test hooks on stdin (not real commands): fake-join <name>, fake-leave <name>, fake-crash.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';

const env = process.env;
let argv = process.argv.slice(2);
// `dotnet tModLoader.dll …` with the launcher standing in for dotnet: the dll comes first.
const dll = argv[0]?.endsWith('.dll') ? argv.shift() : null;
const has = (f) => argv.includes(f);
const arg = (...names) => {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  }
  return undefined;
};

const flavour = (() => {
  const v = env.FAKE_TERRARIA_FLAVOUR ?? env.GAME_FLAVOUR;
  if (v === 'vanilla' || v === 'tshock' || v === 'tmodloader') return v;
  if (has('-configpath') || argv.some((a) => /^--?rest-/.test(a))) return 'tshock';
  if (has('-server') || has('-tmlsavedirectory') || /tModLoader\.dll$/i.test(dll ?? '')) return 'tmodloader';
  return 'vanilla';
})();
const tshock = flavour === 'tshock';
const tml = flavour === 'tmodloader';

const TERRARIA = tml ? '1.4.4.9' : '1.4.5.8';
const TML = '2026.7.3.0';
const TSHOCK = '6.2.1.0';
const scenario = env.FAKE_TERRARIA_SCENARIO ?? 'normal';
const bootMs = Number(env.FAKE_TERRARIA_BOOT_MS ?? 300);
const bindHost = env.FAKE_TERRARIA_BIND_HOST ?? '127.0.0.1';
const cwd = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (l) => process.stdout.write(`${l}\n`);
const err = (l) => process.stderr.write(`${l}\n`);
/** The console prompt: printed without a newline, so the next line the game prints starts with it (measured). */
const prompt = () => process.stdout.write(': ');
const header = `Terraria Server v${TERRARIA}`;

// ------------------------------------------------------------------ settings (flags, then -config)
/** serverconfig.txt: key=value lines, # comments; the game never writes it. */
function readConfig(file) {
  const map = {};
  if (!file) return map;
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([a-z_]+)=(.*)$/.exec(raw.trim());
      if (m) map[m[1]] = m[2];
    }
  } catch {
    // measured: a missing -config file is not an error
  }
  return map;
}
const cfg = readConfig(arg('-config'));
const port = Number(arg('-port') ?? cfg.port ?? 7777);
let maxPlayers = Number(arg('-maxplayers', '-players') ?? cfg.maxplayers ?? (tshock ? 8 : 16));
let password = arg('-password', '-pass') ?? cfg.password ?? '';
let motd = arg('-motd') ?? cfg.motd ?? '';
const banlist = arg('-banlist') ?? cfg.banlist;
const autocreate = Number(arg('-autocreate') ?? cfg.autocreate ?? 0);
const saveDir = tml ? (arg('-tmlsavedirectory') ?? path.join(env.HOME ?? cwd, '.local/share/Terraria/tModLoader')) : (arg('-savedirectory') ?? path.join(env.HOME ?? cwd, '.local/share/Terraria'));
const worldName = arg('-worldname') ?? cfg.worldname ?? 'World';
// tModLoader creates an autocreated world in <save dir>/Worlds, whatever -world says (measured)
let worldFile = arg('-world') ?? cfg.world ?? null;
if (tml && worldFile && autocreate && !fs.existsSync(worldFile)) worldFile = path.join(saveDir, 'Worlds', `${worldName}.wld`);
const seed = arg('-seed') ?? cfg.seed ?? String(crypto.randomInt(1, 2 ** 31 - 1));
const difficulty = Number(cfg.difficulty ?? 0);
const configPath = arg('-configpath') ?? path.join(cwd, 'tshock');

// ------------------------------------------------------------------ players
/** online players by lower-case name: { name, ip, port, uuid } */
const online = new Map();
const nextPort = () => 30000 + crypto.randomInt(0, 30000);
function join(name, ip = '192.0.2.1') {
  const p = { name, ip, port: nextPort(), uuid: crypto.randomUUID() };
  out(`${ip}:${p.port} is connecting...`);
  if (tshock && bans.some((b) => b.identifier === `name:${name}` || b.identifier === `ip:${ip}`)) {
    const b = bans.find((x) => x.identifier === `name:${name}` || x.identifier === `ip:${ip}`);
    out(`${ip}:${p.port} was booted: #${b.ticket} - You are banned: ${b.reason}`);
    return false;
  }
  if (!tshock && banlist && readBanlist().includes(ip)) {
    out(`${ip}:${p.port} was booted: You are banned from this server.`);
    return false;
  }
  online.set(name.toLowerCase(), p);
  out(`${name} has joined.`);
  if (tshock) out(`${name} has joined. IP: ${ip}`);
  return true;
}
function leave(name, bootReason = null) {
  const p = online.get(name.toLowerCase());
  if (!p) return false;
  online.delete(name.toLowerCase());
  if (bootReason) out(`${p.ip}:${p.port} was booted: ${bootReason}`);
  out(`${p.name} has left.`);
  // measured: the world is saved when the server becomes empty (TShock: SaveWorldOnLastPlayerExit)
  if (!online.size && ready) saveWorld(false);
  return true;
}

// ------------------------------------------------------------------ world files
const WORLD_MAGIC = 'FAKE-TERRARIA-WORLD';
const sizes = { 1: [4200, 1200], 2: [6400, 1800], 3: [8400, 2400] };
function worldBytes() {
  return `${WORLD_MAGIC}\nname=${worldName}\nseed=${seed}\nsaved=${new Date().toISOString()}\n`;
}
/**
 * A save as measured: read the old file, write the new one in place (not atomic), validate it,
 * then (`backup`) rotate .bak → .bak2 and write the old bytes to .bak. Returns the backup step.
 */
function writeWorldFile(file, bytes) {
  const old = fs.existsSync(file) ? fs.readFileSync(file) : null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return () => {
    if (!old) return;
    if (fs.existsSync(`${file}.bak`)) fs.renameSync(`${file}.bak`, `${file}.bak2`);
    fs.writeFileSync(`${file}.bak`, old);
  };
}
function saveWorld(announcePrompt = true) {
  if (!worldFile || !worldLoaded) return;
  if (tshock) {
    out('Saving world data:');
    out('');
  } else for (const p of [20, 43, 62, 83, 100]) out(`Saving world data: ${p}%`);
  const backup = writeWorldFile(worldFile, worldBytes());
  if (tshock) out('Validating world save:');
  else for (const p of [38, 97]) out(`Validating world save: ${p}%`);
  // measured: the .wld is complete when "Backing up world file" (tModLoader: "Saving modded world data") is printed
  if (tml) {
    backup();
    out('Saving modded world data');
    writeWorldFile(worldFile.replace(/\.wld$/, '.twld'), `FAKE-TMOD-WORLD-DATA ${worldName}\n`)();
  } else {
    out('Backing up world file');
    backup();
  }
  if (tshock) tlog(`SaveManager: INFO: World saved at (${worldFile})`);
  if (announcePrompt) prompt();
}

// ------------------------------------------------------------------ vanilla ban list (IP bans, name as a comment)
function readBanlist() {
  try {
    return fs.readFileSync(banlist, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('//'));
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ TShock: config, database, logs, REST
const TSHOCK_DEFAULTS = JSON.parse('{"ServerPassword":"","ServerPort":7777,"MaxSlots":8,"ReservedSlots":20,"ServerName":"","UseServerName":false,"LogPath":"tshock/logs","DebugLogs":false,"DisableLoginBeforeJoin":false,"IgnoreChestStacksOnLoad":false,"WorldTileProvider":"constileation","AutoSave":true,"AnnounceSave":false,"ShowBackupAutosaveMessages":true,"BackupInterval":10,"BackupKeepFor":240,"SaveWorldOnCrash":true,"SaveWorldOnLastPlayerExit":true,"InvasionMultiplier":1,"DefaultMaximumSpawns":5,"DefaultSpawnRate":600,"InfiniteInvasion":false,"PvPMode":"normal","SpawnProtection":false,"SpawnProtectionRadius":10,"RangeChecks":false,"HardcoreOnly":false,"MediumcoreOnly":false,"SoftcoreOnly":false,"DisableBuild":false,"DisableHardmode":false,"DisableDungeonGuardian":false,"DisableClownBombs":false,"DisableSnowBalls":false,"DisableTombstones":false,"DisablePrimeBombs":false,"ForceTime":"normal","DisableInvisPvP":false,"MaxRangeForDisabled":10,"RegionProtectChests":false,"RegionProtectGemLocks":true,"IgnoreProjUpdate":false,"IgnoreProjKill":false,"AllowCutTilesAndBreakables":false,"AllowIce":false,"AllowCrimsonCreep":true,"AllowCorruptionCreep":true,"AllowHallowCreep":true,"StatueSpawn200":3,"StatueSpawn600":6,"StatueSpawnWorld":10,"PreventBannedItemSpawn":false,"PreventDeadModification":true,"PreventInvalidPlaceStyle":true,"ForceXmas":false,"ForceHalloween":false,"AllowAllowedGroupsToSpawnBannedItems":false,"RespawnSeconds":0,"RespawnBossSeconds":0,"AnonymousBossInvasions":true,"MaxHP":500,"MaxMP":200,"BombExplosionRadius":5,"GiveItemsDirectly":false,"DefaultRegistrationGroupName":"default","DefaultGuestGroupName":"guest","RememberLeavePos":false,"MaximumLoginAttempts":3,"KickOnMediumcoreDeath":false,"MediumcoreKickReason":"Death results in a kick","BanOnMediumcoreDeath":false,"MediumcoreBanReason":"Death results in a ban","DisableDefaultIPBan":false,"EnableWhitelist":false,"WhitelistKickReason":"You are not on the whitelist.","ServerFullReason":"Server is full","ServerFullNoReservedReason":"Server is full. No reserved slots open.","KickOnHardcoreDeath":false,"HardcoreKickReason":"Death results in a kick","BanOnHardcoreDeath":false,"HardcoreBanReason":"Death results in a ban","KickProxyUsers":true,"RequireLogin":false,"AllowLoginAnyUsername":true,"AllowRegisterAnyUsername":false,"MinimumPasswordLength":4,"BCryptWorkFactor":7,"DisableUUIDLogin":false,"KickEmptyUUID":true,"TilePaintThreshold":200,"KickOnTilePaintThresholdBroken":false,"MaxDamage":20000,"MaxProjDamage":20000,"KickOnDamageThresholdBroken":false,"TileKillThreshold":200,"KickOnTileKillThresholdBroken":false,"TilePlaceThreshold":200,"KickOnTilePlaceThresholdBroken":false,"TileLiquidThreshold":200,"KickOnTileLiquidThresholdBroken":false,"ProjIgnoreShrapnel":true,"ProjectileThreshold":200,"KickOnProjectileThresholdBroken":false,"HealOtherThreshold":200,"KickOnHealOtherThresholdBroken":false,"SuppressPermissionFailureNotices":false,"DisableModifiedZenith":false,"DisableCustomDeathMessages":true,"CommandSpecifier":"/","CommandSilentSpecifier":".","MaximumChatMessageLength":500,"TruncateExcessiveChatMessages":false,"DisableSpewLogs":true,"DisableSecondUpdateLogs":false,"SuperAdminChatRGB":[255,255,255],"SuperAdminChatPrefix":"(Super Admin) ","SuperAdminChatSuffix":"","EnableGeoIP":true,"DisplayIPToAdmins":true,"ChatFormat":"{1}{2}{3}: {4}","ChatAboveHeadsFormat":"{2}","EnableChatAboveHeads":true,"BroadcastRGB":[127,255,212],"StorageType":"sqlite","SqliteConnectionString":"","SqliteDBPath":"tshock.sqlite","MySqlConnectionString":"","MySqlHost":"localhost:3306","MySqlDbName":"","MySqlUsername":"","MySqlPassword":"","PostgresConnectionString":"","PostgresHost":"","PostgresDbName":"","PostgresUsername":"","PostgresPassword":"","UseSqlLogs":false,"RevertToTextLogsOnSqlFailures":10,"RestApiEnabled":false,"RestApiPort":7878,"LogRest":false,"EnableTokenEndpointAuthentication":false,"RESTMaximumRequestsPerInterval":5,"RESTRequestBucketDecreaseIntervalMinutes":1,"ApplicationRestTokens":{}}');
let settings = { ...TSHOCK_DEFAULTS };
/** tokens: token → user name */
const restTokens = new Map();
let bans = [];
let nextTicket = 1;
let users = [];
let tlogFile = null;
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
/** A line in TShock's own log file (tshock/logs/<date>.log), not on the console. */
const tlog = (msg) => tlogFile && fs.appendFileSync(tlogFile, `${stamp()} - ${msg}\n`);
const cfgFile = () => path.join(configPath, 'config.json');
/** Read config.json, complete it with the defaults, drop unknown keys, and write it back as TShock does at boot. */
function loadTshockConfig() {
  let given = {};
  try {
    given = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')).Settings ?? {};
  } catch {
    given = {};
  }
  settings = Object.fromEntries(Object.entries(TSHOCK_DEFAULTS).map(([k, v]) => [k, k in given ? given[k] : v]));
  fs.mkdirSync(configPath, { recursive: true });
  // measured: 2-space indent, no final newline, unknown keys gone
  fs.writeFileSync(cfgFile(), JSON.stringify({ Settings: settings }, null, 2));
}
const dbFile = () => path.join(configPath, settings.SqliteDBPath || 'tshock.sqlite');
async function openDb() {
  // A real SQLite file (journal mode "delete", as measured), so hot-backup snapshots work on it.
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile());
    db.exec('CREATE TABLE IF NOT EXISTS Users (ID INTEGER PRIMARY KEY, Username TEXT UNIQUE, Password TEXT, UUID TEXT, Usergroup TEXT, Registered TEXT, LastAccessed TEXT, KnownIPs TEXT)');
    db.exec('CREATE TABLE IF NOT EXISTS PlayerBans (TicketNumber INTEGER PRIMARY KEY, Identifier TEXT, Reason TEXT, BanningUser TEXT, Date INTEGER, Expiration INTEGER)');
    return db;
  } catch {
    return null;
  }
}
let db = null;
function persist() {
  if (!db) return;
  db.exec('DELETE FROM Users; DELETE FROM PlayerBans;');
  const u = db.prepare('INSERT INTO Users (ID, Username, Usergroup) VALUES (?, ?, ?)');
  for (const x of users) u.run(x.id, x.name, x.group);
  const b = db.prepare('INSERT INTO PlayerBans (TicketNumber, Identifier, Reason, BanningUser, Date, Expiration) VALUES (?, ?, ?, ?, ?, ?)');
  for (const x of bans) b.run(x.ticket, x.identifier, x.reason, x.by, x.start, x.end);
}
function loadDb() {
  if (!db) return;
  users = db.prepare('SELECT ID AS id, Username AS name, Usergroup AS "group" FROM Users').all();
  // .NET ticks are beyond JavaScript's safe integers: read them as BigInts (node:sqlite refuses them as numbers), then
  // as the numbers the rest of the fake uses.
  const read = db.prepare('SELECT TicketNumber AS ticket, Identifier AS identifier, Reason AS reason, BanningUser AS "by", Date AS start, Expiration AS "end" FROM PlayerBans');
  read.setReadBigInts(true);
  bans = read.all().map((b) => ({ ...b, ticket: Number(b.ticket), start: Number(b.start), end: Number(b.end) }));
  nextTicket = Math.max(0, ...bans.map((b) => b.ticket)) + 1;
}
const TICKS_FOREVER = 3155378976000000000;
const nowTicks = () => Date.now() * 10000 + 621355968000000000;
function addBan(identifier, reason, by) {
  const b = { ticket: nextTicket++, identifier, reason: reason || 'Banned', by, start: nowTicks(), end: TICKS_FOREVER };
  bans.push(b);
  persist();
  return b;
}
const GROUPS = [
  { name: 'guest', parent: '', chatcolor: '255,255,255' },
  { name: 'default', parent: 'guest', chatcolor: '255,255,255' },
  { name: 'vip', parent: 'default', chatcolor: '255,128,0' },
  { name: 'newadmin', parent: 'vip', chatcolor: '255,255,255' },
  { name: 'admin', parent: 'newadmin', chatcolor: '255,255,255' },
  { name: 'trustedadmin', parent: 'admin', chatcolor: '255,255,255' },
  { name: 'owner', parent: 'trustedadmin', chatcolor: '255,255,255' },
  { name: 'superadmin', parent: '', chatcolor: '255,255,255' },
];

let restServer = null;
/** TShock's REST API as measured: GET with query parameters, JSON answers with a string "status". */
function startRest(restPort) {
  const json = (res, status, body) => {
    const buf = Buffer.from(JSON.stringify({ status: String(status), ...body }));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
    res.end(buf);
  };
  restServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const q = (k) => url.searchParams.get(k);
    const p = url.pathname;
    const token = q('token');
    const user = token !== null ? restTokens.get(token) : undefined;
    // What TShock logs for each request (LogRest): the endpoint and query without the token.
    const shown = `${p}${[...url.searchParams.entries()].filter(([k]) => k !== 'token').length ? `?${[...url.searchParams.entries()].filter(([k]) => k !== 'token').map(([k, v]) => `${k}=${v}`).join('&')}` : ''}`;
    const logRest = (who) => settings.LogRest && out(`${who} requested REST endpoint: ${shown}`);
    const status = () => ({
      name: settings.ServerName,
      serverversion: `v${TERRARIA}`,
      tshockversion: TSHOCK,
      port,
      playercount: online.size,
      maxplayers: maxPlayers,
      world: worldName,
      uptime: '0.00:00:10',
      serverpassword: Boolean(password || settings.ServerPassword),
      ...(q('players') === 'true' ? { players: [...online.values()].map((x) => ({ nickname: x.name, username: '', group: 'guest', active: true, state: 10, team: 1 })) } : {}),
      ...(q('rules') === 'true' ? { rules: { AutoSave: settings.AutoSave, DisableBuild: settings.DisableBuild, DisableClownBombs: settings.DisableClownBombs } } : {}),
    });
    // anonymous endpoints
    if (p === '/status' || p === '/v2/server/status') {
      logRest('Anonymous');
      return json(res, 200, status());
    }
    if (p === '/v2/token/create') return json(res, 403, { error: 'Username or password may be incorrect or this account may not have sufficient privileges.' });
    if (!user) return json(res, 403, { error: 'Not authorized. The specified API endpoint requires a token, but the provided token was not valid.' });
    logRest(`"${user}"`);
    const player = () => online.get(String(q('player') ?? '').toLowerCase());
    switch (p) {
      case '/tokentest':
        return json(res, 200, { response: 'Token is valid and was passed through correctly.', associateduser: user });
      case '/v2/players/list':
        return json(res, 200, { players: [...online.values()].map((x) => ({ nickname: x.name, username: '', group: 'guest', active: true, state: 10, team: 1 })) });
      case '/v3/players/read':
      case '/v4/players/read': {
        const x = player();
        if (!x) return json(res, 400, { error: `Player ${q('player')} was not found` });
        return json(res, 200, { nickname: x.name, username: null, ip: x.ip, group: 'guest', registered: null, muted: false, position: '2096,245' });
      }
      case '/v2/players/kick': {
        const x = player();
        if (!x) return json(res, 400, { error: `Player ${q('player')} was not found` });
        const reason = q('reason') ?? 'Kicked via web';
        leave(x.name, `Kicked: ${reason}`);
        out(`Kicked ${x.name} for : '${reason}'`);
        return json(res, 200, { response: `Player ${x.name} was kicked` });
      }
      case '/v3/bans/create': {
        const id = q('identifier');
        if (!id) return json(res, 400, { error: 'Missing or empty identifier parameter' });
        addBan(id, q('reason'), user);
        // measured on 6.2.1: the ban is stored, then the reply is a 500 (a null reference while it
        // looks for matching players) whenever players are online; it does not kick them
        if (online.size) return json(res, 500, { error: 'Internal server error.', errormsg: 'Object reference not set to an instance of an object.', stacktrace: '   at TShockAPI.RestManager.BanCreateV3(RestRequestArgs args) (FAKE)' });
        return json(res, 200, { response: 'Ban added.' });
      }
      case '/v3/bans/list':
        return json(res, 200, { bans: bans.map((b) => ({ ticket_number: b.ticket, identifier: b.identifier, reason: b.reason, banning_user: b.by, start_date_ticks: b.start, end_date_ticks: b.end })) });
      case '/v3/bans/read': {
        const n = q('ticketNumber');
        if (!n) return json(res, 400, { error: 'Missing or empty ticketNumber parameter' });
        const b = bans.find((x) => String(x.ticket) === n);
        if (!b) return json(res, 200, { response: 'No matching bans found.' });
        return json(res, 200, { ticket_number: b.ticket, identifier: b.identifier, reason: b.reason, banning_user: b.by, start_date_ticks: b.start, end_date_ticks: b.end });
      }
      case '/v3/bans/destroy': {
        const n = q('ticketNumber');
        if (!n) return json(res, 400, { error: 'Missing or empty ticketNumber parameter' });
        const i = bans.findIndex((x) => String(x.ticket) === n);
        if (i < 0) return json(res, 500, { error: 'Internal server error.', errormsg: `The given key '${n}' was not present in the dictionary.` });
        bans.splice(i, 1);
        persist();
        return json(res, 200, { response: 'Ban removed.' });
      }
      case '/v2/server/broadcast': {
        const msg = q('msg');
        if (!msg) return json(res, 400, { error: 'Missing or empty msg parameter' });
        out(`(Server Broadcast) ${msg}`);
        return json(res, 200, { response: 'The message was broadcasted successfully' });
      }
      case '/v3/server/rawcmd': {
        const cmd = q('cmd') ?? '';
        if (!cmd.startsWith('/')) return json(res, 200, { response: ['Invalid command entered. Type /help for a list of valid commands.'] });
        out(`${user} executed: ${cmd}.`);
        return json(res, 200, { response: runTshock(cmd.slice(1), { quiet: true, colored: true }) });
      }
      case '/v2/world/save':
        saveWorld(false);
        return json(res, 200, { response: 'World saved' });
      case '/v2/server/off': {
        if (q('confirm') !== 'true') return json(res, 400, { error: 'Missing or invalid confirm parameter' });
        const message = q('message') ?? 'Server shutting down!';
        json(res, 200, { response: 'The server is shutting down' });
        setImmediate(() => shutdown(q('nosave') !== 'true', message));
        return undefined;
      }
      case '/v2/users/list':
        return json(res, 200, { users: users.map((u) => ({ name: u.name, id: u.id, group: u.group })) });
      case '/v2/users/create': {
        const name = q('user');
        if (!name || !q('password')) return json(res, 400, { error: 'Missing or empty user parameter' });
        users.push({ id: Math.max(0, ...users.map((u) => u.id)) + 1, name, group: q('group') ?? settings.DefaultRegistrationGroupName });
        persist();
        return json(res, 200, { response: 'User was successfully created' });
      }
      case '/v2/users/read':
      case '/v2/users/update':
      case '/v2/users/destroy': {
        const u = users.find((x) => x.name === q('user'));
        if (!u) return json(res, 400, { error: `User ${q('user')} was not found` });
        if (p === '/v2/users/read') return json(res, 200, { group: u.group, id: String(u.id), name: u.name });
        if (p === '/v2/users/update') {
          if (q('group')) u.group = q('group');
          persist();
          return json(res, 200, { 'group-response': 'Group updated successfully' });
        }
        users = users.filter((x) => x !== u);
        persist();
        return json(res, 200, { response: 'User deleted successfully' });
      }
      case '/v2/groups/list':
        return json(res, 200, { groups: GROUPS });
      case '/v2/players/mute': {
        const x = player();
        if (!x) return json(res, 400, { error: `Player ${q('player')} was not found` });
        return json(res, 200, { response: `Player ${x.name} has been muted` });
      }
      default:
        return json(res, 404, { error: `Specified API endpoint doesn't exist. Refer to the documentation for a list of valid endpoints.` });
    }
  });
  // A taken REST port is not fatal for the game (unmeasured; the fake just goes on without it).
  return new Promise((resolve) => {
    restServer.once('error', () => resolve());
    restServer.listen(restPort, bindHost, () => resolve());
  });
}

// ------------------------------------------------------------------ console commands
const VANILLA_HELP = [
  'Available commands:', '',
  'help\t\tDisplays a list of commands.', 'playing\t\tShows the list of players.', 'clear\t\tClear the console window.', 'exit\t\tShutdown the server and save.',
  'exit-nosave\tShutdown the server without saving.', 'save\t\tSave the game world.', 'kick <player>\tKicks a player from the server.', 'ban <player>\tBans a player from the server.',
  'password\tShow password.', 'password <pass>\tChange password.', 'version\t\tPrint version number.', 'time\t\tDisplay game time.', 'port\t\tPrint the listening port.',
  'maxplayers\tPrint the max number of players.', 'say <words>\tSend a message.', 'motd\t\tPrint MOTD.', 'motd <words>\tChange MOTD.', 'dawn\t\tChange time to dawn.',
  'noon\t\tChange time to noon.', 'dusk\t\tChange time to dusk.', 'midnight\tChange time to midnight.', 'settle\t\tSettle all water.', 'seed\t\tDisplays the world seed.',
];
const TML_HELP = [...VANILLA_HELP, 'customsets\tDisplays a list of named ID sets.', 'modlist\t\tDisplays a list of loaded mods.'];

/** vanilla and tModLoader: the game's own console. Returns false when the server stops. */
function runVanilla(line) {
  const text = line.trim();
  const [cmd = ''] = text.split(/\s+/);
  const tail = text.slice(cmd.length).trim();
  switch (cmd.toLowerCase()) {
    case 'help':
      for (const l of tml ? TML_HELP : VANILLA_HELP) out(l);
      break;
    case 'playing':
      for (const p of online.values()) out(`${p.name} (${p.ip}:${p.port})`);
      out(online.size === 0 ? 'No players connected.' : online.size === 1 ? '1 player connected.' : `${online.size} players connected.`);
      break;
    case 'clear':
    case 'dawn':
    case 'noon':
    case 'dusk':
    case 'midnight':
      break;
    case 'version':
      out(tml ? `${header} - tModLoader v${TML}` : header);
      break;
    case 'time':
      out('Time: 8:15 AM');
      break;
    case 'port':
      out(`Port: ${port}`);
      break;
    case 'maxplayers':
      out(`Player limit: ${maxPlayers}`);
      break;
    case 'seed':
      out(`World Seed: 1.1.2.0.${seed}`);
      break;
    case 'settle':
      out('Forcing water to settle.');
      break;
    case 'motd':
      if (tail) motd = tail;
      else out(`MOTD: ${motd}`);
      break;
    case 'password':
      // measured: the console prints the password in clear text
      if (tail) password = tail;
      out(password ? `Password: ${password}` : 'No password set.');
      break;
    case 'say':
      out(`<Server> ${tail}`);
      break;
    case 'kick': {
      const p = online.get(tail.toLowerCase());
      if (p) leave(p.name, 'Kicked from server.');
      break;
    }
    case 'ban': {
      // measured: without a writable -banlist the ban throws and the console says "Invalid command."
      if (!banlist) {
        out('Invalid command.');
        break;
      }
      const p = online.get(tail.toLowerCase());
      if (!p) break;
      try {
        fs.appendFileSync(banlist, `//${p.name}\n${p.ip}\n`);
      } catch {
        out('Invalid command.');
        break;
      }
      leave(p.name, 'Banned from server.');
      break;
    }
    case 'modlist':
      if (tml) {
        for (const m of mods) out(m.display);
        break;
      }
      out('Invalid command.');
      break;
    case 'customsets':
      if (tml) break;
      out('Invalid command.');
      break;
    case 'save':
      saveWorld(false);
      break;
    case 'exit':
      stop(true);
      return false;
    case 'exit-nosave':
      stop(false);
      return false;
    default:
      if (!hook(cmd, tail)) out('Invalid command.');
  }
  prompt();
  return true;
}

/** TShock: every console line is a TShock command (with or without its "/"). */
function runTshock(line, o = {}) {
  const text = line.trim().replace(/^\//, '');
  const [cmd = '', ...rest] = text.split(/\s+/);
  const tail = text.slice(cmd.length).trim();
  const lines = [];
  const say = (l) => (o.quiet ? lines.push(l) : out(l));
  const known = ['help', 'playing', 'who', 'online', 'version', 'time', 'motd', 'say', 'broadcast', 'bc', 'kick', 'ban', 'save', 'exit', 'off', 'off-nosave', 'serverpassword', 'setup'];
  if (!known.includes(cmd.toLowerCase()) && !cmd.startsWith('fake-')) {
    say('Invalid command entered. Type /help for a list of valid commands.');
    return lines;
  }
  if (cmd === 'setup') {
    say('You must use this command in-game.');
    return lines;
  }
  if (!o.quiet && !cmd.startsWith('fake-')) {
    out(`Server executed: /${text}.`);
    tlog(`Utils: INFO: Server executed: /${text}.`);
  }
  switch (cmd.toLowerCase()) {
    case 'help':
      say('Commands (1/4):');
      say('/setup, /user, /login, /logout, /password, /register, /accountinfo, /ban, ');
      say('/broadcast, /displaylogs, /group, /itemban, /projban, /tileban, /region, ');
      say('/kick, /mute, /overridessc, /savessc, /uploadssc, /tempgroup, /su, /sudo, ');
      say('/userinfo, /annoy, /rocket, /firework, /checkupdates, /off, /off-nosave, ');
      say('Type /help 2 for more.');
      break;
    case 'playing':
    case 'who':
    case 'online':
      if (!online.size) say('There are currently no players online.');
      else {
        say(o.colored ? `Online Players ([c/AAFFAA:${online.size}]/${maxPlayers})` : `Online Players (${online.size}/${maxPlayers})`);
        say([...online.values()].map((p) => p.name).join(', '));
      }
      break;
    case 'version':
      say(`TShock: ${TSHOCK} Profoundly Collaborative (3.11).`);
      break;
    case 'time':
      say('The current time is 8:15.');
      break;
    case 'motd':
      say(`Welcome to ${worldName} on TShock for Terraria.`);
      say(`Online players (${online.size}/${maxPlayers}): [c/FFFF00:${[...online.values()].map((p) => p.name).join(', ')}]`);
      say('Type /help for a list of commands.');
      break;
    case 'say':
    case 'broadcast':
    case 'bc':
      say(`(Server Broadcast) ${tail}`);
      tlog(`Utils: INFO: Broadcast: (Server Broadcast) ${tail}`);
      break;
    case 'kick': {
      const [name, ...why] = rest;
      const p = name && online.get(name.toLowerCase());
      if (!p) {
        say('Player not found. Unable to kick the player.');
        break;
      }
      const reason = why.join(' ') || 'Misbehaviour.';
      const pp = online.get(name.toLowerCase());
      online.delete(name.toLowerCase());
      out(`${pp.ip}:${pp.port} was booted: Kicked: ${reason}`);
      out(`Kicked ${pp.name} for : '${reason}'`);
      out(`Server kicked ${pp.name} for '${reason}'`);
      out(`: ${pp.name} has left.`);
      if (!online.size) saveWorld(false);
      break;
    }
    case 'ban': {
      const [sub = '', target = '', ...why] = rest;
      if (sub === 'add') {
        const p = online.get(target.toLowerCase());
        if (!p) {
          say('Could not find the target specified. Check that you have the correct spelling.');
          break;
        }
        const b = addBan(`name:${p.name}`, why.join(' '), 'Server');
        leave(p.name, `#${b.ticket} - You are banned: ${b.reason}`);
      } else if (sub === 'list') {
        say(`Bans (1/1):`);
        for (const b of [...bans].reverse()) say(`[${b.ticket}] ${b.identifier}`);
      } else if (sub === 'del') {
        const i = bans.findIndex((b) => String(b.ticket) === target);
        if (i < 0) say('Command failed, check logs for more details.');
        else {
          bans.splice(i, 1);
          persist();
          say(`Ban ${target} has now been marked as expired.`);
        }
      } else if (sub === 'details') {
        const b = bans.find((x) => String(x.ticket) === target);
        say(b ? `Ban #${b.ticket} - ${b.identifier}: ${b.reason}` : 'No bans found matching the provided ticket number.');
      } else say('Invalid Ban Add syntax. Refer to /ban help add for details on how to use the /ban add command');
      break;
    }
    case 'serverpassword':
      if (!tail) say('Invalid syntax. Proper syntax: /serverpassword "<new password>".');
      else {
        password = tail.replace(/^"|"$/g, '');
        say(`Server password has been changed to: ${password}.`);
      }
      break;
    case 'save':
      saveWorld(false);
      break;
    case 'exit':
    case 'off':
      saveWorld(false);
      setImmediate(() => shutdown(true, 'Server shutting down!'));
      break;
    case 'off-nosave':
      setImmediate(() => shutdown(false, 'Server shutting down!'));
      break;
    default:
      hook(cmd, tail);
  }
  return lines;
}

/** Test hooks (fake-join, fake-leave, fake-crash); true when the line was one. */
function hook(cmd, tail) {
  if (cmd === 'fake-join') join(tail);
  else if (cmd === 'fake-leave') leave(tail);
  else if (cmd === 'fake-crash') setImmediate(crashAfterReady);
  else return false;
  return true;
}

// ------------------------------------------------------------------ lifecycle
let ready = false;
let worldLoaded = false;
let stopping = false;
let gameServer = null;
function close() {
  restServer?.close();
  gameServer?.close();
  if (tshock) {
    try {
      fs.rmSync(path.join(configPath, 'tshock.pid'), { force: true });
    } catch {
      // gone
    }
  }
}
/** vanilla and tModLoader `exit` / `exit-nosave` */
function stop(save) {
  if (scenario === 'ignore-stop') {
    out('Saving before exit...');
    return; // acknowledged, then nothing: the agent must escalate to signals
  }
  if (stopping) return;
  stopping = true;
  if (save) {
    out('Saving before exit...');
    saveWorld(false);
  }
  close();
  setTimeout(() => process.exit(0), 100);
}
/** TShock's /exit, /off and REST /v2/server/off */
function shutdown(save, message) {
  if (scenario === 'ignore-stop') return;
  if (stopping) return;
  stopping = true;
  for (const p of [...online.values()]) {
    out(`${p.ip}:${p.port} was booted: ${message}`);
    online.delete(p.name.toLowerCase());
  }
  out(message);
  tlog(`Utils: INFO: Broadcast: ${message}`);
  if (save) {
    out('Saving before exit...');
    saveWorld(false);
  }
  close();
  setTimeout(() => process.exit(0), 100);
}
/** The unhandled exception measured on vanilla after a burst of reconnects; exit 1. */
function crashAfterReady() {
  out('================');
  out(`${new Date().toLocaleString('en-US')}: Unhandled Exception`);
  out('Thread: 20 [Server Loop Thread]');
  out('Culture: ');
  out('Exception: System.ObjectDisposedException: Cannot access a disposed object.');
  out("Object name: 'System.Net.Sockets.NetworkStream'.");
  out('  at Terraria.Netplay.ServerLoop () [0x00009] in <FAKE>:0 ');
  out('================');
  err('[ERROR] FATAL UNHANDLED EXCEPTION: System.ObjectDisposedException: Cannot access a disposed object.');
  setTimeout(() => process.exit(1), 50);
}
// Measured: vanilla and TShock die at once on SIGTERM without saving (143); tModLoader saves first and exits 0.
process.on('SIGTERM', () => {
  if (tml && !stopping) {
    stopping = true;
    out('Saving before exit...');
    saveWorld(false);
    close();
    setTimeout(() => process.exit(0), 100);
    return;
  }
  process.exit(143);
});

// ------------------------------------------------------------------ stdin
const rl = readline.createInterface({ input: process.stdin });
const early = [];
let menu = false;
rl.on('line', (line) => {
  if (menu) {
    // the world menu takes nothing the agent would type: it shows itself again
    worldMenu();
    return;
  }
  if (!ready) return void early.push(line); // lines typed before the server is up wait for it
  if (tshock) runTshock(line);
  else runVanilla(line);
});
// Measured: stdin reaching its end changes nothing; the server keeps running (and so does the menu).
setInterval(() => undefined, 1 << 30);

let headerPrinted = false;
function worldMenu() {
  if (!headerPrinted || menu) {
    out(tml ? `${header} - tModLoader v${TML}` : header);
    out('');
  }
  menu = true;
  if (tml) {
    let n = 0;
    for (const f of fs.existsSync(path.join(saveDir, 'Worlds')) ? fs.readdirSync(path.join(saveDir, 'Worlds')) : []) if (f.endsWith('.wld')) out(`${++n}\t\t${f.slice(0, -4)}`);
  }
  out('n\t\tNew World');
  out('d <number>\tDelete World');
  if (tml) out('m\t\tMods List');
  out('');
  process.stdout.write('Choose World: ');
}

// ------------------------------------------------------------------ tModLoader mods
/**
 * The version folder tModLoader 2026.7 takes from a Workshop item (measured in its server.log):
 * the newest one not built for a newer tModLoader ("Skipped … Reason: a newer version exists." for
 * the others) and not of the 1.4.3 line, 2022.9 and older ("… for a different Terraria
 * version/LTS release stream.").
 */
function pickFolder(folders) {
  const v = (f) => f.split('.').map(Number);
  const le = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
  const mine = v(TML.split('.').slice(0, 2).join('.'));
  return folders
    .filter((f) => /^\d{4}\.\d+$/.test(f))
    .sort((a, b) => (le(v(a), v(b)) ? 1 : -1))
    .find((f) => le(v(f), mine) && !le(v(f), [2022, 9]));
}
/** Enabled mods found in the workshop folder (the folder tModLoader takes) or <save dir>/Mods. */
let mods = [];
function findMods() {
  let enabled;
  try {
    enabled = JSON.parse(fs.readFileSync(path.join(saveDir, 'Mods', 'enabled.json'), 'utf8'));
  } catch {
    enabled = [];
  }
  const ws = arg('-steamworkshopfolder');
  const found = new Map();
  const content = ws ? path.join(ws, 'content', '1281930') : null;
  if (content && fs.existsSync(content)) {
    for (const id of fs.readdirSync(content)) {
      const dir = path.join(content, id);
      const v = pickFolder(fs.readdirSync(dir));
      if (!v) continue;
      for (const f of fs.readdirSync(path.join(dir, v))) if (f.endsWith('.tmod') && !found.has(f.slice(0, -5))) found.set(f.slice(0, -5), { name: f.slice(0, -5), version: '1.0', display: f.slice(0, -5) });
    }
  }
  const local = path.join(saveDir, 'Mods');
  if (fs.existsSync(local)) for (const f of fs.readdirSync(local)) if (f.endsWith('.tmod')) found.set(f.slice(0, -5), { name: f.slice(0, -5), version: '1.0', display: f.slice(0, -5) });
  mods = enabled.filter((n) => found.has(n)).map((n) => found.get(n));
}

// ------------------------------------------------------------------ TShock plugins
/**
 * The plugins in `ServerPlugins/` next to TShock.Server, which TShock loads at start (measured):
 * the fake's install folder is found in GAME_INSTALL_DIR (the agent's), else
 * FAKE_TERRARIA_INSTALL_DIR, as the folder holding a TShock.Server. A file with the fake plugin's
 * marker (downloads.mjs `fakePlugin`) is initialised; anything else (a broken dll, an assembly
 * that isn't a plugin, TShock's own fake TShockAPI.dll) is ignored without a word (measured).
 */
function serverPlugins() {
  const root = env.GAME_INSTALL_DIR || env.FAKE_TERRARIA_INSTALL_DIR;
  const home = root && fs.existsSync(root) ? fs.readdirSync(root).map((d) => path.join(root, d)).find((d) => fs.existsSync(path.join(d, 'TShock.Server'))) : undefined;
  // `-additionalplugins <folder>` loads the plugins directly in that folder too, never its subfolders
  // (measured on TShock 6.2.1: docs/verification/shared-installs.md).
  const dirs = [home && path.join(home, 'ServerPlugins'), arg('-additionalplugins')].filter((d) => d && fs.existsSync(d));
  const found = [];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.toLowerCase().endsWith('.dll')) continue;
      let text;
      try {
        if (!fs.statSync(path.join(dir, f)).isFile()) continue;
        text = fs.readFileSync(path.join(dir, f), 'latin1');
      } catch {
        continue;
      }
      const m = /FAKE-TSHOCK-PLUGIN name=(\S+) version=(\S+) author=(\S+)/.exec(text);
      if (text.startsWith('MZ') && m) found.push({ name: m[1], version: m[2], author: m[3] });
    }
  }
  return found;
}

// A shared install (HST-09): an install an install job finished carries the shared-install marker,
// and servers mount it read-only, so the fake treats an install with the marker as read-only (a real
// read-only mount, as in the fake images, fails the same way). A write that lands outside the
// install through a link in it (a redirect into the data folder) goes through.
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

// ------------------------------------------------------------------ boot
async function boot() {
  if (tml) {
    // measured: tModLoader writes its logs into <working directory>/tModLoader-Logs and gives up without it
    // (read-only, or a link to a target that is missing: docs/verification/shared-installs.md)
    try {
      if (readOnlyAt(path.join(cwd, 'tModLoader-Logs'))) throw new Error('EROFS');
      fs.mkdirSync(path.join(cwd, 'tModLoader-Logs'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'tModLoader-Logs', 'server.log'), `[00:00:00.000] [Main Thread/INFO] [tML]: Starting tModLoader server ${TERRARIA}+${TML.replace(/(\d+)\.(\d+)\./, (_m, a, b) => `${a}.${b.padStart(2, '0')}.`)} (FAKE)\n`);
    } catch {
      err('Failed to init logging');
      out(`tModLoader v${TML} Fatal Error`);
      out('Failed to init logging');
      out('');
      out(`System.IO.DirectoryNotFoundException: Could not find a part of the path '${path.join(cwd, 'tModLoader-Logs')}'.`);
      process.exit(1);
    }
    fs.mkdirSync(path.join(saveDir, 'Mods'), { recursive: true });
    if (!fs.existsSync(path.join(saveDir, 'Mods', 'enabled.json'))) fs.writeFileSync(path.join(saveDir, 'Mods', 'enabled.json'), '[]');
    findMods();
    out('Finding Mods...');
    for (const m of mods) out(`Sandboxing: ${m.display} v${m.version}`);
    out('Constructing Mods...');
    for (const phase of ['Adding Content', 'Configuring Content', 'Finalizing Content']) {
      out(`${phase}: tModLoader v${TML}`);
      for (const m of mods) out(`${phase}: ${m.display} v${m.version}`);
      if (phase === 'Adding Content') out('Resizing...');
    }
    out('Adding Recipes...');
  } else {
    // vanilla prints two byte-order marks first, on stdout and stderr (TShock only on neither)
    out(tshock ? 'Error Logging Enabled.' : '\uFEFF\uFEFFError Logging Enabled.');
    if (!tshock) process.stderr.write('\uFEFF\uFEFF');
  }
  if (tshock) {
    out(`[OTAPI] Starting up (PC Server,3.3.14+ca9c239,ModFw:1.1.15+a2c0c70).`);
    out(`TerrariaAPI Version: 2.1.0.0 (Protocol v${TERRARIA} (326), OTAPI 3.3.14+ca9c239)`);
    if (arg('-configpath')) out(`[TShock] Info Config path has been set to ${configPath}`);
    const logPath = arg('-logpath') ?? path.join(configPath, 'logs');
    if (arg('-logpath')) out(`[TShock] Info Log path has been set to ${logPath}`);
    fs.mkdirSync(logPath, { recursive: true });
    tlogFile = path.join(logPath, `${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.log`);
    loadTshockConfig();
    for (const [t, v] of Object.entries(settings.ApplicationRestTokens ?? {})) restTokens.set(t, v?.Username ?? 'null');
    fs.appendFileSync(path.join(cwd, 'ServerLog.txt'), `[${new Date().toISOString()}] [Server API] Verbose: \tCommand line: TShock.Server ${argv.join(' ')}\n`);
    for (const f of ['motd.txt', 'rules.txt', 'whitelist.txt', 'sscconfig.json']) {
      const file = path.join(configPath, f);
      if (!fs.existsSync(file)) fs.writeFileSync(file, f === 'whitelist.txt' ? '# Localhost\r\n127.0.0.1\r\n' : f === 'sscconfig.json' ? JSON.stringify({ Settings: { Enabled: false } }, null, 2) : f === 'rules.txt' ? "Respect the admins!\nDon't use TNT!" : 'Welcome to %map% on TShock for Terraria.\nType %specifier%help for a list of commands.');
    }
    db = await openDb();
    loadDb();
    fs.writeFileSync(path.join(configPath, 'tshock.pid'), String(process.pid).slice(-1));
    if (arg('-port')) out(`Port overridden by startup argument. Set to ${port}`);
    if (arg('-maxplayers', '-players')) out('Startup parameter overrode maximum player slot configuration value.');
    if (arg('--rest-token', '-rest-token')) {
      restTokens.set(arg('--rest-token', '-rest-token'), 'null');
      out('Startup parameter overrode REST token.');
    }
    if (arg('--rest-enabled', '-rest-enabled')) {
      settings.RestApiEnabled = arg('--rest-enabled', '-rest-enabled') === 'true';
      out('Startup parameter overrode REST enable.');
    }
    if (arg('--rest-port', '-rest-port')) {
      settings.RestApiPort = Number(arg('--rest-port', '-rest-port'));
      out('Startup parameter overrode REST port.');
    }
    out('Using ConstileationProvider for tile implementation');
    out(`TShock ${TSHOCK} (Profoundly Collaborative (3.11)) now running.`);
    out(settings.AutoSave ? 'AutoSave Enabled' : 'AutoSave Disabled');
    out('Backups Enabled');
    out('Welcome to TShock for Terraria!');
    out('TShock comes with no warranty & is free software.');
    out('You can modify & distribute it under the terms of the GNU GPLv3.');
    out(`[Server API] Info Plugin TShock v${TSHOCK} (by The TShock Team) initiated.`);
    for (const p of serverPlugins()) out(`[Server API] Info Plugin ${p.name} v${p.version} (by ${p.author}) initiated.`);
  }
  if (!(tml && !worldFile && !autocreate)) {
    // (tModLoader's world menu prints its own header)
    out(header);
    out('');
    headerPrinted = true;
  }

  if (scenario === 'never-ready') return; // stuck before the world: no ready line, ever
  if (scenario === 'blocking-prompt' || (!worldFile && !autocreate)) return worldMenu();
  if (scenario === 'crash-on-boot') return loadFailed('System.IO.EndOfStreamException: Unable to read beyond the end of the stream.');

  if (worldFile && fs.existsSync(worldFile)) {
    const head = fs.readFileSync(worldFile, 'utf8').slice(0, WORLD_MAGIC.length);
    if (head !== WORLD_MAGIC) return loadFailed('System.Exception: LoadWorld failed with status: UnknownError');
    if (tshock) {
      out('Resetting game objects');
      out('Loading world data:');
      out('Settling liquids');
    } else {
      for (const p of [1, 2, 100]) out(`Resetting game objects ${p}%`);
      for (const p of [1, 2, 100]) out(`Loading world data: ${p}%`);
      for (const p of [1, 2, 50]) out(`Settling liquids ${p}%`);
    }
    await sleep(bootMs);
    worldLoaded = true;
  } else if (autocreate) {
    // measured: without a writable save folder the game can't write favorites.json and silently
    // creates no world; the server still says it started (and its exit save then fails)
    const [w, h] = sizes[autocreate] ?? sizes[2];
    const writable = (() => {
      try {
        fs.mkdirSync(saveDir, { recursive: true });
        fs.accessSync(saveDir, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    })();
    if (!writable) {
      out(`Failed to create the file: "${path.join(saveDir, 'favorites.json').replace(/\//g, '\\')}"!`);
      out('');
      out('The original Error below');
      out(`System.IO.DirectoryNotFoundException: Could not find a part of the path "${path.join(saveDir, 'favorites.json')}".`);
    } else {
      out(`Creating world - Seed: ${seed}, Width: ${w}, Height: ${h}, Evil: -1, ${tml ? 'IsExpert: False' : `Difficulty: ${difficulty}`}`);
      if (tshock) for (const phase of ['Terrain', 'Forming the depths', 'Hiding treasure', 'Clean up']) out(phase);
      else for (const p of ['0.0% - Generating world terrain - 0.1%', '0.4% - Adding sand - 0.0%', '99.9% - Final cleanup - 100.0%']) out(p);
      await sleep(bootMs);
      fs.writeFileSync(path.join(saveDir, 'favorites.json'), `{\n  "World": {\n    "${path.basename(worldFile ?? `${worldName}.wld`)}": false\n  }\n}`);
      worldFile ??= path.join(saveDir, 'Worlds', `${worldName}.wld`);
      writeWorldFile(worldFile, worldBytes());
      if (tml) writeWorldFile(worldFile.replace(/\.wld$/, '.twld'), `FAKE-TMOD-WORLD-DATA ${worldName}\n`);
      worldLoaded = true;
      if (tshock) {
        out('Saving world data:');
        out('Validating world save:');
        out('Loading world data:');
      }
    }
  } else {
    // measured: a -world that doesn't exist, without -autocreate, exits 0 without a word
    setTimeout(() => process.exit(0), 50);
    return undefined;
  }

  if (tml) out('Running engine preload...');
  out(tml ? `${header}` : header);
  out('');
  out(`Listening on port ${port}`);
  out("Type 'help' for a list of commands.");
  out('');
  if (env.FAKE_TERRARIA_BIND_GAME_PORT === '1') {
    gameServer = net.createServer((s) => s.destroy());
    const bound = await new Promise((r) => {
      gameServer.once('error', (e) => r(e));
      gameServer.listen(port, bindHost, () => r(null));
    });
    if (bound) {
      // measured: a taken port prints the prompt and exits 0, without a message
      prompt();
      setTimeout(() => process.exit(0), 300);
      return undefined;
    }
  }
  if (tshock) {
    out('Login before join enabled. Users may be prompted for an account specific password instead of a server password on connect.');
    out('Login using UUID enabled. Users automatically login via UUID.');
    out("A malicious server can easily steal a user's UUID. You may consider turning this option off if you run a public server.");
    // measured: no setup code once setup.lock exists or an account does
    if (!fs.existsSync(path.join(configPath, 'setup.lock')) && users.length === 0) {
      const codeFile = path.join(configPath, 'setup-code.txt');
      if (fs.existsSync(codeFile)) out('TShock Notice: setup-code.txt is still present, and the code located in that file will be used.');
      const code = fs.existsSync(codeFile) ? fs.readFileSync(codeFile, 'utf8').trim() : String(crypto.randomInt(100000, 10000000));
      fs.writeFileSync(codeFile, code);
      out(`To setup the server, join the game and type /setup ${code}`);
      out('This token will display until disabled by verification. (/setup)');
    }
    if (settings.RestApiEnabled) await startRest(settings.RestApiPort);
  }
  if (!tml) prompt();
  out('Server started');
  ready = true;
  for (const name of (env.FAKE_TERRARIA_PLAYERS ?? '').split(',').filter(Boolean)) join(name);
  for (const line of early.splice(0)) (tshock ? runTshock : runVanilla)(line);
  if (scenario === 'crash-after-ready') setTimeout(crashAfterReady, Number(env.FAKE_TERRARIA_CRASH_MS ?? 500));
  return undefined;
}

/** A world that can't be read: the measured lines, then exit 0. */
function loadFailed(exception) {
  out('Load failed!  No backup found.');
  out('');
  out(exception);
  out('  at Terraria.IO.WorldFile.LoadWorld () [0x00239] in <FAKE>:0 ');
  setTimeout(() => process.exit(0), 50);
}

await boot();
