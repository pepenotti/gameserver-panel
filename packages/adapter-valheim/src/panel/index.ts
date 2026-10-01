/**
 * Valheim, panel side (M6): the panel adapter the manifest engine makes
 * from `manifest/valheim.json`. Its launch settings form (the server's
 * name, password, the public list and crossplay, both off by default, the
 * autosave interval) with the password rules of a public server checked
 * before it starts; the admin, ban and allowed lists edited as text and
 * through moderation by SteamID, while the server is stopped; backups of
 * the world and the lists; resets. No console, so no messages to players.
 */
import type { PanelAdapter } from '@gsp/adapter-api';
import { manifestPanelAdapter, type ManifestSettings } from '@gsp/adapter-manifest/panel';
import { VALHEIM } from '../shared';

/** The launch settings the panel stores. */
export type ValheimLaunchSettings = ManifestSettings;

export const valheimPanelAdapter: PanelAdapter<ValheimLaunchSettings> = manifestPanelAdapter(VALHEIM);
