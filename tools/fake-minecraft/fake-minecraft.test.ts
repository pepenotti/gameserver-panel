// The Minecraft fake against what the real 26.3 servers did (fixtures/minecraft/26.3,
// docs/verification/minecraft-26.3.md): its lines match the patterns the captures match, its RCON
// frames like the real one, and its files look like the game's.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProperties, propertiesToRecord } from '@gsp/formats';
import { afterEach, describe, expect, it } from 'vitest';
import { RconClient } from '../../packages/agent/src/rcon-client';
import { startFakeDownloads } from './downloads.mjs';

const SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, 'server.mjs');
const FIXTURES = path.join(here, '..', '..', 'fixtures', 'minecraft', '26.3');
const fixture = (...p: string[]) => readFileSync(path.join(FIXTURES, ...p), 'utf8');
const PASSWORD = 'fake-rcon-password-0123';
type Loader = 'vanilla' | 'paper' | 'fabric';

/** Log line patterns the adapter will rely on; each must match the real capture and the fake. */
const PATTERNS = {
  ready: /^(?:\[\d\d:\d\d:\d\d\] \[Server thread\/INFO\]|\[\d\d:\d\d:\d\d INFO\]): Done \(\d+\.\d+s\)! For help, type "help"$/,
  rconUp: /: RCON running on 0\.0\.0\.0:\d+$/,
  eula: /: You need to agree to the EULA in order to run the server\. Go to eula\.txt for more info\.$/,
  join: /: System chat: (\S+) joined the game$/,
  leave: /: System chat: (\S+) left the game$/,
  bindFailed: /: \*\*\*\* FAILED TO BIND TO PORT!$/,
  crashed: /: Encountered an unexpected exception$/,
  version: /: Starting minecraft server version (\S+)$/,
};

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
  const d = mkdtempSync(path.join(os.tmpdir(), 'gsp-fake-mc-'));
  dirs.push(d);
  return d;
}

function start(o: { dir?: string; loader?: Loader; env?: Record<string, string>; args?: string[] } = {}): Fake {
  const dir = o.dir ?? tempDir();
  const args = o.args ?? ['-Xms1G', '-Xmx1G', '-DbundlerRepoDir=' + path.join(dir, 'install'), '-jar', path.join(dir, 'install', 'server.jar'), 'nogui'];
  const child = spawn(process.execPath, [SERVER, ...args], {
    cwd: dir,
    env: { ...process.env, FAKE_MC_LOADER: o.loader ?? 'vanilla', FAKE_MC_BOOT_MS: '50', ...o.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  const waiters = new Set<{ re: RegExp; resolve: (l: string) => void }>();
  let buf = '';
  const onData = (d: Buffer) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      for (const w of waiters) {
        if (!w.re.test(line)) continue;
        waiters.delete(w);
        w.resolve(line);
      }
    }
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const f: Fake = {
    dir,
    child,
    lines,
    exited,
    waitFor(re, ms = 5000 * SCALE) {
      const hit = lines.find((l) => re.test(l));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { re, resolve };
        waiters.add(w);
        setTimeout(() => {
          if (waiters.delete(w)) reject(new Error(`timed out waiting for ${re}\n${lines.slice(-10).join('\n')}`));
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

/** A data folder that has accepted the EULA and enables RCON on `rcon`. */
function prepared(rcon: number, extra: Record<string, string> = {}): string {
  const dir = tempDir();
  writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  const props = { 'enable-rcon': 'true', 'rcon.port': String(rcon), 'rcon.password': PASSWORD, ...extra };
  writeFileSync(path.join(dir, 'server.properties'), Object.entries(props).map(([k, v]) => `${k}=${v}\n`).join(''));
  return dir;
}

// --------------------------------------------------------------------- raw RCON
function frame(id: number, type: number, body: string): Buffer {
  const b = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}
interface Packet {
  id: number;
  type: number;
  body: string;
}
/** A raw RCON connection that keeps every packet and whether the server closed it. */
async function raw(port: number) {
  const sock = net.connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => (sock.once('connect', resolve), sock.once('error', reject)));
  const packets: Packet[] = [];
  let pending = Buffer.alloc(0);
  let closed = false;
  sock.on('data', (d) => {
    pending = Buffer.concat([pending, d]);
    while (pending.length >= 4 && pending.length >= pending.readInt32LE(0) + 4) {
      const size = pending.readInt32LE(0);
      packets.push({ id: pending.readInt32LE(4), type: pending.readInt32LE(8), body: pending.subarray(12, size + 2).toString('utf8') });
      pending = pending.subarray(size + 4);
    }
  });
  sock.on('close', () => (closed = true));
  sock.on('error', () => undefined);
  const settle = () => new Promise((r) => setTimeout(r, 150 * SCALE));
  return {
    packets,
    get closed() {
      return closed;
    },
    async write(...bufs: Buffer[]) {
      sock.write(Buffer.concat(bufs));
      await settle();
    },
    close: () => sock.destroy(),
  };
}

afterEach(async () => {
  for (const f of running.splice(0)) {
    if (f.child.exitCode === null) f.child.kill('SIGKILL');
    await f.exited;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// --------------------------------------------------------------------- tests
describe('the patterns the adapter will use match the real captures', () => {
  it.each(['vanilla', 'paper', 'fabric'] as const)('%s first boot, EULA refusal and players', (loader) => {
    const boot = fixture(loader, 'logs', 'first-boot.log').split('\n');
    expect(boot.filter((l) => PATTERNS.ready.test(l))).toHaveLength(1);
    expect(boot.some((l) => PATTERNS.rconUp.test(l))).toBe(true);
    expect(boot.find((l) => PATTERNS.version.test(l))).toMatch(/version 26\.3$/);
    expect(fixture(loader, 'logs', 'no-eula.log')).toMatch(new RegExp(PATTERNS.eula.source, 'm'));
    const players = fixture(loader, 'logs', 'players.log').split('\n');
    expect(players.filter((l) => PATTERNS.join.test(l)).length).toBeGreaterThanOrEqual(4);
    expect(players.filter((l) => PATTERNS.leave.test(l)).length).toBeGreaterThanOrEqual(3);
  });

  it('vanilla port-in-use failure', () => {
    const log = fixture('vanilla', 'logs', 'port-in-use.log').split('\n');
    expect(log.some((l) => PATTERNS.bindFailed.test(l))).toBe(true);
    expect(log.some((l) => PATTERNS.crashed.test(l))).toBe(true);
  });
});

describe('fake-minecraft server.mjs', () => {
  it('refuses to start without eula=true exactly as the real one: it writes eula.txt and the default server.properties, and exits 0 without waiting', async () => {
    const f = start();
    expect(await f.exited).toBe(0);
    expect(f.lines.some((l) => PATTERNS.eula.test(l))).toBe(true);
    expect(f.lines.some((l) => /\[ServerMain\/WARN\]: Failed to load eula\.txt$/.test(l))).toBe(true);
    const eula = readFileSync(path.join(f.dir, 'eula.txt'), 'utf8');
    expect(eula).toMatch(/^#By changing the setting below to TRUE you are indicating your agreement to our EULA \(https:\/\/aka\.ms\/MinecraftEULA\)\.\n#.+\neula=false\n$/);
    // The same keys as the real 26.3 default file.
    const real = Object.keys(propertiesToRecord(parseProperties(fixture('vanilla', 'config', 'server.properties.generated')))).sort();
    const fake = Object.keys(propertiesToRecord(parseProperties(readFileSync(path.join(f.dir, 'server.properties'), 'utf8')))).sort();
    expect(fake).toEqual(real);
    // A second refusal: eula.txt stays as it is.
    const again = start({ dir: f.dir });
    expect(await again.exited).toBe(0);
    expect(readFileSync(path.join(f.dir, 'eula.txt'), 'utf8')).toBe(eula);
    expect(again.lines.some((l) => /Failed to load eula/.test(l))).toBe(false);
  });

  it('boots from a partial server.properties and rewrites it the way the game does: sorted, its own header, comments gone, unknown keys and UTF-8 kept', async () => {
    const rcon = await freePort();
    const dir = prepared(rcon, { motd: 'Servidor de prueba \u00d1and\u00fa \u2603', 'gsp-probe-unknown-key': 'kept' });
    writeFileSync(path.join(dir, 'server.properties'), `# a comment of ours\n${readFileSync(path.join(dir, 'server.properties'), 'utf8')}`);
    const f = start({ dir });
    await f.waitFor(PATTERNS.ready);
    const text = readFileSync(path.join(dir, 'server.properties'), 'utf8');
    expect(text).toMatch(/^#Minecraft server properties\n#\w{3} \w{3} \d\d \d\d:\d\d:\d\d UTC \d{4}\n/);
    expect(text).not.toContain('a comment of ours');
    expect(text).toContain('motd=Servidor de prueba \u00d1and\u00fa \u2603\n');
    expect(text).toContain('gsp-probe-unknown-key=kept\n');
    expect(text).toContain('level-type=minecraft\\:normal\n');
    expect(text.endsWith('\n')).toBe(true);
    const keys = text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('=')[0]!);
    expect(keys).toEqual([...keys].sort());
    expect(propertiesToRecord(parseProperties(text))['management-server-secret']).toMatch(/^[A-Za-z0-9]{40}$/);
    // The player list files exist, empty, as on a real first boot.
    for (const n of ['ops', 'whitelist', 'banned-players', 'banned-ips', 'usercache']) expect(readFileSync(path.join(dir, `${n}.json`), 'utf8')).toBe('[]');
  });

  it.each(['vanilla', 'paper', 'fabric'] as const)('%s: the ready line, then RCON (Paper opens RCON before its ready line)', async (loader) => {
    const rcon = await freePort();
    const f = start({ dir: prepared(rcon), loader });
    await f.waitFor(PATTERNS.ready);
    await f.waitFor(PATTERNS.rconUp);
    const ready = f.lines.findIndex((l) => PATTERNS.ready.test(l));
    const up = f.lines.findIndex((l) => PATTERNS.rconUp.test(l));
    expect(loader === 'paper' ? up < ready : up > ready).toBe(true);
    expect(f.lines.find((l) => PATTERNS.version.test(l))).toMatch(/version 26\.3$/);
    if (loader === 'paper') expect(f.lines.some((l) => /^\[\d\d:\d\d:\d\d INFO\]: \[bootstrap\] Loading Paper /.test(l))).toBe(true);
    if (loader === 'fabric') expect(f.lines.some((l) => /\[main\/INFO\]: Loading Minecraft 26\.3 with Fabric Loader /.test(l))).toBe(true);
  });

  it('frames RCON like the real server: one auth packet, -1 for a wrong password, a reply per command, "Unknown request" for other types, 4096-character parts', async () => {
    const rcon = await freePort();
    const f = start({ dir: prepared(rcon) });
    await f.waitFor(PATTERNS.rconUp);
    const bad = await raw(rcon);
    await bad.write(frame(7, 3, 'wrong'));
    await bad.write(frame(10, 2, 'list'));
    expect(bad.packets).toEqual([
      { id: -1, type: 2, body: '' },
      { id: -1, type: 2, body: '' },
    ]);
    expect(bad.closed).toBe(false);
    bad.close();

    const c = await raw(rcon);
    await c.write(frame(1, 3, PASSWORD));
    expect(c.packets).toEqual([{ id: 1, type: 2, body: '' }]);
    await c.write(frame(10, 2, 'list'));
    await c.write(frame(11, 0, ''));
    await c.write(frame(12, 2, 'notacommand'));
    await c.write(frame(13, 2, 'say hi'));
    expect(c.packets.slice(1)).toEqual([
      { id: 10, type: 0, body: 'There are 0 of a max of 20 players online: ' },
      { id: 11, type: 0, body: 'Unknown request 0' },
      { id: 12, type: 0, body: 'Unknown or incomplete command. See below for errornotacommand<--[HERE]' },
      { id: 13, type: 0, body: '' },
    ]);
    await c.write(frame(20, 2, 'help'));
    const help = c.packets.filter((p) => p.id === 20);
    expect(help.length).toBeGreaterThan(1);
    expect(help[0]!.body).toHaveLength(4096);
    c.close();
  });

  it('drops the connection when two packets arrive in one write, as the real server does — so a client may not pipeline its sentinel', async () => {
    const rcon = await freePort();
    const f = start({ dir: prepared(rcon) });
    await f.waitFor(PATTERNS.rconUp);
    const c = await raw(rcon);
    await c.write(frame(1, 3, PASSWORD));
    await c.write(frame(10, 2, 'list'), frame(11, 0, ''));
    expect(c.closed).toBe(true);
    expect(c.packets).toEqual([{ id: 1, type: 2, body: '' }]);
    // The agent's client today sends a command and its sentinel in one write (fixtures/pz/b42/rcon):
    // against Minecraft that never gets an answer (docs/verification/minecraft-26.3.md, RCON).
    const client = new RconClient('127.0.0.1', rcon, () => PASSWORD, 1500 * SCALE);
    await expect(client.command('list')).rejects.toThrow();
    client.close();
  });

  it('takes packets of up to 1460 bytes and drops the connection on a longer one; say takes 256 characters', async () => {
    const rcon = await freePort();
    const f = start({ dir: prepared(rcon) });
    await f.waitFor(PATTERNS.rconUp);
    const c = await raw(rcon);
    await c.write(frame(1, 3, PASSWORD));
    await c.write(frame(10, 2, `say ${'x'.repeat(1442)}`)); // 1460 bytes in all
    await c.write(frame(11, 2, `say ${'y'.repeat(256)}`));
    expect(c.packets.slice(1)).toEqual([
      { id: 10, type: 0, body: 'Chat message was too long (1442 > maximum 256 characters)' },
      { id: 11, type: 0, body: '' },
    ]);
    await c.write(frame(12, 2, `say ${'x'.repeat(1443)}`)); // 1461 bytes
    expect(c.closed).toBe(true);
  });

  it('Paper keeps the newlines in a multi-line RCON reply; vanilla joins the lines with nothing', async () => {
    const rcon = await freePort();
    const f = start({ dir: prepared(rcon), loader: 'paper' });
    await f.waitFor(PATTERNS.ready);
    await f.waitFor(PATTERNS.rconUp);
    const c = await raw(rcon);
    await c.write(frame(1, 3, PASSWORD));
    await c.write(frame(10, 2, 'notacommand'));
    expect(c.packets[1]).toEqual({ id: 10, type: 0, body: 'Unknown or incomplete command. See below for error\nnotacommand<--[HERE]' });
    c.close();
  });

  it('players: joins and leaves in the measured lines, list and list uuids, kick, ban of an online player', async () => {
    const rcon = await freePort();
    const f = start({ dir: prepared(rcon, { 'online-mode': 'false' }), env: { FAKE_MC_PLAYERS: 'gspffAlice' } });
    await f.waitFor(PATTERNS.join);
    f.send('fake-join gspffBob');
    await f.waitFor(/gspffBob joined the game$/);
    expect(f.lines.find((l) => /gspffAlice\[\/127\.0\.0\.1:\d+\] logged in with entity id \d+ at \(/.test(l))).toBeDefined();
    const c = await raw(rcon);
    await c.write(frame(1, 3, PASSWORD));
    await c.write(frame(10, 2, 'list'));
    await c.write(frame(11, 2, 'list uuids'));
    await c.write(frame(12, 2, 'kick gspffBob Testing a kick'));
    await c.write(frame(13, 2, 'ban gspffAlice Testing a ban'));
    await c.write(frame(14, 2, 'kick nobody'));
    expect(c.packets.slice(1).map((p) => p.body)).toEqual([
      'There are 2 of a max of 20 players online: gspffAlice, gspffBob',
      'There are 2 of a max of 20 players online: gspffAlice (ffcc114b-0550-393e-a2da-7e8930eb7054), gspffBob (dc6418c1-65ab-357a-98d4-eacecaaf26ba)',
      'Kicked gspffBob: Testing a kick',
      'Banned gspffAlice: Testing a ban',
      'No player was found',
    ]);
    await f.waitFor(/gspffAlice lost connection: You are banned from this server$/);
    expect(f.lines.some((l) => /: gspffBob lost connection: Testing a kick$/.test(l))).toBe(true);
    expect(f.lines.some((l) => /: System chat: \[Rcon: Kicked gspffBob: Testing a kick\]$/.test(l))).toBe(true);
    const bans = JSON.parse(readFileSync(path.join(f.dir, 'banned-players.json'), 'utf8'));
    expect(bans).toEqual([{ uuid: 'ffcc114b-0550-393e-a2da-7e8930eb7054', name: 'gspffAlice', created: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \+0000$/), source: 'Rcon', expires: 'forever', reason: 'Testing a ban' }]);
    c.close();
  });

  it('player files: the same JSON shape as the captures, written without a final newline; offline names lower-cased by vanilla, kept by Paper', async () => {
    for (const loader of ['vanilla', 'paper'] as const) {
      const rcon = await freePort();
      const f = start({ dir: prepared(rcon, { 'online-mode': 'false' }), loader });
      await f.waitFor(PATTERNS.rconUp);
      const c = await raw(rcon);
      await c.write(frame(1, 3, PASSWORD));
      await c.write(frame(10, 2, 'whitelist add gspffAlice'));
      await c.write(frame(11, 2, 'op gspffAlice'));
      await c.write(frame(12, 2, 'ban-ip 203.0.113.7 Testing an IP ban'));
      c.close();
      const name = loader === 'paper' ? 'gspffAlice' : 'gspffalice';
      const wl = readFileSync(path.join(f.dir, 'whitelist.json'), 'utf8');
      expect(wl.endsWith(']')).toBe(true);
      expect(JSON.parse(wl)).toEqual([{ uuid: expect.any(String), name }]);
      // Same keys, in the same order, as the real files.
      const keysOf = (text: string) => Object.keys(JSON.parse(text)[0]);
      expect(keysOf(wl)).toEqual(keysOf(fixture(loader, 'files', 'whitelist.json')));
      expect(keysOf(readFileSync(path.join(f.dir, 'ops.json'), 'utf8'))).toEqual(keysOf(fixture(loader, 'files', 'ops.json')));
      expect(keysOf(readFileSync(path.join(f.dir, 'banned-ips.json'), 'utf8'))).toEqual(keysOf(fixture(loader, 'files', 'banned-ips.json')));
      expect(readFileSync(path.join(f.dir, 'usercache.json'), 'utf8')).not.toContain('\n');
    }
  });

  it('online mode: a name no account has is "That player does not exist"; a known account resolves', async () => {
    const rcon = await freePort();
    const f = start({ dir: prepared(rcon), env: { FAKE_MC_PROFILES: 'gspffKnown=00000000-0000-4000-8000-000000000001' } });
    await f.waitFor(PATTERNS.rconUp);
    const c = await raw(rcon);
    await c.write(frame(1, 3, PASSWORD));
    await c.write(frame(10, 2, 'whitelist add gspffNoSuchPlr7'));
    await c.write(frame(11, 2, 'whitelist add gspffknown'));
    expect(c.packets.slice(1).map((p) => p.body)).toEqual(['That player does not exist', 'Added gspffKnown to the whitelist']);
    c.close();
  });

  it('edits on disk while running: whitelist.json only after "whitelist reload"; server.properties is overwritten by the next write the game makes', async () => {
    const rcon = await freePort();
    const f = start({ dir: prepared(rcon, { 'online-mode': 'false', 'white-list': 'false' }) });
    await f.waitFor(PATTERNS.rconUp);
    writeFileSync(path.join(f.dir, 'whitelist.json'), JSON.stringify([{ uuid: '00000000-0000-3000-8000-00000000c0de', name: 'gspffCarol' }], null, 2));
    const props = path.join(f.dir, 'server.properties');
    writeFileSync(props, readFileSync(props, 'utf8').replace(/^motd=.*$/m, 'motd=Edited on disk while running'));
    const c = await raw(rcon);
    await c.write(frame(1, 3, PASSWORD));
    await c.write(frame(10, 2, 'whitelist list'));
    await c.write(frame(11, 2, 'whitelist reload'));
    await c.write(frame(12, 2, 'whitelist list'));
    await c.write(frame(13, 2, 'whitelist on'));
    await c.write(frame(14, 2, 'whitelist on'));
    expect(c.packets.slice(1).map((p) => p.body)).toEqual(['There are no whitelisted players', 'Reloaded the whitelist', 'There are 1 whitelisted player(s): gspffCarol', 'Whitelist is now turned on', 'Whitelist is already turned on']);
    const after = readFileSync(props, 'utf8');
    expect(after).toContain('motd=A Minecraft Server\n');
    expect(after).toContain('white-list=true\n');
    c.close();
  });

  it('BAK-02 commands: save-off, save-all flush, save-on, with the measured replies', async () => {
    const rcon = await freePort();
    const f = start({ dir: prepared(rcon) });
    await f.waitFor(PATTERNS.rconUp);
    const c = await raw(rcon);
    await c.write(frame(1, 3, PASSWORD));
    for (const [i, cmd] of ['save-off', 'save-off', 'save-all flush', 'save-on', 'save-on'].entries()) await c.write(frame(10 + i, 2, cmd));
    expect(c.packets.slice(1).map((p) => p.body)).toEqual(['Automatic saving is now disabled', 'Saving is already turned off', 'Saving the game (this may take a moment!)Saved the game', 'Automatic saving is now enabled', 'Saving is already turned on']);
    expect(existsSync(path.join(f.dir, 'world', 'level.dat'))).toBe(true);
    expect(readFileSync(path.join(f.dir, 'world', 'session.lock'), 'utf8')).toBe('\u2603');
    c.close();
  });

  it('stop over RCON answers "Stopping the server" and exits 0; so does stop on the console', async () => {
    const rcon = await freePort();
    const f = start({ dir: prepared(rcon) });
    await f.waitFor(PATTERNS.rconUp);
    const c = await raw(rcon);
    await c.write(frame(1, 3, PASSWORD));
    await c.write(frame(10, 2, 'stop'));
    expect(c.packets[1]).toEqual({ id: 10, type: 0, body: 'Stopping the server' });
    expect(await f.exited).toBe(0);
    expect(f.lines.some((l) => /: Stopping server$/.test(l))).toBe(true);
    const g = start({ dir: prepared(await freePort()) });
    await g.waitFor(PATTERNS.ready);
    g.send('stop');
    expect(await g.exited).toBe(0);
    expect(g.lines.some((l) => /: System chat: Stopping the server$/.test(l))).toBe(true);
  });

  it('queues console commands typed before the server is ready, and keeps running when stdin ends', async () => {
    const f = start({ dir: prepared(await freePort()), env: { FAKE_MC_BOOT_MS: '300' } });
    f.send('list');
    await f.waitFor(/System chat: There are 0 of a max of 20 players online: $/);
    f.child.stdin!.end();
    await new Promise((r) => setTimeout(r, 300));
    expect(f.child.exitCode).toBeNull();
  });

  it('crash-on-boot: the measured bind failure, a crash report, exit 0', async () => {
    const f = start({ dir: prepared(await freePort()), env: { FAKE_MC_SCENARIO: 'crash-on-boot' } });
    expect(await f.exited).toBe(0);
    expect(f.lines.some((l) => PATTERNS.bindFailed.test(l))).toBe(true);
    expect(f.lines.some((l) => PATTERNS.crashed.test(l))).toBe(true);
    expect(f.lines.some((l) => PATTERNS.ready.test(l))).toBe(false);
    expect(existsSync(path.join(f.dir, 'crash-reports'))).toBe(true);
  });

  it('a game port already taken fails the same way (FAKE_MC_BIND_GAME_PORT=1)', async () => {
    const port = await freePort();
    const holder = net.createServer().listen(port, '127.0.0.1');
    await new Promise((r) => holder.once('listening', r));
    try {
      const f = start({ dir: prepared(await freePort(), { 'server-port': String(port) }), env: { FAKE_MC_BIND_GAME_PORT: '1' } });
      expect(await f.exited).toBe(0);
      expect(f.lines.some((l) => /The exception was: .*Address already in use$/.test(l))).toBe(true);
    } finally {
      holder.close();
    }
  });

  it('crash-after-ready: ready, then the crash lines and exit 0', async () => {
    const f = start({ dir: prepared(await freePort()), env: { FAKE_MC_SCENARIO: 'crash-after-ready', FAKE_MC_CRASH_MS: '100' } });
    await f.waitFor(PATTERNS.ready);
    expect(await f.exited).toBe(0);
    expect(f.lines.some((l) => PATTERNS.crashed.test(l))).toBe(true);
  });

  it.each(['never-ready', 'blocking-prompt'])('%s: no ready line, and it stays up', async (scenario) => {
    const f = start({ dir: prepared(await freePort()), env: { FAKE_MC_SCENARIO: scenario } });
    await f.waitFor(/Preparing level "world"/);
    await new Promise((r) => setTimeout(r, 400));
    expect(f.lines.some((l) => PATTERNS.ready.test(l))).toBe(false);
    expect(f.child.exitCode).toBeNull();
  });

  it('ignore-stop: stop is acknowledged and nothing happens, so the agent must escalate to signals', async () => {
    const rcon = await freePort();
    const f = start({ dir: prepared(rcon), env: { FAKE_MC_SCENARIO: 'ignore-stop' } });
    await f.waitFor(PATTERNS.rconUp);
    const c = await raw(rcon);
    await c.write(frame(1, 3, PASSWORD));
    await c.write(frame(10, 2, 'stop'));
    expect(c.packets[1]!.body).toBe('Stopping the server');
    await new Promise((r) => setTimeout(r, 400));
    expect(f.child.exitCode).toBeNull();
    c.close();
    f.child.kill('SIGTERM');
    const code = await f.exited;
    // Measured: the real server exits 143 on SIGTERM (Windows can't deliver the signal to a child).
    if (process.platform !== 'win32') expect(code).toBe(143);
  });

  it('RCON on without a password: the measured warning, no listener', async () => {
    const dir = prepared(await freePort());
    writeFileSync(path.join(dir, 'server.properties'), 'enable-rcon=true\nrcon.password=\n');
    const f = start({ dir });
    await f.waitFor(PATTERNS.ready);
    await f.waitFor(/No rcon password set in server\.properties, rcon disabled!$/);
  });
});

describe('fake-minecraft install steps (the fake also stands in for java running an installer)', () => {
  it('the Fabric installer: the measured lines, and the launch jar, game jar and libraries in -dir', () => {
    const dir = tempDir();
    const target = path.join(dir, 'opt-game');
    mkdirSync(target);
    const r = spawnSync(process.execPath, [SERVER, '-jar', path.join(dir, 'fabric-installer-1.1.2.jar'), 'server', '-mcversion', '26.3', '-loader', '0.19.5', '-dir', target, '-downloadMinecraft'], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const real = fixture('fabric', 'logs', 'installer.log').trimEnd().split('\n');
    expect(r.stdout.trimEnd().split('\n')).toEqual(real);
    for (const f of ['fabric-server-launch.jar', 'server.jar', 'libraries/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar']) expect(existsSync(path.join(target, f))).toBe(true);
  });

  it("Paper's patch-only step: the two measured lines, into the bundler's repo dir, exit 0", () => {
    const dir = tempDir();
    const r = spawnSync(process.execPath, [SERVER, '-Dpaperclip.patchonly=true', `-DbundlerRepoDir=${path.join(dir, 'game')}`, '-jar', 'paper.jar'], { cwd: dir, encoding: 'utf8', env: { ...process.env, FAKE_MC_LOADER: 'paper' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(fixture('paper', 'logs', 'patch-only.log'));
    for (const f of ['cache/mojang_26.3.jar', 'versions/26.3/paper-26.3.jar']) expect(existsSync(path.join(dir, 'game', f))).toBe(true);
  });

  it('with FAKE_MC_REQUIRE_JAR=1: a missing jar, and Fabric without its game jar, fail with the measured messages', () => {
    const dir = tempDir();
    const missing = spawnSync(process.execPath, [SERVER, '-jar', '/opt/game/missing.jar', 'nogui'], { cwd: dir, encoding: 'utf8', env: { ...process.env, FAKE_MC_REQUIRE_JAR: '1' } });
    expect(missing.status).toBe(1);
    expect(missing.stderr.trim()).toBe(fixture('vanilla', 'logs', 'missing-jar.log').trim());
    writeFileSync(path.join(dir, 'fabric-server-launch.jar'), 'x');
    const fabric = spawnSync(process.execPath, [SERVER, '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: dir, encoding: 'utf8', env: { ...process.env, FAKE_MC_REQUIRE_JAR: '1', FAKE_MC_LOADER: 'fabric' } });
    expect(fabric.status).toBe(1);
    expect(fabric.stdout).toMatch(/^The Minecraft server \.JAR is missing \(.*server\.jar\)!$/m);
    expect(existsSync(path.join(dir, 'fabric-server-launcher.properties'))).toBe(true);
  });

  it('the vanilla bundler unpacks once, into -DbundlerRepoDir, with the measured line shape', async () => {
    const dir = prepared(await freePort());
    const f = start({ dir });
    await f.waitFor(PATTERNS.ready);
    const unpack = f.lines.filter((l) => l.startsWith('Unpacking '));
    expect(unpack.length).toBeGreaterThan(1);
    for (const l of unpack) expect(l).toMatch(/^Unpacking \S+ \((?:versions|libraries):\S+\) to \S+$/);
    expect(fixture('vanilla', 'logs', 'no-eula.log').split('\n').filter((l) => l.startsWith('Unpacking ')).every((l) => /^Unpacking \S+ \((?:versions|libraries):\S+\) to \S+$/.test(l))).toBe(true);
  });
});

describe('fake-minecraft downloads.mjs', () => {
  const UA = 'gameserver-panel-test';
  const get = (url: string) => fetch(url, { headers: { 'user-agent': UA } });

  it("Mojang: manifest → version file → server jar whose sha1 matches, with each version's Java major", async () => {
    const d = await startFakeDownloads();
    try {
      const m = (await (await get(`${d.url}/mc/game/version_manifest_v2.json`)).json()) as { latest: { release: string }; versions: { id: string; url: string; sha1: string }[] };
      expect(m.latest.release).toBe('26.3');
      const entry = m.versions.find((v) => v.id === m.latest.release)!;
      const text = await (await get(entry.url)).text();
      const { createHash } = await import('node:crypto');
      expect(createHash('sha1').update(text).digest('hex')).toBe(entry.sha1);
      const v = JSON.parse(text) as { javaVersion: { majorVersion: number }; downloads: { server: { url: string; sha1: string; size: number } } };
      expect(v.javaVersion.majorVersion).toBe(25);
      const jar = Buffer.from(await (await get(v.downloads.server.url)).arrayBuffer());
      expect(jar.length).toBe(v.downloads.server.size);
      expect(createHash('sha1').update(jar).digest('hex')).toBe(v.downloads.server.sha1);
      const majors = Object.fromEntries(await Promise.all(m.versions.map(async (x) => [x.id, ((await (await get(x.url)).json()) as { javaVersion: { majorVersion: number } }).javaVersion.majorVersion])));
      expect(majors).toMatchObject({ '26.3': 25, '1.20.6': 21, '1.17.1': 16, '1.16.5': 8 });
      expect(d.requests.every((r) => r.userAgent === UA)).toBe(true);
    } finally {
      await d.close();
    }
  });

  it('Paper (Fill v3): versions, builds by channel (case-sensitive), latest build and a sha256 that matches; v2 is gone', async () => {
    const d = await startFakeDownloads();
    try {
      const builds = (await (await get(`${d.url}/v3/projects/paper/versions/26.2/builds?channel=STABLE`)).json()) as { id: number; channel: string }[];
      expect(builds.map((b) => b.channel)).toEqual(['STABLE', 'STABLE']);
      expect((await get(`${d.url}/v3/projects/paper/versions/26.2/builds?channel=stable`)).status).toBe(400);
      const latest = (await (await get(`${d.url}/v3/projects/paper/versions/26.3/builds/latest`)).json()) as { channel: string; downloads: Record<string, { url: string; checksums: { sha256: string } }> };
      expect(latest.channel).toBe('ALPHA');
      const dl = latest.downloads['server:default']!;
      const { createHash } = await import('node:crypto');
      expect(createHash('sha256').update(Buffer.from(await (await get(dl.url)).arrayBuffer())).digest('hex')).toBe(dl.checksums.sha256);
      expect((await get(`${d.url}/v3/projects/paper/versions/9.9.9/builds`)).status).toBe(404);
      expect((await get(`${d.url}/v2/projects/paper`)).status).toBe(410);
    } finally {
      await d.close();
    }
  });

  it('Fabric: game, loader and installer lists, the server launcher jar (no checksum, same bytes every time), the installer with its sha256', async () => {
    const d = await startFakeDownloads();
    try {
      const loaders = (await (await get(`${d.url}/v2/versions/loader`)).json()) as { version: string; stable: boolean }[];
      expect(loaders.find((l) => l.stable)?.version).toBe('0.19.5');
      const a = Buffer.from(await (await get(`${d.url}/v2/versions/loader/26.3/0.19.5/1.1.2/server/jar`)).arrayBuffer());
      const b = Buffer.from(await (await get(`${d.url}/v2/versions/loader/26.3/0.19.5/1.1.2/server/jar`)).arrayBuffer());
      expect(a.equals(b)).toBe(true);
      expect((await get(`${d.url}/v2/versions/loader/9.9.9`)).status).toBe(400);
      const inst = (await (await get(`${d.url}/v2/versions/installer`)).json()) as { url: string; stable: boolean }[];
      const url = inst.find((i) => i.stable)!.url;
      const { createHash } = await import('node:crypto');
      const jar = Buffer.from(await (await get(url)).arrayBuffer());
      expect(createHash('sha256').update(jar).digest('hex')).toBe((await (await get(`${url}.sha256`)).text()).trim());
    } finally {
      await d.close();
    }
  });

  it('failures: bad checksums, missing files, rate limits', async () => {
    const bad = await startFakeDownloads({ fail: 'bad-checksum' });
    const missing = await startFakeDownloads({ fail: 'not-found' });
    const limited = await startFakeDownloads({ fail: 'rate-limit' });
    try {
      const { createHash } = await import('node:crypto');
      const b = (await (await get(`${bad.url}/v3/projects/paper/versions/26.3/builds/latest`)).json()) as { downloads: Record<string, { url: string; checksums: { sha256: string } }> };
      const dl = b.downloads['server:default']!;
      expect(createHash('sha256').update(Buffer.from(await (await get(dl.url)).arrayBuffer())).digest('hex')).not.toBe(dl.checksums.sha256);
      const m = (await (await get(`${missing.url}/v3/projects/paper/versions/26.3/builds/latest`)).json()) as { downloads: Record<string, { url: string }> };
      expect((await get(m.downloads['server:default']!.url)).status).toBe(404);
      const r = await get(`${limited.url}/mc/game/version_manifest_v2.json`);
      expect(r.status).toBe(429);
      expect(r.headers.get('retry-after')).toBe('1');
    } finally {
      await Promise.all([bad.close(), missing.close(), limited.close()]);
    }
  });
});

describe('fake-game.mjs picks the Minecraft fake by adapter id', () => {
  it('GAME_ADAPTER=minecraft runs tools/fake-minecraft/server.mjs', () => {
    const dir = tempDir();
    const fakeGame = path.join(here, '..', 'fake-orchestrator', 'fake-game.mjs');
    const r = spawnSync(process.execPath, [fakeGame, 'server', '-jar', 'server.jar', 'nogui'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GAME_ADAPTER: 'minecraft', FAKE_MC_BOOT_MS: '10' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(PATTERNS.eula.source, 'm'));
  });
});
