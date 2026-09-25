/**
 * Minecraft: Java Edition, agent side: a skeleton (M3 contract step). The
 * launch command, readiness and log lines, the stop command and RCON come
 * from the M3 fact-finding captures (D5); until then this adapter launches
 * nothing (`prepare` and `command` refuse), and it isn't offered.
 */
import type { FileRoots, LaunchCommand, LineSignal, RuntimeAdapter } from '@gsp/adapter-api';
import { MINECRAFT_META } from '../shared/meta';

/** Launch params the panel sends (`LaunchEnvelope.params`). TODO(M3): version, loader, memory. */
export type MinecraftLaunch = Record<string, never>;

/** The orchestrator's mounts for the java family: the server's data and install volumes. */
export const MINECRAFT_ROOTS: FileRoots = { data: '/data', install: '/opt/game' };

const SKELETON = 'The Minecraft adapter is a skeleton: launching the game comes with the M3 fact-finding';

export function parseLaunch(input: unknown): MinecraftLaunch {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Launch params must be an object');
  // TODO(M3 fact-finding): the settings a Minecraft server is launched with.
  return {};
}

export const minecraftRuntimeAdapter: RuntimeAdapter<MinecraftLaunch> = {
  meta: MINECRAFT_META,
  parseLaunch,
  secrets: (_p, st) => [st.controlSecret],
  // TODO(M3): the installed version and loader.
  installed: () => null,
  async prepare() {
    // TODO(M3 fact-finding): the files the agent owns (ports, RCON), and the game's own EULA
    // acceptance, written only when `ctx.eulaAccepted` is true (D6: the owner accepted it in the panel).
    throw new Error(SKELETON);
  },
  command(): LaunchCommand {
    throw new Error(SKELETON);
  },
  // TODO(M3 fact-finding): readiness, version, join and leave, save and fatal lines.
  classify: (line): LineSignal => ({ message: line }),
  // TODO(M3 fact-finding): RCON (PRD §7).
  channel: () => ({ kind: 'none' }),
  async stop() {
    // TODO(M3 fact-finding): the game's own stop command; until then the agent's signals stop it.
  },
  roots: () => ({ ...MINECRAFT_ROOTS }),
};
