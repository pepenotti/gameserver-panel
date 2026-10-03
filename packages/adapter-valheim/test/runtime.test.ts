// Valheim's runtime half against what the dedicated server 1.0.16 did
// (docs/verification/valheim-1.0.16.md, fixtures/valheim/1.0.16): its
// command line (SRV-01, CFG-01), the password rules of a public server
// refused before a start in both languages, its lines (CON-01, SRV-07),
// the stop by signal (SRV-03, NFR-04), its own saves and the running copy
// (BAK-02), players (PLY-01) and the install through steamcmd (UPD-01…03).
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ControlHandle, InstallCtx, LaunchSettingRefusal, LineSignal, RuntimeCtx } from '@gsp/adapter-api';
import { valheimRuntimeAdapter as vh } from '../src/runtime';
import { FIXTURES, fixtureLines, valheimLaunch } from './helpers';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function ctxOf(over: Partial<RuntimeCtx> = {}): RuntimeCtx {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-valheim-'));
  dirs.push(dir);
  const roots = { data: path.join(dir, 'data'), install: path.join(dir, 'install') };
  mkdirSync(roots.data, { recursive: true });
  mkdirSync(roots.install, { recursive: true });
  return { roots, stateDir: path.join(dir, 'state'), ports: { game: 30550, query: 30551 }, state: { controlSecret: 's'.repeat(48), gameVersion: '1.0.16' }, tools: { home: path.join(dir, 'home') }, env: {}, log: () => undefined, ...over };
}

const launch = (over: Record<string, unknown> = {}) => vh.parseLaunch(valheimLaunch(over));
const read = (file: string) => fixtureLines('logs', file).map((l) => vh.classify(l));

/** A running game, as the agent's handle drives it: what it was sent, and lines it prints. */
function game(o: { ready?: boolean } = {}) {
  const signals: NodeJS.Signals[] = [];
  const waiters = new Set<{ re: RegExp; resolve: (m: RegExpExecArray | null) => void }>();
  const ctl: ControlHandle = {
    ready: o.ready ?? true,
    command: async () => null,
    stdin: () => false,
    signal: (s) => void signals.push(s),
    waitForLine: (re) => new Promise((resolve) => waiters.add({ re, resolve })),
  };
  const print = (raw: string): LineSignal => {
    const s = vh.classify(raw);
    for (const w of [...waiters]) {
      const m = w.re.exec(s.message);
      if (m) {
        waiters.delete(w);
        w.resolve(m);
      }
    }
    return s;
  };
  return { ctl, signals, print };
}

describe('the command line (SRV-01, CFG-01)', () => {
  it('is the measured one: the save folder in the data volume, the port, the world named after the server, a 5-minute autosave; never -logfile', () => {
    const ctx = ctxOf();
    const cmd = vh.command(ctx, launch());
    expect(cmd).toEqual({
      argv: [`${ctx.roots.install}/valheim_server.x86_64`, '-nographics', '-batchmode', '-name', 'gspff test', '-port', '30550', '-world', 'vh', '-password', 'secret12', '-public', '0', '-savedir', ctx.roots.data, '-saveinterval', '300'],
      cwd: ctx.roots.install,
      env: { LD_LIBRARY_PATH: `${ctx.roots.install}/linux64`, SteamAppId: '892970' },
    });
    expect(cmd.argv).not.toContain('-logfile');
  });

  it('passes -password only when there is one, -public 1 when listed, -crossplay only when asked (Q14, Q15)', () => {
    const ctx = ctxOf();
    const args = (over: Record<string, unknown>) => vh.command(ctx, launch(over)).argv.slice(1);
    // A private server without a password: no -password at all (an empty argument isn't what was measured).
    expect(args({ password: '' })).toEqual(['-nographics', '-batchmode', '-name', 'gspff test', '-port', '30550', '-world', 'vh', '-public', '0', '-savedir', ctx.roots.data, '-saveinterval', '300']);
    expect(args({ public: true, password: 'hunter22' })).toEqual(expect.arrayContaining(['-password', 'hunter22', '-public', '1']));
    expect(args({})).not.toContain('-crossplay');
    expect(args({ crossplay: true }).at(-1)).toBe('-crossplay');
    // The dev loop and tests start the fake in the game's place.
    expect(vh.command(ctxOf({ tools: { home: 'h', launcher: ['node', 'server.mjs'] } }), launch()).argv.slice(0, 3)).toEqual(['node', 'server.mjs', '-nographics']);
  });

  it('keeps the password out of every log line', () => {
    expect(vh.secrets(launch({ password: 'hunter22' }), { controlSecret: 'c', gameVersion: null })).toEqual(['c', 'hunter22']);
    expect(vh.secrets(launch({ password: '' }), { controlSecret: 'c', gameVersion: null })).toEqual(['c']);
  });

  it('refuses before a start what Valheim would refuse after 36 s: a listed server with a short, missing or name-contained password, in both languages', () => {
    const refused = (over: Record<string, unknown>) => {
      try {
        launch(over);
      } catch (e) {
        return { field: (e as LaunchSettingRefusal).field, text: (e as LaunchSettingRefusal).text };
      }
      throw new Error('expected a refusal');
    };
    const short = {
      field: 'password',
      text: { en: 'A server in the public list needs a password of at least 5 characters: Valheim refuses to start otherwise.', es: 'Un servidor de la lista pública necesita una contraseña de al menos 5 caracteres: si no, Valheim no arranca.' },
    };
    // As measured: 4 characters and none failed with "The password is too short".
    expect(refused({ public: true, password: 'abcd' })).toEqual(short);
    expect(refused({ public: true, password: '' })).toEqual(short);
    // As measured: "gspff" inside "gspff test" failed with "Invalid password" (case is ignored, to be safe).
    const inName = {
      field: 'password',
      text: { en: "A server in the public list can't have a password that is part of its name: Valheim refuses to start otherwise.", es: 'Un servidor de la lista pública no puede tener una contraseña que forme parte de su nombre: si no, Valheim no arranca.' },
    };
    expect(refused({ public: true, password: 'gspff' })).toEqual(inName);
    expect(refused({ public: true, password: 'GSPFF TEST' })).toEqual(inName);
    expect(() => launch({ public: true, password: 'hunter22' })).not.toThrow();
    // A private server took 3 characters and none (measured).
    expect(() => launch({ password: 'abc' })).not.toThrow();
    expect(() => launch({ password: '' })).not.toThrow();
    expect(refused({ serverName: '' })).toMatchObject({ field: 'serverName' });
    expect(refused({ saveInterval: 30 })).toMatchObject({ field: 'saveInterval' });
    expect(refused({ memoryMb: 1024 })).toMatchObject({ field: 'memoryMb' });
  });

  it('prepares nothing of its own: Valheim writes its lists and worlds itself', async () => {
    const ctx = ctxOf();
    await vh.prepare(ctx, launch());
    expect(vh.roots(launch())).toEqual({ data: '/data', install: '/opt/game' });
  });
});

describe("reading Valheim's lines (CON-01, SRV-07)", () => {
  it('ready on "Opened Steam server" (PlayFab with crossplay), once per boot, with its version; not on Steam\'s logon', () => {
    for (const [file, ready] of [
      ['first-boot-then-sigterm.log', 'Opened Steam server'],
      ['existing-world-autosaves-then-sigint.log', 'Opened Steam server'],
      ['public.log', 'Opened Steam server'],
      ['private-short-password.log', 'Opened Steam server'],
      ['crossplay.log', 'Opened PlayFab server'],
      ['crossplay-missing-libraries.log', 'Opened PlayFab server'],
    ] as const) {
      const s = read(file);
      expect(s.filter((x) => x.ready).map((x) => x.message), file).toEqual([ready]);
      expect(s.flatMap((x) => (x.version ? [x.version] : [])), file).toEqual(['1.0.16']);
      expect(s.some((x) => x.fatal), file).toBe(false);
    }
    // "Game server connected" is Steam's logon: on a first boot it came before the world existed.
    expect(vh.classify('10/01/2026 15:39:30: Game server connected').ready).toBeUndefined();
  });

  it('marks the measured failures fatal, and never readies the ones that never got ready', () => {
    for (const file of ['fail-password-too-short-public.log', 'fail-no-password-public.log', 'fail-password-in-name.log', 'fail-query-port-in-use.log', 'never-ready-readonly-savedir.log']) {
      const s = read(file);
      expect(s.filter((x) => x.fatal).length, file).toBe(1);
      expect(s.some((x) => x.ready), file).toBe(false);
    }
    // A corrupt world: the fatal line first, then the ready line anyway, then the game quits.
    const corrupt = read('fail-corrupt-world.log');
    expect(corrupt.findIndex((x) => x.fatal)).toBeLessThan(corrupt.findIndex((x) => x.ready));
    expect(corrupt.find((x) => x.fatal)!.message).toBe('World load failed mid-file. Exiting without save. Check backups!');
    // A taken game port is silent (measured): nothing the panel can read.
    expect(read('game-port-in-use-silent.log').some((x) => x.fatal)).toBe(false);
  });

  it('warns, once a run in the agent, when Steam is out of reach or crossplay lacks its libraries', () => {
    const warned = (file: string) => read(file).filter((x) => x.warning);
    const offline = warned('no-network.log').filter((x) => x.message === 'Game server connected failed');
    expect(offline.length).toBeGreaterThanOrEqual(3);
    expect(new Set(offline.map((x) => x.warning!.en)).size).toBe(1);
    expect(offline[0]!.warning!.en).toMatch(/^Valheim can't reach Steam/);
    // PlayFab's libraries were missing from the image every capture but crossplay.log ran in: its line
    // shows on every start, with or without crossplay; the warning says only crossplay needs them.
    const libs = warned('crossplay-missing-libraries.log');
    expect(libs.map((x) => x.message)).toEqual(['DllNotFoundException: libParty.so assembly:<unknown assembly> type:<unknown type> member:(null)']);
    expect(libs[0]!.warning!.en).toMatch(/libraries crossplay needs.*Servers without crossplay aren't affected\.$/);
    expect(warned('first-boot-then-sigterm.log').map((x) => x.warning!.en)).toEqual([libs[0]!.warning!.en]);
    // The steam image has them since M6: a crossplay boot with them warns of nothing.
    expect(warned('crossplay.log')).toEqual([]);
  });

  it("takes Valheim's timestamp off, and shows its chatty boot as a few progress runs", () => {
    expect(vh.classify('10/01/2026 15:43:18: Opened Steam server')).toEqual({ message: 'Opened Steam server', ready: true });
    expect(vh.display!('10/01/2026 15:43:18: Registering lobby')).toBe('Registering lobby');
    // Unity's lines carry no stamp, and stay as they are.
    expect(vh.display!('Forcing GfxDevice: Null')).toBe('Forcing GfxDevice: Null');
    const boot = read('first-boot-then-sigterm.log');
    const runs = (key: string) => boot.filter((x) => x.progress?.key === key).length;
    expect(runs('unity-memory')).toBe(29);
    expect(runs('translations')).toBe(13);
    expect(runs('location-types')).toBe(6);
    // World generation: the run of location lines before the ready line (48 on the measured first boot).
    expect(runs('worldgen')).toBe(48);
    expect(boot.findLastIndex((x) => x.progress?.key === 'worldgen')).toBeLessThan(boot.findIndex((x) => x.ready));
    // An existing world isn't generated again.
    expect(read('existing-world-autosaves-then-sigint.log').some((x) => x.progress?.key === 'worldgen')).toBe(false);
  });

  it("follows its autosaves, and the save of a stop, as saves (BAK-02)", () => {
    const s = read('existing-world-autosaves-then-sigint.log');
    // Eight saves: seven on the 60-second timer, one on SIGINT.
    expect(s.filter((x) => x.saved).map((x) => x.message.replace(/\[\d+ms\]/, '[…]'))).toEqual(Array(8).fill('World save (5/5) done. Total time […]'));
  });
});

describe('stopping and saving (SRV-03, NFR-04)', () => {
  it('stops with SIGINT, which saves first, whether the game is up or still starting; it has no save command', async () => {
    const up = game();
    await vh.stop(up.ctl, { budgetMs: 1000 });
    expect(up.signals).toEqual(['SIGINT']);
    const starting = game({ ready: false });
    await vh.stop(starting.ctl, { budgetMs: 1000 });
    expect(starting.signals).toEqual(['SIGINT']);
    expect(vh.save).toBeUndefined();
    expect(vh.channel(ctxOf(), launch())).toEqual({ kind: 'none' });
    expect(vh.consoleLine).toBeUndefined();
  });

  it('copies a running server without waiting for its save: the hook takes the newest complete set (BAK-02)', async () => {
    const g = game();
    g.print('10/01/2026 15:44:02: World save (1/5) Cloud & Backup checks done [1ms] => Save number 2');
    await expect(vh.hotCopy!.before(g.ctl)).resolves.toBeUndefined();
    // On disk, written in this order (a second apart): set 1, then save 2's chunk and index so far.
    const ctx = ctxOf();
    const files = ['adminlist.txt', 'worlds_local/vh/00_00__0_1.chunk', 'worlds_local/vh/_main.1.chunks', 'worlds_local/vh/_main.1.db2', 'worlds_local/vh/_main.1.fwl2', 'worlds_local/vh/_main.1.ok', 'worlds_local/vh/00_00__0_2.chunk', 'worlds_local/vh/_main.2.chunks'];
    mkdirSync(path.join(ctx.roots.data, 'worlds_local', 'vh'), { recursive: true });
    files.forEach((f, i) => {
      const file = path.join(ctx.roots.data, ...f.split('/'));
      writeFileSync(file, 'x');
      utimesSync(file, 1_000_000 + i, 1_000_000 + i);
    });
    expect(await vh.hotCopy!.select!(ctx, [...files].sort())).toEqual(['adminlist.txt', 'worlds_local/vh/00_00__0_1.chunk', 'worlds_local/vh/_main.1.chunks', 'worlds_local/vh/_main.1.db2', 'worlds_local/vh/_main.1.fwl2', 'worlds_local/vh/_main.1.ok']);
    g.print('10/01/2026 15:44:02: World save (5/5) done. Total time [94ms]');
    await expect(vh.hotCopy!.after(g.ctl)).resolves.toBeUndefined();
  });
});

describe('players (PLY-01)', () => {
  it('counts a private server from its join and leave lines (as the game\'s strings word them: no client joined)', async () => {
    const ctx = ctxOf();
    const p = launch();
    vh.command(ctx, p);
    const g = game();
    g.print('10/01/2026 16:00:00: Got connection SteamID 76561198000000001');
    expect(g.print('10/01/2026 16:00:00: Got handshake from client 76561198000000001')).toMatchObject({ join: '76561198000000001' });
    g.print('10/01/2026 16:00:01: Got handshake from client 76561198000000002');
    expect(g.print('10/01/2026 16:00:05: Closing socket 76561198000000001')).toMatchObject({ leave: '76561198000000001' });
    expect(await vh.listPlayers!(g.ctl, ctx, p)).toEqual({ count: 1, names: ['76561198000000002'] });
    // A new run starts with nobody online.
    vh.command(ctx, p);
    expect(await vh.listPlayers!(g.ctl, ctx, p)).toEqual({ count: 0, names: [] });
  });

  it("asks Steam's server query on the query port of a server in the public list (an answer from nobody fails the poll)", async () => {
    // Nothing listens on this port: the query times out, which the agent counts as an unanswered poll.
    const ctx = ctxOf({ ports: { game: 9, query: 9 } });
    const p = launch({ public: true, password: 'hunter22' });
    await expect(vh.listPlayers!(game().ctl, ctx, p)).rejects.toThrow(/did not answer Steam's server query on port 9/);
  }, 10_000);
});

describe('install and versions (UPD-01…03)', () => {
  it('reads the app manifest steamcmd left, installs app 896660 anonymously, offers the branches Steam lists', async () => {
    const ctx = ctxOf();
    expect(vh.installed(ctx)).toBeNull();
    expect(vh.installOnStart!(ctx, launch())).toBe('required');
    mkdirSync(path.join(ctx.roots.install, 'steamapps'));
    copyFileSync(path.join(FIXTURES, 'steamcmd', 'appmanifest_896660.acf'), path.join(ctx.roots.install, 'steamapps', 'appmanifest_896660.acf'));
    expect(vh.installed(ctx)).toEqual({ version: '1.0.16', channel: 'public', build: '25527701' });
    // HST-09: shared (it ran read-only as it is, measured), named by branch and build.
    expect(vh.meta.install).toEqual({ mode: 'shared' });
    expect(vh.installKey!(ctx)).toEqual({ flavour: null, version: null, build: '25527701', branch: 'public' });
    expect(vh.installOnStart!(ctx, launch())).toBeNull();
    expect(vh.installOnStart!(ctx, launch({ updateOnStart: true }))).toBe('update');
    expect(vh.installOnStart!(ctx, launch({ branch: 'default_old' }))).toBe('required');
    const calls: unknown[] = [];
    const install = { ...ctx, onLine: () => undefined, progress: () => undefined, steam: { appUpdate: async (o: unknown) => (calls.push(o), { ok: true }), branches: async () => [{ id: 'public', build: '25527701' }, { id: 'default_old', build: '25390671' }], workshopDownload: async () => ({ ok: true }) } } as InstallCtx;
    await vh.install!(install, launch(), { validate: true });
    await vh.install!(install, launch({ branch: 'default_old' }), { validate: false });
    expect(calls).toEqual([
      { appId: '896660', branch: 'public', validate: true },
      { appId: '896660', branch: 'default_old', validate: false },
    ]);
    expect((await vh.versions!(install, launch())).versions.map((v) => v.id)).toEqual(['public', 'default_old']);
  });
});
