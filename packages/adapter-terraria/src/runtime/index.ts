/**
 * Terraria, agent side (M5): vanilla, TShock and tModLoader installed and
 * pinned per server, launched with every path absolute and the data root as
 * their save folder, read from their console, controlled on stdin (and
 * TShock also through its REST API, in the runtime's actions), saved and
 * hot-copied with `save`. Every fact comes from
 * docs/verification/terraria-1.4.5.8.md and fixtures/terraria/1.4.5.8.
 */
import type { ControlHandle, FileRoots, LaunchCommand, LineSignal, PlayerList, RuntimeAdapter, RuntimeCtx } from '@gsp/adapter-api';
import { DATA } from '../shared/install';
import { parseTerrariaLaunch, type TerrariaLaunch } from '../shared/launch';
import { bare, display, FATAL, parsePlaying, playingDone, TR_PATTERNS } from '../shared/log';
import { TERRARIA_META } from '../shared/meta';
import { dataPath, port, prepare, worldFile } from './files';
import { install, installedEntry, installedInfo, installNeeded, listVersions } from './install';
import { restPlayerList, TSHOCK_ACTIONS } from './rest';

export type { TerrariaLaunch };
export { managedServerConfig, setServerConfig, tshockConfig } from './files';
export { readMarker } from './install';
export { clearSourceCache } from './sources';
export { restBans, restPlayers, TSHOCK_ACTIONS, type RestBan, type RestPlayer } from './rest';

/** The orchestrator's mounts for the native and steam families: the server's data and install volumes. */
export const TERRARIA_ROOTS: FileRoots = { data: '/data', install: '/opt/game' };

/** Microsoft's .NET runtime in the images (docker/steam for tModLoader); TShock's app host finds it through DOTNET_ROOT. */
export const DOTNET = '/usr/share/dotnet/dotnet';
/** How long a hot copy waits for the save it asks for; a large world takes a while. */
const HOT_COPY_SAVE_MS = 5 * 60_000;
/** How long `playing` gets to answer. */
const PLAYING_MS = 10_000;

export function classify(raw: string): LineSignal {
  const m = bare(raw);
  const s: LineSignal = { message: m };
  if (TR_PATTERNS.ready.test(m)) s.ready = true;
  const v = TR_PATTERNS.version.exec(m);
  if (v) s.version = v[1]!;
  const j = TR_PATTERNS.join.exec(m);
  if (j) s.join = j[1]!;
  const l = TR_PATTERNS.leave.exec(m);
  if (l) s.leave = l[1]!;
  if (TR_PATTERNS.saved.test(m)) s.saved = true;
  // Every start names a world; the menu means it got none and would wait forever.
  if (TR_PATTERNS.worldMenu.test(m)) s.blockingPrompt = 'The server is showing its world menu (it was given no world it could load) and waits for a choice nobody will type';
  if (FATAL.some((re) => re.test(m))) s.fatal = true;
  return s;
}

/** `save`, then the line that says the world file is complete. */
async function save(ctl: ControlHandle, o: { budgetMs: number }): Promise<void> {
  const line = ctl.waitForLine(TR_PATTERNS.saved, o.budgetMs);
  if (!ctl.stdin('save')) throw new Error('Could not write to the server console');
  if (!(await line)) throw new Error('The server did not report that it finished saving');
}

/**
 * `playing` on the console (vanilla and tModLoader list the players, then
 * their count; TShock gives a count and the names). An agent without
 * `waitForLines` gets the count only.
 */
async function consolePlayers(ctl: ControlHandle): Promise<PlayerList | null> {
  if (ctl.waitForLines) {
    const lines = ctl.waitForLines(playingDone, PLAYING_MS);
    if (!ctl.stdin('playing')) throw new Error('Could not write to the server console');
    const got = await lines;
    if (!got) throw new Error('The server did not answer playing');
    return parsePlaying(got);
  }
  const count = ctl.waitForLine(TR_PATTERNS.playingCount, PLAYING_MS);
  if (!ctl.stdin('playing')) throw new Error('Could not write to the server console');
  const m = await count;
  if (!m) throw new Error('The server did not answer playing');
  return { count: m[1] === undefined ? 0 : Number(m[1]), names: [] };
}

function launchEntry(ctx: RuntimeCtx, p: TerrariaLaunch) {
  const e = installedEntry(ctx);
  if (!e) throw new Error('Terraria is not installed yet');
  if (e.marker.flavour !== p.flavour) throw new Error(`The installed server is ${e.marker.flavour}, not ${p.flavour}: install it first`);
  return e;
}

/** The launch's flags, the same for the three flavours (all paths absolute: vanilla moves itself into its install folder). */
function gameFlags(ctx: RuntimeCtx, p: TerrariaLaunch): string[] {
  return [
    '-port',
    String(port(ctx, 'game')),
    '-maxplayers',
    String(p.maxPlayers),
    '-world',
    worldFile(ctx, p),
    // Always: without it a missing world means a silent exit 0; with it an existing world is loaded.
    '-autocreate',
    String(p.worldSize),
    '-worldname',
    p.world,
    '-banlist',
    dataPath(ctx, DATA.banlist),
    '-config',
    dataPath(ctx, DATA.serverConfig),
  ];
}

export function command(ctx: RuntimeCtx, p: TerrariaLaunch): LaunchCommand {
  const e = launchEntry(ctx, p);
  const data = ctx.roots.data;
  const launcher = ctx.tools.launcher;
  if (p.flavour === 'tmodloader') {
    return {
      // `dotnet tModLoader.dll`; the launcher stands in for dotnet in tests and the dev loop.
      argv: [
        ...(launcher ?? [DOTNET]),
        e.entry,
        '-server',
        '-nosteam',
        ...gameFlags(ctx, p),
        '-tmlsavedirectory',
        data,
        '-steamworkshopfolder',
        dataPath(ctx, DATA.workshop),
      ],
      // It must run from its install folder (it loads its libraries from there) and writes its logs there.
      cwd: e.folder,
    };
  }
  const bin = launcher ?? [e.entry];
  if (p.flavour === 'tshock') {
    return {
      argv: [...bin, ...gameFlags(ctx, p), '-savedirectory', data, '-configpath', dataPath(ctx, DATA.tshock), '-logpath', dataPath(ctx, DATA.tshockLogs), '-crashdir', dataPath(ctx, DATA.tshockCrashes)],
      cwd: data,
      // The single-file app host unpacks a native library; HOME is read-only.
      env: { DOTNET_BUNDLE_EXTRACT_BASE_DIR: '/tmp/dotnet-bundle', DOTNET_CLI_TELEMETRY_OPTOUT: '1' },
    };
  }
  return { argv: [...bin, ...gameFlags(ctx, p), '-savedirectory', data, '-noupnp'], cwd: data };
}

export const terrariaRuntimeAdapter: RuntimeAdapter<TerrariaLaunch> = {
  meta: TERRARIA_META,
  parseLaunch: parseTerrariaLaunch,

  // The control secret is TShock's REST token; vanilla's `password` command prints the password.
  secrets: (p, st) => [st.controlSecret, ...(p.password ? [p.password] : [])],

  installed: installedInfo,
  install,
  installOnStart: installNeeded,
  versions: listVersions,

  prepare,
  command,
  classify,
  // The prompt and byte-order marks out; TShock's setup code (if one is ever printed) hidden.
  display,

  channel: () => ({ kind: 'stdin' }),

  async stop(ctl) {
    // `exit` saves and stops every flavour (TShock: like `off`); SIGTERM doesn't save on vanilla and
    // TShock. Lines typed while the world is still loading wait for it. Any exit the agent didn't ask
    // for is a crash, even with code 0.
    ctl.stdin('exit');
  },

  save,

  hotCopy: {
    // BAK-02: there is no save-off; a save leaves the world file complete, and the copy follows.
    before: (ctl) => save(ctl, { budgetMs: HOT_COPY_SAVE_MS }),
    after: async () => undefined,
    // TShock's accounts and bans (rollback journal): copied through SQLite.
    sqlite: [DATA.tshockDb],
  },

  async listPlayers(ctl, ctx, p): Promise<PlayerList | null> {
    // TShock logs every console command, so it is asked over its REST API, quietly.
    if (ctx && p?.flavour === 'tshock') return restPlayerList(ctx);
    return consolePlayers(ctl);
  },

  roots: () => ({ ...TERRARIA_ROOTS }),
  actions: TSHOCK_ACTIONS,
};
