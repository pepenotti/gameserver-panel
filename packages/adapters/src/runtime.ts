// The runtime adapters the agent can run. Only the agent's entry point
// imports this (NFR-08); everything else sees `RuntimeAdapter`.
import type { RuntimeAdapter } from '@gsp/adapter-api';
import { manifestRuntimeAdapter } from '@gsp/adapter-manifest/runtime';
import { AVORION } from '@gsp/adapter-manifest/shared';
import { minecraftRuntimeAdapter } from '@gsp/adapter-minecraft/runtime';
import { pzRuntimeAdapter } from '@gsp/adapter-pz/runtime';
import { terrariaRuntimeAdapter } from '@gsp/adapter-terraria/runtime';
import { valheimRuntimeAdapter } from '@gsp/adapter-valheim/runtime';
import { enabledOf, type AdapterEntry } from './entry';

/**
 * Every runtime adapter, and whether an agent runs it (the skeletons don't
 * yet: see `panelAdapterEntries`). A game's runtime half is enabled once it
 * is measured and built, before the panel offers the game (its panel half
 * comes next): Minecraft since M3, Terraria since M5 phase 2, Avorion (from
 * its manifest alone) since M6.
 */
export const runtimeAdapterEntries: readonly AdapterEntry<RuntimeAdapter>[] = [
  { adapter: pzRuntimeAdapter, enabled: true },
  { adapter: minecraftRuntimeAdapter, enabled: true },
  { adapter: terrariaRuntimeAdapter, enabled: true },
  { adapter: valheimRuntimeAdapter, enabled: false },
  { adapter: manifestRuntimeAdapter(AVORION) as RuntimeAdapter, enabled: true },
];

/** The runtime adapters an agent runs: the enabled ones. */
export const runtimeAdapters: readonly RuntimeAdapter[] = enabledOf(runtimeAdapterEntries);

export function runtimeAdapter(id: string): RuntimeAdapter {
  const a = runtimeAdapters.find((x) => x.meta.id === id);
  if (!a) throw new Error(`No runtime adapter "${id}"`);
  return a;
}
