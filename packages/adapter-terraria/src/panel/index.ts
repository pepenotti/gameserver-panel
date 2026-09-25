/**
 * Terraria, panel side: a skeleton (M3 contract step, for M5). Launch
 * settings, config files, world creation, backups, resets, players, TShock
 * plugins and tModLoader's Workshop mods (`@gsp/source-workshop`, MOD-03)
 * come with the M5 adapter, from measured facts (D5).
 */
import type { PanelAdapter } from '@gsp/adapter-api';
import { TERRARIA_META } from '../shared/meta';

/** The launch settings the panel stores. TODO(M5): world, flavour settings. */
export type TerrariaLaunchSettings = Record<string, never>;

export const terrariaPanelAdapter: PanelAdapter<TerrariaLaunchSettings> = {
  meta: TERRARIA_META,
  launch: { schema: [], defaults: () => ({}), toAgent: () => ({}) },
  config: { files: () => [], roots: () => [], schemas: {}, managedValues: () => ({}) },
  backups: { parts: [] },
  resets: [],
  // TODO(M5 fact-finding): in-game countdown messages, once the game's say command is measured.
  messages: { announce: () => null },
};
