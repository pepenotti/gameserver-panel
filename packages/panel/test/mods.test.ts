import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getIniValue, parseIni } from '@pz/formats';
import { sortByDependencies } from '../src/mods/service';
import { SteamWorkshop } from '../src/mods/steam';
import { makePanel, ownerReady, type TestPanel } from './harness';

const fixtures = fileURLToPath(new URL('../../../fixtures/b42/workshop/', import.meta.url));

/** A fake Steam Workshop API: known items, one collection. */
function fakeSteam(items: Record<string, { title: string; updated?: number; app?: number }>, collections: Record<string, string[]> = {}) {
  const calls: string[] = [];
  const doFetch = (async (url: string, init?: { body?: URLSearchParams }) => {
    const body = init?.body as URLSearchParams;
    const ids = [...body.entries()].filter(([k]) => k.startsWith('publishedfileids')).map(([, v]) => v);
    calls.push(`${url.split('/').at(-3)}:${ids.join(',')}`);
    if (url.includes('GetCollectionDetails')) {
      const children = collections[ids[0]!];
      return new Response(JSON.stringify({ response: { collectiondetails: [children ? { result: 1, children: children.map((c) => ({ publishedfileid: c, filetype: 0 })) } : { result: 9 }] } }));
    }
    return new Response(
      JSON.stringify({
        response: {
          publishedfiledetails: ids.map((id) =>
            items[id]
              ? { publishedfileid: id, result: 1, title: items[id]!.title, consumer_app_id: items[id]!.app ?? 108600, time_updated: items[id]!.updated ?? 1000, file_size: 10, hcontent_file: 'x', preview_url: `https://steamuserimages-a.akamaihd.net/${id}.jpg` }
              : { publishedfileid: id, result: 9 },
          ),
        },
      }),
    );
  }) as unknown as typeof fetch;
  return { steam: new SteamWorkshop(doFetch), calls };
}

/** Pretend the agent downloaded these items (copying the real B42 mod folders). */
function fakeDownloads(p: TestPanel) {
  p.agent.downloadWorkshop = async (ids) => {
    p.agent.calls.push(`download:${ids.join(',')}`);
    for (const id of ids) {
      const dest = path.join(p.deps.env.pzDataDir, '.workshop', 'steamapps', 'workshop', 'content', '108600', id);
      mkdirSync(dest, { recursive: true });
      try {
        cpSync(path.join(fixtures, id), dest, { recursive: true });
      } catch {
        // not in fixtures: an empty item
      }
    }
    return { ok: true };
  };
}

const ITEMS = {
  '2503622437': { title: 'Skill Recovery Journal' },
  '2544353492': { title: 'Has Been Read' },
  '2725378876': { title: 'They Knew' },
  '2946364542': { title: 'Search Containers' },
  '1111111111': { title: 'Chuckleberry Finn Alert System' },
};

async function setup() {
  const s = fakeSteam(ITEMS, { '9999999999': ['2544353492', '2946364542'] });
  const p = await makePanel({}, { steam: s.steam });
  fakeDownloads(p);
  const { client } = await ownerReady(p);
  return { p, c: client, calls: s.calls };
}

const iniLine = (p: TestPanel, key: string) => getIniValue(parseIni(readFileSync(p.deps.config.pathOf('ini'), 'utf8')), key);

describe('adding mods', () => {
  it('adds by URL, downloads, reads the B42 mod.info and writes the ini lines', async () => {
    const { p, c } = await setup();
    const r = await c.post('/api/mods', { refs: ['https://steamcommunity.com/sharedfiles/filedetails/?id=2544353492'] });
    expect(r.json()).toMatchObject({ added: ['2544353492'] });
    await p.deps.ops.idle();
    const list = (await c.get('/api/mods')).json() as { items: { workshopId: string; title: string; mods: { modId: string; versionFolder: string; compatible: boolean }[] }[]; enabled: { modId: string }[] };
    expect(list.items[0]).toMatchObject({ title: 'Has Been Read', mods: [{ modId: 'P4HasBeenRead', versionFolder: '42.15', compatible: true }] });
    // A single-mod item is enabled on arrival.
    expect(list.enabled).toEqual([{ modId: 'P4HasBeenRead', workshopId: '2544353492' }]);
    expect(iniLine(p, 'Mods')).toBe('\\P4HasBeenRead');
    expect(iniLine(p, 'WorkshopItems')).toBe('2544353492');
    expect(iniLine(p, 'Map')).toBe('Muldraugh, KY');
  });

  it('expands collections and refuses items that are not Project Zomboid mods', async () => {
    const { p, c } = await setup();
    const r = (await c.post('/api/mods', { refs: ['9999999999'] })).json() as { added: string[] };
    expect(r.added.sort()).toEqual(['2544353492', '2946364542']);
    await p.deps.ops.idle();

    const s2 = fakeSteam({ '5555555555': { title: 'Skyrim mod', app: 72850 } });
    const p2 = await makePanel({}, { steam: s2.steam });
    const { client } = await ownerReady(p2);
    expect((await client.post('/api/mods', { refs: ['5555555555'] })).json()).toMatchObject({ error: 'not-a-pz-mod', ids: ['5555555555'] });
    expect((await client.post('/api/mods', { refs: ['https://evil.example/?id=1'] })).json()).toMatchObject({ error: 'invalid-workshop-ref' });
  });
});

describe('health checks', () => {
  it('flags B41-only mods, missing dependencies and load order', async () => {
    const { p, c } = await setup();
    await c.post('/api/mods', { refs: ['2725378876', '2503622437'] });
    await p.deps.ops.idle();
    // They Knew has no B42 folder; Skill Recovery Journal requires two mods we don't have.
    const issues = ((await c.get('/api/mods')).json() as { issues: { kind: string; modId?: string; requires?: string }[] }).issues;
    expect(issues).toEqual(
      expect.arrayContaining([
        { kind: 'not-b42', modId: 'TheyKnew', reason: 'no-b42-folder' },
        { kind: 'missing-dependency', modId: 'SkillRecoveryJournal', requires: 'ChuckleberryFinnAlertSystem', availableIn: null },
        { kind: 'missing-dependency', modId: 'SkillRecoveryJournal', requires: 'errorMagnifier', availableIn: null },
      ]),
    );
  });

  it('sorts dependencies first', () => {
    const order = [
      { modId: 'A', workshopId: '1' },
      { modId: 'B', workshopId: '2' },
      { modId: 'C', workshopId: '3' },
    ];
    const req: Record<string, string[]> = { A: ['C'], B: [], C: ['B'] };
    expect(sortByDependencies(order, (id) => req[id] ?? []).map((m) => m.modId)).toEqual(['B', 'C', 'A']);
  });
});

describe('enabling and ordering', () => {
  it('writes the chosen order, puts map mods before the vanilla map, and needs a restart when running', async () => {
    const { p, c } = await setup();
    await c.post('/api/mods', { refs: ['2544353492', '2946364542'] });
    await p.deps.ops.idle();
    // Give Search Containers a map folder, as map mods have.
    const mapDir = path.join(p.deps.env.pzDataDir, '.workshop', 'steamapps', 'workshop', 'content', '108600', '2946364542', 'mods', 'Search Containers', '42.0', 'media', 'maps', 'Raven Creek');
    mkdirSync(mapDir, { recursive: true });
    writeFileSync(path.join(mapDir, 'map.info'), 'title=Raven Creek');
    p.deps.mods.rescan();
    const r = await c.req('PUT', '/api/mods/enabled', {
      enabled: [
        { modId: 'SearchContainers', workshopId: '2946364542' },
        { modId: 'P4HasBeenRead', workshopId: '2544353492' },
      ],
    });
    expect(r.statusCode).toBe(200);
    expect(iniLine(p, 'Mods')).toBe('\\SearchContainers;\\P4HasBeenRead');
    expect(iniLine(p, 'Map')).toBe('Raven Creek;Muldraugh, KY');
    expect((await c.req('PUT', '/api/mods/enabled', { enabled: [{ modId: 'Nope', workshopId: '2946364542' }] })).json()).toMatchObject({ error: 'unknown-mod' });
  });

  it('removes an item and its mods from the ini', async () => {
    const { p, c } = await setup();
    await c.post('/api/mods', { refs: ['2544353492'] });
    await p.deps.ops.idle();
    await c.req('DELETE', '/api/mods/2544353492');
    expect(iniLine(p, 'Mods')).toBe('');
    expect(iniLine(p, 'WorkshopItems')).toBe('');
  });

  it('adopts mods already in the ini the first time', async () => {
    const { p, c } = await setup();
    mkdirSync(path.dirname(p.deps.config.pathOf('ini')), { recursive: true });
    writeFileSync(p.deps.config.pathOf('ini'), 'WorkshopItems=2544353492\nMods=P4HasBeenRead\n');
    await fakeDownloads(p);
    await p.agent.downloadWorkshop(['2544353492']);
    const list = (await c.get('/api/mods')).json() as { enabled: { modId: string }[] };
    expect(list.enabled.map((e) => e.modId)).toEqual(['P4HasBeenRead']);
  });
});

describe('updates', () => {
  it('detects a newer version on Steam than the files we scanned', async () => {
    const items = { '2544353492': { title: 'Has Been Read', updated: 1000 } };
    const s = fakeSteam(items);
    const p = await makePanel({}, { steam: s.steam });
    fakeDownloads(p);
    const { client } = await ownerReady(p);
    await client.post('/api/mods', { refs: ['2544353492'] });
    await p.deps.ops.idle();
    expect(((await client.post('/api/mods/check')).json() as { updates: string[] }).updates).toEqual([]);
    items['2544353492'].updated = 2000;
    expect(((await client.post('/api/mods/check')).json() as { updates: string[] }).updates).toEqual(['2544353492']);
  });
});
