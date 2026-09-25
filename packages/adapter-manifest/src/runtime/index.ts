/**
 * Steam games from a manifest, agent side: a skeleton (M3 contract step,
 * for M6). Installing with the manifest's app id, launching its command,
 * readiness from its pattern and stopping by its method come in M6; until
 * then this adapter launches nothing (`prepare` and `command` refuse), and
 * it isn't offered.
 */
import type { FileRoots, LaunchCommand, LineSignal, RuntimeAdapter } from '@gsp/adapter-api';
import { MANIFEST_META } from '../shared/meta';

/** Launch params the panel sends (`LaunchEnvelope.params`). TODO(M6): the manifest's launch settings. */
export type ManifestLaunch = Record<string, never>;

/** The orchestrator's mounts for the steam family: the server's data and install volumes. */
export const MANIFEST_ROOTS: FileRoots = { data: '/data', install: '/opt/game' };

const SKELETON = 'The manifest adapter is a skeleton: running a game from a manifest comes with M6';

export function parseLaunch(input: unknown): ManifestLaunch {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Launch params must be an object');
  // TODO(M6): the settings the manifest declares.
  return {};
}

export const manifestRuntimeAdapter: RuntimeAdapter<ManifestLaunch> = {
  meta: MANIFEST_META,
  parseLaunch,
  secrets: (_p, st) => [st.controlSecret],
  // TODO(M6): the installed Steam build of the manifest's app.
  installed: () => null,
  async prepare() {
    throw new Error(SKELETON);
  },
  command(): LaunchCommand {
    throw new Error(SKELETON);
  },
  // TODO(M6): the manifest's readiness pattern.
  classify: (line): LineSignal => ({ message: line }),
  // TODO(M6): the manifest's control channel, if any.
  channel: () => ({ kind: 'none' }),
  async stop() {
    // TODO(M6): the manifest's stop method; until then the agent's signals stop it.
  },
  roots: () => ({ ...MANIFEST_ROOTS }),
};
