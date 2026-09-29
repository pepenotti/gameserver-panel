/**
 * Whether an update would change what the server runs (UPD-03), from the
 * agent's version list for the stored launch (the flavour's releases,
 * newest first, and what is installed):
 *   - a pinned version: only when something else is installed (an update
 *     installs the pinned one); newer releases are listed on the server's
 *     page, and the pin changes only when someone picks another;
 *   - "newest": when the flavour's newest release (TShock's newest full
 *     release, tModLoader's newest of the channel the server takes) isn't
 *     the one installed: an update installs it.
 * Null when the versions can't be listed.
 */
import type { ServerCtx, UpdateInfo } from '@gsp/adapter-api';
import type { TerrariaVersionInfo } from '../shared/install';
import { parseTerrariaLaunchSettings, type TerrariaLaunchSettings } from './launch';

export async function terrariaCheckUpdate(ctx: ServerCtx, launch: TerrariaLaunchSettings): Promise<UpdateInfo | null> {
  const s = parseTerrariaLaunchSettings(launch);
  const flavour = ctx.srv.flavour;
  const info = await ctx.versions();
  const versions = info.versions as TerrariaVersionInfo[];
  const inst = info.installed;
  // What is installed, as the launch names versions: vanilla's game version, the others' release tag.
  const current = inst && inst.channel === flavour ? (flavour === 'vanilla' ? inst.version : (inst.build ?? null)) : null;
  if (s.version !== '') {
    const pinned = versions.find((v) => v.id === s.version);
    return { available: current !== s.version, current, latest: s.version, ...(pinned?.channel ? { channel: pinned.channel } : {}) };
  }
  const newest = flavour === 'vanilla' ? versions[0] : flavour === 'tmodloader' && s.channel === 'preview' ? versions[0] : versions.find((v) => v.channel === 'stable');
  if (!newest) return null;
  return { available: current !== newest.id, current, latest: newest.id, ...(newest.channel ? { channel: newest.channel } : {}) };
}
