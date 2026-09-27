// The one list of adapters (PRD §10 "Package layout"): every adapter
// package is registered, and the skeletons of the M3 contract step are not
// offered anywhere until their milestone measured the game (D4, D5).
// Minecraft's runtime half is built (M3): agents run it; the panel offers
// Minecraft once its panel half exists.
import { describe, expect, it } from 'vitest';
import { panelAdapter, panelAdapterEntries, panelAdapters, runtimeAdapter, runtimeAdapterEntries, runtimeAdapters } from '../src/index';

const SKELETONS = ['terraria', 'valheim', 'manifest'];
/** Enabled for agents, not yet for the panel. */
const RUNTIME_ONLY = ['minecraft'];

describe('the adapter list (D4, D5)', () => {
  it('registers every adapter on both sides, with the same meta', () => {
    const ids = panelAdapterEntries.map((e) => e.adapter.meta.id);
    expect(ids).toEqual(['pz', 'minecraft', ...SKELETONS]);
    expect(runtimeAdapterEntries.map((e) => e.adapter.meta.id)).toEqual(ids);
    for (const [i, e] of panelAdapterEntries.entries()) {
      expect(runtimeAdapterEntries[i]!.adapter.meta, e.adapter.meta.id).toBe(e.adapter.meta);
      // A game the panel offers always runs on agents.
      if (e.enabled) expect(runtimeAdapterEntries[i]!.enabled, e.adapter.meta.id).toBe(true);
    }
  });

  it('offers only enabled adapters: the skeletons are registered but disabled', () => {
    expect(panelAdapterEntries.filter((e) => !e.enabled).map((e) => e.adapter.meta.id)).toEqual([...RUNTIME_ONLY, ...SKELETONS]);
    expect(runtimeAdapterEntries.filter((e) => !e.enabled).map((e) => e.adapter.meta.id)).toEqual(SKELETONS);
    expect(panelAdapters.map((a) => a.meta.id)).toEqual(['pz']);
    expect(runtimeAdapters.map((a) => a.meta.id)).toEqual(['pz', 'minecraft']);
    expect(panelAdapter('pz').meta.id).toBe('pz');
    expect(runtimeAdapter('pz').meta.id).toBe('pz');
    for (const id of SKELETONS) {
      expect(() => panelAdapter(id), id).toThrow(/No panel adapter/);
      expect(() => runtimeAdapter(id), id).toThrow(/No runtime adapter/);
    }
  });

  it("runs Minecraft on agents (UPD-06) while the panel doesn't offer it yet", () => {
    expect(runtimeAdapter('minecraft').meta.id).toBe('minecraft');
    expect(() => panelAdapter('minecraft')).toThrow(/No panel adapter/);
  });

  it('gives each adapter the runtime family the PRD names (§10)', () => {
    const runtime = Object.fromEntries(panelAdapterEntries.map((e) => [e.adapter.meta.id, e.adapter.meta.runtime]));
    expect(runtime).toEqual({ pz: 'steam', minecraft: 'java', terraria: 'native', valheim: 'steam', manifest: 'steam' });
  });
});
