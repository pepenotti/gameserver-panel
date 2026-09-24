// The runtime adapters the agent can run. Only the agent's entry point
// imports this (NFR-08); everything else sees `RuntimeAdapter`.
import type { RuntimeAdapter } from '@gsp/adapter-api';
import { pzRuntimeAdapter } from '@gsp/adapter-pz/runtime';

export const runtimeAdapters: readonly RuntimeAdapter[] = [pzRuntimeAdapter];

export function runtimeAdapter(id: string): RuntimeAdapter {
  const a = runtimeAdapters.find((x) => x.meta.id === id);
  if (!a) throw new Error(`No runtime adapter "${id}"`);
  return a;
}
