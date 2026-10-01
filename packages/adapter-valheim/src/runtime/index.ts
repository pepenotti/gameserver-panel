/**
 * Valheim, agent side (M6): the runtime adapter the manifest engine makes
 * from `manifest/valheim.json`, plus the two things a manifest can't say:
 * which files a running backup takes (each world's newest complete save
 * set, BAK-02) and how many players a server listed publicly has, from
 * Steam's server queries (PLY-01). Everything else is the manifest's: the
 * steamcmd install of app 896660, the launch, readiness and fatal lines,
 * the stop by signal (the game saves first), autosave lines, list files.
 */
import type { PlayerList, RuntimeAdapter, RuntimeCtx } from '@gsp/adapter-api';
import { MANIFEST_ROOTS, manifestRuntimeAdapter, type ManifestLaunch } from '@gsp/adapter-manifest/runtime';
import { VALHEIM } from '../shared';
import { queryInfo } from './a2s';
import { newestCompleteSaves } from './save-sets';

export { A2sError, infoRequest, parseInfo, queryInfo, type A2sInfo } from './a2s';
export { newestCompleteSaves } from './save-sets';

/** Launch params the panel sends (`LaunchEnvelope.params`): the manifest's settings and the server's game name. */
export type ValheimLaunch = ManifestLaunch;

/** The orchestrator's mounts for the steam family: the server's data and install volumes. */
export const VALHEIM_ROOTS = MANIFEST_ROOTS;

/** Where the agent asks: the game listens on all addresses of its own container, which the agent shares. */
const QUERY_HOST = '127.0.0.1';

/** Players on a server listed publicly: the count Steam's server query gives (names aren't read: unverified with a player). */
export async function steamPlayers(_ctx: RuntimeCtx, port: number): Promise<PlayerList> {
  const info = await queryInfo(QUERY_HOST, port);
  return { count: info.players, names: [] };
}

export const valheimRuntimeAdapter: RuntimeAdapter<ValheimLaunch> = manifestRuntimeAdapter(VALHEIM, {
  hotCopySelect: async (_ctx, files) => newestCompleteSaves(files),
  steamQuery: steamPlayers,
});
