// Terraria's mods and plugins through the panel's API (M5): TShock's plugin
// files (MOD-06) and tModLoader's Workshop mods (MOD-03), with the harness's
// fake agents running the Terraria adapter's real runtime actions on the
// test's disk, with the agent's own download and unpacking helpers (every
// address checked, sizes capped, archives refused whole), and the fake
// download services standing in for GitHub. The whole way through a real
// agent and the fake server is terraria-e2e.test.ts.
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstallCtx } from '@gsp/adapter-api';
import { createTmlWorkshopSource } from '@gsp/adapter-terraria/panel';
import { terrariaRuntimeAdapter } from '@gsp/adapter-terraria/runtime';
import { WORKSHOP_DOWNLOAD } from '@gsp/source-workshop';
import { makeDownload, makeExtract, makeFetch } from '../../agent/src/install-tools';
import { fakeAssembly, fakePlugin, makeZip, startFakeDownloads, type FakeDownloads } from '../../../tools/fake-terraria/downloads.mjs';
import { fakeStatus, friend, makePanel, ownerReady, type Client, type TestPanel } from './harness';

const FIXTURES = path.resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'terraria', '1.4.5.8');

let downloads: FakeDownloads;
beforeAll(async () => {
  downloads = await startFakeDownloads({ fail: '' });
});
afterAll(() => downloads.close());

const launch = { version: '', channel: 'stable', worldSize: 1, maxPlayers: 8, password: '', memoryMb: 2048 };
const create = (c: Client, id: string, flavour: string) => c.post('/api/servers', { id, name: id, adapter: 'terraria', flavour, launch });
const roots = (p: TestPanel, id: string) => ({ data: p.fakes(id).dataDir, install: path.join(path.dirname(p.fakes(id).dataDir), 'install') });

/** The server's fake agent runs the Terraria runtime's real actions, with the agent's own download and unpacking. */
function realActions(p: TestPanel, id: string, flavour: string, env: Record<string, string> = {}, steam?: InstallCtx['steam']) {
  const r = roots(p, id);
  const get = makeFetch({ userAgent: 'gameserver-panel/test', attempts: 1 });
  const ctx: InstallCtx = {
    roots: r,
    stateDir: path.join(r.data, '.agent'),
    ports: { game: 7777, rest: 7878 },
    state: { controlSecret: randomBytes(16).toString('hex'), gameVersion: null },
    tools: { home: r.data },
    env: { GAME_FLAVOUR: flavour, ...env },
    log: () => undefined,
    onLine: () => undefined,
    progress: () => undefined,
    fetch: get,
    download: makeDownload({ fetch: get }),
    extract: makeExtract(() => [r.install, r.data]),
    steam,
  };
  const agent = p.fakes(id).agent;
  agent.action = async (name, input) => {
    agent.calls.push(`action:${name}`);
    const a = terrariaRuntimeAdapter.actions![name]!;
    return a.run(ctx, null, a.parse(input));
  };
  return ctx;
}

/** A multipart upload, as the web sends a file. */
async function upload(p: TestPanel, c: Client, id: string, filename: string, data: Buffer) {
  const boundary = '----gspplugin';
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return p.app.inject({
    method: 'POST',
    url: `/api/servers/${id}/plugins/upload`,
    headers: { origin: 'https://panel.test:8443', cookie: `__Host-gspsid=${c.cookie}`, 'x-gsp-csrf': c.csrf!, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

// ------------------------------------------------------------------ TShock's plugins (MOD-06)

async function tshockPanel(env: Record<string, string | undefined> = { GAME_TERRARIA_RELEASES_URL: downloads.url }) {
  const p = await makePanel({}, { downloads: { fetch, env: { GAME_TERRARIA_ORG_URL: downloads.url, GAME_TERRARIA_GITHUB_URL: downloads.url, ...env } } });
  const { client: owner } = await ownerReady(p);
  expect((await create(owner, 'tr-tshock', 'tshock')).statusCode).toBe(200);
  realActions(p, 'tr-tshock', 'tshock', Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)));
  return { p, owner };
}
const plugins = async (c: Client) => (await c.get('/api/servers/tr-tshock/plugins')).json() as { plugins: { name: string; enabled: boolean; active: boolean; size: number; sha256: string; origin: unknown }[]; restartNeeded: boolean };
const rel = () => `${downloads.url}/gspff/HelloPlugin/releases/download/v1.0.0`;

describe("TShock's plugins through the API (MOD-06)", () => {
  it('adds an uploaded plugin and a zip of them, lists them with who added what, and the audit log says so', async () => {
    const { p, owner } = await tshockPanel();
    const dll = fakePlugin('HelloPlugin');
    const r = await upload(p, owner, 'tr-tshock', 'HelloPlugin.dll', dll);
    expect(r.statusCode, r.body).toBe(200);
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    expect(r.json()).toMatchObject({
      added: [{ name: 'HelloPlugin.dll', enabled: true, active: false, size: dll.length, sha256: sha(dll), origin: { addedBy: 'alice', from: { upload: 'HelloPlugin.dll', size: dll.length, sha256: sha(dll) } } }],
      replaced: [],
      skipped: [],
      restartNeeded: false,
    });
    const zip = makeZip([{ name: 'ServerPlugins/HelloPlugin.dll', data: fakePlugin('HelloPlugin', '1.1.0') }, { name: 'ServerPlugins/HelloLib.dll', data: fakeAssembly('HelloLib') }, { name: 'README.md', data: '# hi' }]);
    expect((await upload(p, owner, 'tr-tshock', 'hello-1.1.zip', zip)).json()).toMatchObject({ replaced: ['HelloPlugin.dll'], skipped: ['README.md'] });
    expect((await plugins(owner)).plugins.map((x) => [x.name, x.enabled, (x.origin as { from: { upload: string } }).from.upload])).toEqual([
      ['HelloLib.dll', true, 'hello-1.1.zip'],
      ['HelloPlugin.dll', true, 'hello-1.1.zip'],
    ]);
    // In the data folder, where the agent copies them from before each start.
    expect(existsSync(path.join(roots(p, 'tr-tshock').data, 'tshock', 'plugins', 'HelloLib.dll'))).toBe(true);
    const audit = p.deps.audit.list({ action: 'plugins.add' });
    expect(audit.map((e) => [e.username, e.target, e.ok])).toEqual([
      ['alice', 'HelloLib.dll, HelloPlugin.dll', true],
      ['alice', 'HelloPlugin.dll', true],
    ]);
    expect(JSON.parse(audit[1]!.detail!)).toEqual({ from: { upload: 'HelloPlugin.dll', size: dll.length, sha256: sha(dll) }, added: [{ name: 'HelloPlugin.dll', size: dll.length, sha256: sha(dll) }], replaced: [], skipped: [] });
    expect(JSON.parse(audit[0]!.detail!).from).toMatchObject({ upload: 'hello-1.1.zip', size: zip.length });
  });

  it('adds a plugin from a GitHub release link, which the agent downloads through the redirect to the asset host; the panel fetches nothing (D11)', async () => {
    const { p, owner } = await tshockPanel();
    const before = downloads.requests.length;
    const r = await owner.post('/api/servers/tr-tshock/plugins', { url: `${rel()}/HelloPlugin.dll` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ added: [{ name: 'HelloPlugin.dll', origin: { from: { url: `${rel()}/HelloPlugin.dll` } } }] });
    // Asked by the agent (the fake's actions here), with its User-Agent: the link, then the asset host.
    expect(downloads.requests.slice(before).map((q) => [q.path, q.userAgent])).toEqual([
      ['/gspff/HelloPlugin/releases/download/v1.0.0/HelloPlugin.dll', 'gameserver-panel/test'],
      ['/__release-assets/HelloPlugin.dll', 'gameserver-panel/test'],
    ]);
    expect(p.deps.audit.list({ action: 'plugins.add' })[0]).toMatchObject({ ok: true, target: 'HelloPlugin.dll' });
  });

  it.each([
    ['a zip with a path outside its folder', 'escape.zip', () => makeZip([{ name: '../../Escape.dll', data: fakePlugin('Escape') }]), 400, 'bad-archive'],
    ['a file that is no .dll (nor a zip)', 'notes.txt', () => Buffer.from('hello'), 400, 'not-a-plugin'],
    ['a .dll that is no .NET assembly', 'Broken.dll', () => Buffer.from('garbage'), 400, 'not-a-plugin'],
    ['a zip without any .dll', 'docs.zip', () => makeZip([{ name: 'README.md', data: 'x' }]), 400, 'no-plugins'],
    ['a file over 16 MiB', 'Big.dll', () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(16 * 1024 * 1024)]), 413, 'too-large'],
  ])('refuses an upload of %s, and the audit log says who tried', async (_what, filename, make, status, reason) => {
    const { p, owner } = await tshockPanel();
    const r = await upload(p, owner, 'tr-tshock', filename, make());
    expect([r.statusCode, r.json()]).toEqual([status, { error: 'plugin-refused', reason, message: expect.any(String) }]);
    expect((await plugins(owner)).plugins).toEqual([]);
    // Nothing escaped the data folder, nothing waits in the uploads folder.
    expect(existsSync(path.join(roots(p, 'tr-tshock').data, '..', 'Escape.dll'))).toBe(false);
    expect(existsSync(path.join(roots(p, 'tr-tshock').data, '..', '..', 'Escape.dll'))).toBe(false);
    const uploads = path.join(roots(p, 'tr-tshock').data, '.gsp-uploads', 'plugins');
    expect(existsSync(uploads) ? readdirSync(uploads) : []).toEqual([]);
    expect(p.deps.audit.list({ action: 'plugins.add' })[0]).toMatchObject({ username: 'alice', ok: false, detail: expect.stringContaining(`"reason":"${reason}"`) });
  });

  it.each([
    ['a link to a host that is not GitHub', 'https://example.com/o/r/releases/download/v1/Plugin.dll', 'link-host'],
    ['an http link', 'http://github.com/o/r/releases/download/v1/Plugin.dll', 'link-not-https'],
    ['a release page, not its file', 'https://github.com/o/r/releases/tag/v1', 'link-not-asset'],
    ['a link to something that is no plugin', 'https://github.com/o/r/releases/download/v1/setup.exe', 'not-a-plugin'],
    ['something that is no link', 'plugin.dll', 'link-invalid'],
  ])('refuses %s before anything reaches the server', async (_what, url, reason) => {
    const { p, owner } = await tshockPanel({});
    const before = downloads.requests.length;
    const r = await owner.post('/api/servers/tr-tshock/plugins', { url });
    expect([r.statusCode, r.json()]).toEqual([400, { error: 'plugin-refused', reason, message: expect.any(String) }]);
    expect(p.fakes('tr-tshock').agent.calls.filter((c) => c.startsWith('action:'))).toEqual([]);
    expect(downloads.requests.length).toBe(before);
    expect(p.deps.audit.list({ action: 'plugins.add' })[0]).toMatchObject({ ok: false, detail: expect.stringContaining(url) });
  });

  it.each([
    ['sent on to a host GitHub never sends to', 'Elsewhere.dll', 400, 'redirect-refused'],
    ['bigger than 16 MiB', 'Huge.dll', 413, 'too-large'],
    ['a zip with a path outside its folder', 'Escape.zip', 400, 'bad-archive'],
    ['that is no .NET assembly', 'NotAPlugin.dll', 400, 'not-a-plugin'],
  ])('refuses a release download %s, which the agent finds out', async (_what, file, status, reason) => {
    const { owner } = await tshockPanel();
    const r = await owner.post('/api/servers/tr-tshock/plugins', { url: `${rel()}/${file}` });
    expect([r.statusCode, r.json()]).toEqual([status, { error: 'plugin-refused', reason, message: expect.any(String) }]);
    expect((await plugins(owner)).plugins).toEqual([]);
  });

  it('enables, disables and removes, each waiting for a restart while the server runs (the restart badge)', async () => {
    const { p, owner } = await tshockPanel();
    await upload(p, owner, 'tr-tshock', 'HelloPlugin.dll', fakePlugin('HelloPlugin'));
    p.fakes('tr-tshock').feed.status_ = fakeStatus({ state: 'running', installedInfo: { version: '1.4.5.8', channel: 'tshock', build: 'v6.2.1' } });
    expect((await owner.req('PUT', '/api/servers/tr-tshock/plugins/HelloPlugin.dll', { enabled: false })).json()).toEqual({ changed: true, restartNeeded: true });
    expect((await owner.req('PUT', '/api/servers/tr-tshock/plugins/HelloPlugin.dll', { enabled: false })).json()).toEqual({ changed: false, restartNeeded: false });
    expect((await owner.get('/api/servers/tr-tshock/config/pending')).json()).toMatchObject({ reasons: ['Plugins'] });
    expect(await plugins(owner)).toMatchObject({ plugins: [{ name: 'HelloPlugin.dll', enabled: false, active: false }], restartNeeded: false });
    expect((await owner.req('PUT', '/api/servers/tr-tshock/plugins/HelloPlugin.dll', { enabled: true })).json()).toEqual({ changed: true, restartNeeded: true });
    // Enabled since the last start: the server doesn't run it yet.
    expect((await plugins(owner)).restartNeeded).toBe(true);
    expect((await owner.req('DELETE', '/api/servers/tr-tshock/plugins/HelloPlugin.dll')).json()).toEqual({ restartNeeded: true });
    expect((await owner.req('DELETE', '/api/servers/tr-tshock/plugins/HelloPlugin.dll')).json()).toMatchObject({ error: 'plugin-refused', reason: 'not-found' });
    expect((await owner.req('PUT', '/api/servers/tr-tshock/plugins/..%2Fx.dll', { enabled: true })).statusCode).toBe(400);
    expect(p.deps.audit.list({}).filter((e) => e.action.startsWith('plugins.') && e.action !== 'plugins.add').map((e) => [e.action, e.target])).toEqual([
      ['plugins.remove', 'HelloPlugin.dll'],
      ['plugins.enable', 'HelloPlugin.dll'],
      ['plugins.disable', 'HelloPlugin.dll'],
    ]);
  });

  it('is for admins: operators and viewers are refused, and someone without a role on the server finds nothing', async () => {
    const { p, owner } = await tshockPanel();
    const admin = await friend(p, owner, 'ana', 'admin', { 'tr-tshock': 'admin' });
    expect((await upload(p, admin, 'tr-tshock', 'HelloPlugin.dll', fakePlugin('HelloPlugin'))).statusCode).toBe(200);
    const op = await friend(p, owner, 'olga', 'operator', { 'tr-tshock': 'operator' });
    const viewer = await friend(p, owner, 'vera', 'viewer', { 'tr-tshock': 'viewer' });
    const stranger = await friend(p, owner, 'sam', 'admin', null);
    for (const [c, status] of [
      [op, 403],
      [viewer, 403],
      [stranger, 404],
    ] as const) {
      expect((await c.get('/api/servers/tr-tshock/plugins')).statusCode).toBe(status);
      expect((await upload(p, c, 'tr-tshock', 'Other.dll', fakePlugin('Other'))).statusCode).toBe(status);
      expect((await c.post('/api/servers/tr-tshock/plugins', { url: `${rel()}/HelloPlugin.dll` })).statusCode).toBe(status);
      expect((await c.req('PUT', '/api/servers/tr-tshock/plugins/HelloPlugin.dll', { enabled: false })).statusCode).toBe(status);
      expect((await c.req('DELETE', '/api/servers/tr-tshock/plugins/HelloPlugin.dll')).statusCode).toBe(status);
    }
    expect((await plugins(owner)).plugins.map((x) => [x.name, x.enabled])).toEqual([['HelloPlugin.dll', true]]);
  });

  it('keeps plugins out of the text editor, which still refuses .dll files (CFG-08); other flavours have no plugins', async () => {
    const { p, owner } = await tshockPanel();
    await upload(p, owner, 'tr-tshock', 'HelloPlugin.dll', fakePlugin('HelloPlugin'));
    const r = await owner.get(`/api/servers/tr-tshock/config/files/content?id=${encodeURIComponent('path:data/tshock/plugins/HelloPlugin.dll')}`);
    expect(r.json()).toMatchObject({ error: 'not-editable' });
    const files = JSON.stringify((await owner.get('/api/servers/tr-tshock/config/files')).json());
    expect(files).not.toContain('HelloPlugin.dll');
    for (const f of ['vanilla', 'tmodloader']) {
      await create(owner, `tr-${f}`, f);
      expect((await owner.get(`/api/servers/tr-${f}/plugins`)).json()).toEqual({ error: 'capability-unsupported' });
      expect((await owner.post(`/api/servers/tr-${f}/plugins`, { url: `${rel()}/HelloPlugin.dll` })).json()).toEqual({ error: 'capability-unsupported' });
    }
  });
});

// ------------------------------------------------------------------ tModLoader's Workshop mods (MOD-03)

/** Steam's Workshop API for these items (all tModLoader's, app 1281930, unless said). */
function fakeSteam(items: Record<string, { title: string; updated: number; app?: number }>) {
  return (async (_url: string, init?: { body?: URLSearchParams }) => {
    const ids = [...(init!.body as URLSearchParams).entries()].filter(([k]) => k.startsWith('publishedfileids')).map(([, v]) => v);
    return new Response(
      JSON.stringify({
        response: {
          publishedfiledetails: ids.map((id) =>
            items[id] ? { publishedfileid: id, result: 1, title: items[id]!.title, consumer_app_id: items[id]!.app ?? 1281930, time_updated: items[id]!.updated, file_size: 10, hcontent_file: 'x' } : { publishedfileid: id, result: 9 },
          ),
        },
      }),
    );
  }) as unknown as typeof fetch;
}

async function tmlPanel(items: Record<string, { title: string; updated: number; app?: number }>) {
  const p = await makePanel({}, { downloads: { fetch, env: { GAME_TERRARIA_ORG_URL: downloads.url, GAME_TERRARIA_GITHUB_URL: downloads.url } }, mods: { terraria: [createTmlWorkshopSource({ fetch: fakeSteam(items) })] } });
  const { client: owner } = await ownerReady(p);
  expect((await create(owner, 'tr-tml', 'tmodloader')).statusCode).toBe(200);
  const downloaded: string[][] = [];
  // steamcmd's download as the agent's driver makes it: each item's version folders (Recipe Browser's, as measured), or only a newer one.
  realActions(p, 'tr-tml', 'tmodloader', {}, {
    async workshopDownload({ workshopAppId, ids }) {
      downloaded.push(ids);
      for (const id of ids) {
        const item = path.join(roots(p, 'tr-tml').data, '.workshop', 'steamapps', 'workshop', 'content', workshopAppId, id);
        const [name, folders] = id === '2619954303' ? ['RecipeBrowser', ['2022.9', '2025.6', '2025.9', '2026.7']] : ['FromTheFuture', ['2027.1']];
        for (const v of folders) {
          mkdirSync(path.join(item, v), { recursive: true });
          writeFileSync(path.join(item, v, `${name}.tmod`), `${name} ${v}`);
        }
        cpSync(path.join(FIXTURES, 'tmodloader', 'files', 'workshop.json'), path.join(item, 'workshop.json'));
      }
      return { ok: true };
    },
    appUpdate: async () => ({ ok: true }),
    branches: async () => [],
  });
  return { p, owner, downloaded };
}
const enabledJson = (p: TestPanel) => readFileSync(path.join(roots(p, 'tr-tml').data, 'Mods', 'enabled.json'), 'utf8');

describe("tModLoader's Workshop mods through the API (MOD-03)", () => {
  it('adds an item by its link, downloads it on the server, reads the mod the installed tModLoader takes, and writes Mods/enabled.json as tModLoader does', async () => {
    const { p, owner, downloaded } = await tmlPanel({ '2619954303': { title: 'Recipe Browser', updated: 1788581217 } });
    p.fakes('tr-tml').feed.status_ = fakeStatus({ state: 'stopped', installedInfo: { version: '1.4.4.9', channel: 'tmodloader', build: 'v2026.07.3.0' } });
    const r = await owner.post('/api/servers/tr-tml/mods', { refs: ['https://steamcommunity.com/sharedfiles/filedetails/?id=2619954303'] });
    expect(r.json()).toMatchObject({ added: ['2619954303'] });
    await p.deps.servers.get('tr-tml')!.ops.idle();
    expect(downloaded).toEqual([['2619954303']]);
    const mods = (await owner.get('/api/servers/tr-tml/mods')).json() as { items: { title: string; mods: unknown[]; downloaded: boolean }[]; enabled: unknown[]; issues: unknown[] };
    expect(mods.items).toEqual([expect.objectContaining({ title: 'Recipe Browser', downloaded: true, mods: [{ modId: 'RecipeBrowser', name: 'RecipeBrowser', require: [], incompatible: [], compatible: true, reason: null, versionFolder: '2026.7' }] })]);
    expect(mods.enabled).toEqual([{ modId: 'RecipeBrowser', workshopId: '2619954303' }]);
    expect(mods.issues).toEqual([]);
    // Byte for byte what tModLoader itself wrote for the same mod (fixtures/terraria/1.4.5.8/tmodloader/files/enabled.json).
    expect(enabledJson(p)).toBe(readFileSync(path.join(FIXTURES, 'tmodloader', 'files', 'enabled.json'), 'utf8').replace(/\n$/, ''));
    // Disabled: an empty list. The history keeps each list, like any config file the panel writes (the first enabled on arrival by the panel).
    await owner.req('PUT', '/api/servers/tr-tml/mods/enabled', { enabled: [] });
    expect(enabledJson(p)).toBe('[]');
    expect(((await owner.get('/api/servers/tr-tml/config/history?file=tml-mods')).json() as { username: string | null; note: string }[]).map((v) => [v.username, v.note])).toEqual([
      ['alice', 'mod list'],
      [null, 'mod list'],
    ]);
  });

  it("says when an item is built only for a newer tModLoader, and refuses another game's items", async () => {
    const { p, owner } = await tmlPanel({ '3000000001': { title: 'From the future', updated: 1 }, '2544353492': { title: 'A Zomboid mod', updated: 1, app: 108600 } });
    p.fakes('tr-tml').feed.status_ = fakeStatus({ state: 'stopped', installedInfo: { version: '1.4.4.9', channel: 'tmodloader', build: 'v2026.07.3.0' } });
    await owner.post('/api/servers/tr-tml/mods', { refs: ['3000000001'] });
    await p.deps.servers.get('tr-tml')!.ops.idle();
    await owner.req('PUT', '/api/servers/tr-tml/mods/enabled', { enabled: [{ modId: 'FromTheFuture', workshopId: '3000000001' }] });
    expect(((await owner.get('/api/servers/tr-tml/mods')).json() as { issues: unknown[] }).issues).toEqual([{ kind: 'incompatible-version', modId: 'FromTheFuture', reason: 'needs-newer-game' }]);
    expect((await owner.post('/api/servers/tr-tml/mods', { refs: ['2544353492'] })).json()).toMatchObject({ error: 'mod-not-for-game', ids: ['2544353492'] });
  });

  it('checks for updates like any Workshop mod, and downloads what is missing or updated before the next start, since tModLoader reads only its disk', async () => {
    const items = { '2619954303': { title: 'Recipe Browser', updated: 1000 } };
    const { p, owner, downloaded } = await tmlPanel(items);
    await owner.post('/api/servers/tr-tml/mods', { refs: ['2619954303'] });
    const srv = p.deps.servers.get('tr-tml')!;
    await srv.ops.idle();
    expect(((await owner.post('/api/servers/tr-tml/mods/check')).json() as { updates: string[] }).updates).toEqual([]);
    // Up to date and on disk: a start downloads nothing.
    await owner.post('/api/servers/tr-tml/server/start');
    await srv.ops.idle();
    expect(downloaded).toEqual([['2619954303']]);
    // A newer version on Steam: found by the check, downloaded before the next start, then read again.
    items['2619954303'].updated = 2000;
    expect(((await owner.post('/api/servers/tr-tml/mods/check')).json() as { updates: string[] }).updates).toEqual(['2619954303']);
    await owner.post('/api/servers/tr-tml/server/start');
    await srv.ops.idle();
    expect(downloaded).toEqual([['2619954303'], ['2619954303']]);
    expect(((await owner.post('/api/servers/tr-tml/mods/check')).json() as { updates: string[] }).updates).toEqual([]);
    // Restored onto an empty volume (the Workshop cache is never backed up): the enabled item comes back before the start.
    rmSync(path.join(roots(p, 'tr-tml').data, '.workshop'), { recursive: true, force: true });
    await owner.post('/api/servers/tr-tml/server/start');
    await srv.ops.idle();
    expect(downloaded).toHaveLength(3);
    expect(p.fakes('tr-tml').agent.calls.filter((c) => c === `action:${WORKSHOP_DOWNLOAD}` || c === 'start')).toEqual([`action:${WORKSHOP_DOWNLOAD}`, 'start', `action:${WORKSHOP_DOWNLOAD}`, 'start', `action:${WORKSHOP_DOWNLOAD}`, 'start']);
  });

  it('is for the tModLoader flavour only', async () => {
    const { owner } = await tmlPanel({});
    for (const f of ['vanilla', 'tshock']) {
      await create(owner, `tr-${f}`, f);
      expect((await owner.get(`/api/servers/tr-${f}/mods`)).json()).toEqual({ error: 'capability-unsupported' });
    }
  });
});
