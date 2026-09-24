/**
 * Project Zomboid, panel side without the config files: launch settings,
 * backup parts, resets, in-game messages, players, Workshop mods, updates,
 * the console catalog and the first-start hook.
 */
import type { PanelAdapterCore } from '@gsp/adapter-api';
import { PZ_BACKUP_PARTS, PZ_RESETS, pzBeforeStart } from './backups';
import { PZ_CONSOLE_CATALOG } from './console';
import { PZ_LAUNCH_DEFAULTS, PZ_LAUNCH_SCHEMA, pzToAgent, type PzLaunchSettings } from './launch';
import { pzAnnounce, pzBroadcast } from './messages';
import { pzPlayers } from './players';
import { pzCheckUpdate } from './updates';
import { createWorkshopSource } from './workshop';

export type { PanelExtras, SettingsAccess } from './ctx';
export { parsePzLaunchSettings, PZ_LAUNCH_DEFAULTS, PZ_SECRET_ADMIN_PASSWORD, type LaunchHints, type PzLaunchSettings } from './launch';
export { PZ_ACCESS_LEVELS, parseAccounts, parseBans } from './players';
export { createWorkshopSource, FALLBACK_GAME_VERSION, PZ_WORKSHOP_APP_ID, SteamWorkshopApi, VANILLA_MAP, type PzMod, type WorkshopDetails } from './workshop';

export const pzPanelCore: PanelAdapterCore<PzLaunchSettings> = {
  launch: {
    schema: PZ_LAUNCH_SCHEMA,
    defaults: () => ({ ...PZ_LAUNCH_DEFAULTS }),
    toAgent: pzToAgent,
  },
  backups: { parts: PZ_BACKUP_PARTS },
  resets: PZ_RESETS,
  messages: { announce: pzAnnounce, broadcast: pzBroadcast },
  players: pzPlayers,
  mods: [createWorkshopSource()],
  updates: { check: pzCheckUpdate },
  consoleCatalog: PZ_CONSOLE_CATALOG,
  hooks: { beforeStart: pzBeforeStart },
};
