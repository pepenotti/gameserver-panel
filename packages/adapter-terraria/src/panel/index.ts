/**
 * Terraria, panel side (M5 phase 3): launch settings with the flavour and
 * the versions each offers, the config files and their forms (TShock's
 * REST token hidden whole), backups and resets, messages to players,
 * moderation per flavour (vanilla's and tModLoader's IP bans on the
 * console, TShock's through its REST API), update checks and the console
 * catalog, and each flavour's mods: tModLoader's Workshop mods (MOD-03,
 * through `@gsp/source-workshop`) and TShock's plugins (MOD-06). Every fact
 * comes from docs/verification/terraria-1.4.5.8.md and
 * fixtures/terraria/1.4.5.8.
 */
import type { PanelAdapter } from '@gsp/adapter-api';
import { TERRARIA_META } from '../shared/meta';
import { TERRARIA_BACKUP_PARTS, TERRARIA_RESETS } from './backups';
import { terrariaPanelConfig } from './config';
import { TERRARIA_CONSOLE_CATALOG } from './console';
import { TERRARIA_LAUNCH_DEFAULTS, TERRARIA_LAUNCH_SCHEMA, TERRARIA_WARNINGS, terrariaChoices, terrariaToAgent, terrariaWanted, type TerrariaLaunchSettings } from './launch';
import { terrariaAnnounce, terrariaBroadcast, terrariaSend } from './messages';
import { terrariaPlayersOf } from './players';
import { tshockPlugins } from './plugins';
import { terrariaCheckUpdate } from './updates';
import { createTmlWorkshopSource } from './workshop';

export type { TerrariaLaunchSettings };
export { TERRARIA_BACKUP_PARTS, TERRARIA_RESETS } from './backups';
export { terrariaManagedValues } from './config';
export { TERRARIA_CONSOLE_CATALOG } from './console';
export { CHOICES_TTL_MS, clearChoicesCache, parseTerrariaLaunchSettings, TERRARIA_LAUNCH_DEFAULTS, TERRARIA_LAUNCH_SCHEMA, TERRARIA_WARNINGS, terrariaChoices, terrariaToAgent, terrariaWanted } from './launch';
export { SAY_MAX, sayText, terrariaAnnounce, terrariaBroadcast, terrariaSend } from './messages';
export { consolePlayers, LEFT_MS, parseBanlist, terrariaPlayersOf, terrariaRefused, tshockPlayers, unbanChanges } from './players';
export { SERVERCONFIG_GROUPS, SERVERCONFIG_MANAGED, SERVERCONFIG_SCHEMA, SERVERCONFIG_TML_MANAGED, SERVERCONFIG_TML_SCHEMA } from './serverconfig';
export { TSHOCK_GROUPS, TSHOCK_MANAGED, TSHOCK_SCHEMA, TSHOCK_SECRETS, TSHOCK_TOKEN_TREE } from './tshock';
export { tshockPlugins } from './plugins';
export { terrariaCheckUpdate } from './updates';
export { createTmlWorkshopSource, enabledJson, pickVersionFolder, scanTmlItem, TML_FALLBACK, TML_LEGACY_LAST, tmlVersionOf, type TmlMod, type TmlVersion } from './workshop';

export const terrariaPanelAdapter: PanelAdapter<TerrariaLaunchSettings> = {
  meta: TERRARIA_META,
  launch: {
    schema: TERRARIA_LAUNCH_SCHEMA,
    defaults: () => ({ ...TERRARIA_LAUNCH_DEFAULTS }),
    toAgent: terrariaToAgent,
    choices: terrariaChoices,
    warnings: TERRARIA_WARNINGS,
  },
  config: terrariaPanelConfig,
  backups: { parts: TERRARIA_BACKUP_PARTS },
  resets: TERRARIA_RESETS,
  messages: { announce: terrariaAnnounce, broadcast: terrariaBroadcast, send: terrariaSend },
  // Each flavour moderates its own way (every Terraria server has a flavour).
  playersOf: terrariaPlayersOf,
  // Each for the flavour with its capability: tModLoader's Workshop mods, TShock's plugins.
  mods: [createTmlWorkshopSource()],
  plugins: [tshockPlugins],
  updates: { check: terrariaCheckUpdate },
  consoleCatalog: TERRARIA_CONSOLE_CATALOG,
  install: { wanted: terrariaWanted },
};
