import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { INTERNAL_DIR, RootedFiles, type HotCopy } from '../src/rooted';
import { unpack, type TarEntry } from '../src/tar';

/** Every folder the tests made, removed at the end (rmSync never follows a link). */
const made: string[] = [];
afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpRoots() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gsp-archive-'));
  made.push(tmp);
  const data = path.join(tmp, 'data');
  mkdirSync(path.join(data, 'world'), { recursive: true });
  return { tmp, data, install: path.join(tmp, 'install') };
}

function spy(o: { failBefore?: boolean } = {}): HotCopy & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sqlite: ['**/*.db'],
    async before() {
      calls.push('before');
      if (o.failBefore) throw new Error('the game did not save');
    },
    async after() {
      calls.push('after');
    },
  };
}

/** Every entry of a pack, with file contents. */
async function entriesOf(stream: AsyncIterable<Buffer>): Promise<(TarEntry & { data?: Buffer })[]> {
  const out: (TarEntry & { data?: Buffer })[] = [];
  await unpack(stream, async (e) => {
    const entry: TarEntry & { data?: Buffer } = { ...e };
    out.push(entry);
    if (e.type === 'dir') return null;
    const chunks: Buffer[] = [];
    return new Writable({
      write(c: Buffer, _e, cb) {
        chunks.push(c);
        cb();
      },
      final(cb) {
        entry.data = Buffer.concat(chunks);
        cb();
      },
    });
  });
  return out;
}

describe('RootedFiles hidden folders', () => {
  it('never reaches a hidden folder, nor removes, swaps or packs one along with its parent', async () => {
    const { data, install } = tmpRoots();
    const state = path.join(data, 'world', '.state');
    mkdirSync(state);
    writeFileSync(path.join(state, 'secret.json'), '{"token":"x"}');
    writeFileSync(path.join(data, 'world', 'map.bin'), 'map');
    const files = new RootedFiles({ roots: { data, install }, hidden: [state] });
    const code = (p: Promise<unknown>) => p.then(() => 'no error', (e: { code?: string }) => e.code);
    expect(await code(files.read('data', 'world/.state/secret.json'))).toBe('outside-root');
    expect(await code(files.writeAtomic('data', 'world/.state/x', 'x'))).toBe('outside-root');
    expect((await files.list('data', 'world')).map((e) => e.name)).toEqual(['map.bin']);
    expect(await code(files.remove('data', ['world']))).toBe('outside-root');
    expect(await code(files.swap('00000000-0000-4000-8000-000000000000', ['world']))).toBe('outside-root');
    expect(await code(files.stage((async function* () {})(), ['world']))).toBe('outside-root');
    expect((await entriesOf(await files.pack({ root: 'data', rels: ['world'] }))).map((e) => e.name)).toEqual(['world/', 'world/map.bin']);
    // What is next to it is fine.
    await files.remove('data', ['world/map.bin']);
    expect(readdirSync(state)).toEqual(['secret.json']);
  });
});

describe('RootedFiles hot packs', () => {
  it('snapshots the SQLite databases between before and after while the game holds them open', async () => {
    const { tmp, data, install } = tmpRoots();
    const dbFile = path.join(data, 'world', 'players.db');
    const live = new DatabaseSync(dbFile);
    live.exec("CREATE TABLE p (name TEXT); INSERT INTO p VALUES ('rick')");
    writeFileSync(path.join(data, 'world', 'fake.db'), 'not a database');
    writeFileSync(path.join(data, 'world', 'map.bin'), 'map');
    const hot = spy();
    const files = new RootedFiles({ roots: { data, install }, hot: () => hot });
    try {
      const entries = await entriesOf(await files.pack({ root: 'data', rels: ['world'], sqlite: [], prefix: 'data/' }));
      expect(hot.calls).toEqual(['before', 'after']);
      expect(entries.map((e) => e.name)).toEqual(['data/world/', 'data/world/fake.db', 'data/world/map.bin', 'data/world/players.db']);
      // The snapshot is a database of its own, with what the game had committed.
      const copy = path.join(tmp, 'copy.db');
      writeFileSync(copy, entries.find((e) => e.name.endsWith('players.db'))!.data!);
      const db = new DatabaseSync(copy, { readOnly: true });
      expect(db.prepare('SELECT name FROM p').all()).toEqual([{ name: 'rick' }]);
      db.close();
      // A file the glob names that isn't SQLite is copied as it is, with a note.
      const fake = entries.find((e) => e.name.endsWith('fake.db'))!;
      expect(fake.data!.toString()).toBe('not a database');
      expect(fake.meta?.['GSP.warning']).toMatch(/world\/fake\.db: copied as a plain file/);
      expect(entries.find((e) => e.name.endsWith('players.db'))!.meta).toBeUndefined();
      // Snapshots don't outlive the pack.
      expect(readdirSync(path.join(data, INTERNAL_DIR, 'snapshots'))).toEqual([]);
    } finally {
      live.close();
    }
  });

  it('copies plain files, with no hooks, while nothing runs', async () => {
    const { data, install } = tmpRoots();
    writeFileSync(path.join(data, 'world', 'fake.db'), 'not a database');
    const files = new RootedFiles({ roots: { data, install }, hot: () => null });
    const entries = await entriesOf(await files.pack({ root: 'data', rels: ['world/fake.db', 'world', 'missing'], sqlite: ['**/*.db'] }));
    // Paths inside another requested path are packed once; missing ones are skipped.
    expect(entries.map((e) => [e.name, e.meta])).toEqual([
      ['world/', undefined],
      ['world/fake.db', undefined],
    ]);
  });

  it('always runs after, when before fails and when the reader stops early', async () => {
    const { data, install } = tmpRoots();
    writeFileSync(path.join(data, 'world', 'a.bin'), Buffer.alloc(3 << 20, 1));

    const failing = spy({ failBefore: true });
    const files = new RootedFiles({ roots: { data, install }, hot: () => failing });
    await expect(entriesOf(await files.pack({ root: 'data', rels: ['world'] }))).rejects.toThrow('the game did not save');
    expect(failing.calls).toEqual(['before', 'after']);

    const stopped = spy();
    const files2 = new RootedFiles({ roots: { data, install }, hot: () => stopped });
    const stream = (await files2.pack({ root: 'data', rels: ['world'] })) as AsyncGenerator<Buffer>;
    await stream.next();
    await stream.next();
    expect(stopped.calls).toEqual(['before']);
    await stream.return(undefined);
    expect(stopped.calls).toEqual(['before', 'after']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('runs after when a file cannot be read mid-pack', async () => {
    const { data, install } = tmpRoots();
    writeFileSync(path.join(data, 'world', 'a.bin'), 'a');
    mkdirSync(path.join(data, 'world', 'locked'));
    chmodSync(path.join(data, 'world', 'locked'), 0o000);
    const hot = spy();
    const files = new RootedFiles({ roots: { data, install }, hot: () => hot });
    try {
      await expect(entriesOf(await files.pack({ root: 'data', rels: ['world'] }))).rejects.toThrow(/EACCES/);
      expect(hot.calls).toEqual(['before', 'after']);
    } finally {
      chmodSync(path.join(data, 'world', 'locked'), 0o755);
    }
  });

  it.skipIf(process.platform === 'win32')('skips names a restore would refuse, and says so on their folder', async () => {
    const { data, install } = tmpRoots();
    writeFileSync(path.join(data, 'world', 'ok.txt'), 'ok');
    writeFileSync(path.join(data, 'world', 'what?.txt'), 'x');
    const files = new RootedFiles({ roots: { data, install } });
    const entries = await entriesOf(await files.pack({ root: 'data', rels: ['world'] }));
    expect(entries.map((e) => e.name)).toEqual(['world/', 'world/ok.txt']);
    expect(entries[0]!.meta?.['GSP.warning']).toMatch(/skipped 1 name/);
  });
});
