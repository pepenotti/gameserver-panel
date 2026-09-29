// The panel adapters the panel offers. Only the panel's wiring imports this
// (NFR-08); everything else sees `PanelAdapter`.
import type { PanelAdapter } from '@gsp/adapter-api';
import { manifestPanelAdapter } from '@gsp/adapter-manifest/panel';
import { minecraftPanelAdapter } from '@gsp/adapter-minecraft/panel';
import { pzPanelAdapter } from '@gsp/adapter-pz/panel';
import { terrariaPanelAdapter } from '@gsp/adapter-terraria/panel';
import { valheimPanelAdapter } from '@gsp/adapter-valheim/panel';
import { enabledOf, type AdapterEntry } from './entry';

/**
 * Every panel adapter, and whether the panel offers it. The skeletons
 * (M3 contract step) are here so their packages build and pass the
 * contract, but no server can be created from them until their milestone
 * turns them on (M6 Valheim and manifests). Minecraft is offered since M3
 * measured it and built both halves, Terraria since M5 phase 3.
 */
export const panelAdapterEntries: readonly AdapterEntry<PanelAdapter>[] = [
  { adapter: pzPanelAdapter, enabled: true },
  { adapter: minecraftPanelAdapter, enabled: true },
  { adapter: terrariaPanelAdapter, enabled: true },
  { adapter: valheimPanelAdapter, enabled: false },
  { adapter: manifestPanelAdapter, enabled: false },
];

/** The panel adapters servers are created from and run with: the enabled ones. */
export const panelAdapters: readonly PanelAdapter[] = enabledOf(panelAdapterEntries);

export function panelAdapter(id: string): PanelAdapter {
  const a = panelAdapters.find((x) => x.meta.id === id);
  if (!a) throw new Error(`No panel adapter "${id}"`);
  return a;
}
