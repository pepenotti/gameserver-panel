import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalServerFiles, ServerFilesError } from '../src/files/local';
import { Client, makePanel, ownerReady } from './harness';

function setup() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gsp-files-'));
  const data = path.join(tmp, 'data');
  const install = path.join(tmp, 'install');
  mkdirSync(data, { recursive: true });
  mkdirSync(install, { recursive: true });
  return { tmp, data, install, files: new LocalServerFiles({ data, install }) };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof ServerFilesError ? e.code : `other: ${(e as Error).message}`;
  }
  return 'no error';
};

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

  it('refuses paths that are absolute, climb out or hide separators', async () => {
    const { files } = setup();
    for (const rel of ['../x', 'a/../../x', '/etc/passwd', 'C:/Windows/win.ini', 'c:x', 'a\\b', 'a\0b', '..']) {
      expect(await code(files.read('data', rel)), rel).toBe('invalid-path');
      expect(await code(files.writeAtomic('data', rel, 'x')), rel).toBe('invalid-path');
    }
    expect(await code(files.writeAtomic('data', '', 'x'))).toBe('invalid-path');
    expect(await code(files.remove('data', ['.']))).toBe('invalid-path');
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

describe('file routes (reserved)', () => {
  it('answer 501 to admins and stay behind sign-in', async () => {
    const p = await makePanel();
    const anon = new Client(p.app);
    expect((await anon.get('/api/files')).statusCode).toBe(401);
    const { client } = await ownerReady(p);
    for (const url of ['/api/files', '/api/files/data/Server/zomboid.ini']) {
      const r = await client.get(url);
      expect(r.statusCode).toBe(501);
      expect(r.json()).toEqual({ error: 'not-implemented' });
    }
    expect((await client.req('PUT', '/api/files/data/x', { text: 'y' })).statusCode).toBe(501);
  });
});
