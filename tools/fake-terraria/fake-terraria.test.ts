// The Terraria fake against what the real servers did (fixtures/terraria/1.4.5.8,
// docs/verification/terraria-1.4.5.8.md): the line patterns the adapter will rely on match the
// real captures and the fake alike, and the fake's console, files, REST API, downloads and
// steamcmd behave like the measured ones.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeAssembly, fakePlugin, startFakeDownloads } from './downloads.mjs';

const SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, 'server.mjs');
const STEAMCMD = path.join(here, 'steamcmd.mjs');
const FIXTURES = path.join(here, '..', '..', 'fixtures', 'terraria', '1.4.5.8');
const fixture = (...p: string[]) => readFileSync(path.join(FIXTURES, ...p), 'utf8');
type Flavour = 'vanilla' | 'tshock' | 'tmodloader';

/** What a console line says once the game's decorations are off: byte-order marks, and the ": " prompt it prints without a newline. */
const bare = (line: string) => line.replace(/^\uFEFF+/, '').replace(/^(?:: )+/, '');

/** Log line patterns the adapter will rely on (on `bare` lines); each must match the real captures and the fake. */
const PATTERNS = {
  ready: /^Server started$/,
  listening: /^Listening on port (\d+)$/,
  version: /^Terraria Server v(\d+(?:\.\d+){3})(?: - tModLoader v(\S+))?$/,
  tshockVersion: /^TShock (\d+(?:\.\d+){3}) \(.*\) now running\.$/,
  tmlVersion: /^Adding Content: tModLoader v(\S+)$/,
  join: /^(.+) has joined\.$/,
  leave: /^(.+) has left\.$/,
  worldMenu: /^n\t\tNew World$/,
  saved: /^(?:Backing up world file|Saving modded world data)$/,
  loadFailed: /^Load failed! {2}No backup found\.$/,
  unhandled: /^\[ERROR\] FATAL UNHANDLED EXCEPTION: /,
  noDotnet: /^You must install \.NET to run this application\.$/,
  noFavorites: /^Failed to create the file: ".*favorites\.json"!$/,
};
const lines = (text: string) => text.split('\n').map(bare);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

interface Fake {
  dir: string;
  child: ChildProcess;
  lines: string[];
  exited: Promise<number | null>;
  waitFor(re: RegExp, ms?: number): Promise<string>;
  send(line: string): void;
}
const running: Fake[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'gsp-fake-tr-'));
  dirs.push(d);
  return d;
}

function start(flavour: Flavour, args: string[], o: { dir?: string; env?: Record<string, string> } = {}): Fake {
  const dir = o.dir ?? tempDir();
  const child = spawn(process.execPath, [SERVER, ...args], {
    cwd: dir,
    env: { ...process.env, FAKE_TERRARIA_FLAVOUR: flavour, FAKE_TERRARIA_BOOT_MS: '30', ...o.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const got: string[] = [];
  const waiters = new Set<{ re: RegExp; resolve: (l: string) => void }>();
  // One buffer per stream: the game prints prompts and byte-order marks without a newline.
  const reader = () => {
    let buf = '';
    return (d: Buffer) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = bare(buf.slice(0, i));
        buf = buf.slice(i + 1);
        got.push(line);
        for (const w of waiters) {
          if (!w.re.test(line)) continue;
          waiters.delete(w);
          w.resolve(line);
        }
      }
    };
  };
  child.stdout!.on('data', reader());
  child.stderr!.on('data', reader());
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const f: Fake = {
    dir,
    child,
    lines: got,
    exited,
    waitFor(re, ms = 5000 * SCALE) {
      const hit = got.find((l) => re.test(l));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { re, resolve };
        waiters.add(w);
        setTimeout(() => {
          if (waiters.delete(w)) reject(new Error(`timed out waiting for ${re}\n${got.slice(-10).join('\n')}`));
        }, ms);
      });
    },
    send(line) {
      child.stdin!.write(`${line}\n`);
    },
  };
  running.push(f);
  return f;
}

/** The vanilla launch the adapter will make (absolute paths: the real server runs from its install folder). */
const vanillaArgs = (dir: string, extra: string[] = []) => ['-port', '7777', '-maxplayers', '8', '-world', path.join(dir, 'worlds', 'w1.wld'), '-autocreate', '1', '-worldname', 'w1', '-savedirectory', dir, '-banlist', path.join(dir, 'banlist.txt'), '-noupnp', ...extra];

afterEach(async () => {
  for (const f of running.splice(0)) {
    if (f.child.exitCode === null) f.child.kill('SIGKILL');
    await f.exited;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// --------------------------------------------------------------------- the real captures
describe('the patterns the adapter will use match the real captures', () => {
  it('vanilla: first boot, console, players, save, failures', () => {
    const created = lines(fixture('vanilla', 'logs', 'crash-after-rapid-connections.log')); // a medium world's first boot
    expect(created.filter((l) => PATTERNS.ready.test(l))).toHaveLength(1);
    expect(created.find((l) => l.startsWith('Creating world - '))).toMatch(/^Creating world - Seed: \d+, Width: 6400, Height: 1800, Evil: -1, Difficulty: 0$/);
    const existing = lines(fixture('vanilla', 'logs', 'boot-existing-world.log'));
    expect(existing.filter((l) => PATTERNS.ready.test(l))).toHaveLength(1);
    expect(existing.find((l) => PATTERNS.listening.test(l))).toBe('Listening on port 7777');
    expect(existing.find((l) => PATTERNS.version.test(l))).toBe('Terraria Server v1.4.5.8');
    const players = lines(fixture('vanilla', 'logs', 'players.log'));
    expect(players.filter((l) => PATTERNS.join.test(l)).map((l) => PATTERNS.join.exec(l)![1])).toEqual(['gspffalice', 'gspffbob', 'gspffcarol']);
    expect(players.filter((l) => PATTERNS.leave.test(l)).map((l) => PATTERNS.leave.exec(l)![1])).toEqual(['gspffbob', 'gspffcarol', 'gspffalice']);
    expect(lines(fixture('vanilla', 'logs', 'save-then-exit.log')).some((l) => PATTERNS.saved.test(l))).toBe(true);
    expect(lines(fixture('vanilla', 'logs', 'no-args-world-menu.log')).some((l) => PATTERNS.worldMenu.test(l))).toBe(true);
    expect(lines(fixture('vanilla', 'logs', 'corrupt-world-truncated.log')).some((l) => PATTERNS.loadFailed.test(l))).toBe(true);
    expect(lines(fixture('vanilla', 'logs', 'crash-reconnect-burst.log')).some((l) => PATTERNS.unhandled.test(l))).toBe(true);
    expect(lines(fixture('vanilla', 'logs', 'first-boot-readonly-home.log')).some((l) => PATTERNS.noFavorites.test(l))).toBe(true);
    // the port-in-use and missing-world failures say nothing: only the exit before the ready line tells
    for (const f of ['port-in-use.log', 'missing-world-no-autocreate.log']) expect(lines(fixture('vanilla', 'logs', f)).some((l) => PATTERNS.ready.test(l))).toBe(false);
  });

  it('TShock: boot, players, save, missing .NET', () => {
    const boot = lines(fixture('tshock', 'logs', 'first-boot.log'));
    expect(boot.filter((l) => PATTERNS.ready.test(l))).toHaveLength(1);
    expect(boot.find((l) => PATTERNS.tshockVersion.test(l))).toMatch(/^TShock 6\.2\.1\.0 /);
    expect(boot.find((l) => PATTERNS.version.test(l))).toBe('Terraria Server v1.4.5.8');
    const mod = lines(fixture('tshock', 'logs', 'setup-lock-players-moderation.log'));
    expect(mod.filter((l) => PATTERNS.join.test(l)).length).toBeGreaterThanOrEqual(2);
    expect(mod.filter((l) => PATTERNS.leave.test(l)).length).toBeGreaterThanOrEqual(2);
    expect(mod.some((l) => /\/setup \d/.test(l))).toBe(false); // setup.lock: no setup code
    expect(lines(fixture('tshock', 'logs', 'save-then-exit.log')).some((l) => PATTERNS.saved.test(l))).toBe(true);
    expect(lines(fixture('tshock', 'logs', 'no-dotnet-runtime.log')).some((l) => PATTERNS.noDotnet.test(l))).toBe(true);
  });

  it("TShock: a third-party plugin's load line, right after TShock's own, which the fake prints the same way (MOD-06)", () => {
    const boot = lines(fixture('tshock', 'logs', 'boot-with-plugin.log'));
    const plugin = /^\[Server API\] Info Plugin (\S+) v(\S+) \(by (.+)\) initiated\.$/;
    expect(boot.filter((l) => plugin.test(l))).toEqual(['[Server API] Info Plugin TShock v6.2.1.0 (by The TShock Team) initiated.', '[Server API] Info Plugin Bagger v1.3.1 (by Soofa) initiated.']);
    const own = boot.indexOf('[Server API] Info Plugin TShock v6.2.1.0 (by The TShock Team) initiated.');
    expect(boot[own + 1]).toMatch(plugin);
    expect(boot.filter((l) => PATTERNS.ready.test(l))).toHaveLength(1);
  });

  it('tModLoader: boot, mods, save, world menu', () => {
    const boot = lines(fixture('tmodloader', 'logs', 'first-boot.log'));
    expect(boot.filter((l) => PATTERNS.ready.test(l))).toHaveLength(1);
    expect(boot.find((l) => PATTERNS.tmlVersion.test(l))).toBe('Adding Content: tModLoader v2026.7.3.0');
    expect(boot.find((l) => PATTERNS.version.test(l))).toBe('Terraria Server v1.4.4.9');
    expect(lines(fixture('tmodloader', 'logs', 'boot-with-workshop-mod.log'))).toContain('Sandboxing: Recipe Browser v0.12.0.3');
    expect(lines(fixture('tmodloader', 'logs', 'no-world-menu.log')).some((l) => PATTERNS.worldMenu.test(l))).toBe(true);
    const session = JSON.parse(fixture('tmodloader', 'console', 'console-session.json')) as { dir: string; text: string }[];
    expect(session.some((e) => e.dir === 'out' && PATTERNS.saved.test(bare(e.text)))).toBe(true);
  });

  it("TShock's REST transcripts: the answers the panel will parse", () => {
    const auth = JSON.parse(fixture('tshock', 'rest', '1-auth.json')) as { path: string; status: number; body: Record<string, unknown> }[];
    expect(auth.find((e) => e.path === '/v2/server/status')!.status).toBe(200); // anonymous
    expect(auth.find((e) => e.path.startsWith('/tokentest?token=not-a-token'))!.status).toBe(403);
    const players = JSON.parse(fixture('tshock', 'rest', '2-players.json')) as { path: string; status: number; body: Record<string, unknown> }[];
    const list = players.find((e) => e.path.startsWith('/v2/players/list'))!.body.players as { nickname: string; active: boolean }[];
    expect(list.map((p) => p.nickname)).toEqual(['gspffalice', 'gspffbob', 'gspffcarol']);
    expect(players.find((e) => e.path.startsWith('/v3/bans/create?identifier=name:'))!.status).toBe(500);
    expect(players.find((e) => e.path.startsWith('/v3/bans/list'))!.body.bans).toContainEqual(expect.objectContaining({ identifier: 'name:gspffcarol' }));
  });
});

// --------------------------------------------------------------------- the fake server
describe('fake-terraria server.mjs: vanilla', () => {
  it('autocreates the world at -world, says it started, answers the console and saves on exit', async () => {
    const dir = tempDir();
    const f = start('vanilla', vanillaArgs(dir));
    await f.waitFor(PATTERNS.ready);
    expect(f.lines[0]).toBe('Error Logging Enabled.');
    expect(f.lines).toContain('Listening on port 7777');
    expect(existsSync(path.join(dir, 'worlds', 'w1.wld'))).toBe(true);
    expect(existsSync(path.join(dir, 'favorites.json'))).toBe(true);
    f.send('version');
    await f.waitFor(/^Terraria Server v1\.4\.5\.8$/);
    f.send('password');
    await f.waitFor(/^No password set\.$/);
    f.send('notacommand');
    await f.waitFor(/^Invalid command\.$/);
    const created = readFileSync(path.join(dir, 'worlds', 'w1.wld'), 'utf8');
    f.send('save');
    await f.waitFor(PATTERNS.saved);
    // the .wld is complete when the line shows; the .bak (the previous save) follows it
    expect(readFileSync(path.join(dir, 'worlds', 'w1.wld'), 'utf8')).not.toBe(created);
    f.send('seed');
    await f.waitFor(/^World Seed: /);
    expect(readFileSync(path.join(dir, 'worlds', 'w1.wld.bak'), 'utf8')).toBe(created);
    f.send('exit');
    expect(await f.exited).toBe(0);
    expect(f.lines).toContain('Saving before exit...');
    expect(existsSync(path.join(dir, 'worlds', 'w1.wld.bak2'))).toBe(true);
  });

  it('players: joins, playing, kick, a ban into -banlist (IP with the name as a comment), the save when the server empties', async () => {
    const dir = tempDir();
    const f = start('vanilla', vanillaArgs(dir), { env: { FAKE_TERRARIA_PLAYERS: 'gspffalice,gspffbob' } });
    await f.waitFor(/^gspffbob has joined\.$/);
    f.send('playing');
    await f.waitFor(/^2 players connected\.$/);
    expect(f.lines.some((l) => /^gspffalice \(192\.0\.2\.1:\d+\)$/.test(l))).toBe(true);
    f.send('kick gspffbob');
    await f.waitFor(/^gspffbob has left\.$/);
    expect(f.lines.some((l) => /^192\.0\.2\.1:\d+ was booted: Kicked from server\.$/.test(l))).toBe(true);
    f.send('ban gspffalice');
    await f.waitFor(/^gspffalice has left\.$/);
    expect(readFileSync(path.join(dir, 'banlist.txt'), 'utf8')).toBe('//gspffalice\n192.0.2.1\n');
    await f.waitFor(PATTERNS.saved);
    f.send('fake-join gspffcarol');
    await f.waitFor(/was booted: You are banned from this server\.$/);
  });

  it('without -banlist a ban fails with "Invalid command." (measured with the install read-only)', async () => {
    const dir = tempDir();
    const f = start('vanilla', vanillaArgs(dir).filter((a, i, all) => a !== '-banlist' && all[i - 1] !== '-banlist'), { env: { FAKE_TERRARIA_PLAYERS: 'gspffalice' } });
    await f.waitFor(PATTERNS.ready);
    f.send('ban gspffalice');
    await f.waitFor(/^Invalid command\.$/);
  });

  it('exit-nosave leaves the world as it was', async () => {
    const dir = tempDir();
    const f = start('vanilla', vanillaArgs(dir));
    await f.waitFor(PATTERNS.ready);
    const before = readFileSync(path.join(dir, 'worlds', 'w1.wld'), 'utf8');
    f.send('exit-nosave');
    expect(await f.exited).toBe(0);
    expect(readFileSync(path.join(dir, 'worlds', 'w1.wld'), 'utf8')).toBe(before);
    expect(existsSync(path.join(dir, 'worlds', 'w1.wld.bak'))).toBe(false);
  });

  it('a missing world without -autocreate exits 0 without a word; a broken one fails to load; no world at all shows the menu and waits', async () => {
    const dir = tempDir();
    const missing = start('vanilla', ['-port', '7777', '-world', path.join(dir, 'nope.wld')]);
    expect(await missing.exited).toBe(0);
    expect(missing.lines.some((l) => PATTERNS.ready.test(l))).toBe(false);
    writeFileSync(path.join(dir, 'bad.wld'), 'not a world');
    const broken = start('vanilla', ['-port', '7777', '-world', path.join(dir, 'bad.wld')]);
    expect(await broken.exited).toBe(0);
    expect(broken.lines.some((l) => PATTERNS.loadFailed.test(l))).toBe(true);
    const menu = start('vanilla', ['-port', '7777']);
    await menu.waitFor(PATTERNS.worldMenu);
    menu.child.stdin!.end(); // measured: the end of stdin changes nothing
    await new Promise((r) => setTimeout(r, 300 * SCALE));
    expect(menu.child.exitCode).toBeNull();
  });

  it('queues commands typed before the server is ready', async () => {
    const dir = tempDir();
    const f = start('vanilla', vanillaArgs(dir), { env: { FAKE_TERRARIA_BOOT_MS: '300' } });
    f.send('maxplayers');
    await f.waitFor(/^Player limit: 8$/);
    expect(f.lines.indexOf('Player limit: 8')).toBeGreaterThan(f.lines.findIndex((l) => PATTERNS.ready.test(l)));
  });

  it('a game port already taken: the prompt, then exit 0 without a message (FAKE_TERRARIA_BIND_GAME_PORT=1)', async () => {
    const dir = tempDir();
    const port = await freePort();
    const blocker = net.createServer().listen(port, '127.0.0.1');
    try {
      const f = start('vanilla', vanillaArgs(dir).map((a) => (a === '7777' ? String(port) : a)), { env: { FAKE_TERRARIA_BIND_GAME_PORT: '1' } });
      expect(await f.exited).toBe(0);
      expect(f.lines).toContain(`Listening on port ${port}`);
      expect(f.lines.some((l) => PATTERNS.ready.test(l))).toBe(false);
    } finally {
      blocker.close();
    }
  });

  it('scenarios: crash-after-ready exits 1 with the unhandled exception, crash-on-boot fails the load, never-ready stays quiet, ignore-stop ignores exit, blocking-prompt shows the menu', async () => {
    const d1 = tempDir();
    const crash = start('vanilla', vanillaArgs(d1), { env: { FAKE_TERRARIA_SCENARIO: 'crash-after-ready', FAKE_TERRARIA_CRASH_MS: '50' } });
    expect(await crash.exited).toBe(1);
    expect(crash.lines.some((l) => PATTERNS.ready.test(l))).toBe(true);
    expect(crash.lines.some((l) => PATTERNS.unhandled.test(l))).toBe(true);
    const onBoot = start('vanilla', vanillaArgs(tempDir()), { env: { FAKE_TERRARIA_SCENARIO: 'crash-on-boot' } });
    expect(await onBoot.exited).toBe(0);
    expect(onBoot.lines.some((l) => PATTERNS.loadFailed.test(l))).toBe(true);
    const never = start('vanilla', vanillaArgs(tempDir()), { env: { FAKE_TERRARIA_SCENARIO: 'never-ready' } });
    await never.waitFor(/^Terraria Server v/);
    await new Promise((r) => setTimeout(r, 300 * SCALE));
    expect(never.lines.some((l) => PATTERNS.ready.test(l))).toBe(false);
    expect(never.child.exitCode).toBeNull();
    const ignore = start('vanilla', vanillaArgs(tempDir()), { env: { FAKE_TERRARIA_SCENARIO: 'ignore-stop' } });
    await ignore.waitFor(PATTERNS.ready);
    ignore.send('exit');
    await ignore.waitFor(/^Saving before exit\.\.\.$/);
    await new Promise((r) => setTimeout(r, 300 * SCALE));
    expect(ignore.child.exitCode).toBeNull();
    const prompt = start('vanilla', vanillaArgs(tempDir()), { env: { FAKE_TERRARIA_SCENARIO: 'blocking-prompt' } });
    await prompt.waitFor(PATTERNS.worldMenu);
  });

  it.skipIf(process.platform === 'win32')('SIGTERM: exit 143 without saving (measured on vanilla and TShock)', async () => {
    const dir = tempDir();
    const f = start('vanilla', vanillaArgs(dir));
    await f.waitFor(PATTERNS.ready);
    const before = readFileSync(path.join(dir, 'worlds', 'w1.wld'), 'utf8');
    f.child.kill('SIGTERM');
    expect(await f.exited).toBe(143);
    expect(readFileSync(path.join(dir, 'worlds', 'w1.wld'), 'utf8')).toBe(before);
  });
});

describe('fake-terraria server.mjs: TShock', () => {
  const tshockArgs = (dir: string, extra: string[] = []) => ['-port', '7777', '-maxplayers', '8', '-world', path.join(dir, 'worlds', 't1.wld'), '-autocreate', '1', '-worldname', 't1', '-savedirectory', dir, '-configpath', path.join(dir, 'tshock'), '-logpath', path.join(dir, 'tshock', 'logs'), ...extra];

  it('writes its files, completes config.json with the defaults and drops unknown keys (no final newline), prints the setup code unless setup.lock exists', async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'tshock'), { recursive: true });
    writeFileSync(path.join(dir, 'tshock', 'config.json'), JSON.stringify({ Settings: { ServerName: 'Prueba Ñandú ☃', GspProbeUnknownKey: 42 }, GspTop: true }));
    const f = start('tshock', tshockArgs(dir), { dir });
    await f.waitFor(PATTERNS.ready);
    expect(f.lines.some((l) => /^To setup the server, join the game and type \/setup \d+$/.test(l))).toBe(true);
    const text = readFileSync(path.join(dir, 'tshock', 'config.json'), 'utf8');
    expect(text.endsWith('}')).toBe(true);
    const cfg = JSON.parse(text) as { Settings: Record<string, unknown> };
    expect(Object.keys(cfg)).toEqual(['Settings']);
    expect(cfg.Settings.ServerName).toBe('Prueba Ñandú ☃');
    expect(cfg.Settings).not.toHaveProperty('GspProbeUnknownKey');
    expect(cfg.Settings.RestApiPort).toBe(7878);
    expect(Object.keys(cfg.Settings)).toHaveLength(Object.keys(JSON.parse(fixture('tshock', 'config', 'config.json.generated')).Settings).length);
    for (const n of ['motd.txt', 'rules.txt', 'whitelist.txt', 'sscconfig.json', 'tshock.sqlite', 'setup-code.txt']) expect(existsSync(path.join(dir, 'tshock', n))).toBe(true);
    expect(existsSync(path.join(dir, 'ServerLog.txt'))).toBe(true);
    f.send('exit');
    expect(await f.exited).toBe(0);

    writeFileSync(path.join(dir, 'tshock', 'setup.lock'), '');
    const again = start('tshock', tshockArgs(dir), { dir });
    await again.waitFor(PATTERNS.ready);
    expect(again.lines.some((l) => /\/setup /.test(l))).toBe(false);
  });

  it('loads the plugins in ServerPlugins next to TShock.Server at start, ignoring without a word what is no plugin (MOD-06)', async () => {
    const dir = tempDir();
    const install = path.join(dir, 'install');
    const plugins = path.join(install, 'tshock-v6.2.1', 'ServerPlugins');
    mkdirSync(plugins, { recursive: true });
    writeFileSync(path.join(install, 'tshock-v6.2.1', 'TShock.Server'), '');
    writeFileSync(path.join(plugins, 'TShockAPI.dll'), 'FAKE TShockAPI 6.2.1\n');
    writeFileSync(path.join(plugins, 'HelloPlugin.dll'), fakePlugin('HelloPlugin', '1.2.0', 'gspff'));
    writeFileSync(path.join(plugins, 'HelloLib.dll'), fakeAssembly('HelloLib'));
    writeFileSync(path.join(plugins, 'Broken.dll'), 'garbage');
    const f = start('tshock', tshockArgs(dir), { dir, env: { GAME_INSTALL_DIR: install } });
    await f.waitFor(PATTERNS.ready);
    expect(f.lines.filter((l) => /^\[Server API\] Info Plugin /.test(l))).toEqual(['[Server API] Info Plugin TShock v6.2.1.0 (by The TShock Team) initiated.', '[Server API] Info Plugin HelloPlugin v1.2.0 (by gspff) initiated.']);
    expect(f.lines.join('\n')).not.toMatch(/HelloLib|Broken/);
  });

  it('console: "Server executed" echoes, who, kick with its three lines, bans by name refuse the join', async () => {
    const dir = tempDir();
    const f = start('tshock', tshockArgs(dir), { env: { FAKE_TERRARIA_PLAYERS: 'gspffalice,gspffbob' } });
    await f.waitFor(/^gspffbob has joined\. IP: 192\.0\.2\.1$/);
    f.send('who');
    await f.waitFor(/^Online Players \(2\/8\)$/);
    await f.waitFor(/^gspffalice, gspffbob$/);
    f.send('kick gspffbob Bye');
    await f.waitFor(/^Server kicked gspffbob for 'Bye'$/);
    await f.waitFor(/^gspffbob has left\.$/);
    f.send('ban add gspffalice Test');
    await f.waitFor(/^gspffalice has left\.$/);
    f.send('fake-join gspffalice');
    await f.waitFor(/was booted: #1 - You are banned: Test$/);
    f.send('notacommand');
    await f.waitFor(/^Invalid command entered\. Type \/help for a list of valid commands\.$/);
  });

  it('REST (CON-04): anonymous status, the application token from config.json, players, kick, bans (500 with players online, stored anyway), rawcmd, save, off', async () => {
    const dir = tempDir();
    const restPort = await freePort();
    const token = 'fake-rest-token-0123';
    mkdirSync(path.join(dir, 'tshock'), { recursive: true });
    writeFileSync(path.join(dir, 'tshock', 'config.json'), JSON.stringify({ Settings: { RestApiEnabled: true, RestApiPort: restPort, LogRest: true, ApplicationRestTokens: { [token]: { Username: 'gspagent', UserGroupName: 'superadmin' } } } }));
    writeFileSync(path.join(dir, 'tshock', 'setup.lock'), '');
    const f = start('tshock', tshockArgs(dir), { env: { FAKE_TERRARIA_PLAYERS: 'gspffalice,gspffbob' } });
    await f.waitFor(PATTERNS.ready);
    const base = `http://127.0.0.1:${restPort}`;
    const get = async (p: string) => {
      const r = await fetch(`${base}${p}`);
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    expect(await get('/v2/server/status')).toMatchObject({ status: 200, body: { status: '200', serverversion: 'v1.4.5.8', tshockversion: '6.2.1.0', playercount: 2 } });
    expect((await get('/tokentest?token=wrong')).status).toBe(403);
    expect((await get(`/tokentest?token=${token}`)).body).toMatchObject({ associateduser: 'gspagent' });
    expect(f.lines).toContain('"gspagent" requested REST endpoint: /tokentest');
    expect(f.lines.join('\n')).not.toContain(token);
    const list = (await get(`/v2/players/list?token=${token}`)).body.players as { nickname: string }[];
    expect(list.map((p) => p.nickname)).toEqual(['gspffalice', 'gspffbob']);
    expect(await get(`/v2/players/kick?player=gspffbob&reason=Bye&token=${token}`)).toMatchObject({ status: 200, body: { response: 'Player gspffbob was kicked' } });
    await f.waitFor(/^Kicked gspffbob for : 'Bye'$/);
    expect((await get(`/v3/bans/create?identifier=name:gspffcarol&reason=Test&token=${token}`)).status).toBe(500);
    const bans = (await get(`/v3/bans/list?token=${token}`)).body.bans as { ticket_number: number; identifier: string }[];
    expect(bans).toEqual([expect.objectContaining({ ticket_number: 1, identifier: 'name:gspffcarol' })]);
    expect((await get(`/v3/bans/read?ticket=1&token=${token}`)).body).toMatchObject({ error: 'Missing or empty ticketNumber parameter' });
    expect((await get(`/v3/bans/destroy?ticketNumber=9&token=${token}`)).status).toBe(500);
    expect((await get(`/v3/bans/destroy?ticketNumber=1&token=${token}`)).body).toMatchObject({ response: 'Ban removed.' });
    expect((await get(`/v3/server/rawcmd?cmd=/who&token=${token}`)).body.response).toEqual(['Online Players ([c/AAFFAA:1]/8)', 'gspffalice']);
    expect((await get(`/v3/server/rawcmd?cmd=who&token=${token}`)).body.response).toEqual(['Invalid command entered. Type /help for a list of valid commands.']);
    expect((await get(`/v2/world/save?token=${token}`)).body).toMatchObject({ response: 'World saved' });
    expect((await get(`/v2/server/off?token=${token}`)).status).toBe(400);
    expect((await get(`/v2/server/off?confirm=true&nosave=false&message=Bye&token=${token}`)).body).toMatchObject({ response: 'The server is shutting down' });
    expect(await f.exited).toBe(0);
    expect(f.lines).toContain('Saving before exit...');
  });

  it('keeps users and bans in a real SQLite database (hot backups snapshot it)', async () => {
    const dir = tempDir();
    const f = start('tshock', tshockArgs(dir), { env: { FAKE_TERRARIA_PLAYERS: 'gspffalice' } });
    await f.waitFor(/^gspffalice has joined\.$/);
    f.send('ban add gspffalice Test');
    await f.waitFor(/^gspffalice has left\.$/);
    f.send('exit');
    await f.exited;
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'tshock', 'tshock.sqlite'), { readOnly: true });
    try {
      expect(db.prepare('SELECT Identifier FROM PlayerBans').all()).toEqual([{ Identifier: 'name:gspffalice' }]);
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    } finally {
      db.close();
    }
    // Started again, it reads them back (their dates are .NET ticks, beyond JavaScript's safe integers) and keeps banning.
    const again = start('tshock', tshockArgs(dir), { dir, env: { FAKE_TERRARIA_PLAYERS: 'gspffalice' } });
    await again.waitFor(/was booted: #1 - You are banned: Test$/);
    again.send('ban list');
    await again.waitFor(/^\[1\] name:gspffalice$/);
  });
});

describe('fake-terraria server.mjs: tModLoader', () => {
  it('runs as `dotnet tModLoader.dll …` with the launcher in place of dotnet: logs in the working directory, the world in <save dir>/Worlds with its .twld, Workshop mods from enabled.json', async () => {
    const dir = tempDir();
    const ws = path.join(dir, '.workshop', 'steamapps', 'workshop');
    spawnSync(process.execPath, [STEAMCMD, '+force_install_dir', path.join(dir, '.workshop'), '+login', 'anonymous', '+workshop_download_item', '1281930', '2619954303', '+quit'], { env: { ...process.env, FAKE_TML_MOD_NAMES: '2619954303=RecipeBrowser' } });
    mkdirSync(path.join(dir, 'tml', 'Mods'), { recursive: true });
    writeFileSync(path.join(dir, 'tml', 'Mods', 'enabled.json'), '[\n  "RecipeBrowser"\n]');
    const install = path.join(dir, 'install');
    mkdirSync(install);
    const f = start('tmodloader', [path.join(install, 'tModLoader.dll'), '-server', '-nosteam', '-port', '7777', '-world', path.join(dir, 'worlds', 'm.wld'), '-autocreate', '1', '-worldname', 'm', '-tmlsavedirectory', path.join(dir, 'tml'), '-steamworkshopfolder', ws], { dir: install });
    await f.waitFor(PATTERNS.ready);
    expect(f.lines).toContain('Sandboxing: RecipeBrowser v1.0');
    expect(f.lines).toContain('Adding Content: tModLoader v2026.7.3.0');
    expect(existsSync(path.join(install, 'tModLoader-Logs', 'server.log'))).toBe(true);
    expect(readdirSync(path.join(dir, 'tml', 'Worlds')).sort()).toEqual(['m.twld', 'm.wld']);
    f.send('modlist');
    await f.waitFor(/^RecipeBrowser$/);
    f.send('version');
    await f.waitFor(/^Terraria Server v1\.4\.4\.9 - tModLoader v2026\.7\.3\.0$/);
    f.send('save');
    await f.waitFor(/^Saving modded world data$/);
    f.send('exit');
    expect(await f.exited).toBe(0);
  });

  it('takes from each Workshop item the folder tModLoader 2026.7 takes: not a newer one, not one of the 1.4.3 line (MOD-03)', async () => {
    const dir = tempDir();
    const content = path.join(dir, 'ws', 'content', '1281930');
    // As measured for Recipe Browser: 2022.9 (1.4.3) and 2026.7 are skipped or taken; a folder for a newer tModLoader is skipped.
    for (const [id, name, folders] of [
      ['1', 'Taken', ['2022.9', '2025.9', '2026.7', '2026.9']],
      ['2', 'OnlyLegacy', ['2022.9']],
      ['3', 'OnlyNewer', ['2027.1']],
    ] as const) {
      for (const v of folders) {
        mkdirSync(path.join(content, id, v), { recursive: true });
        writeFileSync(path.join(content, id, v, `${name}.tmod`), `${name} ${v}`);
      }
    }
    mkdirSync(path.join(dir, 'tml', 'Mods'), { recursive: true });
    writeFileSync(path.join(dir, 'tml', 'Mods', 'enabled.json'), JSON.stringify(['Taken', 'OnlyLegacy', 'OnlyNewer']));
    const f = start('tmodloader', ['-server', '-nosteam', '-port', '7777', '-world', path.join(dir, 'm.wld'), '-autocreate', '1', '-worldname', 'm', '-tmlsavedirectory', path.join(dir, 'tml'), '-steamworkshopfolder', path.join(dir, 'ws')], { dir });
    await f.waitFor(PATTERNS.ready);
    expect(f.lines.filter((l) => l.startsWith('Sandboxing: '))).toEqual(['Sandboxing: Taken v1.0']);
  });

  it('without a world: the menu, with its Mods List line, and it waits', async () => {
    const dir = tempDir();
    const f = start('tmodloader', ['-server', '-tmlsavedirectory', path.join(dir, 'tml')]);
    await f.waitFor(/^m\t\tMods List$/);
    expect(f.lines.some((l) => PATTERNS.worldMenu.test(l))).toBe(true);
    expect(f.child.exitCode).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('SIGTERM saves first and exits 0 (measured)', async () => {
    const dir = tempDir();
    const f = start('tmodloader', ['-server', '-nosteam', '-world', path.join(dir, 'tml', 'Worlds', 'm.wld'), '-autocreate', '1', '-worldname', 'm', '-tmlsavedirectory', path.join(dir, 'tml')]);
    await f.waitFor(PATTERNS.ready);
    f.child.kill('SIGTERM');
    expect(await f.exited).toBe(0);
    expect(f.lines).toContain('Saving before exit...');
  });
});

// --------------------------------------------------------------------- downloads and steamcmd
describe('fake-terraria downloads.mjs', () => {
  const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers: { 'user-agent': 'gsp-test', ...headers } });

  it("terraria.org: the names API lists only the newest (twice), zips by version, 404 'Not Found' otherwise", async () => {
    const s = await startFakeDownloads();
    try {
      expect(await (await get(`${s.url}/api/get/dedicated-servers-names`)).json()).toEqual(JSON.parse(fixture('vanilla', 'api', 'dedicated-servers-names.json')));
      const r = await get(`${s.url}/api/download/pc-dedicated-server/terraria-server-1458.zip`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-disposition')).toBe('attachment; filename="terraria-server-1458.zip"');
      const zip = Buffer.from(await r.arrayBuffer());
      expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');
      expect(zip.includes(Buffer.from('1458/Linux/TerrariaServer.bin.x86_64'))).toBe(true);
      const missing = await get(`${s.url}/api/download/pc-dedicated-server/terraria-server-9999.zip`);
      expect([missing.status, await missing.text()]).toEqual([404, 'Not Found']);
      expect(s.requests.every((q) => q.userAgent === 'gsp-test')).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("GitHub: TShock's and tModLoader's releases with sha256 digests that match, latest skips pre-releases, every call counts against 60 an hour (a 304 too)", async () => {
    const s = await startFakeDownloads();
    try {
      const r = await get(`${s.url}/repos/Pryaxis/TShock/releases/latest`);
      expect(r.headers.get('x-ratelimit-remaining')).toBe('59');
      const latest = (await r.json()) as { tag_name: string; assets: { name: string; digest: string; browser_download_url: string }[] };
      expect(latest.tag_name).toBe('v6.2.1');
      const a = latest.assets.find((x) => x.name === 'TShock-6.2.1-for-Terraria-1.4.5.8-linux-x64-Release.zip')!;
      const bytes = Buffer.from(await (await get(a.browser_download_url)).arrayBuffer());
      expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(a.digest);
      expect(latest.assets.map((x) => x.name)).toContain('TShock-6.2.1-for-Terraria-1.4.5.8-linux-arm64-Release.zip');
      const old = (await (await get(`${s.url}/repos/Pryaxis/TShock/releases/tags/v5.2.4`)).json()) as { assets: { name: string }[] };
      expect(old.assets.map((x) => x.name)).toContain('TShock-5.2.4-for-Terraria-1.4.4.9-linux-amd64-Release.zip');
      const tml = (await (await get(`${s.url}/repos/tModLoader/tModLoader/releases/latest`)).json()) as { tag_name: string; prerelease: boolean };
      expect(tml).toMatchObject({ tag_name: 'v2026.07.3.0', prerelease: false });
      const first = await get(`${s.url}/repos/tModLoader/tModLoader/releases?per_page=10`);
      const etag = first.headers.get('etag')!;
      const again = await get(`${s.url}/repos/tModLoader/tModLoader/releases?per_page=10`, { 'if-none-match': etag });
      expect(again.status).toBe(304);
      expect(Number(again.headers.get('x-ratelimit-remaining'))).toBe(Number(first.headers.get('x-ratelimit-remaining')) - 1);
    } finally {
      await s.close();
    }
  });

  it("a plugin's release downloads redirect to the asset host as github.com's do; latest redirects to the tag first (MOD-06)", async () => {
    const s = await startFakeDownloads();
    try {
      const rel = `${s.url}/gspff/HelloPlugin/releases`;
      const hop = await fetch(`${rel}/download/v1.0.0/HelloPlugin.dll`, { redirect: 'manual' });
      expect([hop.status, hop.headers.get('location')]).toEqual([302, `${s.url}/__release-assets/HelloPlugin.dll`]);
      expect((await fetch(`${rel}/latest/download/HelloPlugin.dll`, { redirect: 'manual' })).headers.get('location')).toBe('/gspff/HelloPlugin/releases/download/v1.0.0/HelloPlugin.dll');
      const dll = Buffer.from(await (await get(`${rel}/download/v1.0.0/HelloPlugin.dll`)).arrayBuffer());
      expect(dll.equals(fakePlugin('HelloPlugin'))).toBe(true);
      const zip = Buffer.from(await (await get(`${rel}/download/v1.0.0/HelloPlugins.zip`)).arrayBuffer());
      expect(zip.includes(Buffer.from('ServerPlugins/HelloLib.dll'))).toBe(true);
      expect(new URL((await fetch(`${rel}/download/v1.0.0/Elsewhere.dll`, { redirect: 'manual' })).headers.get('location')!).hostname).toBe('localhost');
      expect((await fetch(`${rel}/download/v1.0.0/Huge.dll`, { method: 'HEAD' })).headers.get('content-length')).toBe(String(16 * 1024 * 1024 + 1));
      expect((await get(`${rel}/download/v1.0.0/Nope.dll`)).status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it('failures: bad checksums (and truncated terraria.org zips), missing files, rate limits', async () => {
    const bad = await startFakeDownloads({ fail: 'bad-checksum' });
    const missing = await startFakeDownloads({ fail: 'not-found' });
    const limited = await startFakeDownloads({ fail: 'rate-limit' });
    try {
      const rel = (await (await get(`${bad.url}/repos/Pryaxis/TShock/releases/latest`)).json()) as { assets: { digest: string; browser_download_url: string }[] };
      const bytes = Buffer.from(await (await get(rel.assets[0]!.browser_download_url)).arrayBuffer());
      expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).not.toBe(rel.assets[0]!.digest);
      const zip = Buffer.from(await (await get(`${bad.url}/api/download/pc-dedicated-server/terraria-server-1458.zip`)).arrayBuffer());
      expect(zip.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(false); // no end-of-central-directory record
      expect((await get(`${missing.url}/api/download/pc-dedicated-server/terraria-server-1458.zip`)).status).toBe(404);
      const r = await get(`${limited.url}/repos/Pryaxis/TShock/releases`);
      expect(r.status).toBe(403);
      expect(r.headers.get('x-ratelimit-remaining')).toBe('0');
      expect(((await r.json()) as { message: string }).message).toMatch(/^API rate limit exceeded/);
    } finally {
      await Promise.all([bad.close(), missing.close(), limited.close()]);
    }
  });
});

describe('fake-terraria steamcmd.mjs', () => {
  it('app_update 1281930 anonymously "succeeds" and installs nothing, as measured; Workshop items land as <id>/<version>/<Mod>.tmod', () => {
    const dir = tempDir();
    const r = spawnSync(process.execPath, [STEAMCMD, '+force_install_dir', dir, '+login', 'anonymous', '+app_update', '1281930', 'validate', '+workshop_download_item', '1281930', '2619954303', '+quit'], { encoding: 'utf8' });
    expect(r.stdout).toContain("Success! App '1281930' fully installed.");
    expect(existsSync(path.join(dir, 'tModLoader.dll'))).toBe(false);
    expect(readFileSync(path.join(dir, 'steamapps', 'appmanifest_1281930.acf'), 'utf8')).toMatch(/"SizeOnDisk"\t\t"0"/);
    const item = path.join(dir, 'steamapps', 'workshop', 'content', '1281930', '2619954303');
    expect(readdirSync(item).sort()).toEqual(['2025.9', '2026.7', 'workshop.json']);
    expect(existsSync(path.join(item, '2026.7', 'Mod2619954303.tmod'))).toBe(true);
    expect(r.stdout).toMatch(/Success\. Downloaded item 2619954303 to ".*" \(123 bytes\)/);
    const real = fixture('tmodloader', 'steamcmd', 'workshop-download.log');
    expect(real).toMatch(/Success\. Downloaded item 2619954303 to ".*" \(\d+ bytes\)/);
  });
});

describe('fake-game.mjs picks the Terraria fakes by adapter id', () => {
  it('GAME_ADAPTER=terraria runs tools/fake-terraria/server.mjs and steamcmd.mjs', () => {
    const dir = tempDir();
    const fakeGame = path.join(here, '..', 'fake-orchestrator', 'fake-game.mjs');
    const r = spawnSync(process.execPath, [fakeGame, 'server', '-port', '7777', '-world', path.join(dir, 'nope.wld')], { cwd: dir, encoding: 'utf8', env: { ...process.env, GAME_ADAPTER: 'terraria', FAKE_TERRARIA_FLAVOUR: 'vanilla' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Error Logging Enabled\./);
    const s = spawnSync(process.execPath, [fakeGame, 'steamcmd', '+force_install_dir', dir, '+login', 'anonymous', '+app_update', '1281930', '+quit'], { encoding: 'utf8', env: { ...process.env, GAME_ADAPTER: 'terraria' } });
    expect(s.stdout).toContain("Success! App '1281930' fully installed.");
  });
});
