/**
 * Valheim, agent side: a skeleton (M3 contract step, for M6). The steamcmd
 * app id, launch options, readiness and log lines, and the way it stops
 * (PRD §7: signals and log parsing, no console) come from the M6
 * fact-finding captures (D5); until then this adapter launches nothing
 * (`prepare` and `command` refuse), and it isn't offered.
 */
import type { FileRoots, LaunchCommand, LineSignal, RuntimeAdapter } from '@gsp/adapter-api';
import { VALHEIM_META } from '../shared/meta';

/** Launch params the panel sends (`LaunchEnvelope.params`). TODO(M6): world, password, branch. */
export type ValheimLaunch = Record<string, never>;

/** The orchestrator's mounts for the steam family: the server's data and install volumes. */
export const VALHEIM_ROOTS: FileRoots = { data: '/data', install: '/opt/game' };

const SKELETON = 'The Valheim adapter is a skeleton: launching the game comes with the M6 fact-finding';

export function parseLaunch(input: unknown): ValheimLaunch {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Launch params must be an object');
  // TODO(M6 fact-finding): the settings a Valheim server is launched with.
  return {};
}

export const valheimRuntimeAdapter: RuntimeAdapter<ValheimLaunch> = {
  meta: VALHEIM_META,
  parseLaunch,
  secrets: (_p, st) => [st.controlSecret],
  // TODO(M6): the installed Steam build.
  installed: () => null,
  async prepare() {
    throw new Error(SKELETON);
  },
  command(): LaunchCommand {
    throw new Error(SKELETON);
  },
  // TODO(M6 fact-finding): readiness, join and leave, save and fatal lines.
  classify: (line): LineSignal => ({ message: line }),
  // PRD §7: no control channel; signals and the log only.
  channel: () => ({ kind: 'none' }),
  async stop() {
    // TODO(M6 fact-finding): the signal that makes it save and quit; until then the agent's signals stop it.
  },
  roots: () => ({ ...VALHEIM_ROOTS }),
};
