// The ServerFiles contract (D11, CFG-08, BAK-03), run against both
// implementations: LocalServerFiles (the panel's tests and dev loop) and
// AgentServerFiles over the real agent's routes on an ephemeral port. What
// one answers, the other must answer too.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeAdapter, ServerFiles } from '@gsp/adapter-api';
import { closeIterable, headerFor, INTERNAL_DIR, READ_MAX_BYTES, ServerFilesError, TarPacker, unpack } from '@gsp/archive';
import { FS_WRITE_MAX_BYTES } from '@gsp/shared';
import { createAgentServer } from '../../agent/src/http';
import { envelope, makeHarness, TIME_SCALE, type Harness } from '../../agent/test/helpers';
import { AgentCallError } from '../src/agent/client';
import { AgentServerFiles } from '../src/files/agent';
import { LocalServerFiles } from '../src/files/local';

interface Subject {
  files: ServerFiles;
  data: string;
  install: string;
  /** A folder outside every root. */
  outside: string;
  cleanup(): Promise<void>;
}

async function agentSubject(adapter?: (a: RuntimeAdapter) => RuntimeAdapter): Promise<Subject & { h: Harness }> {
  const h = await makeHarness({}, { adapter });
  const data = h.cfg.dataDir!;
  const install = h.cfg.installDir!;
  mkdirSync(data, { recursive: true });
  mkdirSync(install, { recursive: true });
  const outside = path.join(h.dir, 'outside');
  mkdirSync(outside);
  const server: http.Server = createAgentServer(h.agent, h.hub, h.cfg.token);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const files = new AgentServerFiles({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: h.cfg.token });
  return {
    h,
    files,
    data,
    install,
    outside,
    async cleanup() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await h.cleanup();
    },
  };
}

const SUBJECTS: [string, () => Promise<Subject>][] = [
  [
    'LocalServerFiles',
    async () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'gsp-files-'));
      const [data, install, outside] = ['data', 'install', 'outside'].map((d) => path.join(tmp, d)) as [string, string, string];
      for (const d of [data, install, outside]) mkdirSync(d);
      return { files: new LocalServerFiles({ data, install }), data, install, outside, cleanup: async () => rmSync(tmp, { recursive: true, force: true }) };
    },
  ],
  ['AgentServerFiles', () => agentSubject()],
];

/** The refusal's code, or what else happened. */
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof ServerFilesError ? e.code : `other: ${(e as Error).message}`;
  }
  return 'no error';
};

/** A file symlink needs admin rights or developer mode on Windows; false when it can't be made here. */
function tryFileSymlink(target: string, at: string): boolean {
  try {
    symlinkSync(target, at, 'file');
    return true;
  } catch (e) {
    if (process.platform === 'win32' && (e as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw e;
  }
}

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

async function* once(buf: Buffer): AsyncGenerator<Buffer> {
  yield buf;
}

async function tarNames(stream: AsyncIterable<Buffer>): Promise<string[]> {
  const out: string[] = [];
  await unpack(stream, async (e) => {
    out.push(e.name);
    return null;
  });
  return out;
}

async function tarOf(fill: (t: TarPacker) => Promise<void>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const t = new TarPacker(
    new Writable({
      write(c: Buffer, _e, cb) {
        chunks.push(c);
        cb();
      },
    }),
  );
  await fill(t);
  await t.finish();
  return Buffer.concat(chunks);
}

const text = (s: Subject, rel: string) => readFileSync(path.join(s.data, rel), 'utf8');
const stagingLeft = (s: Subject) => (existsSync(path.join(s.data, INTERNAL_DIR, 'staging')) ? readdirSync(path.join(s.data, INTERNAL_DIR, 'staging')) : []);

describe.each(SUBJECTS)('ServerFiles contract: %s', (_name, make) => {
  let s: Subject;
  beforeEach(async () => {
    s = await make();
  });
  afterEach(async () => {
    await s.cleanup();
  });

  it('writes atomically, reads, stats, lists and removes inside a root', async () => {
    const { files, data } = s;
    await files.writeAtomic('data', 'Server/srv.ini', 'PVP=true\n');
    expect(readFileSync(path.join(data, 'Server', 'srv.ini'), 'utf8')).toBe('PVP=true\n');
    expect((await files.read('data', 'Server/srv.ini'))!.toString('utf8')).toBe('PVP=true\n');
    expect(await files.stat('data', 'Server/srv.ini')).toMatchObject({ kind: 'file', size: 9 });
    expect(await files.stat('data', 'Server')).toMatchObject({ kind: 'dir' });
    await files.writeAtomic('data', 'Server/a.lua', Buffer.from('x'));
    // Sorted by name, and no temporary files left behind.
    expect((await files.list('data', 'Server')).map((e) => [e.name, e.kind])).toEqual([
      ['a.lua', 'file'],
      ['srv.ini', 'file'],
    ]);
    await files.writeAtomic('data', 'Server/srv.ini', 'PVP=false\n');
    expect((await files.read('data', 'Server/srv.ini'))!.toString()).toBe('PVP=false\n');
    await files.remove('data', ['Server/a.lua', 'Server/missing.txt']);
    expect(await files.stat('data', 'Server/a.lua')).toBeNull();
    await files.remove('data', ['Server']);
    expect(await files.list('data', '')).toEqual([]);
  });

  it('answers null or empty for what is not there', async () => {
    const { files } = s;
    expect(await files.read('data', 'nope.txt')).toBeNull();
    expect(await files.read('data', 'nope/deeper.txt')).toBeNull();
    expect(await files.stat('data', 'nope.txt')).toBeNull();
    expect(await files.list('data', 'nope')).toEqual([]);
  });

  it('keeps the roots apart, knows only its roots, and never writes the install', async () => {
    const { files, install } = s;
    writeFileSync(path.join(install, 'start-server.sh'), '#!/bin/sh\n');
    expect(await files.stat('install', 'start-server.sh')).toMatchObject({ kind: 'file' });
    expect(await files.stat('data', 'start-server.sh')).toBeNull();
    expect(await code(files.stat('backups', 'x'))).toBe('unknown-root');
    expect(await code(files.stat('constructor', 'x'))).toBe('unknown-root');
    expect(await code(files.writeAtomic('install', 'start-server.sh', 'rm -rf /'))).toBe('outside-root');
    expect(await code(files.remove('install', ['start-server.sh']))).toBe('outside-root');
    expect(readFileSync(path.join(install, 'start-server.sh'), 'utf8')).toBe('#!/bin/sh\n');
  });

  it('refuses paths that are absolute, climb out or hide separators (CFG-08)', async () => {
    const { files } = s;
    for (const rel of ['../x', 'a/../../x', '/etc/passwd', 'C:/Windows/win.ini', 'c:x', 'a\\b', 'a\0b', '..', 'a\nb']) {
      expect(await code(files.read('data', rel)), rel).toBe('invalid-path');
      expect(await code(files.writeAtomic('data', rel, 'x')), rel).toBe('invalid-path');
      expect(await code(files.list('data', rel)), rel).toBe('invalid-path');
    }
    expect(await code(files.writeAtomic('data', '', 'x'))).toBe('invalid-path');
    expect(await code(files.remove('data', ['.']))).toBe('invalid-path');
    expect(await code(files.pack({ root: 'data', rels: ['../..'] }))).toBe('invalid-path');
  });

  it('refuses names Windows would open as another file', async () => {
    const { files } = s;
    for (const rel of ['Server/a.ini:secret', 'Server/evil.lua.', 'Server/evil.lua ', 'NUL', 'Server/con.txt', 'a|b', 'a?b', 'lpt1.log']) {
      expect(await code(files.writeAtomic('data', rel, 'x')), rel).toBe('invalid-path');
    }
  });

  it('refuses a folder link that leads out of the root, and removes only the link', async () => {
    const { files, data, outside } = s;
    writeFileSync(path.join(outside, 'secret.txt'), 'no');
    // A junction on Windows (no admin rights needed); an ordinary symlink elsewhere.
    symlinkSync(outside, path.join(data, 'mods'), 'junction');
    expect(await code(files.read('data', 'mods/secret.txt'))).toBe('outside-root');
    expect(await code(files.writeAtomic('data', 'mods/new.txt', 'x'))).toBe('outside-root');
    expect(await code(files.list('data', 'mods'))).toBe('outside-root');
    expect(await code(files.stat('data', 'mods/secret.txt'))).toBe('outside-root');
    expect(await code(files.remove('data', ['mods/secret.txt']))).toBe('outside-root');
    // Listing the folder that holds it shows it as a link, without following it.
    expect((await files.list('data', '')).map((e) => [e.name, e.kind])).toEqual([['mods', 'symlink']]);
    // Removing the link (or a folder holding one) never reaches what it points at.
    mkdirSync(path.join(data, 'dir'));
    symlinkSync(outside, path.join(data, 'dir', 'inner'), 'junction');
    await files.remove('data', ['dir', 'mods']);
    expect(await files.list('data', '')).toEqual([]);
    expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('no');
  });

  it('refuses links even when they point inside the root (no links anywhere)', async () => {
    const { files, data } = s;
    mkdirSync(path.join(data, 'real'));
    writeFileSync(path.join(data, 'real', 'a.txt'), 'a');
    symlinkSync(path.join(data, 'real'), path.join(data, 'alias'), 'junction');
    expect(await code(files.read('data', 'alias/a.txt'))).toBe('outside-root');
    expect((await files.read('data', 'real/a.txt'))!.toString()).toBe('a');
  });

  it('refuses a file symlink (skipped where the OS cannot make one without admin rights)', async (ctx) => {
    const { files, data, outside } = s;
    writeFileSync(path.join(outside, 'secret.txt'), 'no');
    if (!tryFileSymlink(path.join(outside, 'secret.txt'), path.join(data, 'link.txt'))) {
      ctx.skip('Windows needs admin rights or developer mode for file symlinks; the junction tests cover links here');
      return;
    }
    expect(await code(files.read('data', 'link.txt'))).toBe('outside-root');
    expect(await code(files.writeAtomic('data', 'link.txt', 'mine'))).toBe('outside-root');
    expect(await code(files.stat('data', 'link.txt'))).toBe('outside-root');
    expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('no');
    expect((await files.list('data', '')).map((e) => [e.name, e.kind])).toEqual([['link.txt', 'symlink']]);
    expect(await tarNames(await files.pack({ root: 'data', rels: ['link.txt'] })).catch((e: Error) => e.message)).toMatch(/Symbolic links|outside/);
  });

  it('caps reads and writes, and refuses to read folders or list files', async () => {
    const { files, data } = s;
    await files.writeAtomic('data', 'big.txt', 'x'.repeat(100));
    expect(await code(files.read('data', 'big.txt', { maxBytes: 99 }))).toBe('too-large');
    expect((await files.read('data', 'big.txt', { maxBytes: 100 }))!.length).toBe(100);
    await files.writeAtomic('data', 'dir/f.txt', 'x');
    expect(await code(files.read('data', 'dir'))).toBe('not-a-file');
    expect(await code(files.list('data', 'big.txt'))).toBe('not-a-dir');
    expect(await code(files.writeAtomic('data', 'dir', 'x'))).toBe('not-a-file');
    expect(await code(files.writeAtomic('data', 'huge.bin', Buffer.alloc(FS_WRITE_MAX_BYTES + 1)))).toBe('too-large');
    expect(await files.stat('data', 'huge.bin')).toBeNull();
    // Beyond the hard cap, whatever maxBytes asks for.
    writeFileSync(path.join(data, 'huge.bin'), Buffer.alloc(READ_MAX_BYTES + 1));
    expect(await code(files.read('data', 'huge.bin'))).toBe('too-large');
    expect(await code(files.read('data', 'huge.bin', { maxBytes: READ_MAX_BYTES * 2 }))).toBe('too-large');
  });

  it('keeps its staging and trash folder out of reach', async () => {
    const { files } = s;
    await files.writeAtomic('data', 'world/a.txt', 'a');
    await files.stage(await files.pack({ root: 'data', rels: ['world'] }), ['world']);
    expect((await files.list('data', '')).map((e) => e.name)).toEqual(['world']);
    for (const rel of [`${INTERNAL_DIR}`, `${INTERNAL_DIR}/staging`, `${INTERNAL_DIR}/x.txt`]) {
      expect(await code(files.read('data', rel)), rel).toBe('invalid-path');
      expect(await code(files.writeAtomic('data', rel, 'x')), rel).toBe('invalid-path');
      expect(await code(files.remove('data', [rel])), rel).toBe('invalid-path');
      expect(await code(files.pack({ root: 'data', rels: [rel] })), rel).toBe('invalid-path');
      expect(await code(files.stage(once(Buffer.alloc(1024)), [rel])), rel).toBe('invalid-path');
    }
  });

  it('restores: pack, stage, swap into place, undo, and purge the trash (BAK-03)', async () => {
    const { files, data } = s;
    await files.writeAtomic('data', 'world/map.bin', Buffer.alloc(70_000, 1));
    await files.writeAtomic('data', 'world/sub/b.txt', 'b1');
    await files.writeAtomic('data', 'cfg.ini', 'c1');
    await files.writeAtomic('data', 'keep.txt', 'untouched');
    const archive = await collect(await files.pack({ root: 'data', rels: ['world', 'cfg.ini'] }));
    expect(await tarNames(once(archive))).toEqual(['cfg.ini', 'world/', 'world/map.bin', 'world/sub/', 'world/sub/b.txt']);
    // The same files under a prefix, as backups store them.
    expect(await tarNames(await files.pack({ root: 'data', rels: ['cfg.ini'], prefix: 'data/' }))).toEqual(['data/cfg.ini']);

    // The world moves on: a changed file, a new one, a deleted one.
    await files.writeAtomic('data', 'world/sub/b.txt', 'b2');
    await files.writeAtomic('data', 'world/new.txt', 'new');
    await files.remove('data', ['cfg.ini']);

    const staged = await files.stage(once(archive), ['world', 'cfg.ini']);
    expect(staged.entries).toBe(5);
    const { trashId } = await files.swap(staged.stagingId, ['world', 'cfg.ini']);
    expect(text(s, 'world/sub/b.txt')).toBe('b1');
    expect(readFileSync(path.join(data, 'world', 'map.bin'))[0]).toBe(1);
    expect(existsSync(path.join(data, 'world', 'new.txt'))).toBe(false);
    expect(text(s, 'cfg.ini')).toBe('c1');
    expect(text(s, 'keep.txt')).toBe('untouched');
    // The staging folder is spent.
    expect(stagingLeft(s)).toEqual([]);
    expect(await code(files.swap(staged.stagingId, ['world']))).toBe('invalid-path');

    await files.undo(trashId);
    expect(text(s, 'world/sub/b.txt')).toBe('b2');
    expect(text(s, 'world/new.txt')).toBe('new');
    expect(existsSync(path.join(data, 'cfg.ini'))).toBe(false);
    expect(await code(files.undo(trashId))).toBe('invalid-path');

    // Again, and this time the restored world stays: the trash goes.
    const again = await files.swap((await files.stage(once(archive), ['world', 'cfg.ini'])).stagingId, ['world', 'cfg.ini']);
    await files.purgeTrash(again.trashId);
    expect(await code(files.undo(again.trashId))).toBe('invalid-path');
    expect(text(s, 'world/sub/b.txt')).toBe('b1');
    await files.purgeTrash(again.trashId);
    await files.purgeTrash();
  });

  it('streams a pack straight into a stage', async () => {
    const { files } = s;
    await files.writeAtomic('data', 'world/a.txt', 'a');
    const staged = await files.stage(await files.pack({ root: 'data', rels: ['world'] }), ['world']);
    expect(staged.entries).toBe(2);
    await files.swap(staged.stagingId, ['world']);
    expect(text(s, 'world/a.txt')).toBe('a');
  });

  it('refuses damaged or hostile archives and keeps nothing of them', async () => {
    const { files } = s;
    await files.writeAtomic('data', 'world/a.txt', 'live');
    const good = await tarOf(async (t) => t.addBuffer('world/a.txt', Buffer.from('restored'), 0));
    const withType = (type: string) => {
      const h = headerFor({ name: 'world/l', type: 'file', size: 0, mode: 0o644, mtime: 0 });
      h.write(type, 156);
      h.write('        ', 148);
      let sum = 0;
      for (const b of h) sum += b;
      h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
      return Buffer.concat([h, Buffer.alloc(1024)]);
    };
    const flipped = Buffer.from(good);
    flipped[3] = flipped[3]! ^ 0xff;
    const cases: [string, Buffer, RegExp][] = [
      ['truncated', good.subarray(0, 700), /Truncated/],
      ['bad checksum', flipped, /checksum|Corrupt/],
      ['a symlink entry', withType('2'), /Unsupported entry type "2"/],
      ['a hard link entry', withType('1'), /Unsupported entry type "1"/],
      ['outside the allowed paths', await tarOf(async (t) => t.addBuffer('Server/evil.ini', Buffer.from('x'), 0)), /Server\/evil\.ini/],
      ['climbing out', await tarOf(async (t) => t.addBuffer('world/../../escaped.txt', Buffer.from('x'), 0)), /Unsafe path/],
      ['absolute', await tarOf(async (t) => t.addBuffer('/tmp/escaped.txt', Buffer.from('x'), 0)), /Unsafe path/],
      ['not canonical', await tarOf(async (t) => t.addBuffer('world/./a.txt', Buffer.from('x'), 0)), /Unsafe path/],
      ['twice the same file', await tarOf(async (t) => {
        await t.addBuffer('world/a.txt', Buffer.from('1'), 0);
        await t.addBuffer('world/a.txt', Buffer.from('2'), 0);
      }), /twice/],
    ];
    for (const [what, archive, message] of cases) {
      await expect(files.stage(once(archive), ['world']), what).rejects.toThrow(message);
      expect(stagingLeft(s), what).toEqual([]);
    }
    expect(text(s, 'world/a.txt')).toBe('live');
    expect(existsSync(path.join(s.data, '..', 'escaped.txt'))).toBe(false);
    // Paths a restore may write are data-root paths, at least one.
    expect(await code(files.stage(once(good), []))).toBe('invalid-path');
    expect(await code(files.stage(once(good), ['..']))).toBe('invalid-path');
  });

  it('swaps only whole, separate paths of a staging folder that exists', async () => {
    const { files } = s;
    await files.writeAtomic('data', 'world/a.txt', 'a');
    const staged = await files.stage(await files.pack({ root: 'data', rels: ['world'] }), ['world']);
    expect(await code(files.swap('../../etc', ['world']))).toBe('invalid-path');
    expect(await code(files.swap('00000000-0000-4000-8000-000000000000', ['world']))).toBe('invalid-path');
    expect(await code(files.swap(staged.stagingId, ['world', 'world/a.txt']))).toBe('invalid-path');
    expect(await code(files.swap(staged.stagingId, ['world', 'world']))).toBe('invalid-path');
    expect(await code(files.swap(staged.stagingId, []))).toBe('invalid-path');
    expect(await code(files.undo('nope'))).toBe('invalid-path');
    expect(await code(files.purgeTrash('../x'))).toBe('invalid-path');
    // The refused swaps left the staging folder for a good one.
    await files.swap(staged.stagingId, ['world']);
  });

  it('never follows links while packing', async () => {
    const { files, data, outside } = s;
    writeFileSync(path.join(outside, 'secret.txt'), 'not for backups');
    await files.writeAtomic('data', 'world/map_t.bin', 'world');
    symlinkSync(outside, path.join(data, 'world', 'linked-dir'), 'junction');
    const fileLink = tryFileSymlink(path.join(outside, 'secret.txt'), path.join(data, 'world', 'linked-file.txt'));
    const names = await tarNames(await files.pack({ root: 'data', rels: ['world'] }));
    expect(names).toEqual(['world/', 'world/map_t.bin']);
    if (fileLink) expect(names).not.toContain('world/linked-file.txt');
    // A requested path that is a link is refused outright.
    expect(await code(files.pack({ root: 'data', rels: ['world/linked-dir'] }))).toBe('outside-root');
  });
});

describe('hot packs through the agent (BAK-02)', () => {
  let s: (Subject & { h: Harness }) | null = null;
  afterEach(async () => {
    await s?.cleanup();
    s = null;
  });

  const until = async (pred: () => boolean) => {
    const end = Date.now() + 8_000 * TIME_SCALE;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(pred()).toBe(true);
  };

  it(
    'runs before and after around the copy, also when the panel stops reading or before fails',
    async () => {
      const calls: string[] = [];
      let fail = false;
      // The PZ adapter's hot-copy steps, recorded; `before` fails when asked.
      s = await agentSubject((a) => ({
        ...a,
        hotCopy: {
          sqlite: a.hotCopy?.sqlite,
          before: async (ctl) => {
            calls.push('before');
            if (fail) throw new Error('no save');
            await a.hotCopy!.before(ctl);
          },
          after: async (ctl) => {
            await a.hotCopy!.after(ctl);
            calls.push('after');
          },
        },
      }));
      await s.h.agent.start(envelope(), undefined);
      await s.h.waitFor((x) => x.state === 'running');
      writeFileSync(path.join(s.data, 'Saves', 'big.bin'), Buffer.alloc(8 << 20, 1));

      const names = await tarNames(await s.files.pack({ root: 'data', rels: ['Saves', 'db'], sqlite: ['**/*.db'], prefix: 'data/' }));
      expect(names).toEqual(expect.arrayContaining(['data/Saves/big.bin', 'data/db/testsrv.db']));
      await until(() => calls.length === 2);
      expect(calls).toEqual(['before', 'after']);

      // The panel's backup fails mid-way (its disk is full): it stops reading, the agent still runs after.
      const stream = await s.files.pack({ root: 'data', rels: ['Saves'] });
      const it = stream[Symbol.asyncIterator]();
      await it.next();
      await closeIterable(stream);
      await until(() => calls.length === 4);

      fail = true;
      const failed = await s.files.pack({ root: 'data', rels: ['Saves'] }).catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(AgentCallError);
      expect(failed).toMatchObject({ status: 503, code: 'unavailable' });
      expect(calls).toEqual(['before', 'after', 'before', 'after', 'before', 'after']);
    },
    60_000 * TIME_SCALE,
  );
});
