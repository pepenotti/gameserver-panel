import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { iniToRecord, parseIni } from '@pz/formats';
import { Client, fakeStatus, makePanel, ownerReady, type TestPanel } from './harness';

function seed(p: TestPanel) {
  const d = p.deps.env.pzDataDir;
  mkdirSync(path.join(d, 'Saves', 'Multiplayer', 'zomboid'), { recursive: true });
  writeFileSync(path.join(d, 'Saves', 'Multiplayer', 'zomboid', 'map_t.bin'), 'world');
  mkdirSync(path.join(d, 'db'), { recursive: true });
  writeFileSync(path.join(d, 'db', 'zomboid.db'), 'accounts');
  mkdirSync(path.join(d, 'Server'), { recursive: true });
  writeFileSync(path.join(d, 'Server', 'zomboid.ini'), 'PublicName=Mi server\nResetID=1\nSeed=abc\nMods=\\A\n');
  writeFileSync(path.join(d, 'Server', 'zomboid_SandboxVars.lua'), 'SandboxVars = {\n    Zombies = 4,\n}\n');
}
const exists = (p: TestPanel, rel: string) => existsSync(path.join(p.deps.env.pzDataDir, rel));
const ini = (p: TestPanel) => iniToRecord(parseIni(readFileSync(path.join(p.deps.env.pzDataDir, 'Server', 'zomboid.ini'), 'utf8')));

async function setup() {
  const p = await makePanel();
  seed(p);
  const { client } = await ownerReady(p);
  return { p, c: client };
}

describe('reset', () => {
  it('requires typing the server name', async () => {
    const { c } = await setup();
    expect((await c.post('/api/reset', { scope: 'world', confirm: 'zombie' })).json()).toEqual({ error: 'confirm-mismatch' });
  });

  it('world: new world with a backup first, keeps accounts and settings, bumps ResetID', async () => {
    const { p, c } = await setup();
    expect((await c.post('/api/reset', { scope: 'world', confirm: 'zomboid', newSeed: true })).statusCode).toBe(200);
    await p.deps.ops.idle();
    expect(p.deps.bus.currentOp()).toMatchObject({ kind: 'reset', ok: true });
    expect(exists(p, 'Saves/Multiplayer/zomboid')).toBe(false);
    expect(exists(p, 'db/zomboid.db')).toBe(true);
    const v = ini(p);
    expect(v.PublicName).toBe('Mi server');
    expect(v.Mods).toBe('\\A');
    expect(v.ResetID).not.toBe('1');
    expect(v.Seed).toMatch(/^[A-Za-z]{16}$/);
    const pre = p.deps.backups.list().filter((b) => b.manifest.trigger === 'pre-reset');
    expect(pre).toHaveLength(1);
    expect(pre[0]!.manifest.parts).toEqual(['world', 'accounts', 'configs']);
  });

  it('full: also wipes accounts; factory: also settings, then first-run defaults', async () => {
    const { p, c } = await setup();
    await c.post('/api/reset', { scope: 'full', confirm: 'zomboid' });
    await p.deps.ops.idle();
    expect(exists(p, 'db/zomboid.db')).toBe(false);
    expect(ini(p).PublicName).toBe('Mi server');

    seed(p);
    await c.post('/api/reset', { scope: 'factory', confirm: 'zomboid' });
    await p.deps.ops.idle();
    expect(ini(p)).toEqual({ SaveWorldEveryMinutes: '10' });
    expect(exists(p, 'Server/zomboid_SandboxVars.lua')).toBe(false);
  });

  it('stops and restarts a running server around the reset', async () => {
    const { p, c } = await setup();
    p.feed.status_ = fakeStatus({ state: 'running', players: { count: 0, names: [], at: '' } });
    await c.post('/api/reset', { scope: 'world', confirm: 'zomboid' });
    await p.deps.ops.idle();
    expect(p.agent.calls.filter((x) => x === 'stop' || x === 'start')).toEqual(['stop', 'start']);
  });

  it('aborts without deleting anything when the safety backup fails', async () => {
    const { p, c } = await setup();
    // A file where the backup folder should be makes the backup impossible.
    mkdirSync(path.dirname(p.deps.env.backupDir), { recursive: true });
    writeFileSync(p.deps.env.backupDir, 'not a folder');
    await c.post('/api/reset', { scope: 'world', confirm: 'zomboid' });
    await p.deps.ops.idle();
    expect(p.deps.bus.currentOp()).toMatchObject({ ok: false });
    expect(exists(p, 'Saves/Multiplayer/zomboid/map_t.bin')).toBe(true);
  });

  it('keeps full and factory resets for the owner', async () => {
    const { p, c } = await setup();
    await c.post('/api/users', { username: 'adm', password: 'Temporal-12345', role: 'admin' });
    // An admin who finished 2FA enrolment.
    const { totpCode } = await import('./harness');
    const a = new Client(p.app);
    await a.post('/api/auth/login', { username: 'adm', password: 'Temporal-12345' });
    await a.post('/api/auth/password', { current: 'Temporal-12345', next: 'Admin-propio-2026' });
    const s = (await a.post('/api/auth/totp/setup')).json() as { secret: string };
    await a.post('/api/auth/totp/enable', { code: totpCode(s.secret, 0) });
    expect((await a.post('/api/reset', { scope: 'full', confirm: 'zomboid' })).statusCode).toBe(403);
    expect((await a.post('/api/reset', { scope: 'factory', confirm: 'zomboid' })).statusCode).toBe(403);
    expect((await a.post('/api/reset', { scope: 'world', confirm: 'zomboid' })).statusCode).toBe(200);
    await p.deps.ops.idle();
  });
});
