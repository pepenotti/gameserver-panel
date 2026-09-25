// The Steam Workshop source, shared by every game that gets mods from the
// Workshop (MOD-01 for Project Zomboid today, MOD-03 for tModLoader in M5):
// nothing in it belongs to one game; the app id and the game's own parts
// come from the adapter. The app id below is made up.
import { describe, expect, it } from 'vitest';
import type { DirEntry, InstallCtx, ModEntry, ServerCtx, SteamCmd } from '@gsp/adapter-api';
import { createWorkshopSource, parseWorkshopRef, SteamWorkshopApi, WORKSHOP_DOWNLOAD, workshopItemLocations } from '../src/index';
import { workshopDownloadAction } from '../src/runtime';

const APP = 424242;

/** Steam's two endpoints, answering for items of `APP` and one item of another game. */
function fakeSteam() {
  const calls: string[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body as URLSearchParams;
    if (url.includes('GetCollectionDetails')) {
      calls.push(`collection:${body.get('publishedfileids[0]')}`);
      return new Response(JSON.stringify({ response: { collectiondetails: [{ result: 1, children: [{ publishedfileid: '11111', filetype: 0 }, { publishedfileid: '22222', filetype: 2 }] }] } }));
    }
    const ids = [...body.entries()].filter(([k]) => k.startsWith('publishedfileids')).map(([, v]) => v);
    calls.push(`details:${ids.join(',')}`);
    return new Response(
      JSON.stringify({
        response: {
          publishedfiledetails: ids.map((id) => ({ publishedfileid: id, result: 1, title: `Item ${id}`, consumer_app_id: id === '99999' ? 1 : APP, time_updated: 5, file_size: 3, hcontent_file: 'x', preview_url: 'https://img.example/p.png' })),
        },
      }),
    );
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}

interface Mod extends ModEntry {
  where: string;
}

function ctx(o: { dirs?: string[]; action?: (name: string, input: unknown) => unknown } = {}) {
  const actions: { name: string; input: unknown }[] = [];
  const c = {
    actions,
    files: {
      stat: async (root: string, rel: string) => ((o.dirs ?? []).includes(`${root}:${rel}`) ? { kind: 'dir', size: 0, mtimeMs: 0 } : null),
      list: async (): Promise<DirEntry[]> => [],
    },
    action: async (name: string, input: unknown) => {
      actions.push({ name, input });
      return o.action ? o.action(name, input) : { ok: true };
    },
  };
  return c as unknown as ServerCtx & { actions: typeof actions };
}

function source(doFetch: typeof fetch) {
  return createWorkshopSource<Mod>({
    appId: APP,
    fetch: doFetch,
    fallbackGameVersion: '1.0',
    scan: async (_ctx, root, rel, gameVersion) => [{ modId: 'm', name: 'M', require: [], incompatible: [], compatible: true, reason: null, where: `${root}:${rel}@${gameVersion}` }],
    toConfig: (enabled) => ({ fileId: 'mods', values: { list: enabled.map((e) => e.modId).join(',') } }),
  });
}

describe('the Steam Workshop source, for any game (MOD-03)', () => {
  it("takes the game's app id: only that game's items are ok, wherever they are stored", async () => {
    const { doFetch, calls } = fakeSteam();
    const s = source(doFetch);
    expect(s).toMatchObject({ id: 'steam-workshop', capability: 'mods:workshop', label: { en: 'Steam Workshop' } });
    expect((await s.details(['12345', '99999'])).map((d) => [d.id, d.ok])).toEqual([
      ['12345', true],
      ['99999', false],
    ]);
    expect(await s.expand!('33333')).toEqual(['11111']);
    expect(calls).toEqual(['details:12345,99999', 'collection:33333']);
    expect(workshopItemLocations(APP, '12345')).toEqual([
      { root: 'install', rel: `steamapps/workshop/content/${APP}/12345` },
      { root: 'data', rel: `.workshop/steamapps/workshop/content/${APP}/12345` },
    ]);
    expect((await new SteamWorkshopApi(7, doFetch).details(['12345']))[0]!.ok).toBe(false);
  });

  it("scans an item with the game's own reader, where the server or the agent downloaded it", async () => {
    const { doFetch } = fakeSteam();
    const s = source(doFetch);
    expect(await s.scan(ctx({ dirs: [`data:.workshop/steamapps/workshop/content/${APP}/12345`] }), '12345', '')).toEqual([
      expect.objectContaining({ modId: 'm', where: `data:.workshop/steamapps/workshop/content/${APP}/12345@1.0` }),
    ]);
    expect(await s.scan(ctx({ dirs: [`install:steamapps/workshop/content/${APP}/12345`] }), '12345', '2.0')).toEqual([expect.objectContaining({ where: `install:steamapps/workshop/content/${APP}/12345@2.0` })]);
    expect(await s.scan(ctx(), '12345', '2.0')).toBeNull();
    expect(await s.scan(ctx(), '../x', '2.0')).toBeNull();
    expect(s.toConfig([{ modId: 'a', itemId: '1' }], new Map())).toEqual({ fileId: 'mods', values: { list: 'a' } });
    expect(s.fromConfig).toBeUndefined();
  });

  it("downloads through the agent's action, 100 at a time, which asks steamcmd for the game's items", async () => {
    const { doFetch } = fakeSteam();
    const c = ctx();
    expect(await source(doFetch).download(c, Array.from({ length: 150 }, (_, i) => String(10_000 + i)))).toEqual({ ok: true });
    expect(c.actions.map((a) => [a.name, (a.input as { ids: string[] }).ids.length])).toEqual([
      [WORKSHOP_DOWNLOAD, 100],
      [WORKSHOP_DOWNLOAD, 50],
    ]);
    expect(await source(doFetch).download(c, ['1; rm'])).toMatchObject({ ok: false });

    const action = workshopDownloadAction(String(APP));
    expect(action.job).toBe('workshop');
    expect(() => action.parse({ ids: ['+quit'] })).toThrow(/Invalid workshop id/);
    expect(() => action.parse({ ids: [] })).toThrow(/1-100/);
    const got: unknown[] = [];
    const steam = { workshopDownload: async (x: unknown) => (got.push(x), { ok: true }) } as unknown as SteamCmd;
    const progress: unknown[] = [];
    const ictx = { steam, progress: (...a: unknown[]) => progress.push(a) } as unknown as InstallCtx;
    expect(await action.run(ictx, null, action.parse({ ids: ['12345'] }))).toEqual({ ok: true });
    expect(got).toEqual([{ workshopAppId: String(APP), ids: ['12345'] }]);
    await expect(action.run({ ...ictx, steam: undefined } as InstallCtx, null, { ids: ['12345'] })).rejects.toThrow(/steamcmd/);
    expect(() => workshopDownloadAction('12; quit')).toThrow(/app id/);
  });

  it('reads ids and steamcommunity links only', () => {
    expect(parseWorkshopRef(' 2503622437 ')).toBe('2503622437');
    expect(parseWorkshopRef('https://steamcommunity.com/sharedfiles/filedetails/?id=2503622437')).toBe('2503622437');
    expect(parseWorkshopRef('https://evil.example/?id=2503622437')).toBeNull();
    expect(parseWorkshopRef('1234')).toBeNull();
  });
});
