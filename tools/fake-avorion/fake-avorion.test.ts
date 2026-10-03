// The Avorion fake against what the real server did (fixtures/avorion/2.5.13,
// docs/verification/avorion-2.5.13.md): the line patterns a manifest will rely on match the real
// captures and the fake alike, and the fake's console, server.ini rewrites, saves, Steam queries
// and failures behave like the measured ones.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, 'server.mjs');
const STEAMCMD = path.join(here, 'steamcmd.mjs');
const FIXTURES = path.join(here, '..', '..', 'fixtures', 'avorion', '2.5.13');
const fixture = (...p: string[]) => readFileSync(path.join(FIXTURES, ...p), 'utf8');
const lines = (text: string) => text.trimEnd().split('\n').filter((l) => !l.startsWith('# ')).map((l) => l.replace(/^\[stderr\] /, ''));
const onWindows = process.platform === 'win32';

/** Log line patterns a manifest will rely on; each must match the real captures and the fake. */
const PATTERNS = {
  ready: /^Server startup complete\.$/,
  version: /^Avorion server (\d+\.\d+\.\d+) (\w+) running on /,
  saved: /^All sectors saved successfully\.$/,
  stopped: /^Server shutdown successful\.$/,
  failed: /^Server startup FAILED\.$|^An exception occurred: /,
  steamFallback: /^Error starting steam-based networking\. Falling back/,
  steamUnreachable: /^Server failed to connect to Steam$/,
  players: /^online players \((\d+)\):$/,
  join: /^Player logged in: (.+), index: \d+$/,
  leave: /^Player logged off: (.+)$/,
};

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
  const d = mkdtempSync(path.join(os.tmpdir(), 'gsp-fake-av-'));
  dirs.push(d);
  return d;
}

function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    s.bind(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function start(args: string[], o: { dir?: string; cwd?: string; env?: Record<string, string> } = {}): Fake {
  const dir = o.dir ?? tempDir();
  const child = spawn(process.execPath, [SERVER, ...args], {
    cwd: o.cwd ?? dir,
    env: { ...process.env, HOME: dir, FAKE_AVORION_BOOT_MS: '30', FAKE_AVORION_SAVE_MS: '20', ...o.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const got: string[] = [];
  const waiters = new Set<{ re: RegExp; resolve: (l: string) => void }>();
  const reader = () => {
    let buf = '';
    return (d: Buffer) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
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

/** The launch a manifest will make: the galaxy in the data root, every port given, crash reports off. */
async function launch(dir: string, extra: string[] = []) {
  const [game, query, steamQuery, steamMaster] = [await freeUdpPort(), await freeUdpPort(), await freeUdpPort(), await freeUdpPort()];
  return {
    ports: { game, query, steamQuery, steamMaster },
    args: ['--galaxy-name', 'g1', '--datapath', dir, '--server-name', 'gspff test', '--port', String(game), '--query-port', String(query), '--steam-query-port', String(steamQuery), '--steam-master-port', String(steamMaster), '--send-crash-reports', 'false', ...extra],
  };
}

function a2s(port: number, type: 0x54 | 0x55 | 0x56): Promise<Buffer | null> {
  const body = type === 0x54 ? Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from('Source Engine Query\0', 'latin1')]) : Buffer.from([0xff, 0xff, 0xff, 0xff, type, 0xff, 0xff, 0xff, 0xff]);
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => {
      s.close();
      resolve(null);
    }, 1000 * SCALE);
    s.on('message', (m) => {
      clearTimeout(t);
      s.close();
      resolve(m);
    });
    s.send(body, port, '127.0.0.1');
  });
}

afterEach(async () => {
  for (const f of running.splice(0)) {
    if (f.child.exitCode === null) f.child.kill('SIGKILL');
    await f.exited;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// --------------------------------------------------------------------- the real captures
describe('the patterns a manifest will use match the real captures', () => {
  it('first boot: version, ready, the console, /save, /stop', () => {
    const l = lines(fixture('logs', 'first-boot-console-then-stop.log'));
    expect(l.find((x) => PATTERNS.version.test(x))).toMatch(/^Avorion server 2\.5\.13 0417ab29738c running on /);
    expect(l.filter((x) => PATTERNS.ready.test(x))).toHaveLength(1);
    expect(l).toContain('send crash reports: yes'); // the default: the manifest turns it off
    expect(l.find((x) => PATTERNS.players.test(x))).toBe('online players (0):');
    const save = l.indexOf('> /save');
    expect(l.slice(save, save + 6)).toEqual(['> /save', 'Saving all server data.', 'Triggered saving of all server data.', 'All sectors saved successfully.', '> /stop', 'Cleaning up entity transfers ...']);
    expect(l.at(-1)).toMatch(PATTERNS.stopped);
  });

  it('moderation answers, unknown commands, text without a slash', () => {
    const l = lines(fixture('logs', 'existing-moderation-commands-then-sigterm.log'));
    const after = (typed: string) => l[l.indexOf(typed) + 1];
    expect(after('> /version')).toBe('Server Version: 2.5.13 0417ab29738c');
    expect(after('> /say hello from gspff')).toBe('<Server> hello from gspff ');
    expect(after('> /kick gspffnobody')).toBe('Player gspffnobody is not online.');
    expect(after('> /ban gspffnobody')).toBe('Player gspffnobody not found.');
    expect(after('> /banip 192.0.2.77')).toBe('Player 192.0.2.77 not found');
    expect(after('> /unbanip 192.0.2.77')).toBe('Ip 192.0.2.77 was not blacklisted');
    expect(after('> /notacommand')).toBe('Unknown command: "notacommand". To see all available commands type "/help"');
    expect(after('> say plain words')).toBe("Invalid command formatting. Commands must begin with a '/' character.");
    // SIGTERM saves and exits like /stop
    expect(l.slice(l.indexOf('Server is shutting down.')).some((x) => x === 'Saving sectors...')).toBe(true);
    expect(l.at(-1)).toMatch(PATTERNS.stopped);
  });

  it('failures: ports taken, a wrong working directory, an unwritable galaxy; no network falls back', () => {
    const ports = lines(fixture('logs', 'fail-ports-in-use.log'));
    expect(ports.some((x) => PATTERNS.steamFallback.test(x))).toBe(true);
    expect(ports.filter((x) => PATTERNS.failed.test(x))).toEqual(['Server startup FAILED.']);
    expect(ports.some((x) => PATTERNS.ready.test(x))).toBe(false);
    for (const f of ['fail-wrong-working-directory.log', 'fail-readonly-datapath.log']) {
      const x = lines(fixture('logs', f));
      expect(x.some((y) => /^An exception occurred: /.test(y))).toBe(true);
      expect(x.some((y) => PATTERNS.ready.test(y))).toBe(false);
    }
    const offline = lines(fixture('logs', 'no-network-fallback.log'));
    expect(offline.filter((x) => PATTERNS.steamUnreachable.test(x)).length).toBeGreaterThanOrEqual(3);
    expect(offline.some((x) => PATTERNS.ready.test(x))).toBe(true);
  });

  it('server.ini: command-line values written back; edits made while running lost, while stopped kept', () => {
    const first = fixture('config', 'server.ini.after-first-boot');
    expect(first).toMatch(/^name=gspff test$/m);
    expect(first).toMatch(/^sendCrashReports=true$/m);
    const later = fixture('config', 'server.ini.after-later-runs');
    expect(later).toMatch(/^maxPlayers=8$/m); // --max-players 8 of an earlier run, never passed again
    expect(later).toMatch(/^motd=edited while stopped$/m);
    expect(later).toMatch(/^backupsPath=\/data\/avorion-backups$/m);
    expect(later).not.toMatch(/Gspff|comment of our own/);
    expect(fixture('tree', 'ini-edit-while-running.txt')).toMatch(/== after \/save[^\n]*\n69:motd=$/m);
  });

  it('Steam queries answer only on a listed server', () => {
    const a = JSON.parse(fixture('a2s', 'listed.json')) as { info: { players: number; maxPlayers: number; port: number; gameId: string }; players: { count: number }; rules: { count: number } };
    expect(a.info).toMatchObject({ players: 0, maxPlayers: 8, port: 27000, gameId: '445220' });
    expect(a.players.count).toBe(0);
    expect(a.rules.count).toBe(9);
  });
});

// --------------------------------------------------------------------- the fake server
describe('fake-avorion server.mjs', () => {
  it('first boot: the galaxy files, the ready line, the console; /save and /stop', async () => {
    const dir = tempDir();
    const { args } = await launch(dir);
    const f = start(args, { dir });
    // a command typed before the server is up waits for it
    f.send('/version');
    await f.waitFor(PATTERNS.ready);
    await f.waitFor(/^Server Version: 2\.5\.13 0417ab29738c$/);
    const g = path.join(dir, 'g1');
    for (const n of ['server.ini', 'admin.xml', 'blacklist.txt', 'whitelist.txt', 'ipblacklist.txt', 'server.dat.0']) expect(existsSync(path.join(g, n))).toBe(true);
    expect(readFileSync(path.join(g, 'server.ini'), 'utf8')).toMatch(/^sendCrashReports=false$/m);
    f.send('/players');
    await f.waitFor(/^online players \(0\):$/);
    f.send('say no slash');
    await f.waitFor(/^Invalid command formatting/);
    f.send('/nope');
    await f.waitFor(/^Unknown command: "nope"/);
    f.send('/save');
    await f.waitFor(PATTERNS.saved);
    f.send('/stop');
    expect(await f.exited).toBe(0);
    expect(f.lines.at(-1)).toMatch(PATTERNS.stopped);
  });

  it('server.ini: unknown keys and comments dropped at start, values kept, command-line values written back', async () => {
    const dir = tempDir();
    const g = path.join(dir, 'g1');
    mkdirSync(g, { recursive: true });
    writeFileSync(path.join(g, 'server.ini'), '[Game]\n; ours\nUnknownKey=1\nmotd=hello\n[Administration]\nmaxPlayers=4\n');
    const { args } = await launch(dir, ['--max-players', '6']);
    const f = start(args, { dir });
    await f.waitFor(PATTERNS.ready);
    const ini = readFileSync(path.join(g, 'server.ini'), 'utf8');
    expect(ini).toMatch(/^motd=hello$/m);
    expect(ini).toMatch(/^maxPlayers=6$/m);
    expect(ini).not.toMatch(/UnknownKey|; ours/);
    // an edit while running is lost at the next save
    writeFileSync(path.join(g, 'server.ini'), ini.replace('motd=hello', 'motd=changed'));
    f.send('/save');
    await f.waitFor(PATTERNS.saved);
    expect(readFileSync(path.join(g, 'server.ini'), 'utf8')).toMatch(/^motd=hello$/m);
  });

  it('autosaves are silent; save files rotate', async () => {
    const dir = tempDir();
    const { args } = await launch(dir, ['--save-interval', '1']);
    const f = start(args, { dir, env: { FAKE_AVORION_INTERVAL_MS_PER_S: '50' } });
    await f.waitFor(PATTERNS.ready);
    await new Promise((r) => setTimeout(r, 300 * SCALE));
    const names = readdirSync(path.join(dir, 'g1'));
    expect(names.filter((n) => /^server\.dat\.\d$/.test(n)).sort()).toEqual(['server.dat.0', 'server.dat.1', 'server.dat.2']);
    expect(f.lines.some((l) => /Sav/.test(l))).toBe(false);
  });

  it('Steam queries on the Steam query port when listed; players from the test hooks', async () => {
    const dir = tempDir();
    const { args, ports } = await launch(dir, ['--listed', 'true', '--max-players', '8']);
    const f = start(args, { dir });
    await f.waitFor(PATTERNS.ready);
    const info = await a2s(ports.steamQuery, 0x54);
    expect(info?.readUInt8(4)).toBe(0x49);
    expect(info!.toString('utf8')).toContain('gspff test');
    f.send('fake-join gspffalice');
    await f.waitFor(/^Player logged in: gspffalice, index: 1$/);
    expect((await a2s(ports.steamQuery, 0x55))?.readUInt8(5)).toBe(1);
    expect((await a2s(ports.steamQuery, 0x56))?.readUInt16LE(5)).toBe(9);
    f.send('/kick gspffalice');
    await f.waitFor(/^Player logged off: gspffalice$/);
    f.send('/stop');
    await f.exited;
    const unlisted = await launch(tempDir());
    const g = start(unlisted.args);
    await g.waitFor(PATTERNS.ready);
    expect(await a2s(unlisted.ports.steamQuery, 0x54)).toBeNull();
  });

  it('ports taken: the Steam query port falls back, the query port fails the start (exit 0)', async () => {
    const dir = tempDir();
    const { args, ports } = await launch(dir);
    const holders = [dgram.createSocket('udp4'), dgram.createSocket('udp4')];
    await new Promise<void>((r) => holders[0]!.bind(ports.steamQuery, '127.0.0.1', () => r()));
    await new Promise<void>((r) => holders[1]!.bind(ports.query, '127.0.0.1', () => r()));
    try {
      const f = start(args, { dir });
      expect(await f.exited).toBe(0);
      expect(f.lines.some((l) => PATTERNS.steamFallback.test(l))).toBe(true);
      expect(f.lines).toContain('Server startup FAILED.');
      expect(f.lines.some((l) => PATTERNS.ready.test(l))).toBe(false);
    } finally {
      for (const h of holders) h.close();
    }
  });

  it('scenarios: crash-on-boot, crash-after-ready, never-ready, a wrong working directory', async () => {
    const boot = start((await launch(tempDir())).args, { env: { FAKE_AVORION_SCENARIO: 'crash-on-boot' } });
    expect(await boot.exited).toBe(0);
    expect(boot.lines.some((l) => /^An exception occurred: .*cannot open file$/.test(l))).toBe(true);
    const after = start((await launch(tempDir())).args, { env: { FAKE_AVORION_SCENARIO: 'crash-after-ready', FAKE_AVORION_CRASH_MS: '100' } });
    await after.waitFor(PATTERNS.ready);
    expect(await after.exited).toBe(1);
    const never = start((await launch(tempDir())).args, { env: { FAKE_AVORION_SCENARIO: 'never-ready' } });
    await never.waitFor(PATTERNS.steamUnreachable);
    await new Promise((r) => setTimeout(r, 200));
    expect(never.lines.some((l) => PATTERNS.ready.test(l))).toBe(false);
    const install = tempDir();
    const cwd = start((await launch(tempDir())).args, { env: { FAKE_AVORION_INSTALL_DIR: install } });
    expect(await cwd.exited).toBe(0);
    expect(cwd.lines.some((l) => /^An exception occurred: /.test(l))).toBe(true);
  });

  it('ignore-stop: /stop does nothing', async () => {
    const f = start((await launch(tempDir())).args, { env: { FAKE_AVORION_SCENARIO: 'ignore-stop' } });
    await f.waitFor(PATTERNS.ready);
    f.send('/stop');
    await new Promise((r) => setTimeout(r, 300));
    expect(f.child.exitCode).toBeNull();
  });

  // Windows has no signals a child can handle: there this runs in a Linux container (see the README).
  it.skipIf(onWindows)('SIGINT and SIGTERM save and exit 0', async () => {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      const f = start((await launch(tempDir())).args);
      await f.waitFor(PATTERNS.ready);
      f.child.kill(sig);
      expect(await f.exited).toBe(0);
      expect(f.lines).toContain('Saving sectors...');
    }
  });
});

// --------------------------------------------------------------------- the fake steamcmd
describe('fake-avorion steamcmd.mjs', () => {
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [STEAMCMD, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

  it('installs the public build and a branch, and lists the branches the real one showed', () => {
    const dir = tempDir();
    expect(run(['+force_install_dir', dir, '+login', 'anonymous', '+app_update', '565060', 'validate', '+quit']).stdout).toContain("Success! App '565060' fully installed.");
    expect(readFileSync(path.join(dir, 'steamapps', 'appmanifest_565060.acf'), 'utf8')).toMatch(/"buildid"\t\t"22295362"/);
    expect(existsSync(path.join(dir, 'bin', 'AvorionServer'))).toBe(true);
    const real = fixture('steamcmd', 'app-info-565060.vdf');
    const listed = run(['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', '565060', '+quit']).stdout;
    for (const b of ['public', 'beta', 'previous', '2.5.2']) {
      const id = new RegExp(`"${b.replace(/\./g, '\\.')}"\\s*\\{\\s*"buildid"\\s*"(\\d+)"`).exec(real)![1];
      expect(listed).toMatch(new RegExp(`"${b.replace(/\./g, '\\.')}"\\s*\\{\\s*"buildid"\\t\\t"${id}"`));
    }
  });

  it('keeps an install on its beta branch when none is named, and moves it with -beta public (as measured, HST-09)', () => {
    const real = readFileSync(path.join(here, '..', '..', 'fixtures', 'shared-installs', 'steamcmd', 'branch-switch.txt'), 'utf8');
    expect(real).toContain("Success! App '565060' already up to date.");
    const dir = tempDir();
    const update = (...beta: string[]) => run(['+force_install_dir', dir, '+login', 'anonymous', '+app_update', '565060', ...beta, '+quit']).stdout;
    const manifest = () => readFileSync(path.join(dir, 'steamapps', 'appmanifest_565060.acf'), 'utf8');
    expect(update('-beta', 'previous')).toContain('fully installed');
    expect(manifest()).toMatch(/"BetaKey"\t\t"previous"/);
    expect(update()).toContain("Success! App '565060' already up to date.");
    expect(manifest()).toMatch(/"buildid"\t\t"21146556"/);
    expect(update('-beta', 'public')).toContain('fully installed');
    expect(manifest()).toMatch(/"buildid"\t\t"22295362"/);
    expect(manifest()).toMatch(/"BetaKey"\t\t"public"/);
  });

  it('fails like a fresh steamcmd did on its first install: Missing configuration', () => {
    const real = fixture('steamcmd', 'app-update-565060-first-try.log');
    expect(real).toContain("ERROR! Failed to install app '565060' (Missing configuration)");
    expect(run(['+force_install_dir', tempDir(), '+login', 'anonymous', '+app_update', '565060', '+quit'], { FAKE_STEAMCMD_FAIL: 'missing-config' }).stdout).toContain("ERROR! Failed to install app '565060' (Missing configuration)");
  });
});
