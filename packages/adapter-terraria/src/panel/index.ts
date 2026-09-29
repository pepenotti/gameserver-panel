/**
 * Terraria, panel side (M5 phase 3): launch settings with the flavour and
 * the versions each offers, the config files and their forms (TShock's
 * REST token hidden whole), backups and resets, messages to players,
 * moderation per flavour (vanilla's and tModLoader's IP bans on the
 * console, TShock's through its REST API), update checks and the console
 * catalog. Every fact comes from docs/verification/terraria-1.4.5.8.md and
 * fixtures/terraria/1.4.5.8.
 *
 * TShock's plugins (MOD-06) and tModLoader's Workshop mods (MOD-03,
 * `@gsp/source-workshop`) come next: a mod source in `mods`, its
 * capability in its flavour's list (shared/meta.ts).
 */
import type { PanelAdapter } from '@gsp/adapter-api';
import { TERRARIA_META } from '../shared/meta';
import { TERRARIA_BACKUP_PARTS, TERRARIA_RESETS } from './backups';
import { terrariaPanelConfig } from './config';
import { TERRARIA_CONSOLE_CATALOG } from './console';
import { TERRARIA_LAUNCH_DEFAULTS, TERRARIA_LAUNCH_SCHEMA, TERRARIA_WARNINGS, terrariaChoices, terrariaToAgent, type TerrariaLaunchSettings } from './launch';
import { terrariaAnnounce, terrariaBroadcast, terrariaSend } from './messages';
import { terrariaPlayersOf } from './players';
import { terrariaCheckUpdate } from './updates';

export type { TerrariaLaunchSettings };
export { TERRARIA_BACKUP_PARTS, TERRARIA_RESETS } from './backups';
export { terrariaManagedValues } from './config';
export { TERRARIA_CONSOLE_CATALOG } from './console';
export { CHOICES_TTL_MS, clearChoicesCache, parseTerrariaLaunchSettings, TERRARIA_LAUNCH_DEFAULTS, TERRARIA_LAUNCH_SCHEMA, TERRARIA_WARNINGS, terrariaChoices, terrariaToAgent } from './launch';
export { SAY_MAX, sayText, terrariaAnnounce, terrariaBroadcast, terrariaSend } from './messages';
export { consolePlayers, LEFT_MS, parseBanlist, terrariaPlayersOf, terrariaRefused, tshockPlayers, unbanChanges } from './players';
export { SERVERCONFIG_GROUPS, SERVERCONFIG_MANAGED, SERVERCONFIG_SCHEMA, SERVERCONFIG_TML_MANAGED, SERVERCONFIG_TML_SCHEMA } from './serverconfig';
export { TSHOCK_GROUPS, TSHOCK_MANAGED, TSHOCK_SCHEMA, TSHOCK_SECRETS, TSHOCK_TOKEN_TREE } from './tshock';
export { terrariaCheckUpdate } from './updates';

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
  updates: { check: terrariaCheckUpdate },
  consoleCatalog: TERRARIA_CONSOLE_CATALOG,
};
