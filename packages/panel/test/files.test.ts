import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EditableRoot } from '@gsp/adapter-api';
import type { EditableFolder, TreeEntry } from '../src/config/store';
import { LocalServerFiles, ServerFilesError } from '../src/files/local';
import { decodeText, editableFolderOf, globToRegExp, MAX_TEXT_BYTES, nameReason, textProblem } from '../src/files/policy';
import { Client, makePanel, ownerReady } from './harness';

function setup() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gsp-files-'));
  const data = path.join(tmp, 'data');
  const install = path.join(tmp, 'install');
  mkdirSync(data, { recursive: true });
  mkdirSync(install, { recursive: true });
  return { tmp, data, install, files: new LocalServerFiles({ data, install }) };
}

const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return e instanceof ServerFilesError ? e.code : `other: ${(e as Error).message}`;
  }
  return 'no error';
};

/** A file symlink needs admin rights or developer mode on Windows; null when it can't be made here. */
function tryFileSymlink(target: string, at: string): boolean {
  try {
    symlinkSync(target, at, 'file');
    return true;
  } catch (e) {
    if (process.platform === 'win32' && (e as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw e;
  }
}

describe('LocalServerFiles', () => {
  it('writes atomically, reads, stats, lists and removes inside a root', async () => {
    const { data, files } = setup();
    await files.writeAtomic('data', 'Server/zomboid.ini', 'PVP=true\n');
    expect(readFileSync(path.join(data, 'Server', 'zomboid.ini'), 'utf8')).toBe('PVP=true\n');
    expect((await files.read('data', 'Server/zomboid.ini'))!.toString('utf8')).toBe('PVP=true\n');
    expect(await files.stat('data', 'Server/zomboid.ini')).toMatchObject({ kind: 'file', size: 9 });
    expect(await files.stat('data', 'Server')).toMatchObject({ kind: 'dir' });

    await files.writeAtomic('data', 'Server/a.lua', Buffer.from('x'));
    expect((await files.list('data', 'Server')).map((e) => [e.name, e.kind])).toEqual([
      ['a.lua', 'file'],
      ['zomboid.ini', 'file'],
    ]);
    // No temporary files left behind.
    expect((await files.list('data', 'Server')).length).toBe(2);

    await files.remove('data', ['Server/a.lua', 'Server/missing.txt']);
    expect(await files.stat('data', 'Server/a.lua')).toBeNull();
    await files.remove('data', ['Server']);
    expect(await files.list('data', '')).toEqual([]);
  });

  it('answers null or empty for what is not there', async () => {
    const { files } = setup();
    expect(await files.read('data', 'nope.txt')).toBeNull();
    expect(await files.stat('data', 'nope.txt')).toBeNull();
    expect(await files.list('data', 'nope')).toEqual([]);
  });

  it('keeps the roots apart and knows only its roots', async () => {
    const { install, files } = setup();
    writeFileSync(path.join(install, 'start-server.sh'), '#!/bin/sh\n');
    expect(await files.stat('install', 'start-server.sh')).toMatchObject({ kind: 'file' });
    expect(await files.stat('data', 'start-server.sh')).toBeNull();
    expect(await code(files.stat('backups', 'x'))).toBe('unknown-root');
  });

  it('refuses paths that are absolute, climb out or hide separators (CFG-08)', async () => {
    const { files } = setup();
    for (const rel of ['../x', 'a/../../x', '/etc/passwd', 'C:/Windows/win.ini', 'c:x', 'a\\b', 'a\0b', '..', 'a\nb']) {
      expect(await code(files.read('data', rel)), rel).toBe('invalid-path');
      expect(await code(files.writeAtomic('data', rel, 'x')), rel).toBe('invalid-path');
    }
    expect(await code(files.writeAtomic('data', '', 'x'))).toBe('invalid-path');
    expect(await code(files.remove('data', ['.']))).toBe('invalid-path');
  });

  it('refuses names Windows would open as another file', async () => {
    const { files } = setup();
    for (const rel of ['Server/a.ini:secret', 'Server/evil.lua.', 'Server/evil.lua ', 'NUL', 'Server/con.txt', 'a|b', 'a?b']) {
      expect(await code(files.writeAtomic('data', rel, 'x')), rel).toBe('invalid-path');
    }
  });

  it('refuses a symlink that leads out of the root', async () => {
    const { tmp, data, files } = setup();
    const outside = path.join(tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'no');
    // A junction on Windows (no admin rights needed); an ordinary symlink elsewhere.
    symlinkSync(outside, path.join(data, 'mods'), 'junction');
    expect(await code(files.read('data', 'mods/secret.txt'))).toBe('outside-root');
    expect(await code(files.writeAtomic('data', 'mods/new.txt', 'x'))).toBe('outside-root');
    expect(await code(files.list('data', 'mods'))).toBe('outside-root');
    // Listing the folder that holds it shows it as a link, without following it.
    expect((await files.list('data', '')).map((e) => [e.name, e.kind])).toEqual([['mods', 'symlink']]);
  });

  it('refuses symlinks even when they point inside the root (no links anywhere)', async () => {
    const { data, files } = setup();
    mkdirSync(path.join(data, 'real'));
    writeFileSync(path.join(data, 'real', 'a.txt'), 'a');
    symlinkSync(path.join(data, 'real'), path.join(data, 'alias'), 'junction');
    expect(await code(files.read('data', 'alias/a.txt'))).toBe('outside-root');
    expect((await files.read('data', 'real/a.txt'))!.toString()).toBe('a');
  });

  it('refuses a file symlink (skipped where the OS cannot make one without admin rights)', async (ctx) => {
    const { tmp, data, files } = setup();
    writeFileSync(path.join(tmp, 'secret.txt'), 'no');
    if (!tryFileSymlink(path.join(tmp, 'secret.txt'), path.join(data, 'link.txt'))) {
      ctx.skip('Windows needs admin rights or developer mode for file symlinks; the junction tests cover links here');
      return;
    }
    expect(await code(files.read('data', 'link.txt'))).toBe('outside-root');
    expect(await code(files.writeAtomic('data', 'link.txt', 'mine'))).toBe('outside-root');
    expect(readFileSync(path.join(tmp, 'secret.txt'), 'utf8')).toBe('no');
    expect(await code(files.stat('data', 'link.txt'))).toBe('outside-root');
    expect((await files.list('data', '')).map((e) => [e.name, e.kind])).toEqual([['link.txt', 'symlink']]);
  });

  it('caps reads and refuses to read folders', async () => {
    const { files } = setup();
    await files.writeAtomic('data', 'big.txt', 'x'.repeat(100));
    expect(await code(files.read('data', 'big.txt', { maxBytes: 99 }))).toBe('too-large');
    expect((await files.read('data', 'big.txt', { maxBytes: 100 }))!.length).toBe(100);
    await files.writeAtomic('data', 'dir/f.txt', 'x');
    expect(await code(files.read('data', 'dir'))).toBe('not-a-file');
    expect(await code(files.list('data', 'big.txt'))).toBe('not-a-dir');
  });

  it('does not archive or stage yet', async () => {
    const { files } = setup();
    await expect(files.pack({ root: 'data', rels: ['Server'] })).rejects.toThrow(/not implemented/);
    await expect(files.purgeTrash()).rejects.toThrow(/not implemented/);
  });
});

describe('editor policy (CFG-08)', () => {
  const folders: EditableRoot[] = [
    { id: 'server', root: 'data', rel: 'Server', include: ['*'], exclude: ['*.bak'], label: { en: 'Server', es: 'Servidor' } },
    { id: 'mods', root: 'data', rel: 'Lua', include: ['**/*.ini', '**/*.json'], exclude: ['cache/**'], label: { en: 'Mods', es: 'Mods' } },
  ];

  it('matches globs: * stays in a folder, ** crosses folders', () => {
    expect(globToRegExp('*.ini').test('a.ini')).toBe(true);
    expect(globToRegExp('*.ini').test('x/a.ini')).toBe(false);
    expect(globToRegExp('**/*.ini').test('a.ini')).toBe(true);
    expect(globToRegExp('**/*.ini').test('x/y/a.ini')).toBe(true);
    expect(globToRegExp('a?c.(1)').test('abc.(1)')).toBe(true);
  });

  it('finds the editable folder of a file, honouring include and exclude globs', () => {
    expect(editableFolderOf(folders, 'data', 'Server/zomboid.ini')?.id).toBe('server');
    expect(editableFolderOf(folders, 'data', 'Server/zomboid.ini.bak')).toBeNull();
    expect(editableFolderOf(folders, 'data', 'Server/sub/x.ini')).toBeNull();
    expect(editableFolderOf(folders, 'data', 'Lua/mod/settings.json')?.id).toBe('mods');
    expect(editableFolderOf(folders, 'data', 'Lua/cache/settings.json')).toBeNull();
    expect(editableFolderOf(folders, 'data', 'Lua/notes.txt')).toBeNull();
    expect(editableFolderOf(folders, 'data', 'Saves/players.db')).toBeNull();
    expect(editableFolderOf(folders, 'install', 'Server/zomboid.ini')).toBeNull();
    expect(editableFolderOf(folders, 'data', 'ServerX/zomboid.ini')).toBeNull();
  });

  it('never edits binaries, scripts or the install, and Lua only when declared data-only', () => {
    for (const f of ['mods/a.jar', 'x.DLL', 'lib.so', 'tool.exe']) expect(nameReason('data', f), f).toBe('binary');
    for (const f of ['start.sh', 'run.bat', 'x.ps1', 'x.py', 'x.js', 'x.mjs', 'Server/other.lua']) expect(nameReason('data', f), f).toBe('script');
    expect(nameReason('data', 'Server/zomboid_SandboxVars.lua', { dataOnly: true })).toBeNull();
    expect(nameReason('data', 'Server/zomboid.ini')).toBeNull();
    expect(nameReason('install', 'media/x.ini')).toBe('install-root');
  });

  it('takes text only: no NUL bytes, valid UTF-8, at most 1 MiB', () => {
    expect(decodeText(Buffer.from('PVP=true ñ'))).toEqual({ text: 'PVP=true ñ' });
    expect(decodeText(Buffer.from([0x50, 0x00, 0x51]))).toEqual({ reason: 'binary' });
    expect(decodeText(Buffer.from([0xc3, 0x28]))).toEqual({ reason: 'not-utf8' });
    expect(decodeText(Buffer.alloc(MAX_TEXT_BYTES + 1, 0x41))).toEqual({ reason: 'too-large' });
    const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x41]);
    expect((decodeText(bom) as { text: string }).text.length).toBe(2);
    expect(textProblem('a\0b')).toBe('binary');
    expect(textProblem('x'.repeat(MAX_TEXT_BYTES + 1))).toBe('too-large');
    expect(textProblem('ok')).toBeNull();
  });
});

const fixtures = fileURLToPath(new URL('../../../fixtures/pz/b42/config/', import.meta.url));

/** A panel whose server folder holds the captured files plus the kinds of files the editor must refuse. */
async function editor() {
  const p = await makePanel();
  const data = p.deps.env.pzDataDir;
  const server = path.join(data, 'Server');
  mkdirSync(path.join(data, 'Lua', 'mymod'), { recursive: true });
  mkdirSync(server, { recursive: true });
  copyFileSync(path.join(fixtures, 'server.en.ini'), path.join(server, 'zomboid.ini'));
  copyFileSync(path.join(fixtures, 'SandboxVars.en.lua'), path.join(server, 'zomboid_SandboxVars.lua'));
  writeFileSync(path.join(server, 'zomboid_notes.txt'), 'remember to wipe in March\n');
  writeFileSync(path.join(server, 'zomboid_extra.lua'), 'print("I run as code")\n');
  writeFileSync(path.join(server, 'zomboid_plugin.jar'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
  writeFileSync(path.join(server, 'zomboid_blob.txt'), Buffer.from([0x41, 0x00, 0x42]));
  writeFileSync(path.join(server, 'zomboid_latin1.txt'), Buffer.from([0x61, 0xf1, 0x62]));
  writeFileSync(path.join(server, 'zomboid_huge.txt'), 'x'.repeat(MAX_TEXT_BYTES + 1));
  writeFileSync(path.join(server, 'other-server.ini'), 'PVP=true\n');
  writeFileSync(path.join(data, 'Lua', 'mymod', 'settings.json'), '{\n  "reward": 5\n}\n');
  writeFileSync(path.join(data, 'Lua', 'mymod', 'code.lua'), 'return {}\n');
  const { client } = await ownerReady(p);
  return { p, c: client, data, server };
}

const find = (entries: TreeEntry[], name: string): TreeEntry | undefined => {
  for (const e of entries) {
    if (e.name === name) return e;
    const hit = e.children && find(e.children, name);
    if (hit) return hit;
  }
  return undefined;
};

describe('text editor API (CFG-07, CFG-08)', () => {
  it('lists the declared files and the editable folders, each file editable or not with a reason', async () => {
    const { c } = await editor();
    const r = (await c.get('/api/config/files')).json() as { files: { id: string; exists: boolean; editable: boolean; reason: string | null; highlight: string }[]; folders: EditableFolder[] };
    expect(r.files.map((f) => [f.id, f.exists, f.editable, f.reason, f.highlight])).toEqual([
      ['ini', true, true, null, 'properties'],
      ['sandbox', true, true, null, 'lua'],
      ['spawnregions', false, false, 'missing', 'lua'],
      ['spawnpoints', false, false, 'missing', 'lua'],
    ]);
    const [server, mods] = r.folders;
    expect(server!.entries.map((e) => [e.name, e.id, e.editable, e.reason])).toEqual([
      ['zomboid.ini', 'ini', true, null],
      ['zomboid_SandboxVars.lua', 'sandbox', true, null],
      ['zomboid_blob.txt', 'path:data/Server/zomboid_blob.txt', true, null],
      ['zomboid_extra.lua', 'path:data/Server/zomboid_extra.lua', false, 'script'],
      ['zomboid_huge.txt', 'path:data/Server/zomboid_huge.txt', false, 'too-large'],
      ['zomboid_latin1.txt', 'path:data/Server/zomboid_latin1.txt', true, null],
      ['zomboid_notes.txt', 'path:data/Server/zomboid_notes.txt', true, null],
      ['zomboid_plugin.jar', 'path:data/Server/zomboid_plugin.jar', false, 'binary'],
    ]);
    // Another server's file and a mod's code are not offered at all.
    expect(find(server!.entries, 'other-server.ini')).toBeUndefined();
    expect(find(mods!.entries, 'settings.json')).toMatchObject({ id: 'path:data/Lua/mymod/settings.json', editable: true });
    expect(find(mods!.entries, 'code.lua')).toBeUndefined();
    expect(mods!.label).toEqual({ en: 'Mod settings', es: 'Ajustes de mods' });
  });

  it('opens and saves a file of an editable folder through a proposal, with its history', async () => {
    const { p, c, data } = await editor();
    const id = 'path:data/Lua/mymod/settings.json';
    const content = (await c.get(`/api/config/files/content?id=${id}`)).json() as { text: string; sha256: string; format: string; highlight: string; readonlyReason: null };
    expect(content).toMatchObject({ text: '{\n  "reward": 5\n}\n', format: 'json', highlight: 'json', readonlyReason: null });
    const bad = await c.post('/api/config/proposals', { fileId: id, text: '{\n  "reward": 5,\n}\n', baseSha256: content.sha256 });
    expect(bad.json()).toEqual({ error: 'invalid-file', issues: [{ line: 3, col: 1, message: 'Trailing comma before "}"' }] });
    const ok = (await c.post('/api/config/proposals', { fileId: id, text: '{\n  "reward": 10\n}\n', baseSha256: content.sha256 })).json() as { id: string; applies: string };
    expect(ok.applies).toBe('restart');
    await c.post(`/api/config/proposals/${ok.id}/apply`);
    expect(readFileSync(path.join(data, 'Lua', 'mymod', 'settings.json'), 'utf8')).toBe('{\n  "reward": 10\n}\n');
    expect(p.deps.config.historyOf(id).map((h) => h.note)).toEqual(['changed reward', 'on disk before this change']);
    expect((await c.get(`/api/config/history?file=${id}`)).json()).toHaveLength(2);
    // A declared file's path means that file, with its rules and history.
    expect((await c.get('/api/config/files/content?id=path:data/Server/zomboid.ini')).json()).toMatchObject({ id: 'ini', managedKeys: expect.arrayContaining(['RCONPassword']) });
  });

  it('refuses paths that climb out, are absolute or outside the editable folders', async () => {
    const { c } = await editor();
    for (const [id, error] of [
      ['path:data/Lua/../Server/zomboid.ini', 'invalid-path'],
      ['path:data/Server/../../etc/passwd', 'invalid-path'],
      ['path:data//etc/passwd', 'invalid-path'],
      ['path:data/C:/Windows/win.ini', 'invalid-path'],
      ['path:data/Server/zomboid.ini:stream', 'invalid-path'],
      ['path:data/Saves/Multiplayer/zomboid/players.db', 'not-editable'],
      ['path:install/media/lua/shared/Sandbox/Apocalypse.lua', 'not-editable'],
      ['path:backups/x.txt', 'not-editable'],
      ['nope', 'unknown-file'],
    ] as const) {
      expect((await c.get(`/api/config/files/content?id=${encodeURIComponent(id)}`)).json(), id).toMatchObject({ error });
      expect((await c.post('/api/config/proposals', { fileId: id, text: 'x' })).json(), id).toMatchObject({ error });
    }
  });

  it('never opens or saves binaries, and shows scripts read-only', async () => {
    const { c } = await editor();
    const get = async (name: string) => (await c.get(`/api/config/files/content?id=path:data/Server/${name}`)).json() as { error?: string; reason?: string; readonlyReason?: string; text?: string };
    expect(await get('zomboid_plugin.jar')).toEqual({ error: 'not-editable', reason: 'binary' });
    expect(await get('zomboid_blob.txt')).toEqual({ error: 'not-editable', reason: 'binary' });
    expect(await get('zomboid_latin1.txt')).toEqual({ error: 'not-editable', reason: 'not-utf8' });
    expect(await get('zomboid_huge.txt')).toEqual({ error: 'not-editable', reason: 'too-large' });
    expect(await get('zomboid_extra.lua')).toMatchObject({ readonlyReason: 'script', text: 'print("I run as code")\n' });
    for (const name of ['zomboid_plugin.jar', 'zomboid_extra.lua']) {
      expect((await c.post('/api/config/proposals', { fileId: `path:data/Server/${name}`, text: 'x' })).json(), name).toEqual({ error: 'not-editable', reason: name.endsWith('.jar') ? 'binary' : 'script' });
    }
  });

  it('refuses text with NUL bytes and text over 1 MiB', async () => {
    const { c } = await editor();
    const id = 'path:data/Server/zomboid_notes.txt';
    expect((await c.post('/api/config/proposals', { fileId: id, text: 'line one\nnul \0 here' })).json()).toMatchObject({ error: 'invalid-file', issues: [{ line: 2 }] });
    // Under the character limit, over the byte limit.
    const big = await c.post('/api/config/proposals', { fileId: id, text: 'ñ'.repeat(MAX_TEXT_BYTES / 2 + 1) });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual({ error: 'too-large' });
  });

  it('refuses a folder link that leads out of the server folder', async () => {
    const { c, data } = await editor();
    const outside = mkdtempSync(path.join(os.tmpdir(), 'gsp-outside-'));
    writeFileSync(path.join(outside, 'secret.ini'), 'Token=abc\n');
    symlinkSync(outside, path.join(data, 'Lua', 'linked'), 'junction');
    const id = 'path:data/Lua/linked/secret.ini';
    expect((await c.get(`/api/config/files/content?id=${encodeURIComponent(id)}`)).json()).toEqual({ error: 'not-editable', reason: 'symlink' });
    expect((await c.post('/api/config/proposals', { fileId: id, text: 'Token=pwned\n' })).json()).toEqual({ error: 'not-editable', reason: 'symlink' });
    expect(readFileSync(path.join(outside, 'secret.ini'), 'utf8')).toBe('Token=abc\n');
    const tree = (await c.get('/api/config/files')).json() as { folders: EditableFolder[] };
    expect(find(tree.folders[1]!.entries, 'secret.ini')).toBeUndefined();
  });

  it('is admin-only and behind sign-in', async () => {
    const p = await makePanel();
    const anon = new Client(p.app);
    expect((await anon.get('/api/config/files')).statusCode).toBe(401);
    expect((await anon.get('/api/config/files/content?id=ini')).statusCode).toBe(401);
    // The reserved routes of the first draft are gone.
    const { client } = await ownerReady(p);
    expect((await client.get('/api/files')).statusCode).toBe(404);
  });
});
