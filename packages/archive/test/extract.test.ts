// Unpacking an install's download (UPD-01, `InstallCtx.extract`): zip
// (stored and deflated, ZIP64 too), tar and tar.gz; plain files and folders
// only, nothing outside the destination, corrupt archives refused.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTar } from '../../../tools/fake-terraria/downloads.mjs';
import { extractArchive } from '../src/extract';

const posix = process.platform !== 'win32';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'gsp-extract-'));
  dirs.push(d);
  return d;
}

interface ZipIn {
  name: string;
  data?: string | Buffer;
  /** Unix type and mode; the zip is then "made on Unix". */
  mode?: number;
  deflate?: boolean;
  flags?: number;
}

/** A zip archive built by hand (the images have no zip tool, nor do the tests). */
function zip(entries: ZipIn[], o: { zip64?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const body = e.deflate ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const big = o.zip64 === true;
    const x64 = (vals: number[]) => {
      const b = Buffer.alloc(4 + 8 * vals.length);
      b.writeUInt16LE(1, 0);
      b.writeUInt16LE(8 * vals.length, 2);
      vals.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
      return b;
    };
    const localExtra = big ? x64([data.length, body.length]) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(big ? 45 : 20, 4);
    local.writeUInt16LE(0x0800 | (e.flags ?? 0), 6);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(big ? 0xffffffff : body.length, 18);
    local.writeUInt32LE(big ? 0xffffffff : data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    parts.push(local, name, localExtra, body);
    const cExtra = big ? x64([data.length, body.length, offset]) : Buffer.alloc(0);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(e.mode !== undefined ? 0x0314 : 0x0014, 4);
    c.writeUInt16LE(big ? 45 : 20, 6);
    c.writeUInt16LE(0x0800 | (e.flags ?? 0), 8);
    c.writeUInt16LE(e.deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(big ? 0xffffffff : body.length, 20);
    c.writeUInt32LE(big ? 0xffffffff : data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(cExtra.length, 30);
    c.writeUInt32LE(e.mode !== undefined ? (e.mode << 16) >>> 0 : e.name.endsWith('/') ? 0x10 : 0, 38);
    c.writeUInt32LE(big ? 0xffffffff : offset, 42);
    central.push(c, name, cExtra);
    offset += 30 + name.length + localExtra.length + body.length;
  }
  const cd = Buffer.concat(central);
  const tail: Buffer[] = [];
  if (o.zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(entries.length), 24);
    rec.writeBigUInt64LE(BigInt(entries.length), 32);
    rec.writeBigUInt64LE(BigInt(cd.length), 40);
    rec.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(o.zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(o.zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(o.zip64 ? 0xffffffff : cd.length, 12);
  end.writeUInt32LE(o.zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...parts, cd, ...tail, end]);
}

/** Every file and folder under `dir`, `/`-separated, folders with a trailing `/`. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((r) => r.split(path.sep).join('/') + (statSync(path.join(dir, r)).isDirectory() ? '/' : ''))
    .sort();
}

async function unzip(entries: ZipIn[], req: { only?: string; strip?: number; zip64?: boolean } = {}) {
  const d = tmp();
  const file = path.join(d, 'a.zip');
  writeFileSync(file, zip(entries, { zip64: req.zip64 }));
  const dest = path.join(d, 'out');
  const r = await extractArchive({ file, dest, format: 'zip', only: req.only, strip: req.strip });
  return { r, dest };
}

const mode = (f: string) => statSync(f).mode & 0o777;

describe('extract: zip (UPD-01)', () => {
  it('unpacks stored and deflated files and folders; a Unix exec bit makes a file 0755, everything else is 0644', async () => {
    const big = Buffer.from('terraria '.repeat(5000));
    const { r, dest } = await unzip([
      { name: 'top/', mode: 0o40755 },
      { name: 'top/run.sh', data: '#!/bin/sh\n', mode: 0o100755 },
      { name: 'top/lib/data.bin', data: big, deflate: true, mode: 0o100644 },
      { name: 'plain.txt', data: 'no modes' },
      { name: 'empty.txt' },
    ]);
    expect(r).toEqual({ files: 4, dirs: 1 });
    expect(tree(dest)).toEqual(['empty.txt', 'plain.txt', 'top/', 'top/lib/', 'top/lib/data.bin', 'top/run.sh']);
    expect(readFileSync(path.join(dest, 'top/lib/data.bin')).equals(big)).toBe(true);
    expect(readFileSync(path.join(dest, 'plain.txt'), 'utf8')).toBe('no modes');
    if (posix) {
      expect(mode(path.join(dest, 'top/run.sh'))).toBe(0o755);
      expect(mode(path.join(dest, 'top/lib/data.bin'))).toBe(0o644);
      expect(mode(path.join(dest, 'plain.txt'))).toBe(0o644);
    }
  });

  it('takes only the entries under a folder, dropping leading folders (a download for several systems)', async () => {
    const { r, dest } = await unzip(
      [
        { name: '1458/', data: '' },
        { name: '1458/Linux/', data: '' },
        { name: '1458/Linux/TerrariaServer.bin.x86_64', data: 'elf' },
        { name: '1458/Linux/lib64/libx.so', data: 'so', deflate: true },
        { name: '1458/Linuxy/other', data: 'no' },
        { name: '1458/Windows/TerrariaServer.exe', data: 'exe' },
      ],
      { only: '1458/Linux/', strip: 2 },
    );
    expect(r).toEqual({ files: 2, dirs: 0 });
    expect(tree(dest)).toEqual(['TerrariaServer.bin.x86_64', 'lib64/', 'lib64/libx.so']);
  });

  it('reads ZIP64 sizes and offsets', async () => {
    const { r, dest } = await unzip([{ name: 'a/b.txt', data: 'sixty-four', deflate: true }], { zip64: true });
    expect(r.files).toBe(1);
    expect(readFileSync(path.join(dest, 'a/b.txt'), 'utf8')).toBe('sixty-four');
  });

  it('refuses the whole archive, writing nothing, for a link, a special file, an absolute path or one that climbs out', async () => {
    const ok = { name: 'fine.txt', data: 'x' };
    for (const [bad, why] of [
      [{ name: 'link', data: '/etc/passwd', mode: 0o120777 }, /link/],
      [{ name: 'fifo', data: '', mode: 0o010644 }, /special file/],
      [{ name: '../escape.txt', data: 'x' }, /climbs out/],
      [{ name: 'a/../../escape.txt', data: 'x' }, /climbs out/],
      [{ name: '/abs.txt', data: 'x' }, /absolute/],
      [{ name: 'C:/abs.txt', data: 'x' }, /absolute/],
      [{ name: 'a\\..\\b', data: 'x' }, /unusual name/],
    ] as const) {
      const d = tmp();
      const file = path.join(d, 'bad.zip');
      writeFileSync(file, zip([ok, bad]));
      await expect(extractArchive({ file, dest: path.join(d, 'out'), format: 'zip' }), bad.name).rejects.toThrow(why);
      expect(tree(path.join(d, 'out')), bad.name).toEqual([]);
    }
    expect(readdirSync(path.dirname(tmp()))).not.toContain('escape.txt');
  });

  it('refuses corrupt archives: a CRC or size that does not match, encryption, a truncated file, not a zip', async () => {
    const d = tmp();
    const good = zip([{ name: 'a.txt', data: 'hello world' }]);
    const flipped = Buffer.from(good);
    // The first byte of the entry's data.
    const at = 30 + 'a.txt'.length;
    flipped[at] = flipped[at]! ^ 0xff;
    const cases: [Buffer, RegExp][] = [
      [flipped, /CRC/],
      [zip([{ name: 'a.txt', data: 'x', flags: 0x1 }]), /Encrypted/],
      [good.subarray(0, good.length - 10), /Not a zip|Truncated|Corrupt/],
      [Buffer.from('not a zip at all, just text that is long enough'), /Not a zip/],
    ];
    for (const [bytes, why] of cases) {
      const file = path.join(d, 'c.zip');
      writeFileSync(file, bytes);
      await expect(extractArchive({ file, dest: path.join(d, 'out'), format: 'zip' })).rejects.toThrow(why);
    }
  });

  it.runIf(posix)('never writes through a link already in the destination', async () => {
    const d = tmp();
    const outside = path.join(d, 'outside');
    mkdirSync(outside);
    const dest = path.join(d, 'out');
    mkdirSync(dest);
    symlinkSync(outside, path.join(dest, 'sub'));
    symlinkSync(path.join(outside, 'x.txt'), path.join(dest, 'x.txt'));
    const file = path.join(d, 'a.zip');
    writeFileSync(file, zip([{ name: 'sub/evil.txt', data: 'x' }]));
    await expect(extractArchive({ file, dest, format: 'zip' })).rejects.toThrow(/through a link/);
    writeFileSync(file, zip([{ name: 'x.txt', data: 'x' }]));
    await expect(extractArchive({ file, dest, format: 'zip' })).rejects.toThrow(/isn't a file/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a destination or archive that is not an absolute path', async () => {
    await expect(extractArchive({ file: 'a.zip', dest: tmp(), format: 'zip' })).rejects.toThrow(/absolute/);
    await expect(extractArchive({ file: path.join(tmp(), 'a.zip'), dest: 'out', format: 'zip' })).rejects.toThrow(/absolute/);
  });
});

describe('extract: tar and tar.gz (UPD-01)', () => {
  const entries = [
    { name: 'GeoIP.dat', data: 'geo' },
    { name: 'ServerPlugins/' },
    { name: 'ServerPlugins/TShockAPI.dll', data: 'dll' },
    { name: 'TShock.Server', data: '#!/bin/sh\n', mode: 0o755 },
    { name: 'bin/OTAPI.dll', data: 'otapi', mode: 0o744 },
  ];

  for (const format of ['tar', 'tar.gz'] as const) {
    it(`${format}: keeps the exec bits the archive records, as 0755`, async () => {
      const d = tmp();
      const file = path.join(d, `a.${format}`);
      const tar = makeTar(entries);
      writeFileSync(file, format === 'tar.gz' ? gzipSync(tar) : tar);
      const dest = path.join(d, 'out');
      expect(await extractArchive({ file, dest, format })).toEqual({ files: 4, dirs: 1 });
      expect(tree(dest)).toEqual(['GeoIP.dat', 'ServerPlugins/', 'ServerPlugins/TShockAPI.dll', 'TShock.Server', 'bin/', 'bin/OTAPI.dll']);
      expect(readFileSync(path.join(dest, 'bin/OTAPI.dll'), 'utf8')).toBe('otapi');
      if (posix) {
        expect(mode(path.join(dest, 'TShock.Server'))).toBe(0o755);
        expect(mode(path.join(dest, 'bin/OTAPI.dll'))).toBe(0o755);
        expect(mode(path.join(dest, 'GeoIP.dat'))).toBe(0o644);
      }
    });
  }

  it('takes only a folder, and refuses links and paths that climb out', async () => {
    const d = tmp();
    const file = path.join(d, 'a.tar');
    writeFileSync(file, makeTar(entries));
    const dest = path.join(d, 'only');
    expect(await extractArchive({ file, dest, format: 'tar', only: 'ServerPlugins', strip: 1 })).toEqual({ files: 1, dirs: 0 });
    expect(tree(dest)).toEqual(['TShockAPI.dll']);

    const link = makeTar([{ name: 'x', data: '' }]);
    link.write('2', 156); // a symbolic link
    let sum = 0;
    link.write('        ', 148);
    for (const b of link.subarray(0, 512)) sum += b;
    link.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    writeFileSync(file, link);
    await expect(extractArchive({ file, dest: path.join(d, 'l'), format: 'tar' })).rejects.toThrow(/Unsupported entry type/);
    writeFileSync(file, makeTar([{ name: '../up.txt', data: 'x' }]));
    await expect(extractArchive({ file, dest: path.join(d, 'u'), format: 'tar' })).rejects.toThrow(/climbs out/);
    expect(readdirSync(d)).not.toContain('up.txt');
  });
});
