/**
 * Steam games from a manifest, panel side: a skeleton (M3 contract step,
 * for M6). The manifest's config files (raw editing), backup paths and
 * launch settings come in M6.
 */
import type { PanelAdapter } from '@gsp/adapter-api';
import { MANIFEST_META } from '../shared/meta';

/** The launch settings the panel stores. TODO(M6): the manifest's. */
export type ManifestLaunchSettings = Record<string, never>;

export const manifestPanelAdapter: PanelAdapter<ManifestLaunchSettings> = {
  meta: MANIFEST_META,
  launch: { schema: [], defaults: () => ({}), toAgent: () => ({}) },
  config: { files: () => [], roots: () => [], schemas: {}, managedValues: () => ({}) },
  backups: { parts: [] },
  resets: [],
  messages: { announce: () => null },
};
