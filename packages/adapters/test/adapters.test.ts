// The one list of adapters (PRD §10 "Package layout"): every adapter
// package is registered, and the skeletons of the M3 contract step are not
// offered anywhere until their milestone measured the game (D4, D5).
import { describe, expect, it } from 'vitest';
import { panelAdapter, panelAdapterEntries, panelAdapters, runtimeAdapter, runtimeAdapterEntries, runtimeAdapters } from '../src/index';

const SKELETONS = ['minecraft', 'terraria', 'valheim', 'manifest'];

describe('the adapter list (D4, D5)', () => {
  it('registers every adapter on both sides, with the same meta', () => {
    const ids = panelAdapterEntries.map((e) => e.adapter.meta.id);
    expect(ids).toEqual(['pz', ...SKELETONS]);
    expect(runtimeAdapterEntries.map((e) => e.adapter.meta.id)).toEqual(ids);
    for (const [i, e] of panelAdapterEntries.entries()) {
      expect(runtimeAdapterEntries[i]!.adapter.meta, e.adapter.meta.id).toBe(e.adapter.meta);
      expect(runtimeAdapterEntries[i]!.enabled, e.adapter.meta.id).toBe(e.enabled);
    }
  });

  it('offers only enabled adapters: the skeletons are registered but disabled', () => {
    expect(panelAdapterEntries.filter((e) => !e.enabled).map((e) => e.adapter.meta.id)).toEqual(SKELETONS);
    expect(panelAdapters.map((a) => a.meta.id)).toEqual(['pz']);
    expect(runtimeAdapters.map((a) => a.meta.id)).toEqual(['pz']);
    expect(panelAdapter('pz').meta.id).toBe('pz');
    expect(runtimeAdapter('pz').meta.id).toBe('pz');
    for (const id of SKELETONS) {
      expect(() => panelAdapter(id), id).toThrow(/No panel adapter/);
      expect(() => runtimeAdapter(id), id).toThrow(/No runtime adapter/);
    }
  });

  it('gives each skeleton the runtime family the PRD names (§10)', () => {
    const runtime = Object.fromEntries(panelAdapterEntries.map((e) => [e.adapter.meta.id, e.adapter.meta.runtime]));
    expect(runtime).toEqual({ pz: 'steam', minecraft: 'java', terraria: 'native', valheim: 'steam', manifest: 'steam' });
  });
});
