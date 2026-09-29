// tModLoader's Workshop mods (MOD-03), through the shared Workshop source as
// Project Zomboid's: the version folder tModLoader takes from each item (as
// its server.log said, fixtures/terraria/1.4.5.8/tmodloader/files), the
// mod's name from its .tmod, Mods/enabled.json as tModLoader writes it, the
// items' details from Steam for app 1281930, and the runtime's download
// with the steam image's steamcmd.
import { describe, expect, it } from 'vitest';
import type { AgentStatus, DirEntry, InstallCtx, JobResult, ServerCtx } from '@gsp/adapter-api';
import { WORKSHOP_DOWNLOAD } from '@gsp/source-workshop';
import { createTmlWorkshopSource, enabledJson, pickVersionFolder, TML_LEGACY_LAST, tmlVersionOf } from '../src/panel';
import { terrariaRuntimeAdapter as tr } from '../src/runtime';
import { fixture } from './helpers';

/** The folders of Recipe Browser (2619954303) as downloaded (fixtures/terraria/1.4.5.8/tmodloader/tree/data-after-runs.txt). */
const RECIPE_BROWSER = ['2022.9', '2025.6', '2025.9', '2026.7'];

describe('the version folder tModLoader takes (MOD-03)', () => {
  it('takes the newest folder built for its own version or an older one of its line, as tModLoader 2026.7 did (measured)', () => {
    // server.log: 2022.9 skipped (another Terraria version), 2025.9 and 2025.6 skipped (a newer version exists), 2026.7 selected.
    const log = fixture('tmodloader', 'files', 'server-log-head.log');
    expect(log).toMatch(/Skipped RecipeBrowser 0\.9\.9 for tML 2022\.9\.47\.50 from Workshop\. Reason: mod is for a different Terraria version\/LTS release stream\./);
    expect(log).toMatch(/Selected RecipeBrowser 0\.12\.0\.3 for tML 2026\.7\.3\.0 from Workshop\./);
    expect(pickVersionFolder(RECIPE_BROWSER, [2026, 7])).toEqual({ folder: '2026.7', reason: null, newest: '2026.7' });
    // Older tModLoaders take the newest folder not newer than themselves.
    expect(pickVersionFolder(RECIPE_BROWSER, [2026, 6]).folder).toBe('2025.9');
    expect(pickVersionFolder(RECIPE_BROWSER, [2025, 8]).folder).toBe('2025.6');
    // Only folders for a newer tModLoader, or only for the 1.4.3 line: nothing loads, and says why.
    expect(pickVersionFolder(['2026.9'], [2026, 7])).toEqual({ folder: null, reason: 'needs-newer-game', newest: '2026.9' });
    expect(pickVersionFolder(['2022.9', '2021.12'], [2026, 7])).toEqual({ folder: null, reason: 'no-matching-folder', newest: '2022.9' });
    expect(pickVersionFolder(['mods', 'x'], [2026, 7])).toEqual({ folder: null, reason: 'no-matching-folder', newest: null });
    expect(TML_LEGACY_LAST).toEqual([2022, 9]);
  });

  it('reads tModLoader versions as its tags and folders write them', () => {
    expect(tmlVersionOf('v2026.07.3.0')).toEqual([2026, 7]);
    expect(tmlVersionOf('2026.7.3.0')).toEqual([2026, 7]);
    expect(tmlVersionOf('2025.9')).toEqual([2025, 9]);
    for (const bad of ['', null, undefined, '1.4.4.9', 'v2026.13.0.0', 'x2026.7']) expect(tmlVersionOf(bad)).toBeNull();
  });
});

describe("tModLoader's Workshop source (MOD-03)", () => {
  /** A server whose files are `tree` (dirs end with /) under the data root, running `build`. */
  function serverWith(tree: string[], build: string | null, launchVersion = ''): ServerCtx & { actions: [string, unknown][] } {
    const actions: [string, unknown][] = [];
    const list = async (_root: string, rel: string): Promise<DirEntry[]> => {
      const prefix = rel === '' ? '' : `${rel}/`;
      const names = new Map<string, 'file' | 'dir'>();
      for (const p of tree) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const [head, ...more] = rest.split('/');
        if (head) names.set(head, more.length > 0 ? 'dir' : 'file');
      }
      return [...names].sort().map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0 }));
    };
    const stat = async (root: string, rel: string) => ((await list(root, rel)).length ? { kind: 'dir' as const, size: 0, mtimeMs: 0 } : null);
    return {
      srv: { id: 'tml', gameName: 'tml', flavour: 'tmodloader' },
      files: { list, stat },
      status: () => (build === null ? null : ({ installedInfo: { version: '1.4.4.9', channel: 'tmodloader', build } } as unknown as AgentStatus)),
      launchSettings: () => ({ version: launchVersion }),
      action: async (name: string, input: unknown) => (actions.push([name, input]), { ok: true }),
      actions,
    } as unknown as ServerCtx & { actions: [string, unknown][] };
  }

  const item = (id: string, folders: Record<string, string[]>) => Object.entries(folders).flatMap(([v, mods]) => mods.map((m) => `.workshop/steamapps/workshop/content/1281930/${id}/${v}/${m}.tmod`)).concat(`.workshop/steamapps/workshop/content/1281930/${id}/workshop.json`);

  it("finds an item's mods in the folder the installed tModLoader takes, named after their .tmod files", async () => {
    const source = createTmlWorkshopSource();
    const tree = item('2619954303', Object.fromEntries(RECIPE_BROWSER.map((v) => [v, ['RecipeBrowser']])));
    expect(await source.scan(serverWith(tree, 'v2026.07.3.0'), '2619954303', '1.4.4.9')).toEqual([
      { modId: 'RecipeBrowser', name: 'RecipeBrowser', require: [], incompatible: [], compatible: true, reason: null, versionFolder: '2026.7' },
    ]);
    // Before the agent says what is installed: the pinned version, then the measured stable.
    expect((await source.scan(serverWith(tree, null, 'v2025.09.3.3'), '2619954303', ''))?.[0]?.versionFolder).toBe('2025.9');
    expect((await source.scan(serverWith(tree, null), '2619954303', ''))?.[0]?.versionFolder).toBe('2026.7');
    // Built only for a newer tModLoader: listed, marked as not loading, and why.
    const newer = item('42', { '2027.3': ['Future'] });
    expect(await source.scan(serverWith(newer, 'v2026.07.3.0'), '42', '')).toEqual([{ modId: 'Future', name: 'Future', require: [], incompatible: [], compatible: false, reason: 'needs-newer-game', versionFolder: null }]);
    // Not downloaded: nothing to say yet.
    expect(await source.scan(serverWith([], 'v2026.07.3.0'), '2619954303', '')).toBeNull();
  });

  it('writes Mods/enabled.json whole, as tModLoader writes it, and downloads before a start (the server reads only its disk)', () => {
    const source = createTmlWorkshopSource();
    expect(source.serverFetches).toBe(false);
    const cfg = source.toConfig(
      [
        { modId: 'RecipeBrowser', itemId: '2619954303' },
        { modId: 'BossChecklist', itemId: '2669644269' },
      ],
      new Map(),
    );
    expect(cfg).toEqual({ fileId: 'tml-mods', values: {}, text: '[\n  "RecipeBrowser",\n  "BossChecklist"\n]' });
    // Byte for byte what tModLoader wrote (fixtures/terraria/1.4.5.8/tmodloader/files/enabled.json).
    expect(enabledJson(['RecipeBrowser'])).toBe(fixture('tmodloader', 'files', 'enabled.json').replace(/\n$/, ''));
    expect(source.toConfig([], new Map()).text).toBe('[]');
  });

  it("asks Steam for the items of tModLoader's app, and refuses items of another game", async () => {
    const asked: string[] = [];
    const fetch = (async (_url: string, init?: { body?: URLSearchParams }) => {
      const ids = [...(init!.body as URLSearchParams).entries()].filter(([k]) => k.startsWith('publishedfileids')).map(([, v]) => v);
      asked.push(...ids);
      return new Response(JSON.stringify({ response: { publishedfiledetails: ids.map((id) => ({ publishedfileid: id, result: 1, title: `Item ${id}`, consumer_app_id: id === '108600' ? 108600 : 1281930, time_updated: 1788581217, file_size: 1356461, hcontent_file: 'x' })) } }));
    }) as unknown as typeof globalThis.fetch;
    const source = createTmlWorkshopSource({ fetch });
    expect(await source.details(['2619954303', '108600'])).toEqual([
      expect.objectContaining({ id: '2619954303', ok: true, title: 'Item 2619954303', timeUpdated: 1788581217 }),
      expect.objectContaining({ id: '108600', ok: false }),
    ]);
    expect(source.parseRef('https://steamcommunity.com/sharedfiles/filedetails/?id=2619954303')).toBe('2619954303');
    const ctx = serverWith([], 'v2026.07.3.0');
    expect(await source.download(ctx, ['2619954303'])).toEqual({ ok: true });
    expect(ctx.actions).toEqual([[WORKSHOP_DOWNLOAD, { ids: ['2619954303'] }]]);
  });

  it("downloads on the agent with the steam image's steamcmd, for app 1281930; other images have none", async () => {
    const action = tr.actions![WORKSHOP_DOWNLOAD]!;
    const calls: unknown[] = [];
    const steam = { workshopDownload: async (o: unknown): Promise<JobResult> => (calls.push(o), { ok: true }), appUpdate: async () => ({ ok: true }), branches: async () => [] };
    const ctx = { progress: () => undefined, steam } as unknown as InstallCtx;
    expect(action.job).toBe('workshop');
    expect(await action.run(ctx, null, action.parse({ ids: ['2619954303'] }))).toEqual({ ok: true });
    expect(calls).toEqual([{ workshopAppId: '1281930', ids: ['2619954303'] }]);
    await expect(action.run({ progress: () => undefined } as unknown as InstallCtx, null, { ids: ['2619954303'] })).rejects.toThrow(/steamcmd/);
    expect(() => action.parse({ ids: ['../x'] })).toThrow();
  });
});
