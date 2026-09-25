/**
 * Valheim, panel side: a skeleton (M3 contract step, for M6). Launch
 * options, the admin, banned and permitted lists (the `lines` format),
 * backups and resets come with the M6 adapter, from measured facts (D5).
 */
import type { PanelAdapter } from '@gsp/adapter-api';
import { VALHEIM_META } from '../shared/meta';

/** The launch settings the panel stores. TODO(M6): world, password, branch. */
export type ValheimLaunchSettings = Record<string, never>;

export const valheimPanelAdapter: PanelAdapter<ValheimLaunchSettings> = {
  meta: VALHEIM_META,
  launch: { schema: [], defaults: () => ({}), toAgent: () => ({}) },
  config: { files: () => [], roots: () => [], schemas: {}, managedValues: () => ({}) },
  backups: { parts: [] },
  resets: [],
  // PRD §7: Valheim has no console to message players through.
  messages: { announce: () => null },
};
