// The one list of adapters (PRD §10 "Package layout"): every adapter
// package is registered, and the skeletons of the M3 contract step are not
// offered anywhere until their milestone measured the game (D4, D5).
// Minecraft was measured and built in M3, Terraria in M5 (its runtime half
// in phase 2, its panel half in phase 3): agents run them and the panel
// offers them. Avorion, measured in M6, is the first game added with a
// manifest only: an adapter of its own id, made by the manifest engine.
import { describe, expect, it } from 'vitest';
import { AVORION } from '@gsp/adapter-manifest/shared';
import { panelAdapter, panelAdapterEntries, panelAdapters, runtimeAdapter, runtimeAdapterEntries, runtimeAdapters } from '../src/index';

const SKELETONS = ['valheim'];

describe('the adapter list (D4, D5)', () => {
  it('registers every adapter on both sides, with the same meta', () => {
    const ids = panelAdapterEntries.map((e) => e.adapter.meta.id);
    expect(ids).toEqual(['pz', 'minecraft', 'terraria', ...SKELETONS, 'avorion']);
    expect(runtimeAdapterEntries.map((e) => e.adapter.meta.id)).toEqual(ids);
    for (const [i, e] of panelAdapterEntries.entries()) {
      expect(runtimeAdapterEntries[i]!.adapter.meta, e.adapter.meta.id).toBe(e.adapter.meta);
      // A game the panel offers always runs on agents.
      if (e.enabled) expect(runtimeAdapterEntries[i]!.enabled, e.adapter.meta.id).toBe(true);
    }
  });

  it('offers only enabled adapters: the skeletons are registered but disabled; Terraria on both sides (M5); Avorion (M6)', () => {
    expect(panelAdapterEntries.filter((e) => !e.enabled).map((e) => e.adapter.meta.id)).toEqual(SKELETONS);
    expect(runtimeAdapterEntries.filter((e) => !e.enabled).map((e) => e.adapter.meta.id)).toEqual(SKELETONS);
    expect(panelAdapters.map((a) => a.meta.id)).toEqual(['pz', 'minecraft', 'terraria', 'avorion']);
    expect(runtimeAdapters.map((a) => a.meta.id)).toEqual(['pz', 'minecraft', 'terraria', 'avorion']);
    expect(panelAdapter('pz').meta.id).toBe('pz');
    expect(runtimeAdapter('pz').meta.id).toBe('pz');
    expect(runtimeAdapter('terraria').meta.id).toBe('terraria');
    expect(panelAdapter('terraria').meta).toBe(runtimeAdapter('terraria').meta);
    for (const id of SKELETONS) {
      expect(() => panelAdapter(id), id).toThrow(/No panel adapter/);
      expect(() => runtimeAdapter(id), id).toThrow(/No runtime adapter/);
    }
    // The manifest engine's own skeleton is gone: each manifest is an adapter of its own id.
    expect(() => panelAdapter('manifest')).toThrow(/No panel adapter/);
  });

  it('offers Minecraft on both sides, with its loaders as flavours (M3, UPD-06)', () => {
    expect(runtimeAdapter('minecraft').meta.id).toBe('minecraft');
    expect(panelAdapter('minecraft').meta.flavours.map((f) => f.id)).toEqual(['vanilla', 'paper', 'fabric']);
    expect(panelAdapter('minecraft').meta).toBe(runtimeAdapter('minecraft').meta);
  });

  it('offers Avorion from its manifest alone, both halves sharing one meta (M6, G4)', () => {
    expect(panelAdapter('avorion').meta).toBe(runtimeAdapter('avorion').meta);
    expect(panelAdapter('avorion').meta).toMatchObject({ id: AVORION.id, name: AVORION.name, arch: ['amd64'] });
  });

  it('gives each adapter the runtime family the PRD names (§10), and tModLoader its own', () => {
    const runtime = Object.fromEntries(panelAdapterEntries.map((e) => [e.adapter.meta.id, e.adapter.meta.runtime]));
    expect(runtime).toEqual({ pz: 'steam', minecraft: 'java', terraria: 'native', valheim: 'steam', avorion: 'steam' });
    const flavoured = panelAdapterEntries.flatMap((e) => e.adapter.meta.flavours.flatMap((f) => (f.runtime ? [`${e.adapter.meta.id}/${f.id}:${f.runtime}`] : [])));
    expect(flavoured).toEqual(['terraria/tmodloader:steam']);
  });
});
