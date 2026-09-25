/**
 * Terraria, agent side: a skeleton (M3 contract step, for M5). The launch
 * command, readiness and log lines, the stop command, stdin control and
 * TShock's REST API come from the M5 fact-finding captures (D5); until then
 * this adapter launches nothing (`prepare` and `command` refuse), and it
 * isn't offered.
 */
import type { FileRoots, LaunchCommand, LineSignal, RuntimeAdapter } from '@gsp/adapter-api';
import { TERRARIA_META } from '../shared/meta';

/** Launch params the panel sends (`LaunchEnvelope.params`). TODO(M5): world, flavour settings. */
export type TerrariaLaunch = Record<string, never>;

/** The orchestrator's mounts for the native family: the server's data and install volumes. */
export const TERRARIA_ROOTS: FileRoots = { data: '/data', install: '/opt/game' };

const SKELETON = 'The Terraria adapter is a skeleton: launching the game comes with the M5 fact-finding';

export function parseLaunch(input: unknown): TerrariaLaunch {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Launch params must be an object');
  // TODO(M5 fact-finding): the settings a Terraria server is launched with.
  return {};
}

export const terrariaRuntimeAdapter: RuntimeAdapter<TerrariaLaunch> = {
  meta: TERRARIA_META,
  parseLaunch,
  secrets: (_p, st) => [st.controlSecret],
  // TODO(M5): the installed version and flavour.
  installed: () => null,
  async prepare() {
    // TODO(M5 fact-finding): the files the agent owns (the server config, ports, TShock's REST token).
    throw new Error(SKELETON);
  },
  command(): LaunchCommand {
    throw new Error(SKELETON);
  },
  // TODO(M5 fact-finding): readiness, version, join and leave, save and fatal lines.
  classify: (line): LineSignal => ({ message: line }),
  // TODO(M5 fact-finding): stdin, and TShock's REST API (CON-04).
  channel: () => ({ kind: 'none' }),
  async stop() {
    // TODO(M5 fact-finding): the game's own stop command; until then the agent's signals stop it.
  },
  roots: () => ({ ...TERRARIA_ROOTS }),
};
