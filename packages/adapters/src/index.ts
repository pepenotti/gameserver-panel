// Composition root: every game adapter, in one list per side. The agent and
// the panel import their own half (`@gsp/adapters/runtime`, `/panel`) so
// neither bundles the other's code.
export { panelAdapter, panelAdapters } from './panel';
export { runtimeAdapter, runtimeAdapters } from './runtime';
