// The runtime half the engine makes from a manifest (D4, M6): reading the
// game's lines (CON-01, SRV-07), its command line, the files it prepares
// (CFG-04), install and versions through steamcmd (UPD-01…03), stopping,
// saving and running backups by the manifest's method (BAK-02, NFR-04),
// players (PLY-01), a typed console line (CON-02) and the hooks a game adds.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstallCtx, LaunchSettingRefusal, RuntimeAdapter, RuntimeCtx } from '@gsp/adapter-api';
import { runtimeAdapterSuite } from '@gsp/adapter-api/testing/runtime-suite';
import { manifestRuntimeAdapter, type ManifestLaunch } from '../src/runtime';
import { AVORION } from '../src/shared';
import { avorionLaunch, fixture, fixtureLines, scriptedGame } from './helpers';
import { tideLaunch, TIDEWATER } from './tidewater';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/avorion/2.5.13/', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function ctxOf(over: Partial<RuntimeCtx> = {}): RuntimeCtx {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-manifest-'));
  dirs.push(dir);
  const roots = { data: path.join(dir, 'data'), install: path.join(dir, 'install') };
  mkdirSync(roots.data, { recursive: true });
  mkdirSync(roots.install, { recursive: true });
  return { roots, stateDir: path.join(dir, 'state'), ports: { game: 30550, gametcp: 30550, query: 30551, steamquery: 30552, steammaster: 27021 }, state: { controlSecret: 's'.repeat(48), gameVersion: '2.5.13' }, tools: { home: path.join(dir, 'home') }, env: {}, log: () => undefined, ...over };
}

const avorion = () => manifestRuntimeAdapter(AVORION);
const tide = () => manifestRuntimeAdapter(TIDEWATER);
const avLaunch = (over: Record<string, unknown> = {}) => avorion().parseLaunch({ ...avorionLaunch(), ...over });

describe('reading the game (CON-01, SRV-07)', () => {
  it("reads Avorion's captured lines: ready, version, fatal lines, Steam's warning", () => {
    const a = avorion();
    const boot = fixtureLines('logs', 'first-boot-console-then-stop.log').map((l) => a.classify(l));
    expect(boot.filter((s) => s.ready).map((s) => s.message)).toEqual(['Server startup complete.']);
    expect(boot.flatMap((s) => (s.version ? [s.version] : []))).toEqual(['2.5.13']);
    expect(boot.some((s) => s.fatal || s.warning)).toBe(false);
    expect(boot.filter((s) => s.saved).map((s) => s.message)).toEqual(['All sectors saved successfully.']);
    const fallback = fixtureLines('logs', 'no-network-fallback.log').map((l) => a.classify(l));
    expect(fallback.filter((s) => s.warning).map((s) => s.message)).toEqual(['WARNING: The fallback TCP/UDP protocols are deprecated and potentially UNSAFE!']);
    expect(fallback.find((s) => s.warning)!.warning!.en).toMatch(/^The server runs without Steam's networking/);
    // The same when Steam's query port is taken.
    expect(fixtureLines('logs', 'fail-ports-in-use.log').some((l) => a.classify(l).warning)).toBe(true);
    for (const f of ['fail-ports-in-use.log', 'fail-readonly-datapath.log', 'fail-wrong-working-directory.log']) {
      expect(fixtureLines('logs', f).some((l) => a.classify(l).fatal), f).toBe(true);
      expect(fixtureLines('logs', f).some((l) => a.classify(l).ready), f).toBe(false);
    }
    // Join and leave lines as the game's strings word them (expected: no client joined).
    expect(a.classify('Player logged in: Bob The Builder, index: 1')).toMatchObject({ join: 'Bob The Builder' });
    expect(a.classify('Player logged off: Bob The Builder')).toMatchObject({ leave: 'Bob The Builder' });
  });

  it('takes a timestamp and colours off before matching and in what people see; shows progress runs as one line', () => {
    const t = tide();
    expect(t.classify('\u001b[32m12:00:01 Server is up\u001b[0m')).toEqual({ message: 'Server is up', ready: true });
    expect(t.classify('12:00:02 Version 1.2.3')).toEqual({ message: 'Version 1.2.3', version: '1.2.3' });
    expect(t.classify('12:00:03 Placing trees')).toEqual({ message: 'Placing trees', progress: { key: 'worldgen', text: 'Generating the world' } });
    expect(t.classify('12:00:04 Bad password: too short')).toMatchObject({ fatal: true });
    expect(t.classify('12:00:05 Steam failed')).toMatchObject({ warning: { en: "The server can't reach Steam." } });
    expect(t.display!('\u001b[1m12:00:06 Hello\u001b[0m')).toBe('Hello');
    // Avorion prints plain lines: shown as they are.
    expect(avorion().display).toBeUndefined();
  });
});

describe('launching (UPD-01…03, CFG-04)', () => {
  it("builds Avorion's command line from its template, in its install folder", () => {
    const a = avorion();
    const ctx = ctxOf();
    const cmd = a.command(ctx, avLaunch({ listed: true }));
    expect(cmd).toEqual({
      argv: [
        path.join(ctx.roots.install, 'bin', 'AvorionServer').split(path.sep).join('/').replace(ctx.roots.install.split(path.sep).join('/'), ctx.roots.install),
        ...['--galaxy-name', 'gal', '--datapath', ctx.roots.data, '--server-name', 'Gal test', '--max-players', '8', '--port', '30550', '--query-port', '30551', '--steam-query-port', '30552', '--steam-master-port', '27021'],
        ...['--listed', 'true', '--save-interval', '300', '--send-crash-reports', 'false'],
      ],
      cwd: ctx.roots.install,
      env: { LD_LIBRARY_PATH: `${ctx.roots.install}/linux64` },
    });
    // Tests and the dev loop start a fake in the game's place.
    expect(a.command(ctxOf({ tools: { home: 'h', launcher: ['node', 'fake.mjs'] } }), avLaunch()).argv.slice(0, 3)).toEqual(['node', 'fake.mjs', '--galaxy-name']);
  });

  it('adds conditional arguments only when their condition holds, and booleans as the game takes them', () => {
    const t = tide();
    const ctx = ctxOf({ ports: { game: 30560 } });
    const plain = t.command(ctx, t.parseLaunch(tideLaunch()));
    expect(plain.argv.slice(1)).toEqual(['-name', 'My tide', '-port', '30560', '-password', '', '-public', '0', '-key', 'k-123456789', '-savedir', ctx.roots.data, '-world', 'tide']);
    const hard = t.command(ctx, t.parseLaunch(tideLaunch({ mode: 'hard', public: true, password: 'sea-salt' })));
    expect(hard.argv.slice(1)).toEqual(['-name', 'My tide', '-port', '30560', '-password', 'sea-salt', '-public', '1', '-key', 'k-123456789', '-preset', 'hard', '-savedir', ctx.roots.data, '-world', 'tide']);
    expect(plain.env).toEqual({ TIDE_APP: '7654321', TIDE_LIBS: `${ctx.roots.install}/lib` });
    // The secrets go into no log line.
    expect(t.secrets(t.parseLaunch(tideLaunch({ password: 'sea-salt' })), { controlSecret: 'c', gameVersion: null })).toEqual(['c', 'sea-salt', 'k-123456789']);
  });

  it('checks launch params as the panel does, rules included, naming the setting in both languages', () => {
    const t = tide();
    const refused = (over: Record<string, unknown>) => {
      try {
        t.parseLaunch(tideLaunch(over));
      } catch (e) {
        return { field: (e as LaunchSettingRefusal).field, text: (e as LaunchSettingRefusal).text };
      }
      throw new Error('expected a refusal');
    };
    expect(refused({ public: true, password: 'abc' })).toEqual({ field: 'password', text: { en: 'A public server needs a password of at least 5 characters.', es: 'Un servidor público necesita una contraseña de al menos 5 caracteres.' } });
    expect(refused({ public: true, password: 'tide', serverName: 'My tide server' })).toMatchObject({ field: 'password' });
    expect(refused({ public: true, password: 'Y TIDE', serverName: 'My tide' })).toEqual({ field: 'password', text: { en: "The password can't be part of the server's name.", es: 'La contraseña no puede formar parte del nombre del servidor.' } });
    expect(() => t.parseLaunch(tideLaunch({ public: true, password: 'sea-salt' }))).not.toThrow();
    // A private server takes any password, or none.
    expect(() => t.parseLaunch(tideLaunch({ password: 'a' }))).not.toThrow();
    expect(refused({ saveEvery: 90 })).toEqual({ field: 'saveEvery', text: { en: 'Save every must go in steps of 60.', es: 'Guardar cada debe ir de 60 en 60.' } });
    expect(refused({ mode: 'easy' })).toMatchObject({ field: 'mode' });
    expect(refused({ branch: 'unlisted' })).toMatchObject({ field: 'branch' });
    expect(refused({ memoryMb: 1000 })).toMatchObject({ field: 'memoryMb' });
    expect(refused({ serverName: 'two\nlines' })).toMatchObject({ field: 'serverName' });
    // What the agent is never sent without: a setting, the game name, a generated secret.
    const { mode: _mode, ...noMode } = tideLaunch();
    expect(() => t.parseLaunch(noMode)).toThrow(/mode is missing/);
    expect(() => t.parseLaunch({ ...tideLaunch(), name: '../x' })).toThrow(/name must be/);
    expect(() => t.parseLaunch({ ...tideLaunch(), adminKey: '' })).toThrow(/secret adminKey/);
    expect(() => t.parseLaunch({ ...tideLaunch(), extra: 1 })).toThrow(/Unknown launch setting extra/);
  });

  it("prepares Avorion's galaxy: the backups folder, and the agent's keys set in the server.ini the game wrote, before every start, idempotently", () => {
    const a = avorion();
    const ctx = ctxOf();
    const p = avLaunch({ listed: true, serverName: 'Gal test' });
    return (async () => {
      await a.prepare(ctx, p);
      expect(existsSync(path.join(ctx.roots.data, 'avorion-backups'))).toBe(true);
      // A new galaxy's first start writes server.ini itself: a file written before it makes the galaxy's
      // seed 0 for every server (measured in the manifest adapter check), so nothing is written.
      expect(existsSync(path.join(ctx.roots.data, 'gal', 'server.ini'))).toBe(false);
      mkdirSync(path.join(ctx.roots.data, 'gal'));
      // What the game wrote after its runs: every key the agent manages set again, everything else kept.
      writeFileSync(path.join(ctx.roots.data, 'gal', 'server.ini'), fixture('config', 'server.ini.after-later-runs'));
      await a.prepare(ctx, p);
      const ini = readFileSync(path.join(ctx.roots.data, 'gal', 'server.ini'), 'utf8');
      const value = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(ini)?.[1];
      expect([value('port'), value('name'), value('maxPlayers'), value('isListed'), value('saveInterval'), value('sendCrashReports'), value('backupsPath')]).toEqual(['30550', 'Gal test', '8', 'true', '300', 'false', `${ctx.roots.data}/avorion-backups`]);
      const before = fixture('config', 'server.ini.after-later-runs').split('\n');
      const after = ini.split('\n');
      expect(after.length).toBe(before.length);
      expect(after.filter((l, i) => l !== before[i]).map((l) => l.split('=')[0])).toEqual(expect.arrayContaining(['port', 'backupsPath']));
      expect(after.filter((l) => l.startsWith('['))).toEqual(before.filter((l) => l.startsWith('[')));
      await a.prepare(ctx, p);
      expect(readFileSync(path.join(ctx.roots.data, 'gal', 'server.ini'), 'utf8')).toBe(ini);
    })();
  });

  it('writes a missing file from its seed, and the managed keys of a file that exists (a port that follows another too)', async () => {
    const t = tide();
    const ctx = ctxOf({ ports: { game: 30560 } });
    const p = t.parseLaunch(tideLaunch());
    await t.prepare(ctx, p);
    expect(readFileSync(path.join(ctx.roots.data, 'banned.txt'), 'utf8')).toBe('# banned SteamIDs\n');
    expect(existsSync(path.join(ctx.roots.data, 'worlds'))).toBe(true);
    // No seed: left for the game to write.
    expect(existsSync(path.join(ctx.roots.data, 'allowed.txt'))).toBe(false);
    mkdirSync(path.join(ctx.roots.data, 'worlds', 'tide'));
    writeFileSync(path.join(ctx.roots.data, 'worlds', 'tide', 'settings.ini'), '# the game\nport=1\nmotd=hi\n');
    writeFileSync(path.join(ctx.roots.data, 'banned.txt'), '76561198000000001\n');
    await t.prepare(ctx, p);
    // Keys the file lacks are added at its end, as the ini format adds them (a blank line before each).
    expect(readFileSync(path.join(ctx.roots.data, 'worlds', 'tide', 'settings.ini'), 'utf8')).toBe('# the game\nport=30560\nmotd=hi\n\nquery=30561\n\nsave=300\n\nworld=tide\n\ntelemetry=off\n');
    // A seed never overwrites what is there.
    expect(readFileSync(path.join(ctx.roots.data, 'banned.txt'), 'utf8')).toBe('76561198000000001\n');
  });

  it('reads what steamcmd installed, installs when the branch differs, updates when asked (UPD-01…03)', async () => {
    const a = avorion();
    const ctx = ctxOf();
    expect(a.installed(ctx)).toBeNull();
    expect(a.installOnStart!(ctx, avLaunch())).toBe('required');
    mkdirSync(path.join(ctx.roots.install, 'steamapps'));
    copyFileSync(path.join(FIXTURES, 'steamcmd', 'appmanifest_565060.acf'), path.join(ctx.roots.install, 'steamapps', 'appmanifest_565060.acf'));
    expect(a.installed(ctx)).toEqual({ version: '2.5.13', channel: 'public', build: '22295362' });
    expect(a.installOnStart!(ctx, avLaunch())).toBeNull();
    expect(a.installOnStart!(ctx, avLaunch({ updateOnStart: true }))).toBe('update');
    expect(a.installOnStart!(ctx, avLaunch({ branch: 'beta' }))).toBe('required');

    const calls: unknown[] = [];
    const install = { ...ctx, onLine: () => undefined, progress: () => undefined, steam: { appUpdate: async (o: unknown) => (calls.push(o), { ok: true }), branches: async () => [{ id: 'public', build: '1' }, { id: 'beta', build: '2' }, { id: 'other', build: '3' }], workshopDownload: async () => ({ ok: true }) } } as InstallCtx;
    await a.install!(install, avLaunch(), { validate: true });
    await a.install!(install, avLaunch({ branch: 'beta' }), { validate: false });
    expect(calls).toEqual([
      { appId: '565060', branch: null, validate: true },
      { appId: '565060', branch: 'beta', validate: false },
    ]);
    expect((await a.versions!(install, avLaunch())).versions.map((v) => v.id)).toEqual(['public', 'beta', 'other']);
    // A fixed list offers only its branches.
    const t = tide();
    expect((await t.versions!(install, t.parseLaunch(tideLaunch()))).versions.map((v) => v.id)).toEqual(['public', 'beta']);
  });
});

describe('controlling the running game (NFR-04, BAK-02, PLY-01, CON-02)', () => {
  const games: { close(): void }[] = [];
  afterEach(() => games.splice(0).forEach((g) => g.close()));

  /** Avorion as scripted from its captures: `/save`, `/players` (with `online` names). */
  function avorionGame(a: RuntimeAdapter<ManifestLaunch>, online: string[] = [], o: { ready?: boolean } = {}) {
    const g = scriptedGame(
      (l) => a.classify(l),
      (line) => {
        if (line === '/save') return ['Saving all server data.', 'Triggered saving of all server data.', 'All sectors saved successfully.'];
        if (line === '/players') return [`online players (${online.length}):`, ...online];
        return [];
      },
      o,
    );
    games.push(g);
    return g;
  }

  it('stops with /stop once the game reads its console, else with its signal', async () => {
    const a = avorion();
    const up = avorionGame(a);
    await a.stop(up.ctl, { budgetMs: 1000 });
    expect([up.written, up.signals]).toEqual([['/stop'], []]);
    const starting = avorionGame(a, [], { ready: false });
    await a.stop(starting.ctl, { budgetMs: 1000 });
    expect([starting.written, starting.signals]).toEqual([[], ['SIGTERM']]);
    // A game without a console always gets its signal.
    const t = tide();
    const g = scriptedGame((l) => t.classify(l));
    games.push(g);
    await t.stop(g.ctl, { budgetMs: 1000 });
    expect(g.signals).toEqual(['SIGINT']);
    expect(t.save).toBeUndefined();
  });

  it('saves with /save and its done line; a running copy saves first (save-then-copy)', async () => {
    const a = avorion();
    const g = avorionGame(a);
    await a.save!(g.ctl, { budgetMs: 2000 });
    await a.hotCopy!.before(g.ctl);
    await a.hotCopy!.after(g.ctl);
    expect(g.written).toEqual(['/save', '/save']);
    expect(a.hotCopy!.select).toBeUndefined();
    const silent = scriptedGame((l) => a.classify(l));
    games.push(silent);
    await expect(a.save!(silent.ctl, { budgetMs: 50 })).rejects.toThrow(/did not report that it finished saving/);
  });

  it('copies between saves: waits out an autosave in progress, fails a copy one started during (copy-between-saves)', async () => {
    const t = tide();
    const g = scriptedGame((l) => t.classify(l));
    games.push(g);
    // Nothing in progress: at once.
    await t.hotCopy!.before(g.ctl);
    await t.hotCopy!.after(g.ctl);
    // An autosave in progress: the copy waits for it to finish.
    g.print('12:00:00 Saving world');
    let ready = false;
    const waiting = t.hotCopy!.before(g.ctl).then(() => (ready = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(ready).toBe(false);
    g.print('12:00:01 World saved');
    await waiting;
    // One that starts during the copy fails it.
    g.print('12:00:02 Saving world');
    await expect(t.hotCopy!.after(g.ctl)).rejects.toThrow(/started saving on its own during the copy/);
    g.print('12:00:03 World saved');
    // An autosave that never ends fails the copy before it starts.
    g.print('12:00:04 Saving world');
    await expect(t.hotCopy!.before(g.ctl)).rejects.toThrow(/did not finish saving on its own in time/);
  });

  it("lists Avorion's players from /players: the count, and names one per line when they come so", async () => {
    const a = avorion();
    expect(await a.listPlayers!(avorionGame(a).ctl)).toEqual({ count: 0, names: [] });
    expect(await a.listPlayers!(avorionGame(a, ['Bob', 'Carol Smith']).ctl)).toEqual({ count: 2, names: ['Bob', 'Carol Smith'] });
    // Names in another form than measured: the count still stands.
    const odd = scriptedGame((l) => a.classify(l), (line) => (line === '/players' ? ['online players (2):', 'Bob, Carol'] : []));
    games.push(odd);
    expect(await a.listPlayers!(odd.ctl)).toEqual({ count: 2, names: [] });
  }, 20_000);

  it('follows join and leave lines, or asks Steam through a hook while its condition holds', async () => {
    const asked: number[] = [];
    const t = manifestRuntimeAdapter(TIDEWATER, { steamQuery: async (_ctx, port) => (asked.push(port), { count: 1, names: ['carol'] }) });
    const ctx = ctxOf({ ports: { game: 30560, query: 30561 } });
    t.command(ctx, t.parseLaunch(tideLaunch()));
    const g = scriptedGame((l) => t.classify(l));
    games.push(g);
    g.print('12:00:00 Joined: 76561198000000001');
    g.print('12:00:01 Joined: 76561198000000002');
    g.print('12:00:02 Left: 76561198000000001');
    expect(await t.listPlayers!(g.ctl, ctx, t.parseLaunch(tideLaunch()))).toEqual({ count: 1, names: ['76561198000000002'] });
    expect(await t.listPlayers!(g.ctl, ctx, t.parseLaunch(tideLaunch({ public: true, password: 'sea-salt' })))).toEqual({ count: 1, names: ['carol'] });
    expect(asked).toEqual([30561]);
    // A new run starts with nobody online.
    t.command(ctx, t.parseLaunch(tideLaunch()));
    expect(await t.listPlayers!(g.ctl, ctx, t.parseLaunch(tideLaunch()))).toEqual({ count: 0, names: [] });
  });

  it('gives a typed console line its prefix (CON-02); a game without a console has none', () => {
    expect(avorion().consoleLine!('players')).toBe('/players');
    expect(avorion().consoleLine!('/say hi')).toBe('/say hi');
    expect(tide().consoleLine).toBeUndefined();
    expect(avorion().channel(ctxOf(), avLaunch())).toEqual({ kind: 'stdin' });
    expect(tide().channel(ctxOf(), tide().parseLaunch(tideLaunch()))).toEqual({ kind: 'none' });
  });
});

describe('hooks (what a manifest cannot say)', () => {
  it('turn a selection into the running copy, and may change the adapter they made', async () => {
    const select = async (_ctx: RuntimeCtx, files: string[]) => files.filter((f) => f.endsWith('.ok'));
    const t = manifestRuntimeAdapter(TIDEWATER, { hotCopySelect: select, runtime: (a) => ({ ...a, stop: async (ctl) => ctl.signal('SIGTERM') }) });
    expect(await t.hotCopy!.select!(ctxOf(), ['a.ok', 'a.db'])).toEqual(['a.ok']);
    const g = scriptedGame((l) => t.classify(l));
    // With a selection, a save during the copy can't spoil it: the copy is of the picks.
    g.print('12:00:00 Saving world');
    g.print('12:00:01 World saved');
    await t.hotCopy!.before(g.ctl);
    g.print('12:00:02 Saving world');
    await expect(t.hotCopy!.after(g.ctl)).resolves.toBeUndefined();
    await t.stop(g.ctl, { budgetMs: 10 });
    expect(g.signals).toEqual(['SIGTERM']);
    g.close();
  });
});

describe('a game without a console, from its manifest alone', () => {
  runtimeAdapterSuite(tide(), {
    validLaunch: () => tideLaunch(),
    captured: { boot: ['\u001b[32m12:00:00 Version 0.9.1\u001b[0m', '12:00:01 Placing trees', '12:00:02 Placing rocks', '12:00:03 Server is up'], bootVersion: '0.9.1', fatal: ['12:00:04 Bad password: too short'] },
  });
});
