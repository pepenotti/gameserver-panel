import type { ServerCtx, UpdateInfo } from '@gsp/adapter-api';
import { extras } from './ctx';
import { parsePzLaunchSettings } from './launch';

/**
 * Compares the installed build with the newest build of the pinned branch
 * (steamcmd app info, through the agent). An install of another branch
 * counts as an update. Null when the branch isn't listed or the panel can't
 * ask for the versions.
 */
export async function pzCheckUpdate(ctx: ServerCtx): Promise<UpdateInfo | null> {
  const x = extras(ctx);
  if (!x.versions || !x.launchSettings) return null;
  const { branch } = parsePzLaunchSettings(x.launchSettings());
  const info = await x.versions();
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
