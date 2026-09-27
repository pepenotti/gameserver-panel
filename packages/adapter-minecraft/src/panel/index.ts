/**
 * Minecraft: Java Edition, panel side (M3): launch settings with the loader
 * as the server's flavour and the versions each loader offers, the config
 * files and their forms, backups, resets, countdown messages, moderation,
 * update checks and the console catalog. Every fact comes from
 * docs/verification/minecraft-26.3.md and fixtures/minecraft/26.3.
 */
import type { PanelAdapter } from '@gsp/adapter-api';
import { MINECRAFT_META } from '../shared/meta';
import { MINECRAFT_BACKUP_PARTS, MINECRAFT_RESETS } from './backups';
import { minecraftPanelConfig } from './config';
import { MINECRAFT_CONSOLE_CATALOG } from './console';
import { minecraftChoices, MINECRAFT_LAUNCH_DEFAULTS, MINECRAFT_LAUNCH_SCHEMA, MINECRAFT_WARNINGS, minecraftToAgent, type MinecraftLaunchSettings } from './launch';
import { minecraftAnnounce, minecraftBroadcast } from './messages';
import { minecraftPlayers } from './players';
import { minecraftCheckUpdate } from './updates';

export type { MinecraftLaunchSettings };
export { BSTATS_SCHEMA, MINECRAFT_PRESETS, minecraftManagedValues } from './config';
export { DEFAULT_VERSION, MINECRAFT_LAUNCH_DEFAULTS, MINECRAFT_WARNINGS, minecraftChoices, minecraftToAgent, parseMinecraftLaunchSettings } from './launch';
export { SAY_MAX } from './messages';
export { MINECRAFT_ACCESS_LEVELS } from './players';
export { PROPERTIES_GROUPS, PROPERTIES_SCHEMA, PROPERTIES_SECRETS } from './properties';

export const minecraftPanelAdapter: PanelAdapter<MinecraftLaunchSettings> = {
  meta: MINECRAFT_META,
  launch: {
    schema: MINECRAFT_LAUNCH_SCHEMA,
    defaults: () => ({ ...MINECRAFT_LAUNCH_DEFAULTS }),
    toAgent: minecraftToAgent,
    choices: minecraftChoices,
    warnings: MINECRAFT_WARNINGS,
  },
  config: minecraftPanelConfig,
  backups: { parts: MINECRAFT_BACKUP_PARTS },
  resets: MINECRAFT_RESETS,
  messages: { announce: minecraftAnnounce, broadcast: minecraftBroadcast },
  players: minecraftPlayers,
  updates: { check: minecraftCheckUpdate },
  consoleCatalog: MINECRAFT_CONSOLE_CATALOG,
};
