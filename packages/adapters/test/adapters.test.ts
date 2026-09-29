// The one list of adapters (PRD §10 "Package layout"): every adapter
// package is registered, and the skeletons of the M3 contract step are not
// offered anywhere until their milestone measured the game (D4, D5).
// Minecraft was measured and built in M3: agents run it and the panel
// offers it. Terraria's runtime half was built in M5 phase 2: agents run it,
// and the panel offers it once its panel half exists (phase 3).
import { describe, expect, it } from 'vitest';
import { panelAdapter, panelAdapterEntries, panelAdapters, runtimeAdapter, runtimeAdapterEntries, runtimeAdapters } from '../src/index';

const SKELETONS = ['terraria', 'valheim', 'manifest'];
/** Measured and built on the agent's side only. */
const RUNTIME_ONLY = ['terraria'];

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

  it('offers only enabled adapters: the skeletons are registered but disabled, Terraria runs on agents only (M5)', () => {
    expect(panelAdapterEntries.filter((e) => !e.enabled).map((e) => e.adapter.meta.id)).toEqual(SKELETONS);
    expect(runtimeAdapterEntries.filter((e) => !e.enabled).map((e) => e.adapter.meta.id)).toEqual(SKELETONS.filter((id) => !RUNTIME_ONLY.includes(id)));
    expect(panelAdapters.map((a) => a.meta.id)).toEqual(['pz', 'minecraft']);
    expect(runtimeAdapters.map((a) => a.meta.id)).toEqual(['pz', 'minecraft', 'terraria']);
    expect(panelAdapter('pz').meta.id).toBe('pz');
    expect(runtimeAdapter('pz').meta.id).toBe('pz');
    expect(runtimeAdapter('terraria').meta.id).toBe('terraria');
    expect(() => panelAdapter('terraria')).toThrow(/No panel adapter/);
    for (const id of SKELETONS.filter((x) => !RUNTIME_ONLY.includes(x))) {
      expect(() => panelAdapter(id), id).toThrow(/No panel adapter/);
      expect(() => runtimeAdapter(id), id).toThrow(/No runtime adapter/);
    }
  });

  it('offers Minecraft on both sides, with its loaders as flavours (M3, UPD-06)', () => {
    expect(runtimeAdapter('minecraft').meta.id).toBe('minecraft');
    expect(panelAdapter('minecraft').meta.flavours.map((f) => f.id)).toEqual(['vanilla', 'paper', 'fabric']);
    expect(panelAdapter('minecraft').meta).toBe(runtimeAdapter('minecraft').meta);
  });

  it('gives each adapter the runtime family the PRD names (§10), and tModLoader its own', () => {
    const runtime = Object.fromEntries(panelAdapterEntries.map((e) => [e.adapter.meta.id, e.adapter.meta.runtime]));
    expect(runtime).toEqual({ pz: 'steam', minecraft: 'java', terraria: 'native', valheim: 'steam', manifest: 'steam' });
    const flavoured = panelAdapterEntries.flatMap((e) => e.adapter.meta.flavours.flatMap((f) => (f.runtime ? [`${e.adapter.meta.id}/${f.id}:${f.runtime}`] : [])));
    expect(flavoured).toEqual(['terraria/tmodloader:steam']);
  });
});
