/**
 * Project Zomboid, agent side: steamcmd install and branches, the start
 * command, readiness from the log, RCON with stdin as fallback, save+quit,
 * and reads of the game's own database for the panel (actions).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  BanList,
  ControlHandle,
  InstallCtx,
  InstalledInfo,
  JobResult,
  LaunchCommand,
  LineSignal,
  PlayerAccount,
  PlayerList,
  RuntimeAction,
  RuntimeAdapter,
  RuntimeCtx,
  SteamCmd,
  VersionsResponse,
} from '@gsp/adapter-api';
import { buildIni, isFatal, parseAppManifest, setIniValues } from '@gsp/formats';
import type { PzLaunch } from '../shared/launch';
import { ACCOUNTS, BANS, WORKSHOP_DOWNLOAD, type ServerDbInput, type WorkshopDownloadInput } from '../shared/actions';
import { parseLogLine, parsePlayers, PZ_PATTERNS } from '../shared/log';
import { PZ_META } from '../shared/meta';

/** Launch params the panel sends (`LaunchEnvelope.params`). */
export type { PzLaunch };

/** Steam app of the dedicated server (`PZ_APP_ID` in the agent's environment overrides it). */
export const PZ_APP_ID = '380870';
/** Steam app the game's Workshop items belong to. */
export const PZ_WORKSHOP_APP_ID = '108600';
/** Always passed to the JVM: the files the game generates get English comments. */
export const PZ_JVM_FLAGS = ['-Duser.language=en', '-Duser.country=US'];
/** Default in-container roots (the pz image). */
export const PZ_ROOTS = { data: '/data', install: '/opt/pz' } as const;

const ADMIN_PROMPT = 'The server asked for an admin password on the console';
/** How long the hot copy waits for "Saving finish" (a save the agent asks for has its own budget). */
const HOT_COPY_SAVE_MS = 10 * 60_000;

const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const ADMIN_USER = /^[A-Za-z0-9_]{1,32}$/;
const ADMIN_PASSWORD = /^[\x21-\x7e]{8,64}$/;
const BRANCH = /^[A-Za-z0-9._-]{1,64}$/;
const WORKSHOP_ID = /^\d{5,20}$/;

function asObject(x: unknown): Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

export function parseLaunch(input: unknown): PzLaunch {
  const o = asObject(input);
  const bad = (m: string): never => {
    throw new Error(m);
  };
  if (typeof o.serverName !== 'string' || !NAME.test(o.serverName)) bad('serverName must be 1-32 letters, digits, _ or -');
  if (typeof o.adminUsername !== 'string' || !ADMIN_USER.test(o.adminUsername)) bad('adminUsername must be 1-32 letters, digits or _');
  if (typeof o.adminPassword !== 'string' || !ADMIN_PASSWORD.test(o.adminPassword)) bad('adminPassword must be 8-64 printable characters without spaces');
  if (typeof o.memoryMb !== 'number' || !Number.isInteger(o.memoryMb) || o.memoryMb < PZ_META.memory.minMb || o.memoryMb > 65536) bad(`memoryMb must be ${PZ_META.memory.minMb}-65536`);
  if (typeof o.branch !== 'string' || !BRANCH.test(o.branch)) bad('branch is invalid');
  if (typeof o.updateOnStart !== 'boolean') bad('updateOnStart must be a boolean');
  return {
    serverName: o.serverName as string,
    adminUsername: o.adminUsername as string,
    adminPassword: o.adminPassword as string,
    memoryMb: o.memoryMb as number,
    branch: o.branch as string,
    updateOnStart: o.updateOnStart as boolean,
  };
}

function appId(ctx: RuntimeCtx): string {
  const v = ctx.env.PZ_APP_ID;
  return v && /^\d{1,10}$/.test(v) ? v : PZ_APP_ID;
}

function port(ctx: RuntimeCtx, id: 'game' | 'udp' | 'rcon'): number {
  return ctx.ports[id] ?? PZ_META.ports.find((p) => p.id === id)!.default;
}

function steam(ctx: InstallCtx): SteamCmd {
  if (!ctx.steam) throw new Error('No steamcmd driver: Project Zomboid is installed with steamcmd');
  return ctx.steam;
}

export function installed(ctx: RuntimeCtx): InstalledInfo | null {
  try {
    const m = parseAppManifest(readFileSync(path.join(ctx.roots.install, 'steamapps', `appmanifest_${appId(ctx)}.acf`), 'utf8'));
    return { version: ctx.state.gameVersion, channel: m.branch, build: m.buildId };
  } catch {
    return null;
  }
}

/** Keys the agent owns in `Server/<serverName>.ini`; PZ completes a partial ini with defaults. */
export function managedIni(ctx: RuntimeCtx): Record<string, string> {
  return {
    RCONPort: String(port(ctx, 'rcon')),
    RCONPassword: ctx.state.controlSecret,
    DefaultPort: String(port(ctx, 'game')),
    UDPPort: String(port(ctx, 'udp')),
    UPnP: 'false',
  };
}

export function classify(raw: string): LineSignal {
  const { message } = parseLogLine(raw);
  const s: LineSignal = { message };
  // Measured on 42.20.4: "SERVER STARTED", then "RCON: listening" ~50 ms later.
  if (PZ_PATTERNS.ready.test(message)) s.ready = true;
  if (PZ_PATTERNS.rconListening.test(message)) s.channelReady = true;
  const v = PZ_PATTERNS.version.exec(message);
  if (v) s.version = v[1]!;
  // Without -adminpassword on a fresh world the server blocks on stdin for one.
  if (PZ_PATTERNS.adminPrompt.test(message)) s.blockingPrompt = ADMIN_PROMPT;
  if (PZ_PATTERNS.saveFinished.test(message)) s.saved = true;
  // The JVM's own fatal lines, and the exception PZ logs when its boot dies.
  if (isFatal(raw) || PZ_PATTERNS.bootFailed.test(message)) s.fatal = true;
  return s;
}

/** `save`, then PZ's "Saving finish" within `budgetMs` (the console fallback also works: PZ reads stdin). */
async function save(ctl: ControlHandle, o: { budgetMs: number }): Promise<void> {
  const finished = ctl.waitForLine(PZ_PATTERNS.saveFinished, o.budgetMs);
  await ctl.command('save');
  if (!(await finished)) throw new Error('The server did not report that it finished saving');
}

// ------------------------------------------------------------------ actions

/** The game's own database: accounts, roles, bans (docs/verification/pz-b42.md). */
function gameDbFile(ctx: RuntimeCtx, serverName: string): string {
  return path.join(ctx.roots.data, 'db', `${serverName}.db`);
}

/**
 * The game creates `db/<serverName>.db` early in its first boot, and its
 * tables only when that file doesn't exist yet. A first boot that dies in
 * between leaves it at 0 bytes, and every later start fails with "no such
 * table" (measured in the M2 acceptance run, docs/verification/m2-acceptance.md).
 * An empty file holds nothing, so it goes before a start; one with any
 * content is never touched.
 */
export function removeEmptyGameDb(ctx: RuntimeCtx, serverName: string): void {
  const file = gameDbFile(ctx, serverName);
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return;
  }
  if (!st.isFile() || st.size !== 0) return;
  unlinkSync(file);
  ctx.log(`Removed the empty game database db/${serverName}.db that a failed start left behind; the game creates it again.`);
}

/** Reads the game's database without ever creating or changing it: nothing when it doesn't exist, read-only otherwise. */
function withGameDb<T>(ctx: InstallCtx, serverName: string, fn: (db: DatabaseSync) => T, fallback: T): T {
  const file = gameDbFile(ctx, serverName);
  if (!existsSync(file)) return fallback;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    return fn(db);
  } catch (e) {
    // The game may hold a write lock, or a future build may change the schema.
    ctx.log(`Could not read the game database: ${(e as Error).message}`);
    return fallback;
  } finally {
    db?.close();
  }
}

function parseServerDb(x: unknown): ServerDbInput {
  const o = asObject(x);
  if (typeof o.serverName !== 'string' || !NAME.test(o.serverName)) throw new Error('serverName must be 1-32 letters, digits, _ or -');
  return { serverName: o.serverName };
}

export function readAccounts(ctx: InstallCtx, serverName: string): PlayerAccount[] {
  return withGameDb(
    ctx,
    serverName,
    (db) => {
      const roles = new Map((db.prepare('SELECT id, name FROM role').all() as { id: number; name: string }[]).map((r) => [r.id, r.name]));
      const rows = db.prepare('SELECT username, displayName, role, lastConnection, steamid FROM whitelist ORDER BY username COLLATE NOCASE').all() as {
        username: string;
        displayName: string | null;
        role: number;
        lastConnection: string | null;
        steamid: string | null;
      }[];
      return rows.map((r) => ({ username: r.username, displayName: r.displayName, role: roles.get(r.role) ?? String(r.role), lastConnection: r.lastConnection, steamId: r.steamid }));
    },
    [],
  );
}

export function readBans(ctx: InstallCtx, serverName: string): BanList {
  return withGameDb(
    ctx,
    serverName,
    (db) => ({
      steamIds: (db.prepare('SELECT steamid, reason FROM bannedid').all() as { steamid: string; reason: string | null }[]).map((r) => ({ steamId: r.steamid, reason: r.reason })),
      ips: (db.prepare('SELECT ip, username, reason FROM bannedip').all() as { ip: string; username: string | null; reason: string | null }[]).map((r) => ({ ip: r.ip, username: r.username, reason: r.reason })),
    }),
    { steamIds: [], ips: [] },
  );
}

const actions: Record<string, RuntimeAction> = {
  [WORKSHOP_DOWNLOAD]: {
    job: 'workshop',
    parse(x): WorkshopDownloadInput {
      const ids = asObject(x).ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || !ids.every((id) => typeof id === 'string')) throw new Error('Give 1-100 workshop ids');
      for (const id of ids as string[]) if (!WORKSHOP_ID.test(id)) throw new Error(`Invalid workshop id ${id}`);
      return { ids: ids as string[] };
    },
    async run(ctx, _ctl, input): Promise<JobResult> {
      const { ids } = input as WorkshopDownloadInput;
      const driver = steam(ctx);
      ctx.progress(null, `Downloading ${ids.length} workshop item(s)`);
      return driver.workshopDownload({ workshopAppId: PZ_WORKSHOP_APP_ID, ids });
    },
  },
  [ACCOUNTS]: {
    parse: parseServerDb,
    run: async (ctx, _ctl, input) => readAccounts(ctx, (input as ServerDbInput).serverName),
  },
  [BANS]: {
    parse: parseServerDb,
    run: async (ctx, _ctl, input) => readBans(ctx, (input as ServerDbInput).serverName),
  },
};

// ------------------------------------------------------------------ adapter

export const pzRuntimeAdapter: RuntimeAdapter<PzLaunch> = {
  meta: PZ_META,
  parseLaunch,

  secrets: (p, st) => [p.adminPassword, st.controlSecret],

  installed,

  async install(ctx, p, { validate }): Promise<JobResult> {
    const driver = steam(ctx);
    ctx.progress(null, `${validate ? 'Validating' : 'Installing/updating'} (${p.branch})`);
    // Steam's default branch is `public`: no -beta for it.
    return driver.appUpdate({ appId: appId(ctx), branch: p.branch === 'public' ? null : p.branch, validate });
  },

  installOnStart(ctx, p) {
    const i = installed(ctx);
    if (!i || i.channel !== p.branch) return 'required';
    return p.updateOnStart ? 'update' : null;
  },

  async versions(ctx, _p): Promise<VersionsResponse> {
    ctx.progress(null, 'Checking Steam for the latest builds');
    const versions = await steam(ctx).branches({ appId: appId(ctx) });
    return { installed: installed(ctx), versions };
  },

  async prepare(ctx, p) {
    removeEmptyGameDb(ctx, p.serverName);
    const managed = managedIni(ctx);
    const dir = path.join(ctx.roots.data, 'Server');
    const file = path.join(dir, `${p.serverName}.ini`);
    mkdirSync(dir, { recursive: true });
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const after = before === null ? buildIni(managed) : setIniValues(before, managed);
    if (after !== before) writeFileSync(file, after);
  },

  command(ctx, p): LaunchCommand {
    // start-server.sh passes what comes before "--" to the JVM, the rest to the game.
    const launcher = ctx.tools.launcher ?? [path.join(ctx.roots.install, 'start-server.sh')];
    return {
      argv: [
        ...launcher,
        `-Xms${p.memoryMb}m`,
        `-Xmx${p.memoryMb}m`,
        ...PZ_JVM_FLAGS,
        '--',
        '-servername',
        p.serverName,
        `-cachedir=${ctx.roots.data}`,
        '-adminusername',
        p.adminUsername,
        '-adminpassword',
        p.adminPassword,
      ],
      cwd: ctx.roots.install,
      env: { LANG: 'C.UTF-8' },
    };
  },

  classify,

  channel: (ctx) => ({ kind: 'rcon', port: port(ctx, 'rcon'), password: ctx.state.controlSecret }),

  async stop(ctl) {
    // Save, then quit, over RCON; before the server is up, or when RCON fails, `quit` on the console.
    if (ctl.ready) {
      try {
        await ctl.command('save', 'channel');
        await ctl.command('quit', 'channel');
        return;
      } catch {
        // RCON is down: the console still works.
      }
    }
    ctl.stdin('quit');
  },

  save,

  hotCopy: {
    before: (ctl) => save(ctl, { budgetMs: HOT_COPY_SAVE_MS }),
    // PZ has no save-off: nothing to switch back on.
    after: async () => undefined,
    // Every .db file in a running backup is copied as a SQLite snapshot.
    sqlite: ['**/*.db'],
  },

  async listPlayers(ctl): Promise<PlayerList | null> {
    return parsePlayers((await ctl.command('players', 'channel')) ?? '');
  },

  roots: () => ({ ...PZ_ROOTS }),

  actions,
};
