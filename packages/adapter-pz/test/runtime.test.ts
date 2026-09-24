import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandVia, ControlHandle, InstallCtx, JobResult, SteamCmd, VersionsResponse } from '@gsp/adapter-api';
import { iniToRecord, parseIni } from '@gsp/formats';
import { ACCOUNTS, BANS, WORKSHOP_DOWNLOAD } from '../src/shared/actions';
import { pzRuntimeAdapter as pz, type PzLaunch } from '../src/runtime';
import { fixture } from './fixtures';

const launch: PzLaunch = { serverName: 'testsrv', adminUsername: 'admin', adminPassword: 'Adm1nPassw0rd!', memoryMb: 4096, branch: 'public', updateOnStart: false };
const secret = 'c'.repeat(48);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-pz-runtime-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A recording steamcmd driver: the agent's real one is tested in packages/agent. */
function stubSteam(result: JobResult = { ok: true }) {
  const calls: unknown[] = [];
  const steam: SteamCmd = {
    appUpdate: async (o) => (calls.push(['appUpdate', o]), result),
    branches: async (o): Promise<VersionsResponse> => (calls.push(['branches', o]), { installed: null, versions: [{ id: 'public', build: '1' }] }),
    workshopDownload: async (o) => (calls.push(['workshopDownload', o]), result),
  };
  return { steam, calls };
}

function ctx(o: { env?: Record<string, string>; steam?: SteamCmd; launcher?: string[]; gameVersion?: string | null } = {}) {
  const logs: string[] = [];
  const progress: [number | null, string][] = [];
  const c: InstallCtx = {
    roots: { data: path.join(dir, 'data'), install: path.join(dir, 'install') },
    stateDir: path.join(dir, 'state'),
    ports: { game: 16261, udp: 16262, rcon: 27100 },
    state: { controlSecret: secret, gameVersion: o.gameVersion ?? null },
    tools: { launcher: o.launcher, home: path.join(dir, 'home') },
    env: o.env ?? {},
    log: (l) => logs.push(l),
    onLine: () => undefined,
    progress: (p, m) => progress.push([p, m]),
    steam: o.steam,
  };
  return { c, logs, progress };
}

function writeManifest(appId: string, buildId: string, branch: string) {
  const d = path.join(dir, 'install', 'steamapps');
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, `appmanifest_${appId}.acf`),
    `"AppState"\n{\n\t"appid"\t\t"${appId}"\n\t"buildid"\t\t"${buildId}"\n\t"UserConfig"\n\t{\n\t\t"BetaKey"\t\t"${branch === 'public' ? '' : branch}"\n\t}\n}\n`,
  );
}

/** A scripted control handle: replies by command, records what was sent where. */
function fakeCtl(o: { ready?: boolean; replies?: Record<string, string>; channelDown?: boolean; lines?: string[]; waitTimesOut?: boolean } = {}) {
  const sent: [string, CommandVia | 'stdin-line' | undefined][] = [];
  const pending: { re: RegExp; resolve: (m: RegExpExecArray | null) => void }[] = [];
  const ctl: ControlHandle = {
    ready: o.ready ?? true,
    async command(cmd, via) {
      sent.push([cmd, via]);
      if (via !== 'stdin' && ctl.ready && !o.channelDown) {
        // The game prints `lines` in reply; waiters get the first one that matches.
        for (const p of pending.splice(0)) {
          const m = (o.lines ?? []).map((l) => p.re.exec(l)).find((x) => x !== null);
          if (m) p.resolve(m);
          else pending.push(p);
        }
        return o.replies?.[cmd] ?? '';
      }
      if (via === 'channel') throw new Error('RCON connection refused');
      return null;
    },
    stdin(line) {
      sent.push([line, 'stdin-line']);
      return true;
    },
    signal: () => undefined,
    waitForLine(re, ms) {
      if (o.waitTimesOut) return Promise.resolve(null);
      return new Promise((resolve) => {
        pending.push({ re, resolve });
        setTimeout(() => resolve(null), ms).unref();
      });
    },
  };
  return { ctl, sent };
}

describe('launch params', () => {
  it('accepts valid params and says what is wrong with bad ones', () => {
    expect(pz.parseLaunch(launch)).toEqual(launch);
    expect(pz.parseLaunch({ ...launch, extra: 1 })).toEqual(launch);
    const bad: [Partial<Record<keyof PzLaunch, unknown>>, RegExp][] = [
      [{ serverName: '../x' }, /serverName/],
      [{ adminUsername: 'a b' }, /adminUsername/],
      [{ adminPassword: 'short' }, /adminPassword/],
      [{ memoryMb: 512 }, /memoryMb must be 1024-65536/],
      [{ branch: '-beta x' }, /branch/],
      [{ updateOnStart: 'yes' }, /updateOnStart/],
    ];
    for (const [patch, msg] of bad) expect(() => pz.parseLaunch({ ...launch, ...patch })).toThrow(msg);
  });

  it('redacts the admin password and the RCON secret', () => {
    expect(pz.secrets(launch, { controlSecret: secret, gameVersion: null })).toEqual([launch.adminPassword, secret]);
  });

  it('lives in /opt/pz and /data inside its image', () => {
    expect(pz.roots(launch)).toEqual({ data: '/data', install: '/opt/pz' });
  });
});

describe('output lines', () => {
  const lines = (rel: string) => fixture(rel).split(/\r?\n/);
  const signals = (rel: string) => lines(rel).map((l) => pz.classify(l));

  it('finds readiness, RCON and the version in a real boot', () => {
    const s = signals('logs/boot-with-rcon.log');
    const ready = s.findIndex((x) => x.ready);
    const rcon = s.findIndex((x) => x.channelReady);
    expect(s[ready]!.message).toBe('*** SERVER STARTED ****');
    expect(rcon).toBeGreaterThan(ready);
    expect(s.filter((x) => x.version).map((x) => x.version)).toEqual(['42.20.4']);
    expect(s.some((x) => x.blockingPrompt || x.fatal)).toBe(false);
  });

  it('knows the admin password prompt blocks the server', () => {
    const s = signals('logs/admin-prompt.log');
    expect(s.filter((x) => x.blockingPrompt).map((x) => x.blockingPrompt)).toEqual(['The server asked for an admin password on the console']);
    expect(s.some((x) => x.ready)).toBe(false);
  });

  it('marks saves and fatal JVM errors', () => {
    expect(signals('logs/console-session.log').filter((x) => x.saved)).toHaveLength(2);
    expect(pz.classify('Exception in thread "main" java.lang.IllegalStateException: boom').fatal).toBe(true);
    expect(pz.classify('java.lang.OutOfMemoryError: Java heap space').fatal).toBe(true);
    expect(pz.classify('* additem : Give an item')).toEqual({ message: '* additem : Give an item' });
  });
});

describe('install', () => {
  it('reads what steamcmd installed', () => {
    const { c } = ctx({ gameVersion: '42.20.4' });
    expect(pz.installed(c)).toBeNull();
    writeManifest('380870', '24909800', 'legacy41');
    expect(pz.installed(c)).toEqual({ version: '42.20.4', channel: 'legacy41', build: '24909800' });
    // PZ_APP_ID points it at another app's manifest.
    expect(pz.installed(ctx({ env: { PZ_APP_ID: '999' } }).c)).toBeNull();
  });

  it('installs first when nothing or another branch is installed; updates when asked', () => {
    const { c } = ctx();
    expect(pz.installOnStart!(c, launch)).toBe('required');
    writeManifest('380870', '1', 'public');
    expect(pz.installOnStart!(c, launch)).toBeNull();
    expect(pz.installOnStart!(c, { ...launch, updateOnStart: true })).toBe('update');
    expect(pz.installOnStart!(c, { ...launch, branch: 'legacy41' })).toBe('required');
  });

  it('asks the steamcmd driver for its own app ids', async () => {
    const { steam, calls } = stubSteam();
    const { c, progress } = ctx({ steam });
    await pz.install!(c, launch, { validate: false });
    await pz.install!(c, { ...launch, branch: 'legacy41' }, { validate: true });
    await pz.install!(ctx({ steam, env: { PZ_APP_ID: '12345' } }).c, launch, { validate: false });
    expect(calls).toEqual([
      ['appUpdate', { appId: '380870', branch: null, validate: false }],
      ['appUpdate', { appId: '380870', branch: 'legacy41', validate: true }],
      ['appUpdate', { appId: '12345', branch: null, validate: false }],
    ]);
    expect(progress[1]).toEqual([null, 'Validating (legacy41)']);
    await expect(pz.install!(ctx().c, launch, { validate: false })).rejects.toThrow(/steamcmd/);
  });

  it('lists branches with what is installed', async () => {
    const { steam, calls } = stubSteam();
    writeManifest('380870', '24909800', 'public');
    const r = await pz.versions!(ctx({ steam }).c, launch);
    expect(calls).toEqual([['branches', { appId: '380870' }]]);
    expect(r).toEqual({ installed: { version: null, channel: 'public', build: '24909800' }, versions: [{ id: 'public', build: '1' }] });
  });
});

describe('start', () => {
  const iniFile = () => path.join(dir, 'data', 'Server', 'testsrv.ini');

  it('writes the keys the agent owns and keeps the rest', async () => {
    const { c } = ctx();
    await pz.prepare(c, launch);
    expect(iniToRecord(parseIni(readFileSync(iniFile(), 'utf8')))).toEqual({ RCONPort: '27100', RCONPassword: secret, DefaultPort: '16261', UDPPort: '16262', UPnP: 'false' });

    writeFileSync(iniFile(), 'PVP=true\nRCONPort=1\nUPnP=true\nPublicName=My server\n');
    await pz.prepare(c, launch);
    expect(iniToRecord(parseIni(readFileSync(iniFile(), 'utf8')))).toEqual({ PVP: 'true', RCONPort: '27100', UPnP: 'false', PublicName: 'My server', RCONPassword: secret, DefaultPort: '16261', UDPPort: '16262' });

    // Nothing to change: the file is not rewritten.
    const before = statSync(iniFile()).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await pz.prepare(c, launch);
    expect(statSync(iniFile()).mtimeMs).toBe(before);
  });

  it('puts JVM flags before "--" and game flags after', () => {
    const { c } = ctx();
    const cmd = pz.command(c, launch);
    expect(cmd.argv).toEqual([
      path.join(dir, 'install', 'start-server.sh'),
      '-Xms4096m',
      '-Xmx4096m',
      '-Duser.language=en',
      '-Duser.country=US',
      '--',
      '-servername',
      'testsrv',
      `-cachedir=${path.join(dir, 'data')}`,
      '-adminusername',
      'admin',
      '-adminpassword',
      launch.adminPassword,
    ]);
    expect(cmd.cwd).toBe(path.join(dir, 'install'));
    expect(cmd.env).toEqual({ LANG: 'C.UTF-8' });
    expect(pz.command(ctx({ launcher: ['node', 'fake.mjs'] }).c, launch).argv.slice(0, 3)).toEqual(['node', 'fake.mjs', '-Xms4096m']);
  });

  it('talks RCON on its port with the agent secret', () => {
    expect(pz.channel(ctx().c, launch)).toEqual({ kind: 'rcon', port: 27100, password: secret });
  });
});

describe('control', () => {
  it('stops with save and quit over RCON', async () => {
    const { ctl, sent } = fakeCtl();
    await pz.stop(ctl, { budgetMs: 1000 });
    expect(sent).toEqual([
      ['save', 'channel'],
      ['quit', 'channel'],
    ]);
  });

  it('falls back to quit on the console when RCON fails or the server is still starting', async () => {
    const down = fakeCtl({ channelDown: true });
    await pz.stop(down.ctl, { budgetMs: 1000 });
    expect(down.sent).toEqual([
      ['save', 'channel'],
      ['quit', 'stdin-line'],
    ]);
    const starting = fakeCtl({ ready: false });
    await pz.stop(starting.ctl, { budgetMs: 1000 });
    expect(starting.sent).toEqual([['quit', 'stdin-line']]);
  });

  it('saves and waits for "Saving finish"', async () => {
    const ok = fakeCtl({ lines: ['World saved', 'Saving finish'] });
    await pz.save!(ok.ctl);
    expect(ok.sent).toEqual([['save', undefined]]);
    await pz.hotCopy!.before(ok.ctl);
    await pz.hotCopy!.after(ok.ctl);
    expect(pz.hotCopy!.sqlite).toEqual(['**/*.db']);
    await expect(pz.save!(fakeCtl({ waitTimesOut: true }).ctl)).rejects.toThrow(/finished saving/);
  });

  it('lists players from the RCON reply', async () => {
    const { ctl, sent } = fakeCtl({ replies: { players: 'Players connected (2): \n-alice\n-bob\n' } });
    expect(await pz.listPlayers!(ctl)).toEqual({ count: 2, names: ['alice', 'bob'] });
    expect(sent).toEqual([['players', 'channel']]);
    expect(await pz.listPlayers!(fakeCtl({ replies: { players: 'nope' } }).ctl)).toBeNull();
    await expect(pz.listPlayers!(fakeCtl({ channelDown: true }).ctl)).rejects.toThrow(/refused/);
  });
});

describe('actions', () => {
  const a = pz.actions!;

  function gameDb() {
    mkdirSync(path.join(dir, 'data', 'db'), { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'data', 'db', 'testsrv.db'));
    // PZ's own DDL (as in the panel's players tests).
    db.exec(`
      CREATE TABLE [whitelist] ([id] INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,[world] TEXT DEFAULT '' NULL,[username] TEXT NULL, [password] TEXT NULL, [lastConnection] TEXT NULL, [role] INTEGER NOT NULL, [authType] INTEGER NULL DEFAULT 1, [googleKey] TEXT NULL, [steamid] TEXT NULL, [ownerid] TEXT NULL, [displayName] TEXT NULL);
      CREATE TABLE [role] ([id] INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, [name] TEXT NOT NULL,[description] TEXT NULL, [colorR] REAL NOT NULL, [colorG] REAL NOT NULL, [colorB] REAL NOT NULL, [readonly] BOOLEAN NULL DEFAULT false, [position] INTEGER NOT NULL DEFAULT -1);
      CREATE TABLE [bannedid] ([steamid] TEXT NOT NULL, [reason] TEXT NULL);
      CREATE TABLE [bannedip] ([ip] TEXT NOT NULL,[username] TEXT NULL, [reason] TEXT NULL);
      INSERT INTO role (id, name, colorR, colorG, colorB) VALUES (2, 'user', 1, 1, 1), (7, 'admin', 1, 0, 0);
      INSERT INTO whitelist (world, username, password, role, steamid, lastConnection) VALUES ('testsrv', 'rick', 'y', 2, '76561198000000001', '2026-09-23 10:00:00'), ('testsrv', 'Admin', 'x', 7, NULL, NULL), ('testsrv', 'ghost', 'z', 9, NULL, NULL);
      INSERT INTO bannedid VALUES ('76561198000000009', 'griefing');
      INSERT INTO bannedip VALUES ('192.168.1.50', 'alice', NULL);
    `);
    db.close();
  }

  it('names the actions the panel calls', () => {
    expect(Object.keys(a).sort()).toEqual([ACCOUNTS, BANS, WORKSHOP_DOWNLOAD].sort());
    expect(a[WORKSHOP_DOWNLOAD]!.job).toBe('workshop');
    expect(a[ACCOUNTS]!.job).toBeUndefined();
  });

  it('reads accounts and bans read-only from the game database', async () => {
    const { c } = ctx();
    const input = a[ACCOUNTS]!.parse({ serverName: 'testsrv' });
    expect(await a[ACCOUNTS]!.run(c, null, input)).toEqual([]);
    expect(await a[BANS]!.run(c, null, input)).toEqual({ steamIds: [], ips: [] });
    gameDb();
    expect(await a[ACCOUNTS]!.run(c, null, input)).toEqual([
      { username: 'Admin', displayName: null, role: 'admin', lastConnection: null, steamId: null },
      { username: 'ghost', displayName: null, role: '9', lastConnection: null, steamId: null },
      { username: 'rick', displayName: null, role: 'user', lastConnection: '2026-09-23 10:00:00', steamId: '76561198000000001' },
    ]);
    expect(await a[BANS]!.run(c, null, input)).toEqual({
      steamIds: [{ steamId: '76561198000000009', reason: 'griefing' }],
      ips: [{ ip: '192.168.1.50', username: 'alice', reason: null }],
    });
  });

  it('falls back to nothing, and says why, when the database is unreadable', async () => {
    mkdirSync(path.join(dir, 'data', 'db'), { recursive: true });
    writeFileSync(path.join(dir, 'data', 'db', 'testsrv.db'), 'not a database');
    const { c, logs } = ctx();
    expect(await a[ACCOUNTS]!.run(c, null, { serverName: 'testsrv' })).toEqual([]);
    expect(logs.join('\n')).toMatch(/Could not read the game database/);
  });

  it('refuses bad input', () => {
    for (const bad of [undefined, {}, { serverName: '../etc' }, { serverName: 'a'.repeat(33) }]) {
      expect(() => a[ACCOUNTS]!.parse(bad)).toThrow(/serverName/);
      expect(() => a[BANS]!.parse(bad)).toThrow(/serverName/);
    }
    for (const bad of [undefined, { ids: [] }, { ids: Array(101).fill('2503622437') }, { ids: [2503622437] }]) expect(() => a[WORKSHOP_DOWNLOAD]!.parse(bad)).toThrow(/1-100/);
    expect(() => a[WORKSHOP_DOWNLOAD]!.parse({ ids: ['12', '+quit'] })).toThrow(/Invalid workshop id/);
  });

  it('downloads workshop items for app 108600', async () => {
    const { steam, calls } = stubSteam();
    const { c, progress } = ctx({ steam });
    const input = a[WORKSHOP_DOWNLOAD]!.parse({ ids: ['2503622437', '2544353492'] });
    expect(await a[WORKSHOP_DOWNLOAD]!.run(c, null, input)).toEqual({ ok: true });
    expect(calls).toEqual([['workshopDownload', { workshopAppId: '108600', ids: ['2503622437', '2544353492'] }]]);
    expect(progress).toEqual([[null, 'Downloading 2 workshop item(s)']]);
  });
});
