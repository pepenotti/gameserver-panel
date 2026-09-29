// TShock's plugins (MOD-06): the runtime's actions next to the files (add by
// upload or by a release link the agent downloads itself, with every
// address checked and the size capped; enable, disable, remove), the copy
// into ServerPlugins before each start, and the panel half's first checks.
// The fake download services stand in for GitHub (a release download
// redirects to the asset host), the fake TShock server loads what was copied.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PluginAdded, PluginFile, PluginReply, ServerCtx } from '@gsp/adapter-api';
import { fakeAssembly, fakePlugin, makeZip, startFakeDownloads, type FakeDownloads } from '../../../tools/fake-terraria/downloads.mjs';
import { tshockPlugins } from '../src/panel';
import { terrariaRuntimeAdapter as tr } from '../src/runtime';
import { INSTALL_MARKER, parseTerrariaLaunch, PLUGIN_ACTIONS, PLUGINS, pluginDownloadAllowed, pluginLinkRefusal, RELEASES, type InstallMarker } from '../src/shared';
import { freePort, testCtx, TIME_SCALE, type TestCtx } from './helpers';

let downloads: FakeDownloads;
beforeAll(async () => {
  downloads = await startFakeDownloads();
});
afterAll(async () => {
  await downloads.close();
});

let ctx: TestCtx | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

const p = parseTerrariaLaunch({ flavour: 'tshock', world: 'w', worldSize: 1, maxPlayers: 8, memoryMb: 2048 });
const act = <T extends object>(c: TestCtx, name: string, input: unknown) => tr.actions![name]!.run(c, null, tr.actions![name]!.parse(input)) as Promise<PluginReply<T>>;
const add = (c: TestCtx, input: unknown) => act<PluginAdded>(c, PLUGIN_ACTIONS.add, input);
const list = async (c: TestCtx) => {
  const r = await act<{ plugins: PluginFile[] }>(c, PLUGIN_ACTIONS.list, {});
  if (!r.ok) throw new Error(r.message);
  return r.plugins.map((f) => [f.name, f.enabled, f.active]);
};
const rel = () => `${downloads.url}/gspff/HelloPlugin/releases/download/v1.0.0`;
/** The agent's environment, with the release host pointed at the fake. */
const envFake = () => ({ [RELEASES.env]: downloads.url, GAME_FLAVOUR: 'tshock' });
const data = (c: TestCtx, ...p: string[]) => path.join(c.roots.data, ...p);

/** An upload as the panel leaves it for the agent. */
function upload(c: TestCtx, bytes: Buffer, ext: 'dll' | 'zip'): string {
  const name = `up-${Math.random().toString(36).slice(2)}.${ext}`;
  mkdirSync(data(c, ...PLUGINS.uploads.split('/')), { recursive: true });
  writeFileSync(data(c, ...PLUGINS.uploads.split('/'), name), bytes);
  return name;
}

/** TShock as installed, with its own plugin in ServerPlugins. */
function installTshock(c: TestCtx): string {
  const folder = path.join(c.roots.install, 'tshock-v6.2.1');
  mkdirSync(path.join(folder, 'ServerPlugins'), { recursive: true });
  writeFileSync(path.join(folder, 'TShock.Server'), '');
  writeFileSync(path.join(folder, 'ServerPlugins', 'TShockAPI.dll'), 'FAKE TShockAPI 6.2.1\n');
  const marker: InstallMarker = { schema: 1, flavour: 'tshock', version: 'v6.2.1', terraria: '1.4.5.8', channel: 'stable', folder: 'tshock-v6.2.1', sha256: '0'.repeat(64), verified: true, installedAt: '2026-09-29T00:00:00.000Z' };
  writeFileSync(path.join(c.roots.install, INSTALL_MARKER), JSON.stringify(marker));
  return path.join(folder, 'ServerPlugins');
}

describe('adding plugins by upload (MOD-06)', () => {
  it('takes a .dll, and a zip of them leaving out what is no plugin; a name already there is replaced and keeps its state', async () => {
    const c = (ctx = testCtx({ env: { GAME_FLAVOUR: 'tshock' } }));
    const one = await add(c, { upload: upload(c, fakePlugin('HelloPlugin'), 'dll'), name: 'HelloPlugin.dll' });
    expect(one).toMatchObject({ ok: true, added: [{ name: 'HelloPlugin.dll', enabled: true, active: false, size: fakePlugin('HelloPlugin').length }], replaced: [], skipped: [] });
    expect(existsSync(data(c, 'tshock', 'plugins', 'HelloPlugin.dll'))).toBe(true);
    await act(c, PLUGIN_ACTIONS.set, { name: 'HelloPlugin.dll', enabled: false });
    const zip = makeZip([{ name: 'ServerPlugins/', data: '' }, { name: 'ServerPlugins/helloplugin.dll', data: fakePlugin('HelloPlugin', '2.0.0') }, { name: 'ServerPlugins/HelloLib.dll', data: fakeAssembly('HelloLib') }, { name: 'README.md', data: 'x' }, { name: 'HelloPlugin.pdb', data: 'x' }]);
    const two = await add(c, { upload: upload(c, zip, 'zip'), name: 'Hello 2.0.zip' });
    expect(two).toMatchObject({ ok: true, replaced: ['helloplugin.dll'], skipped: ['HelloPlugin.pdb', 'README.md'] });
    // The replacement stayed disabled (under its new spelling); the new one is enabled.
    expect(await list(c)).toEqual([
      ['HelloLib.dll', true, false],
      ['helloplugin.dll', false, false],
    ]);
    // Uploads never stay behind.
    expect(readdirSync(data(c, ...PLUGINS.uploads.split('/')))).toEqual([]);
  });

  it.each([
    ['a file that is no plugin nor zip', () => ({ bytes: Buffer.from('hello'), ext: 'dll' as const, name: 'notes.txt' }), 'not-a-plugin'],
    ['a .dll that is no .NET assembly', () => ({ bytes: Buffer.from('garbage, not MZ'), ext: 'dll' as const, name: 'Broken.dll' }), 'not-a-plugin'],
    ['a zip with a path outside its folder', () => ({ bytes: makeZip([{ name: '../Escape.dll', data: fakePlugin('Escape') }]), ext: 'zip' as const, name: 'escape.zip' }), 'bad-archive'],
    ['a zip with a link', () => ({ bytes: makeZip([{ name: 'Link.dll', data: '/etc/passwd', mode: 0o120777 }], { unix: true }), ext: 'zip' as const, name: 'link.zip' }), 'bad-archive'],
    ['a zip without a plugin', () => ({ bytes: makeZip([{ name: 'README.md', data: 'x' }]), ext: 'zip' as const, name: 'docs.zip' }), 'no-plugins'],
    ['an upload over 16 MiB', () => ({ bytes: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(16 * 1024 * 1024 - 1)]), ext: 'dll' as const, name: 'Big.dll' }), 'too-large'],
    ['a zip with more entries than allowed', () => ({ bytes: makeZip([{ name: 'A.dll', data: fakePlugin('A') }, ...Array.from({ length: 1000 }, (_, i) => ({ name: `lang/${i}.txt`, data: '' }))]), ext: 'zip' as const, name: 'many.zip' }), 'too-large'],
    ['a zip with the same plugin twice', () => ({ bytes: makeZip([{ name: 'a/X.dll', data: fakePlugin('X') }, { name: 'b/x.dll', data: fakePlugin('X') }]), ext: 'zip' as const, name: 'twice.zip' }), 'bad-archive'],
    ['a plugin with an unusual name', () => ({ bytes: fakePlugin('Y'), ext: 'dll' as const, name: 'my plugin.dll' }), 'bad-name'],
  ])('refuses %s, changing nothing', async (_what, make, reason) => {
    const c = (ctx = testCtx({ env: { GAME_FLAVOUR: 'tshock' } }));
    const u = make();
    const r = await add(c, { upload: upload(c, u.bytes, u.ext), name: u.name });
    expect(r).toMatchObject({ ok: false, reason });
    expect(await list(c)).toEqual([]);
    expect(existsSync(path.join(c.roots.data, '..', 'Escape.dll'))).toBe(false);
    expect(readdirSync(data(c, ...PLUGINS.uploads.split('/')))).toEqual([]);
  });

  it("refuses a plugin named like one of TShock's own, and plugins on a server of another flavour", async () => {
    const c = (ctx = testCtx({ env: { GAME_FLAVOUR: 'tshock' } }));
    installTshock(c);
    expect(await add(c, { upload: upload(c, fakePlugin('TShockAPI'), 'dll'), name: 'tshockapi.dll' })).toMatchObject({ ok: false, reason: 'name-taken' });
    const v = (ctx = testCtx({ env: { GAME_FLAVOUR: 'vanilla' } }));
    expect(await add(v, { upload: upload(v, fakePlugin('A'), 'dll'), name: 'A.dll' })).toMatchObject({ ok: false, reason: 'not-supported' });
    expect(await act(v, PLUGIN_ACTIONS.list, {})).toMatchObject({ ok: false, reason: 'not-supported' });
    c.cleanup();
  });

  it('refuses inputs no panel sends: uploads outside their folder, names with paths', () => {
    const parse = (name: string, x: unknown) => () => tr.actions![name]!.parse(x);
    expect(parse(PLUGIN_ACTIONS.add, { upload: '../../etc/passwd', name: 'x.dll' })).toThrow();
    expect(parse(PLUGIN_ACTIONS.add, { upload: 'a/b.dll', name: 'x.dll' })).toThrow();
    expect(parse(PLUGIN_ACTIONS.set, { name: '../x.dll', enabled: true })).toThrow();
    expect(parse(PLUGIN_ACTIONS.remove, { name: 'x.exe' })).toThrow();
  });
});

describe('adding plugins by release link, downloaded by the agent (MOD-06, D11)', () => {
  it('downloads a GitHub release asset through its redirect to the asset host, and a latest link too', async () => {
    const c = (ctx = testCtx({ env: envFake() }));
    expect(await add(c, { url: `${rel()}/HelloPlugin.dll` })).toMatchObject({ ok: true, added: [{ name: 'HelloPlugin.dll', enabled: true }] });
    expect(await add(c, { url: `${downloads.url}/gspff/HelloPlugin/releases/latest/download/HelloPlugins.zip` })).toMatchObject({ ok: true, replaced: ['HelloPlugin.dll'], skipped: ['README.md'] });
    expect((await list(c)).map((x) => x[0])).toEqual(['HelloLib.dll', 'HelloPlugin.dll']);
    expect(readFileSync(data(c, 'tshock', 'plugins', 'HelloPlugin.dll')).equals(fakePlugin('HelloPlugin', '1.1.0'))).toBe(true);
  });

  it.each([
    ['sent on to another host', 'Elsewhere.dll', 'redirect-refused'],
    ['bigger than 16 MiB', 'Huge.dll', 'too-large'],
    ['with a path outside its folder', 'Escape.zip', 'bad-archive'],
    ['no .NET assembly', 'NotAPlugin.dll', 'not-a-plugin'],
    ['of another kind of file', 'Notes.txt', 'not-a-plugin'],
    ['that is not there', 'Nope.dll', 'download-failed'],
  ])('refuses one %s', async (_what, file, reason) => {
    const c = (ctx = testCtx({ env: envFake() }));
    expect(await add(c, { url: `${rel()}/${file}` })).toMatchObject({ ok: false, reason });
    expect(await list(c)).toEqual([]);
  });

  it('asks nothing of a host that is not the release host', async () => {
    const c = (ctx = testCtx({ env: { GAME_FLAVOUR: 'tshock' } }));
    const before = downloads.requests.length;
    // Without the override: only https://github.com — the fake is neither.
    expect(await add(c, { url: `${rel()}/HelloPlugin.dll` })).toMatchObject({ ok: false, reason: 'link-not-https' });
    expect(await add(c, { url: 'https://example.com/o/r/releases/download/v1/A.dll' })).toMatchObject({ ok: false, reason: 'link-host' });
    expect(downloads.requests.length).toBe(before);
  });
});

describe('release links (MOD-06)', () => {
  const none = {};
  it.each([
    ['https://github.com/Pryaxis/Plugins/releases/download/v1.0/Plugin.dll', null],
    ['https://github.com/o/r/releases/latest/download/Plugins.zip', null],
    ['https://github.com/o/r/releases/download/v1.0/My%20Plugin.dll', 'bad-name'],
    ['http://github.com/o/r/releases/download/v1/A.dll', 'link-not-https'],
    ['https://github.com:8443/o/r/releases/download/v1/A.dll', 'link-host'],
    // A link carrying a user name and password.
    [Object.assign(new URL('https://github.com/o/r/releases/download/v1/A.dll'), { username: 'user', password: 'pw' }).href, 'link-host'],
    ['https://raw.githubusercontent.com/o/r/main/A.dll', 'link-host'],
    ['https://release-assets.githubusercontent.com/github-production-release-asset/1/2?x=y', 'link-host'],
    ['https://evil.example/o/r/releases/download/v1/A.dll', 'link-host'],
    ['https://github.com.evil.example/o/r/releases/download/v1/A.dll', 'link-host'],
    ['https://github.com/o/r/releases/tag/v1.0', 'link-not-asset'],
    ['https://github.com/o/r', 'link-not-asset'],
    ['https://github.com/o/r/archive/refs/tags/v1.zip', 'link-not-asset'],
    ['https://github.com/o/r/releases/download/v1/setup.exe', 'not-a-plugin'],
    ['ftp://github.com/o/r/releases/download/v1/A.dll', 'link-not-https'],
    ['not a link', 'link-invalid'],
  ])('%s → %s', (url, refusal) => {
    expect(pluginLinkRefusal(url, none)).toBe(refusal);
  });

  it('lets a download go to github.com release paths and GitHub’s asset host, over HTTPS, and nowhere else', () => {
    const ok = pluginDownloadAllowed({});
    expect(ok(new URL('https://github.com/o/r/releases/download/v1/A.dll'))).toBe(true);
    expect(ok(new URL('https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r'))).toBe(true);
    for (const u of ['http://release-assets.githubusercontent.com/x', 'https://github.com/o/r/archive/main.zip', 'https://evil.example/x', 'https://release-assets.githubusercontent.com:444/x', 'https://127.0.0.1/x']) expect(ok(new URL(u)), u).toBe(false);
    // The override (tests, the dev loop): its origin only.
    const fake = pluginDownloadAllowed({ [RELEASES.env]: 'http://127.0.0.1:9' });
    expect(fake(new URL('http://127.0.0.1:9/anything'))).toBe(true);
    expect(fake(new URL('http://localhost:9/anything'))).toBe(false);
    expect(fake(new URL('https://github.com/o/r/releases/download/v1/A.dll'))).toBe(false);
  });
});

describe('enable, disable, remove (MOD-06)', () => {
  it('moves a plugin between enabled and disabled, removes it, and says when there is none', async () => {
    const c = (ctx = testCtx({ env: { GAME_FLAVOUR: 'tshock' } }));
    await add(c, { upload: upload(c, fakePlugin('A'), 'dll'), name: 'A.dll' });
    expect(await act(c, PLUGIN_ACTIONS.set, { name: 'a.dll', enabled: false })).toEqual({ ok: true, changed: true });
    expect(await act(c, PLUGIN_ACTIONS.set, { name: 'A.dll', enabled: false })).toEqual({ ok: true, changed: false });
    expect(existsSync(data(c, 'tshock', 'plugins', 'disabled', 'A.dll'))).toBe(true);
    expect(await act(c, PLUGIN_ACTIONS.set, { name: 'A.dll', enabled: true })).toEqual({ ok: true, changed: true });
    expect(await act(c, PLUGIN_ACTIONS.remove, { name: 'A.dll' })).toEqual({ ok: true });
    expect(await act(c, PLUGIN_ACTIONS.remove, { name: 'A.dll' })).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await act(c, PLUGIN_ACTIONS.set, { name: 'B.dll', enabled: true })).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await list(c)).toEqual([]);
  });
});

describe('before every start: the enabled plugins in ServerPlugins (MOD-06)', () => {
  it("copies the enabled ones, removes its own that are no longer enabled, never touches TShock's, and knows what the server runs with", async () => {
    const c = (ctx = testCtx({ env: { GAME_FLAVOUR: 'tshock' } }));
    const sp = installTshock(c);
    await add(c, { upload: upload(c, fakePlugin('A'), 'dll'), name: 'A.dll' });
    await add(c, { upload: upload(c, fakePlugin('B'), 'dll'), name: 'B.dll' });
    await act(c, PLUGIN_ACTIONS.set, { name: 'B.dll', enabled: false });
    await tr.prepare(c, p);
    expect(readdirSync(sp).filter((f) => !f.startsWith('.')).sort()).toEqual(['A.dll', 'TShockAPI.dll']);
    expect(await list(c)).toEqual([
      ['A.dll', true, true],
      ['B.dll', false, false],
    ]);
    // Enabled, disabled or replaced since: the badge until the next start.
    await act(c, PLUGIN_ACTIONS.set, { name: 'B.dll', enabled: true });
    await act(c, PLUGIN_ACTIONS.set, { name: 'A.dll', enabled: false });
    expect(await list(c)).toEqual([
      ['A.dll', false, true],
      ['B.dll', true, false],
    ]);
    await tr.prepare(c, p);
    expect(readdirSync(sp).filter((f) => !f.startsWith('.')).sort()).toEqual(['B.dll', 'TShockAPI.dll']);
    expect(await list(c)).toEqual([
      ['A.dll', false, false],
      ['B.dll', true, true],
    ]);
    expect(readFileSync(path.join(sp, 'TShockAPI.dll'), 'utf8')).toBe('FAKE TShockAPI 6.2.1\n');
  });

  it('copies them again after an update replaced the install folder, and a plugin with TShock’s own name is left out with a log line', async () => {
    const c = (ctx = testCtx({ env: { GAME_FLAVOUR: 'tshock' } }));
    installTshock(c);
    await add(c, { upload: upload(c, fakePlugin('A'), 'dll'), name: 'A.dll' });
    // A plugin put there by hand with TShock's own name (the add refuses one while TShock is installed).
    writeFileSync(data(c, 'tshock', 'plugins', 'TShockAPI.dll'), fakePlugin('Impostor'));
    await tr.prepare(c, p);
    // An update: the whole install folder is replaced.
    rmSync(path.join(c.roots.install, 'tshock-v6.2.1'), { recursive: true });
    const sp = installTshock(c);
    expect(readdirSync(sp)).toEqual(['TShockAPI.dll']);
    await tr.prepare(c, p);
    expect(readdirSync(sp).filter((f) => !f.startsWith('.')).sort()).toEqual(['A.dll', 'TShockAPI.dll']);
    expect(readFileSync(path.join(sp, 'TShockAPI.dll'), 'utf8')).toBe('FAKE TShockAPI 6.2.1\n');
    expect(c.logs.some((l) => /TShockAPI\.dll was not copied: TShock's own install has a plugin of that name/.test(l))).toBe(true);
  });

  it('the fake TShock loads what was copied: the load line for the plugin, nothing for an assembly that is none', async () => {
    const c = (ctx = testCtx({ env: { GAME_FLAVOUR: 'tshock' }, ports: { game: await freePort(), rest: await freePort() } }));
    installTshock(c);
    await add(c, { upload: upload(c, makeZip([{ name: 'HelloPlugin.dll', data: fakePlugin('HelloPlugin', '1.1.0') }, { name: 'HelloLib.dll', data: fakeAssembly('HelloLib') }]), 'zip'), name: 'hello.zip' });
    await tr.prepare(c, p);
    const cmd = tr.command(c, p);
    const out: string[] = [];
    const child: ChildProcess = spawn(cmd.argv[0]!, cmd.argv.slice(1), { cwd: cmd.cwd, env: { ...process.env, ...cmd.env, GAME_INSTALL_DIR: c.roots.install, FAKE_TERRARIA_BOOT_MS: '30' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout!.on('data', (d: Buffer) => out.push(...d.toString('utf8').split('\n').map((l) => tr.classify(l).message)));
    try {
      const end = Date.now() + 20_000 * TIME_SCALE;
      while (!out.includes('Server started') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      expect(out.filter((l) => l.startsWith('[Server API] Info Plugin '))).toEqual(['[Server API] Info Plugin TShock v6.2.1.0 (by The TShock Team) initiated.', '[Server API] Info Plugin HelloPlugin v1.1.0 (by gspff) initiated.']);
    } finally {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
  });
});

describe('the panel half (MOD-06)', () => {
  /** A server whose agent answers the plugin actions with `answer`. */
  function srvCtx(answer: (name: string, input: unknown) => unknown): ServerCtx & { calls: [string, unknown][] } {
    const calls: [string, unknown][] = [];
    return { calls, action: async (name: string, input: unknown) => (calls.push([name, input]), answer(name, input)) } as unknown as ServerCtx & { calls: [string, unknown][] };
  }

  it('says what a plugin is before one is added, in both languages, and takes .dll files of up to 16 MiB', () => {
    expect(tshockPlugins).toMatchObject({ id: 'tshock-plugins', capability: 'mods:tshock', extensions: ['.dll'], maxBytes: 16 * 1024 * 1024, uploadDir: '.gsp-uploads/plugins' });
    expect(tshockPlugins.warning.en).toMatch(/runs its own code inside this server/);
    expect(tshockPlugins.warning.es).toMatch(/ejecuta su propio código dentro de este servidor/);
    expect(tshockPlugins.checkLink('https://github.com/o/r/releases/download/v1/A.dll', {})).toBeNull();
    expect(tshockPlugins.checkLink('https://evil.example/A.dll', {})).toBe('link-host');
  });

  it('passes adds and changes to the runtime’s actions, refusing bad names and links without them', async () => {
    const ctx2 = srvCtx(() => ({ ok: true, changed: true }));
    expect(await tshockPlugins.setEnabled(ctx2, 'A.dll', false)).toEqual({ ok: true, changed: true });
    expect(await tshockPlugins.setEnabled(ctx2, '../A.dll', false)).toMatchObject({ ok: false, reason: 'bad-name' });
    expect(await tshockPlugins.remove(ctx2, 'A.exe')).toMatchObject({ ok: false, reason: 'bad-name' });
    expect(await tshockPlugins.add(ctx2, { url: 'javascript:alert(1)' })).toMatchObject({ ok: false, reason: 'link-invalid' });
    expect(await tshockPlugins.add(ctx2, { upload: '../x.dll', name: 'x.dll' })).toMatchObject({ ok: false, reason: 'bad-name' });
    await tshockPlugins.add(ctx2, { url: 'https://github.com/o/r/releases/download/v1/A.dll' });
    await tshockPlugins.add(ctx2, { upload: 'abc.zip', name: 'Mine.zip' });
    expect(ctx2.calls).toEqual([
      [PLUGIN_ACTIONS.set, { name: 'A.dll', enabled: false }],
      [PLUGIN_ACTIONS.add, { url: 'https://github.com/o/r/releases/download/v1/A.dll' }],
      [PLUGIN_ACTIONS.add, { upload: 'abc.zip', name: 'Mine.zip' }],
    ]);
    await expect(tshockPlugins.list(srvCtx(() => undefined))).rejects.toThrow(/Unexpected reply/);
  });
});
