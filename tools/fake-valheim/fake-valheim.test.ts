// The Valheim fake against what the real server did (fixtures/valheim/1.0.16,
// docs/verification/valheim-1.0.16.md): the line patterns an adapter will rely on match the real
// captures and the fake alike, and the fake's files, sockets, Steam queries, saves and failures
// behave like the measured ones.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, 'server.mjs');
const STEAMCMD = path.join(here, 'steamcmd.mjs');
const FIXTURES = path.join(here, '..', '..', 'fixtures', 'valheim', '1.0.16');
const fixture = (...p: string[]) => readFileSync(path.join(FIXTURES, ...p), 'utf8');
const onWindows = process.platform === 'win32';

/** A line without Valheim's own "MM/DD/YYYY HH:MM:SS: " stamp (Unity's lines have none). */
const bare = (line: string) => line.replace(/^\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d: /, '');
const lines = (text: string) => text.split('\n').filter((l) => !l.startsWith('# ')).map(bare);

/** Log line patterns an adapter (or manifest) will rely on, on `bare` lines; each must match the real captures and the fake. */
const PATTERNS = {
  ready: /^Opened (?:Steam|PlayFab) server$/,
  version: /^Valheim version: (l-\d+(?:\.\d+)+) \(network version (\d+)\)$/,
  saved: /^World save \(5\/5\) done\. Total time \[\d+ms\]$/,
  saveNumber: /^World save \(1\/5\) Cloud & Backup checks done \[\d+ms\] => Save number (\d+)$/,
  stopping: /^Game - OnApplicationQuit$/,
  badPassword: /^Error bad password:(.+)$/,
  steamInitFailed: /^\[Steamworks\.NET\] GameServer\.Init\(\) failed\.$|^Awake of network backend failed$/,
  worldLoadFailed: /^World load failed/,
  savingDisabled: /saving has been disabled/,
  readOnly: /^IOException: Read-only file system$/,
  steamUnreachable: /^Game server connected failed$/,
  joinCode: /^Session "(.+)" registered with join code (\d+)$/,
  locationProgress: /^(?:Location \S+ took more than 0\.5 seconds to place|Failed to place all \S+, placed)/,
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
  const d = mkdtempSync(path.join(os.tmpdir(), 'gsp-fake-vh-'));
  dirs.push(d);
  return d;
}

function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    // Valheim's query port is the game port + 1: both must be free.
    s.bind(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => {
        const t = dgram.createSocket('udp4');
        t.once('error', () => resolve(freeUdpPort()));
        t.bind(p + 1, '127.0.0.1', () => t.close(() => resolve(p)));
      });
    });
  });
}

function start(args: string[], o: { dir?: string; env?: Record<string, string> } = {}): Fake {
  const dir = o.dir ?? tempDir();
  const child = spawn(process.execPath, [SERVER, ...args], {
    cwd: dir,
    env: { ...process.env, HOME: dir, FAKE_VALHEIM_BOOT_MS: '30', FAKE_VALHEIM_GEN_MS: '20', FAKE_VALHEIM_STOP_MS: '20', ...o.env },
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

/** Waits for a condition on what the fake printed (checked as each line arrives would be: every 10 ms). */
async function until(ok: () => boolean, ms = 20_000 * SCALE): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The launch an adapter will make (savedir in the data root). */
const launch = (dir: string, port: number, extra: string[] = []) => ['-nographics', '-batchmode', '-name', 'gspff test', '-port', String(port), '-world', 'w1', '-password', 'secret12', '-public', '0', '-savedir', dir, ...extra];

/** One A2S request (no challenge step: the real server answered at once); null after 1 s. */
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
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o755);
      for (const e of readdirSync(d)) chmodSync(path.join(d, e), 0o755);
    } catch {
      // nothing made read-only
    }
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// --------------------------------------------------------------------- the real captures
describe('the patterns an adapter will use match the real captures', () => {
  it('ready, version and saves: a first boot and an existing world', () => {
    const first = lines(fixture('logs', 'first-boot-then-sigterm.log'));
    expect(first.filter((l) => PATTERNS.ready.test(l))).toEqual(['Opened Steam server']);
    expect(first.find((l) => PATTERNS.version.test(l))).toBe('Valheim version: l-1.0.16 (network version 40)');
    // World generation comes before the ready line, as a run of location lines.
    const ready = first.findIndex((l) => PATTERNS.ready.test(l));
    const gen = first.findIndex((l) => PATTERNS.locationProgress.test(l));
    expect(gen).toBeGreaterThan(0);
    expect(gen).toBeLessThan(ready);
    expect(first.filter((l) => PATTERNS.locationProgress.test(l)).length).toBeGreaterThan(20);
    // "Game server connected" is Steam's, not readiness: on the first boot it came before the world existed.
    expect(first.indexOf('Game server connected')).toBeLessThan(ready);
    // stdin is ignored: the words typed produced nothing
    for (const typed of ['> help', '> save', '> info']) expect(first[first.indexOf(typed) + 1]).toMatch(/^> |^Game - OnApplicationQuit$|^$/);
    // the stop saved: a numbered save, done
    const stop = first.findIndex((l) => PATTERNS.stopping.test(l));
    expect(first.slice(stop).some((l) => PATTERNS.saved.test(l))).toBe(true);

    const existing = lines(fixture('logs', 'existing-world-autosaves-then-sigint.log'));
    expect(existing.filter((l) => PATTERNS.ready.test(l))).toHaveLength(1);
    expect(existing.filter((l) => PATTERNS.saved.test(l)).length).toBeGreaterThanOrEqual(8);
    expect(existing.filter((l) => PATTERNS.saveNumber.test(l)).map((l) => Number(PATTERNS.saveNumber.exec(l)![1]))).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(existing.some((l) => PATTERNS.locationProgress.test(l))).toBe(false);
  });

  it('failed starts: password rules, a taken query port, a corrupt world, an unwritable save folder', () => {
    expect(lines(fixture('logs', 'fail-password-too-short-public.log')).find((l) => PATTERNS.badPassword.test(l))).toBe('Error bad password:The password is too short');
    expect(lines(fixture('logs', 'fail-no-password-public.log')).find((l) => PATTERNS.badPassword.test(l))).toBe('Error bad password:The password is too short');
    expect(lines(fixture('logs', 'fail-password-in-name.log')).find((l) => PATTERNS.badPassword.test(l))).toBe('Error bad password:Invalid password');
    // a private server takes a short password, and none at all
    for (const f of ['private-short-password.log', 'private-no-password-other-port.log']) {
      const l = lines(fixture('logs', f));
      expect(l.some((x) => PATTERNS.badPassword.test(x))).toBe(false);
      expect(l.some((x) => PATTERNS.ready.test(x))).toBe(true);
    }
    for (const f of ['fail-password-too-short-public.log', 'fail-no-password-public.log', 'fail-password-in-name.log', 'fail-query-port-in-use.log']) expect(lines(fixture('logs', f)).some((l) => PATTERNS.ready.test(l))).toBe(false);
    const taken = lines(fixture('logs', 'fail-query-port-in-use.log'));
    expect(taken).toContain('[Steamworks.NET] GameServer.Init() failed.');
    expect(taken).toContain('Awake of network backend failed');
    // a corrupt world: the fatal line, then the ready line anyway, then a quit without saving
    const corrupt = lines(fixture('logs', 'fail-corrupt-world.log'));
    const failed = corrupt.findIndex((l) => PATTERNS.worldLoadFailed.test(l));
    expect(failed).toBeGreaterThan(0);
    expect(corrupt.findIndex((l) => PATTERNS.ready.test(l))).toBeGreaterThan(failed);
    expect(corrupt.some((l) => PATTERNS.savingDisabled.test(l))).toBe(true);
    expect(corrupt).toContain('Skipping world save');
    const ro = lines(fixture('logs', 'never-ready-readonly-savedir.log'));
    expect(ro.some((l) => PATTERNS.readOnly.test(l))).toBe(true);
    expect(ro.some((l) => PATTERNS.ready.test(l))).toBe(false);
  });

  it('a taken game port is silent: ready, but no listening socket to stop', () => {
    const silent = lines(fixture('logs', 'game-port-in-use-silent.log'));
    expect(silent.some((l) => PATTERNS.ready.test(l))).toBe(true);
    expect(silent).not.toContain('Stopping listening socket');
    expect(lines(fixture('logs', 'first-boot-then-sigterm.log'))).toContain('Stopping listening socket');
  });

  it('no network: ready anyway, then Steam keeps failing', () => {
    const l = lines(fixture('logs', 'no-network.log'));
    expect(l.some((x) => PATTERNS.ready.test(x))).toBe(true);
    expect(l.filter((x) => PATTERNS.steamUnreachable.test(x)).length).toBeGreaterThanOrEqual(3);
  });

  it('crossplay: PlayFab instead of Steam, a join code only with its libraries', () => {
    const with_ = lines(fixture('logs', 'crossplay.log'));
    expect(with_.filter((l) => PATTERNS.ready.test(l))).toEqual(['Opened PlayFab server']);
    expect(with_.find((l) => PATTERNS.joinCode.test(l))).toBe('Session "gspff test" registered with join code 123456');
    const without = lines(fixture('logs', 'crossplay-missing-libraries.log'));
    expect(without.some((l) => /^DllNotFoundException: libParty\.so/.test(l))).toBe(true);
    expect(without.some((l) => PATTERNS.joinCode.test(l))).toBe(false);
  });

  it('-logfile moves the log out of stdout', () => {
    expect(lines(fixture('logs', 'logfile-stdout.log')).some((l) => PATTERNS.ready.test(l))).toBe(false);
    const file = lines(fixture('logs', 'logfile-file.log'));
    expect(file.some((l) => PATTERNS.ready.test(l))).toBe(true);
    expect(file).toContain('Setting world modifier preset: hard');
    expect(file).toContain('Setting world modifier: raids->none');
  });

  it('saves: a numbered set, the .ok marker last, the previous set removed after it', () => {
    const ev = fixture('tree', 'save-file-events.txt').split('\n').filter((l) => /\[fs\]/.test(l)).slice(0, 15);
    const order = ev.map((l) => /\/(_main\.\d+\.\w+|00_00__0_\d+\.chunk)/.exec(l)![1]);
    expect(order.indexOf('_main.2.ok')).toBeGreaterThan(order.indexOf('_main.2.db2'));
    expect(order.indexOf('_main.2.ok')).toBeLessThan(order.indexOf('_main.1.db2'));
    expect(ev.filter((l) => /_main\.1\./.test(l)).every((l) => /\(gone\)$/.test(l))).toBe(true);
  });

  it('Steam queries answer only on a public server', () => {
    const pub = JSON.parse(fixture('a2s', 'public.json')) as { info: { players: number; maxPlayers: number; port: number; keywords: string } };
    expect(pub.info).toMatchObject({ players: 0, maxPlayers: 10, port: 2456, keywords: 'g=1.0.16,n=40,m=' });
    expect(JSON.parse(fixture('a2s', 'private.json'))).toEqual({ info: null, players: null, rules: null });
  });
});

// --------------------------------------------------------------------- the fake server
describe('fake-valheim server.mjs', () => {
  it('a first boot: the lists, a new world, the ready line; then a numbered save on an interval, the previous one gone', async () => {
    const dir = tempDir();
    const port = await freeUdpPort();
    const f = start(launch(dir, port, ['-saveinterval', '1']), { dir, env: { FAKE_VALHEIM_SAVE_MS_PER_S: String(400 * SCALE) } });
    await f.waitFor(PATTERNS.ready);
    expect(f.lines).toContain('Valheim version: l-1.0.16 (network version 40)');
    expect(f.lines.some((l) => PATTERNS.locationProgress.test(l))).toBe(true);
    expect(readFileSync(path.join(dir, 'bannedlist.txt'), 'utf8')).toBe('// List banned players ID  ONE per line\n');
    expect(readdirSync(path.join(dir, 'worlds_local', 'w1'))).toEqual(['_main.0.fwl2']);
    // saves 1, 2, 3 (a new world's first save is number 1)
    for (let i = 0; i < 200 && f.lines.filter((l) => PATTERNS.saved.test(l)).length < 3; i++) await new Promise((r) => setTimeout(r, 20 * SCALE));
    expect(f.lines.filter((l) => PATTERNS.saveNumber.test(l)).slice(0, 3).map((l) => PATTERNS.saveNumber.exec(l)![1])).toEqual(['1', '2', '3']);
    const now = readdirSync(path.join(dir, 'worlds_local', 'w1')).sort();
    expect(now.filter((n) => n.endsWith('.ok'))).toHaveLength(1);
    expect(now.some((n) => /_main\.[12]\./.test(n))).toBe(false);
    // stdin is ignored, except the fake's own test hooks
    f.send('save');
    f.send('help');
    await new Promise((r) => setTimeout(r, 100));
    expect(f.lines.some((l) => /help|Unknown/.test(l))).toBe(false);
  });

  it('a save can take its time step by step: caught half written, the previous complete set is still whole', async () => {
    const dir = tempDir();
    // A save every 3 s whose 5 steps take 150 ms each.
    const f = start(launch(dir, await freeUdpPort(), ['-saveinterval', '1']), { dir, env: { FAKE_VALHEIM_SAVE_MS_PER_S: String(3000 * SCALE), FAKE_VALHEIM_SAVE_STEP_MS: String(150 * SCALE) } });
    const world = () => readdirSync(path.join(dir, 'worlds_local', 'w1')).sort();
    await f.waitFor(/^World save \(1\/5\) .* => Save number 2$/, 20_000 * SCALE);
    // Set 2 being written, its database done (no .fwl2 or .ok yet); set 1 complete and still there.
    await until(() => f.lines.slice(f.lines.findIndex((l) => / => Save number 2$/.test(l))).some((l) => /^World save \(3\/5\) /.test(l)));
    expect(world()).toEqual(['00_00__0_1.chunk', '00_00__0_2.chunk', '_main.1.chunks', '_main.1.db2', '_main.1.fwl2', '_main.1.ok', '_main.2.chunks', '_main.2.db2']);
    await until(() => f.lines.filter((l) => PATTERNS.saved.test(l)).length >= 2);
    expect(world()).toEqual(['00_00__0_2.chunk', '_main.2.chunks', '_main.2.db2', '_main.2.fwl2', '_main.2.ok']);
  });

  it('fake-hold-save holds saves half written until fake-release-save (a test hook)', async () => {
    const dir = tempDir();
    const f = start(launch(dir, await freeUdpPort(), ['-saveinterval', '1']), { dir, env: { FAKE_VALHEIM_SAVE_MS_PER_S: '100' } });
    await f.waitFor(PATTERNS.saved);
    f.send('fake-hold-save');
    const count = (re: RegExp) => f.lines.filter((l) => re.test(l)).length;
    // A save got to its chunk files and stopped there.
    await until(() => count(/^World save \(2\/5\) /) > count(PATTERNS.saved));
    const n = Number(PATTERNS.saveNumber.exec(f.lines.findLast((l) => PATTERNS.saveNumber.test(l))!)![1]);
    await new Promise((r) => setTimeout(r, 300));
    expect(count(PATTERNS.saved)).toBe(n - 1);
    const world = readdirSync(path.join(dir, 'worlds_local', 'w1')).sort();
    expect(world).toEqual([`00_00__0_${n - 1}.chunk`, `00_00__0_${n}.chunk`, `_main.${n - 1}.chunks`, `_main.${n - 1}.db2`, `_main.${n - 1}.fwl2`, `_main.${n - 1}.ok`, `_main.${n}.chunks`].sort());
    f.send('fake-release-save');
    await until(() => count(PATTERNS.saved) >= n);
  });

  it('a chunk nothing changed keeps its file and version (FAKE_VALHEIM_DIRTY_SAVES=first, as in the adapter check); fake-dirty writes the next one', async () => {
    const dir = tempDir();
    const f = start(launch(dir, await freeUdpPort(), ['-saveinterval', '1']), { dir, env: { FAKE_VALHEIM_SAVE_MS_PER_S: '100', FAKE_VALHEIM_DIRTY_SAVES: 'first' } });
    const count = (re: RegExp) => f.lines.filter((l) => re.test(l)).length;
    const world = () => readdirSync(path.join(dir, 'worlds_local', 'w1')).sort();
    const lastSave = () => Number(PATTERNS.saveNumber.exec(f.lines.findLast((l) => PATTERNS.saveNumber.test(l))!)![1]);
    /** Holds the next save half written, and says its number. */
    const freeze = async () => {
      f.send('fake-hold-save');
      await until(() => count(/^World save \(2\/5\) /) > count(PATTERNS.saved));
      return lastSave();
    };
    await until(() => count(PATTERNS.saved) >= 3);
    let n = await freeze();
    expect(world()).toEqual(['00_00__0_1.chunk', ...['chunks', 'db2', 'fwl2', 'ok'].map((x) => `_main.${n - 1}.${x}`), `_main.${n}.chunks`].sort());
    const dirty = f.lines.flatMap((l) => /Number of dirty chunks to save: (\d+)/.exec(l)?.[1] ?? []);
    expect(dirty.slice(0, 3)).toEqual(['1', '0', '0']);
    // The next save finds it changed: version 2, and version 1 goes once that save is complete.
    f.send('fake-dirty');
    f.send('fake-release-save');
    await until(() => count(PATTERNS.saved) >= n + 1);
    n = await freeze();
    expect(world()).toEqual(['00_00__0_2.chunk', ...['chunks', 'db2', 'fwl2', 'ok'].map((x) => `_main.${n - 1}.${x}`), `_main.${n}.chunks`].sort());
    f.send('fake-release-save');
  });

  it('saves never overlap: a timer save is skipped while one runs', async () => {
    // A save every 40 ms whose 5 steps take 30 ms each.
    const f = start(launch(tempDir(), await freeUdpPort(), ['-saveinterval', '1']), { env: { FAKE_VALHEIM_SAVE_MS_PER_S: '40', FAKE_VALHEIM_SAVE_STEP_MS: '30' } });
    await until(() => f.lines.filter((l) => PATTERNS.saved.test(l)).length >= 4);
    // Each (1/5) line is followed by its own (5/5) before the next (1/5), and the numbers go up by one.
    const steps = f.lines.filter((l) => /^World save \((1|5)\/5\)/.test(l)).map((l) => l.slice(12, 13));
    expect(steps.join('')).toMatch(/^(15)+1?$/);
    const numbers = f.lines.filter((l) => PATTERNS.saveNumber.test(l)).map((l) => Number(PATTERNS.saveNumber.exec(l)![1]));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it('an existing world loads by its newest complete save, without generating', async () => {
    const dir = tempDir();
    const port = await freeUdpPort();
    const a = start(launch(dir, port, ['-saveinterval', '1']), { dir, env: { FAKE_VALHEIM_SAVE_MS_PER_S: '50' } });
    await a.waitFor(PATTERNS.saved);
    a.child.kill('SIGKILL');
    await a.exited;
    const b = start(launch(dir, port), { dir });
    await b.waitFor(PATTERNS.ready);
    expect(b.lines.some((l) => /^ZNet\.LoadWorld: w1 \(w1\), save number \d+$/.test(l))).toBe(true);
    expect(b.lines.some((l) => PATTERNS.locationProgress.test(l))).toBe(false);
  });

  it('password rules on a public server; a private one takes any', async () => {
    const port = await freeUdpPort();
    const short = start(['-name', 'gspff test', '-port', String(port), '-world', 'w1', '-password', 'abcd', '-public', '1', '-savedir', tempDir()]);
    await short.waitFor(/^Error bad password:The password is too short$/);
    expect(await short.exited).toBe(0);
    const inName = start(['-name', 'gspff test', '-port', String(port), '-world', 'w1', '-password', 'gspff', '-public', '1', '-savedir', tempDir()]);
    await inName.waitFor(/^Error bad password:Invalid password$/);
    expect(await inName.exited).toBe(0);
    expect(inName.lines.some((l) => PATTERNS.ready.test(l))).toBe(false);
    const priv = start(['-name', 'gspff test', '-port', String(port), '-world', 'w1', '-password', 'abc', '-public', '0', '-savedir', tempDir()]);
    await priv.waitFor(PATTERNS.ready);
  });

  it('Steam queries: a public server answers info and players on the game port + 1, a private one stays silent', async () => {
    const port = await freeUdpPort();
    const pub = start(['-name', 'gspff test', '-port', String(port), '-world', 'w1', '-password', 'secret12', '-public', '1', '-savedir', tempDir()]);
    await pub.waitFor(PATTERNS.ready);
    const info = await a2s(port + 1, 0x54);
    expect(info?.readUInt8(4)).toBe(0x49);
    expect(info!.toString('latin1')).toContain('g=1.0.16,n=40,m=');
    pub.send('fake-join 76561198000000001');
    await pub.waitFor(/^Got handshake from client 76561198000000001$/);
    const players = await a2s(port + 1, 0x55);
    expect(players?.readUInt8(4)).toBe(0x44);
    expect(players?.readUInt8(5)).toBe(1);
    expect(await a2s(port + 1, 0x56)).toBeNull();
    pub.send('fake-leave 76561198000000001');
    await pub.waitFor(/^Closing socket 76561198000000001$/);
    pub.child.kill('SIGKILL');
    await pub.exited;
    const port2 = await freeUdpPort();
    const priv = start(launch(tempDir(), port2));
    await priv.waitFor(PATTERNS.ready);
    expect(await a2s(port2 + 1, 0x54)).toBeNull();
  });

  it('a banned SteamID or one missing from a non-empty permitted list is turned away', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'permittedlist.txt'), '// List permitted players ID ONE per line\n76561198000000002\n');
    const f = start(launch(dir, await freeUdpPort()), { dir });
    await f.waitFor(PATTERNS.ready);
    f.send('fake-join 76561198000000003');
    await f.waitFor(/^Peer 76561198000000003 is blacklisted or not in whitelist\.$/);
    f.send('fake-join 76561198000000002');
    await f.waitFor(/^Got handshake from client 76561198000000002$/);
  });

  it('crash-on-boot: the query port can\'t be bound, exit 0 before the ready line; a really taken one does the same', async () => {
    const f = start(launch(tempDir(), await freeUdpPort()), { env: { FAKE_VALHEIM_SCENARIO: 'crash-on-boot' } });
    expect(await f.exited).toBe(0);
    expect(f.lines.filter((l) => PATTERNS.steamInitFailed.test(l))).toHaveLength(2);
    const port = await freeUdpPort();
    const holder = dgram.createSocket('udp4');
    await new Promise<void>((r) => holder.bind(port + 1, '127.0.0.1', () => r()));
    try {
      const g = start(launch(tempDir(), port));
      expect(await g.exited).toBe(0);
      expect(g.lines).toContain(`CreateBoundSocket: ::bind couldn't find an open port between ${port + 1} and ${port + 1}`);
    } finally {
      holder.close();
    }
  });

  it('crash-after-ready: the world fails to load, the ready line still shows, then it quits without saving', async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'worlds_local', 'w1'), { recursive: true });
    for (const [f, c] of Object.entries({ '_main.4.db2': 'torn', '_main.4.fwl2': 'x', '_main.4.chunks': 'x', '_main.4.ok': '4' })) writeFileSync(path.join(dir, 'worlds_local', 'w1', f), c);
    const f = start(launch(dir, await freeUdpPort()), { dir });
    expect(await f.exited).toBe(0);
    expect(f.lines.findIndex((l) => PATTERNS.worldLoadFailed.test(l))).toBeLessThan(f.lines.findIndex((l) => PATTERNS.ready.test(l)));
    expect(f.lines).toContain('Skipping world save');
    expect(readFileSync(path.join(dir, 'worlds_local', 'w1', '_main.4.db2'), 'utf8')).toBe('torn');
    const g = start(launch(tempDir(), await freeUdpPort()), { env: { FAKE_VALHEIM_SCENARIO: 'crash-after-ready' } });
    expect(await g.exited).toBe(0);
  });

  it('never-ready: an unwritable save folder prints the exception and never gets ready', async () => {
    const f = start(launch(tempDir(), await freeUdpPort()), { env: { FAKE_VALHEIM_SCENARIO: 'never-ready' } });
    await f.waitFor(PATTERNS.readOnly);
    await new Promise((r) => setTimeout(r, 300));
    expect(f.lines.some((l) => PATTERNS.ready.test(l))).toBe(false);
    expect(f.child.exitCode).toBeNull();
  });

  it('crossplay: PlayFab lines; a join code only with its libraries; nothing bound on the game port', async () => {
    const port = await freeUdpPort();
    const without = start(launch(tempDir(), port, ['-crossplay']));
    await without.waitFor(PATTERNS.ready);
    expect(without.lines.some((l) => /^DllNotFoundException: libParty\.so/.test(l))).toBe(true);
    expect(without.lines.some((l) => PATTERNS.joinCode.test(l))).toBe(false);
    without.child.kill('SIGKILL');
    await without.exited;
    const withLibs = start(launch(tempDir(), port, ['-crossplay']), { env: { FAKE_VALHEIM_CROSSPLAY_LIBS: '1' } });
    await withLibs.waitFor(PATTERNS.joinCode);
    // the game port is free: crossplay doesn't listen on it (measured)
    const probe = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.bind(port, '127.0.0.1', () => resolve());
    });
    probe.close();
  });

  it('-logfile: the log goes to the file, stdout stops after the first lines', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'valheim.log');
    const f = start(launch(dir, await freeUdpPort(), ['-logfile', file, '-preset', 'hard', '-modifier', 'raids', 'none']), { dir });
    for (let i = 0; i < 100 && !(existsSync(file) && /Opened Steam server/.test(readFileSync(file, 'utf8'))); i++) await new Promise((r) => setTimeout(r, 50 * SCALE));
    const logged = readFileSync(file, 'utf8');
    expect(logged).toMatch(/Setting world modifier preset: hard/);
    expect(logged).toMatch(/Setting world modifier: raids->none/);
    expect(f.lines.some((l) => PATTERNS.ready.test(l))).toBe(false);
  });

  // Windows has no signals a child can handle: there these run in a Linux container (see the README).
  it.skipIf(onWindows)('SIGINT and SIGTERM save and exit 0; ignore-stop ignores both', async () => {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      const dir = tempDir();
      const f = start(launch(dir, await freeUdpPort()), { dir });
      await f.waitFor(PATTERNS.ready);
      f.child.kill(sig);
      expect(await f.exited).toBe(0);
      expect(f.lines).toContain('Game - OnApplicationQuit');
      expect(f.lines.some((l) => PATTERNS.saved.test(l))).toBe(true);
      expect(readdirSync(path.join(dir, 'worlds_local', 'w1'))).toContain('_main.1.ok');
    }
    const g = start(launch(tempDir(), await freeUdpPort()), { env: { FAKE_VALHEIM_SCENARIO: 'ignore-stop' } });
    await g.waitFor(PATTERNS.ready);
    g.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    expect(g.child.exitCode).toBeNull();
  });
});

// --------------------------------------------------------------------- the fake steamcmd
describe('fake-valheim steamcmd.mjs', () => {
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [STEAMCMD, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

  it('installs the public build and writes its manifest; a branch gets its BetaKey', () => {
    const dir = tempDir();
    const r = run(['+force_install_dir', dir, '+login', 'anonymous', '+app_update', '896660', 'validate', '+quit']);
    expect(r.stdout).toContain("Success! App '896660' fully installed.");
    expect(readFileSync(path.join(dir, 'steamapps', 'appmanifest_896660.acf'), 'utf8')).toMatch(/"buildid"\t\t"25527701"/);
    expect(existsSync(path.join(dir, 'valheim_server.x86_64'))).toBe(true);
    const old = tempDir();
    run(['+force_install_dir', old, '+login', 'anonymous', '+app_update', '896660', '-beta', 'default_old', '+quit']);
    expect(readFileSync(path.join(old, 'steamapps', 'appmanifest_896660.acf'), 'utf8')).toMatch(/"buildid"\t\t"25390671"[\s\S]*"BetaKey"\t\t"default_old"/);
  });

  it('lists the branches the real app_info_print showed', () => {
    const r = run(['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', '896660', '+quit']);
    const real = fixture('steamcmd', 'app-info-896660.vdf');
    for (const b of ['public', 'default_old', 'default_pre1_0', 'default_preml']) {
      const id = new RegExp(`"${b}"\\s*\\{\\s*"buildid"\\s*"(\\d+)"`).exec(real)![1];
      expect(r.stdout).toMatch(new RegExp(`"${b}"\\s*\\{\\s*"buildid"\\t\\t"${id}"`));
    }
  });

  it('fails like a fresh steamcmd did once: Missing configuration', () => {
    const r = run(['+force_install_dir', tempDir(), '+login', 'anonymous', '+app_update', '896660', '+quit'], { FAKE_STEAMCMD_FAIL: 'missing-config' });
    expect(r.stdout).toContain("ERROR! Failed to install app '896660' (Missing configuration)");
  });
});
