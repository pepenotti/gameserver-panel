import type { ServerCtx, UpdateInfo } from '@gsp/adapter-api';
import { parsePzLaunchSettings, type PzLaunchSettings } from './launch';

/**
 * Compares the installed build with the newest build of the pinned branch
 * (steamcmd app info, through the agent). An install of another branch
 * counts as an update. Null when the branch isn't listed.
 */
export async function pzCheckUpdate(ctx: ServerCtx, launch: PzLaunchSettings): Promise<UpdateInfo | null> {
  const { branch } = parsePzLaunchSettings(launch);
  const info = await ctx.versions();
  const latest = info.versions.find((v) => v.id === branch);
  if (!latest?.build) return null;
  const inst = info.installed;
  return {
    available: !inst || inst.channel !== branch || inst.build !== latest.build,
    current: inst?.build ?? null,
    latest: latest.build,
    channel: branch,
  };
}
