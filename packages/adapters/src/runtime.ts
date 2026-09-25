// The runtime adapters the agent can run. Only the agent's entry point
// imports this (NFR-08); everything else sees `RuntimeAdapter`.
import type { RuntimeAdapter } from '@gsp/adapter-api';
import { manifestRuntimeAdapter } from '@gsp/adapter-manifest/runtime';
import { minecraftRuntimeAdapter } from '@gsp/adapter-minecraft/runtime';
import { pzRuntimeAdapter } from '@gsp/adapter-pz/runtime';
import { terrariaRuntimeAdapter } from '@gsp/adapter-terraria/runtime';
import { valheimRuntimeAdapter } from '@gsp/adapter-valheim/runtime';
import { enabledOf, type AdapterEntry } from './entry';

/** Every runtime adapter, and whether an agent runs it (the skeletons don't yet: see `panelAdapterEntries`). */
export const runtimeAdapterEntries: readonly AdapterEntry<RuntimeAdapter>[] = [
  { adapter: pzRuntimeAdapter, enabled: true },
  { adapter: minecraftRuntimeAdapter, enabled: false },
  { adapter: terrariaRuntimeAdapter, enabled: false },
  { adapter: valheimRuntimeAdapter, enabled: false },
  { adapter: manifestRuntimeAdapter, enabled: false },
];

/** The runtime adapters an agent runs: the enabled ones. */
export const runtimeAdapters: readonly RuntimeAdapter[] = enabledOf(runtimeAdapterEntries);

export function runtimeAdapter(id: string): RuntimeAdapter {
  const a = runtimeAdapters.find((x) => x.meta.id === id);
  if (!a) throw new Error(`No runtime adapter "${id}"`);
  return a;
}
