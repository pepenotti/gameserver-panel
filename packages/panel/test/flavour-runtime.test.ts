// PRD §10, HST-05: a flavour may run in another image family than its
// adapter (a game whose flavours need different runtimes). The spec the
// panel asks the orchestrator for names the flavour's family; adapters and
// flavours that name none keep the adapter's.
import { describe, expect, it } from 'vitest';
import type { PanelAdapter } from '@gsp/adapter-api';
import { pzPanelAdapter } from '@gsp/adapter-pz/panel';
import { buildSpec, runtimeOf } from '../src/servers/spec';
import type { ServerRow } from '../src/servers/store';
import { makePanel, ownerReady } from './harness';

const adapter = {
  meta: {
    id: 'twoimages',
    name: { en: 'Two images', es: 'Dos imágenes' },
    runtime: 'native',
    arch: ['amd64'],
    flavours: [
      { id: 'plain', name: { en: 'Plain', es: 'Simple' } },
      { id: 'modded', name: { en: 'Modded', es: 'Con mods' }, runtime: 'steam' },
    ],
    ports: [{ id: 'game', proto: 'tcp', default: 7777, publish: true, sameInsideOut: false, label: { en: 'Game', es: 'Juego' } }],
    memory: { minMb: 1024, defaultMb: 2048, overheadMb: 256 },
    capabilities: [],
    stopBudgetMs: 60_000,
  },
} as unknown as PanelAdapter;

const row = (flavour: string | null): ServerRow => ({
  id: 'srv1',
  name: 'Server one',
  adapter: 'twoimages',
  flavour,
  gameName: 'world',
  versionPin: null,
  ports: { game: 30550 },
  memLimitMb: 2304,
  cpus: null,
  spec: null,
  eulaAcceptedAt: null,
  eulaAcceptedBy: null,
  createdAt: '2026-09-29T00:00:00.000Z',
  createdBy: null,
  sort: 0,
  installId: null,
});

describe("a flavour's own image family (PRD §10, HST-05)", () => {
  it('is the runtime of servers of that flavour; others keep the adapter\'s', () => {
    expect(runtimeOf(adapter, 'modded')).toBe('steam');
    expect(runtimeOf(adapter, 'plain')).toBe('native');
    expect(runtimeOf(adapter, null)).toBe('native');
    expect(runtimeOf(adapter, 'unknown')).toBe('native');
  });

  it('reaches the orchestrator in the spec, with the flavour in GAME_FLAVOUR for the agent', () => {
    const spec = buildSpec(row('modded'), adapter, { agentToken: 't'.repeat(40), tz: 'UTC' });
    expect(spec).toMatchObject({ runtime: 'steam', env: { GAME_ADAPTER: 'twoimages', GAME_FLAVOUR: 'modded', GAME_PORT_GAME: '7777' }, ports: [{ container: 7777, host: 30550, proto: 'tcp' }] });
    expect(buildSpec(row('plain'), adapter, { agentToken: 't'.repeat(40), tz: 'UTC' }).runtime).toBe('native');
  });

  it('is said to whoever creates servers, and a server created with that flavour gets that image', async () => {
    // A made-up game built on the PZ adapter, whose `modded` flavour runs in the steam image.
    const twoImages: PanelAdapter = {
      ...pzPanelAdapter,
      meta: { ...pzPanelAdapter.meta, id: 'twoimages', runtime: 'native', flavours: adapter.meta.flavours },
    };
    const p = await makePanel({}, { adapters: [pzPanelAdapter, twoImages] });
    const { client: owner } = await ownerReady(p);
    const listed = ((await owner.get('/api/adapters')).json() as { adapters: { id: string; runtime: string; flavours: unknown[] }[] }).adapters;
    expect(listed.find((a) => a.id === 'twoimages')).toMatchObject({
      runtime: 'native',
      flavours: [{ id: 'plain', name: { en: 'Plain', es: 'Simple' } }, { id: 'modded', name: { en: 'Modded', es: 'Con mods' }, runtime: 'steam' }],
    });
    expect(Object.keys((listed.find((a) => a.id === 'twoimages')!.flavours[0] as object) ?? {})).toEqual(['id', 'name']);

    for (const [id, flavour, runtime] of [
      ['mod1', 'modded', 'steam'],
      ['plain1', 'plain', 'native'],
    ] as const) {
      const r = await owner.post('/api/servers', { id, name: id, adapter: 'twoimages', flavour });
      expect(r.statusCode, r.body).toBe(200);
      expect(p.orch.containers.get(id)!.spec).toMatchObject({ runtime, env: { GAME_ADAPTER: 'twoimages', GAME_FLAVOUR: flavour } });
    }
  });
});
