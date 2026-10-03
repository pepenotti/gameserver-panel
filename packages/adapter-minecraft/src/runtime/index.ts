/**
 * Minecraft: Java Edition, agent side (M3): vanilla, Paper and Fabric
 * installed and pinned per server, launched on the Java its version
 * declares, read from its log, controlled over RCON with the console as
 * fallback, saved and hot-copied with its own save commands. Every fact
 * comes from docs/verification/minecraft-26.3.md and fixtures/minecraft/26.3.
 */
import path from 'node:path';
import type { ControlHandle, FileRoots, LaunchCommand, LineSignal, PlayerList, RuntimeAdapter } from '@gsp/adapter-api';
import { isFatal } from '@gsp/formats';
import { LOADER_JARS } from '../shared/install';
import { parseMinecraftLaunch, type MinecraftLaunch } from '../shared/launch';
import { MC_PATTERNS, parseLogLine, parsePlayerList, stripFormatting } from '../shared/log';
import { MINECRAFT_META } from '../shared/meta';
import { managedProperties, prepare } from './files';
import { install, installedInfo, installKey, installNeeded, listVersions, readMarker, warmUp } from './install';
import { javaCommand } from './java';

export type { MinecraftLaunch };
export { EULA_NOT_ACCEPTED, BSTATS_CONFIG, managedProperties } from './files';
export { readMarker } from './install';
export { jreFor, javaBin, SHIPPED_JRES } from './java';
export { clearSourceCache } from './sources';

/** The orchestrator's mounts for the java family: the server's data and install volumes. */
export const MINECRAFT_ROOTS: FileRoots = { data: '/data', install: '/opt/game' };

/** How long a hot copy waits for the flush it asks for; a big world takes a while. */
const HOT_COPY_SAVE_MS = 5 * 60_000;
/** How long `save-off` and `save-on` get to be confirmed. */
const CONFIRM_MS = 30_000;

export function classify(raw: string): LineSignal {
  const line = parseLogLine(raw);
  const m = line.message;
  const s: LineSignal = { message: m };
  if (line.header) {
    if (MC_PATTERNS.ready.test(m)) {
      s.ready = true;
      // Paper opens RCON before its ready line ("RCON running on …" just above it): both are true here.
      if (line.paper) s.channelReady = true;
    }
    // Vanilla and Fabric open RCON right after the ready line.
    if (MC_PATTERNS.rconUp.test(m)) s.channelReady = true;
    const v = MC_PATTERNS.version.exec(m);
    if (v) s.version = v[1]!;
    const j = MC_PATTERNS.join.exec(m);
    if (j) s.join = j[1]!;
    const l = MC_PATTERNS.leave.exec(m);
    if (l) s.leave = l[1]!;
    if (MC_PATTERNS.saved.test(m)) s.saved = true;
    // A crash report (a taken port, a dead main loop) or no EULA: the process exits, with code 0.
    if (MC_PATTERNS.bindFailed.test(m) || MC_PATTERNS.crashed.test(m) || MC_PATTERNS.eulaRefused.test(m)) s.fatal = true;
  } else if (MC_PATTERNS.wrongJava.test(raw) || MC_PATTERNS.badJar.test(raw) || MC_PATTERNS.fabricNoGameJar.test(raw)) {
    // The JVM and Fabric's launcher print these without the game's header, then exit 1.
    s.fatal = true;
  }
  if (isFatal(raw)) s.fatal = true;
  return s;
}

/**
 * Sends `cmd` and checks the game confirmed it with `re`: in the RCON reply,
 * or, when the command went to the console, in the log (waited for before
 * sending, so the line can't be missed).
 */
async function confirmed(ctl: ControlHandle, cmd: string, re: RegExp, timeoutMs: number): Promise<void> {
  const line = ctl.waitForLine(re, timeoutMs);
  const reply = await ctl.command(cmd);
  if (reply !== null) {
    if (!re.test(reply.trim())) throw new Error(`The server answered "${reply.trim().slice(0, 200)}" to ${cmd}`);
    return;
  }
  if (!(await line)) throw new Error(`The server did not confirm ${cmd}`);
}

/**
 * `save-all flush`: the RCON reply comes once the world is on disk
 * (`…Saved the game`, measured 12 of 12 times with a copy right after it
 * clean); on the console, the `Saved the game` line.
 */
async function save(ctl: ControlHandle, o: { budgetMs: number }): Promise<void> {
  const line = ctl.waitForLine(MC_PATTERNS.saved, o.budgetMs);
  const reply = await ctl.command('save-all flush');
  if (reply !== null) {
    if (!reply.includes('Saved the game')) throw new Error(`The server did not confirm the save: "${reply.trim().slice(0, 200)}"`);
    return;
  }
  if (!(await line)) throw new Error('The server did not report that it finished saving');
}

function launchJar(ctx: Parameters<RuntimeAdapter<MinecraftLaunch>['command']>[0], p: MinecraftLaunch) {
  const m = readMarker(ctx);
  if (!m) throw new Error('Minecraft is not installed yet');
  if (m.loader !== p.loader || m.version !== p.version) throw new Error(`The installed server is ${m.loader} ${m.version}, not ${p.loader} ${p.version}: install it first`);
  return m;
}

export const minecraftRuntimeAdapter: RuntimeAdapter<MinecraftLaunch> = {
  meta: MINECRAFT_META,
  parseLaunch: parseMinecraftLaunch,

  secrets: (_p, st) => [st.controlSecret],

  installed: installedInfo,
  install,
  installOnStart: installNeeded,
  installKey,
  warmUp,
  versions: listVersions,

  prepare,

  command(ctx, p): LaunchCommand {
    const m = launchJar(ctx, p);
    const root = ctx.roots.install;
    return {
      argv: [
        ...javaCommand(ctx, m.jre),
        `-Xms${p.memoryMb}m`,
        `-Xmx${p.memoryMb}m`,
        // The bundler and paperclip unpack into the install root, never the data root.
        `-DbundlerRepoDir=${root}`,
        // Fabric's launcher looks for Mojang's jar in the working directory otherwise.
        ...(p.loader === 'fabric' ? [`-Dfabric.gameJarPath=${path.join(root, 'server.jar')}`] : []),
        '-jar',
        path.join(root, LOADER_JARS[p.loader]),
        'nogui',
      ],
      cwd: ctx.roots.data,
    };
  },

  classify,

  // Paper's replies (and plugins' lines) carry § colour codes: people read them without.
  display: stripFormatting,

  channel: (ctx) => ({ kind: 'rcon', port: Number(managedProperties(ctx)['rcon.port']), password: ctx.state.controlSecret }),

  async stop(ctl) {
    // `stop` over RCON (answered "Stopping the server"); before RCON is up, or when it fails, on the
    // console, where the server takes it once it's running. Any exit not asked for is a crash, even
    // with code 0 (the agent's rule; the game exits 0 on its own failures).
    if (ctl.ready) {
      try {
        await ctl.command('stop', 'channel');
        return;
      } catch {
        // RCON is down, or closed as the server stopped: the console still works.
      }
    }
    ctl.stdin('stop');
  },

  save,

  hotCopy: {
    // BAK-02: saving off, then a flush whose reply means the world is on disk.
    async before(ctl) {
      await confirmed(ctl, 'save-off', MC_PATTERNS.savingOff, CONFIRM_MS);
      await save(ctl, { budgetMs: HOT_COPY_SAVE_MS });
    },
    // The archive runs this whatever happened to the copy (a finally).
    after: (ctl) => confirmed(ctl, 'save-on', MC_PATTERNS.savingOn, CONFIRM_MS),
  },

  async listPlayers(ctl): Promise<PlayerList | null> {
    return parsePlayerList((await ctl.command('list', 'channel')) ?? '');
  },

  roots: () => ({ ...MINECRAFT_ROOTS }),
};
