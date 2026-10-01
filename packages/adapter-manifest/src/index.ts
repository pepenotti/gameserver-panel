/**
 * Both halves of a manifest game's adapter at once (D4). The adapter list
 * (`packages/adapters`) takes each half from its own entry point instead, so
 * the agent's bundle holds no panel code and the panel's no runtime code;
 * this is for the package's own tests and for tools that want both.
 */
import type { PanelAdapter, RuntimeAdapter } from '@gsp/adapter-api';
import { manifestPanelAdapter } from './panel';
import { manifestRuntimeAdapter } from './runtime';
import type { ManifestHooks, ManifestLaunch, ManifestSettings, SteamGameManifest } from './shared';

export function manifestAdapter(m: SteamGameManifest, hooks: ManifestHooks = {}): { runtime: RuntimeAdapter<ManifestLaunch>; panel: PanelAdapter<ManifestSettings> } {
  return { runtime: manifestRuntimeAdapter(m, hooks), panel: manifestPanelAdapter(m, hooks) };
}
