import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { END_OF_ARCHIVE, headerFor, TarError, TarPacker, unpack, type TarEntry } from '../src/tar';

async function packToBuffer(fill: (t: TarPacker) => Promise<void>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(c: Buffer, _e, cb) {
      chunks.push(c);
      cb();
    },
  });
  const t = new TarPacker(sink);
  await fill(t);
  await t.finish();
  return Buffer.concat(chunks);
}

async function unpackAll(buf: Buffer | AsyncIterable<Buffer>): Promise<{ files: Record<string, string>; entries: TarEntry[] }> {
  const files: Record<string, string> = {};
  const entries: TarEntry[] = [];
  let src: AsyncIterable<Buffer>;
  if (Buffer.isBuffer(buf)) {
    const pt = new PassThrough();
    pt.end(buf);
    src = pt;
  } else src = buf;
  await unpack(src, async (e) => {
    entries.push(e);
    if (e.type === 'dir') {
      files[e.name] = '<dir>';
      return null;
    }
    const chunks: Buffer[] = [];
    return new Writable({
      write(c: Buffer, _e, cb) {
        chunks.push(c);
        cb();
      },
      final(cb) {
        files[e.name] = Buffer.concat(chunks).toString('utf8');
        cb();
      },
    });
  });
  return { files, entries };
}

function withType(type: string): Buffer {
  const h = headerFor({ name: 'evil', type: 'file', size: 0, mode: 0o644, mtime: 0 });
  h.write(type, 156);
  // Recompute the checksum so only the type is "wrong".
  h.write('        ', 148);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

describe('tar', () => {
  it('round-trips files, directories, long and non-ASCII names', async () => {
    const long = `data/Saves/Multiplayer/srv/${'chunk_'.repeat(30)}ñandú.bin`;
    const buf = await packToBuffer(async (t) => {
      await t.addDir('data/Saves/', 0);
      await t.addBuffer('manifest.json', Buffer.from('{"a":1}'), 0);
      await t.addBuffer(long, Buffer.from('x'.repeat(1025)), 0);
      await t.addBuffer('data/empty', Buffer.alloc(0), 0);
      const sink = await t.addFile('data/streamed.bin', 700, 0);
      sink.write(Buffer.alloc(300, 0x61));
      sink.end(Buffer.alloc(400, 0x62));
      await new Promise((r) => sink.on('finish', r));
    });
    expect((await unpackAll(buf)).files).toEqual({
      'data/Saves/': '<dir>',
      'manifest.json': '{"a":1}',
      [long]: 'x'.repeat(1025),
      'data/empty': '',
      'data/streamed.bin': `${'a'.repeat(300)}${'b'.repeat(400)}`,
    });
  });

  it('carries notes about an entry in GSP PAX records, and nothing else', async () => {
    const buf = Buffer.concat([
      headerFor({ name: 'data/x.db', type: 'file', size: 0, mode: 0o644, mtime: 0, meta: { 'GSP.warning': 'copied\nas a plain file', 'not-ours': 'x' } }),
      headerFor({ name: 'data/y', type: 'file', size: 0, mode: 0o644, mtime: 0 }),
      END_OF_ARCHIVE,
    ]);
    const { entries } = await unpackAll(buf);
    expect(entries.map((e) => [e.name, e.meta])).toEqual([
      ['data/x.db', { 'GSP.warning': 'copied as a plain file' }],
      ['data/y', undefined],
    ]);
  });

  it('refuses links, devices and corrupt or truncated archives', async () => {
    for (const type of ['1', '2', '3', '4', '6']) {
      await expect(unpackAll(Buffer.concat([withType(type), END_OF_ARCHIVE])), type).rejects.toThrow(`Unsupported entry type "${type}"`);
    }
    const good = headerFor({ name: 'evil', type: 'file', size: 0, mode: 0o644, mtime: 0 });
    const corrupt = Buffer.from(good);
    corrupt[0] = 0x41;
    await expect(unpackAll(Buffer.concat([corrupt, END_OF_ARCHIVE]))).rejects.toThrow(TarError);
    await expect(unpackAll(good)).rejects.toThrow(/Truncated/);
    const withData = headerFor({ name: 'f', type: 'file', size: 2000, mode: 0o644, mtime: 0 });
    await expect(unpackAll(Buffer.concat([withData, Buffer.alloc(100)]))).rejects.toThrow(/Truncated/);
  });

  it('reads its input to the end, and leaves it alone on an error', async () => {
    let finished = false;
    async function* producer() {
      yield await packToBuffer(async (t) => t.addBuffer('a', Buffer.from('1'), 0));
      // Whoever produces the archive gets to finish cleanly (a hot copy's `after`).
      finished = true;
    }
    await unpackAll(producer());
    expect(finished).toBe(true);

    // On an error the input stays open: an HTTP request body must still be readable for the error reply.
    let returned = false;
    const chunks = [headerFor({ name: 'd', type: 'dir', size: 0, mode: 0o755, mtime: 0 }), withType('2')];
    const input: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => (chunks.length ? { done: false, value: chunks.shift()! } : { done: true, value: undefined }),
        return: async () => {
          returned = true;
          return { done: true, value: undefined };
        },
      }),
    };
    await expect(unpack(input, async () => null)).rejects.toThrow(/Unsupported/);
    expect(returned).toBe(false);
  });

  it('stops at a sink that fails instead of writing past it', async () => {
    const buf = await packToBuffer(async (t) => t.addBuffer('big', Buffer.alloc(200_000, 1), 0));
    const pt = new PassThrough();
    pt.end(buf);
    const failing = unpack(pt, async () => {
      return new Writable({
        highWaterMark: 1,
        write(_c, _e, cb) {
          cb(new Error('disk full'));
        },
      });
    });
    await expect(failing).rejects.toThrow('disk full');
  });
});
