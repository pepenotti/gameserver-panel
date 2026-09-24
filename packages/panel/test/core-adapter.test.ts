import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Capability } from '@gsp/adapter-api';
import { globToRegExp } from '../src/backups/glob';
import { unpack } from '../src/backups/tar';
import { Client, makePanel, ownerReady, type TestPanel } from './harness';

async function asRole(p: TestPanel, owner: Client, role: 'viewer' | 'operator') {
  await owner.post('/api/users', { username: `u-${role}`, password: 'Temporal-12345', role });
  const c = new Client(p.app);
  await c.post('/api/auth/login', { username: `u-${role}`, password: 'Temporal-12345' });
  await c.post('/api/auth/password', { current: 'Temporal-12345', next: 'Propia-clave-2026' });
  return c;
}

/** The same adapter without some capabilities. */
function without(p: TestPanel, ...caps: Capability[]): void {
  const a = p.deps.adapter;
  p.deps.adapter = { ...a, meta: { ...a.meta, capabilities: a.meta.capabilities.filter((c) => !caps.includes(c)) } };
}

describe('capability guard', () => {
  it('answers 409 capability-unsupported for what the game lacks, after the permission check', async () => {
    const p = await makePanel();
    const { client: c } = await ownerReady(p);
    without(p, 'kick', 'broadcast', 'updateCheck');

    const kick = await c.post('/api/players/kick', { username: 'rick' });
    expect(kick.statusCode).toBe(409);
    expect(kick.json()).toEqual({ error: 'capability-unsupported', capability: 'kick' });
    expect((await c.post('/api/server/broadcast', { message: 'hola' })).json()).toMatchObject({ error: 'capability-unsupported' });
    expect((await c.get('/api/server/updates')).statusCode).toBe(409);
    // Nothing reached the game.
    expect(p.agent.calls).toEqual([]);

    // What the game still supports works.
    expect((await c.post('/api/players/ban', { username: 'rick' })).statusCode).toBe(200);
    // Permissions come first: someone who may not kick learns nothing about the game.
    const viewer = await asRole(p, c, 'viewer');
    expect((await viewer.post('/api/players/kick', { username: 'rick' })).statusCode).toBe(403);
  });

  it('refuses mods when the game has no mod source', async () => {
    const p = await makePanel({}, { mods: [] });
    const { client: c } = await ownerReady(p);
    expect((await c.get('/api/mods')).json()).toMatchObject({ error: 'capability-unsupported' });
    expect((await c.post('/api/mods', { refs: ['2544353492'] })).statusCode).toBe(409);
  });
});

describe('GET /api/meta', () => {
  it("describes the server's adapter to any signed-in user", async () => {
    const p = await makePanel();
    const { client: c } = await ownerReady(p);
    const m = (await c.get('/api/meta')).json() as {
      adapter: { id: string; name: { en: string } };
      server: { gameName: string };
      capabilities: string[];
      launch: { schema: { key: string }[]; secrets: { key: string; label: { en: string } }[] };
      backupParts: { id: string; label: { en: string; es: string } }[];
      resets: { id: string; permission: string; removeParts: string[] }[];
      accessLevels: string[];
      modSources: { id: string; capability: string }[];
      consoleCatalog: { name: string }[];
    };
    expect(m.adapter).toMatchObject({ id: 'pz', name: { en: 'Project Zomboid' } });
    expect(m.server).toEqual({ id: 'default', gameName: 'zomboid', flavour: null });
    expect(m.capabilities).toEqual(expect.arrayContaining(['kick', 'ban', 'whitelist', 'broadcast', 'mods:workshop', 'updateCheck']));
    expect(m.launch.schema.map((o) => o.key)).toEqual(['memoryMb', 'branch', 'updateOnStart']);
    // Which secrets the server needs, never their values.
    expect(m.launch.secrets).toEqual([{ key: 'adminPassword', label: expect.objectContaining({ en: expect.any(String) }) }]);
    expect(JSON.stringify(m)).not.toContain('AdminPw-123456');
    expect(m.backupParts.map((x) => x.id)).toEqual(['world', 'accounts', 'configs']);
    expect(m.resets).toEqual([
      expect.objectContaining({ id: 'world', permission: 'reset.world', removeParts: ['world'] }),
      expect.objectContaining({ id: 'full', permission: 'reset.full', removeParts: ['world', 'accounts'] }),
      expect.objectContaining({ id: 'factory', permission: 'reset.factory', removeParts: ['world', 'accounts', 'configs'] }),
    ]);
    expect(m.accessLevels).toEqual(['none', 'observer', 'gm', 'overseer', 'moderator', 'admin']);
    expect(m.modSources).toEqual([expect.objectContaining({ id: 'workshop', capability: 'mods:workshop' })]);
    expect(m.consoleCatalog.map((x) => x.name)).toContain('servermsg');

    const viewer = await asRole(p, c, 'viewer');
    expect((await viewer.get('/api/meta')).statusCode).toBe(200);
    expect((await new Client(p.app).get('/api/meta')).statusCode).toBe(401);
  });

  it('follows the adapter: a capability it drops is gone', async () => {
    const p = await makePanel();
    const { client: c } = await ownerReady(p);
    without(p, 'kick');
    expect(((await c.get('/api/meta')).json() as { capabilities: string[] }).capabilities).not.toContain('kick');
  });
});

describe('backup globs', () => {
  it('keeps * and ? inside a folder and lets ** span folders', () => {
    const db = globToRegExp('**/*.db');
    expect(['x.db', 'db/zomboid.db', 'Saves/Multiplayer/zomboid/players.db'].every((s) => db.test(s))).toBe(true);
    expect(['x.db-journal', 'x.dbx', 'db/x.db/y'].some((s) => db.test(s))).toBe(false);
    expect(globToRegExp('*.db').test('db/x.db')).toBe(false);
    expect(globToRegExp('Server/?.ini').test('Server/a.ini')).toBe(true);
    expect(globToRegExp('Server/?.ini').test('Server/ab.ini')).toBe(false);
    // Regex characters are literal.
    expect(globToRegExp('a+(b).txt').test('a+(b).txt')).toBe(true);
    expect(globToRegExp('a+(b).txt').test('aa(b)xtxt')).toBe(false);
  });
});

describe('backups never follow links', () => {
  it('skips symbolic links inside the data folder instead of archiving what they point at', async () => {
    const p = await makePanel();
    const world = path.join(p.deps.env.pzDataDir, 'Saves', 'Multiplayer', 'zomboid');
    mkdirSync(world, { recursive: true });
    writeFileSync(path.join(world, 'map_t.bin'), 'world');
    // Something outside the data folder a mod might try to make the panel copy.
    const outside = mkdtempSync(path.join(os.tmpdir(), 'gsp-outside-'));
    writeFileSync(path.join(outside, 'secret.txt'), 'not for backups');
    // A junction needs no privileges on Windows; elsewhere it is a plain symlink.
    symlinkSync(outside, path.join(world, 'linked-dir'), 'junction');
    let fileLink = true;
    try {
      symlinkSync(path.join(outside, 'secret.txt'), path.join(world, 'linked-file.txt'), 'file');
    } catch {
      // Windows without symlink rights: the directory link still proves it.
      fileLink = false;
    }

    const b = await p.deps.backups.create({ trigger: 'manual', hot: false });
    const names: string[] = [];
    const src = new PassThrough();
    src.end(zstdDecompressSync(readFileSync(path.join(p.deps.env.backupDir, b.name))));
    await unpack(src, async (e) => {
      names.push(e.name);
      return null;
    });
    expect(names).toContain('data/Saves/Multiplayer/zomboid/map_t.bin');
    expect(names.filter((n) => n.includes('linked') || n.includes('secret'))).toEqual([]);
    expect(b.manifest.files).toBe(1);
    if (fileLink) expect(names).not.toContain('data/Saves/Multiplayer/zomboid/linked-file.txt');
  });
});
