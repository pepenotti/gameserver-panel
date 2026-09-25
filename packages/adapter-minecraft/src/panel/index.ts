/**
 * Minecraft: Java Edition, panel side: a skeleton (M3 contract step).
 * Launch settings, config files (server.properties and friends, with the
 * `properties` format), backups, resets, players and messages come with the
 * M3 adapter, from measured facts (D5).
 */
import type { PanelAdapter } from '@gsp/adapter-api';
import { MINECRAFT_META } from '../shared/meta';

/** The launch settings the panel stores. TODO(M3): version, loader, memory. */
export type MinecraftLaunchSettings = Record<string, never>;

export const minecraftPanelAdapter: PanelAdapter<MinecraftLaunchSettings> = {
  meta: MINECRAFT_META,
  launch: { schema: [], defaults: () => ({}), toAgent: () => ({}) },
  config: { files: () => [], roots: () => [], schemas: {}, managedValues: () => ({}) },
  backups: { parts: [] },
  resets: [],
  // TODO(M3 fact-finding): in-game countdown messages, once the game's say command is measured.
  messages: { announce: () => null },
};
