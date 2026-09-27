import type { ServerCtx, UpdateInfo } from '@gsp/adapter-api';
import type { MinecraftVersionInfo } from '../shared/install';
import { channelAllows } from '../shared/launch';
import { parseMinecraftLaunchSettings, type MinecraftLaunchSettings } from './launch';

/**
 * Whether a newer build of what the server pins exists (UPD-03, UPD-05),
 * from the agent's version list for the stored launch:
 *   - vanilla: a pinned version has no newer builds; only an install of
 *     another version (or none) needs one;
 *   - Paper: the newest build of the pinned version in the pinned channel
 *     or a more stable one;
 *   - Fabric: the newest stable loader for the pinned version, unless a
 *     loader is pinned.
 * Never another Minecraft version. Null when the version isn't listed.
 */
export async function minecraftCheckUpdate(ctx: ServerCtx, launch: MinecraftLaunchSettings): Promise<UpdateInfo | null> {
  const s = parseMinecraftLaunchSettings(launch);
  const loader = ctx.srv.flavour;
  const info = await ctx.versions();
  const own = info.versions.find((v) => v.id === s.version) as MinecraftVersionInfo | undefined;
  if (!own) return null;
  const inst = info.installed;
  const sameVersion = inst?.version === s.version && inst.channel === loader;

  if (loader === 'paper') {
    const newest = (own.builds ?? []).find((b) => channelAllows(s.channel, b.channel));
    if (!newest) return { available: false, current: sameVersion && inst?.build ? `${s.version}-${inst.build}` : null, latest: `${s.version} (${s.channel})`, channel: s.channel };
    const current = sameVersion && inst?.build ? Number(inst.build) : null;
    return { available: current === null || newest.id > current, current: current === null ? null : `${s.version}-${current}`, latest: `${s.version}-${newest.id}`, channel: newest.channel };
  }
  if (loader === 'fabric') {
    const want = s.loaderVersion !== '' ? s.loaderVersion : ((own.loaders ?? []).find((l) => l.stable)?.version ?? own.build ?? null);
    if (!want) return null;
    const current = sameVersion ? (inst?.build ?? null) : null;
    return { available: current !== want, current, latest: want };
  }
  return { available: !sameVersion, current: inst?.version ?? null, latest: s.version };
}
