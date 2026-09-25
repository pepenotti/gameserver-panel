// Composition root: every game adapter, in one list per side. The agent and
// the panel import their own half (`@gsp/adapters/runtime`, `/panel`) so
// neither bundles the other's code.
export type { AdapterEntry } from './entry';
export { panelAdapter, panelAdapterEntries, panelAdapters } from './panel';
export { runtimeAdapter, runtimeAdapterEntries, runtimeAdapters } from './runtime';
