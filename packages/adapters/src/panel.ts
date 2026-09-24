// The panel adapters the panel offers. Only the panel's wiring imports this
// (NFR-08); everything else sees `PanelAdapter`.
import type { PanelAdapter } from '@gsp/adapter-api';
import { pzPanelAdapter } from '@gsp/adapter-pz/panel';

export const panelAdapters: readonly PanelAdapter[] = [pzPanelAdapter];

export function panelAdapter(id: string): PanelAdapter {
  const a = panelAdapters.find((x) => x.meta.id === id);
  if (!a) throw new Error(`No panel adapter "${id}"`);
  return a;
}
