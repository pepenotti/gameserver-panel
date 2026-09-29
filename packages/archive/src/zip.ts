import { createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { crc32, createInflateRaw } from 'node:zlib';

/**
 * A minimal zip reader for installs (UPD-01): the central directory, then
 * each entry's bytes, stored or deflated, checked against the sizes and CRC
 * the directory gives. ZIP64 sizes and offsets are read; encrypted entries,
 * other compression methods and archives split over several disks are
 * refused. What an entry may be (no links, no special files) and where it
 * may go is `extract.ts`'s to decide.
 */

export class ZipError extends Error {}

export interface ZipEntry {
  /** As stored: `/`-separated, a trailing `/` for folders. */
  name: string;
  dir: boolean;
  /** The Unix file type and mode, for zips made on Unix; null otherwise (MS-DOS attributes carry no mode). */
  unixMode: number | null;
  /** 0 stored, 8 deflated. */
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  /** Where the entry's local header starts. */
  localOffset: number;
}

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;
const HOST_UNIX = 3;
const U32 = 0xffffffff;
const U16 = 0xffff;

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw new ZipError('Truncated zip archive');
  return buf;
}

const u64 = (b: Buffer, at: number): number => {
  const n = b.readBigUInt64LE(at);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('Zip archive too large');
  return Number(n);
};

/** Where the central directory is, and how many entries it has. */
async function findDirectory(fh: FileHandle, size: number): Promise<{ offset: number; length: number; entries: number }> {
  if (size < 22) throw new ZipError('Not a zip archive');
  const tailLength = Math.min(size, 22 + MAX_COMMENT);
  const tail = await readAt(fh, size - tailLength, tailLength);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new ZipError('Not a zip archive (no end of central directory)');
  if (tail.readUInt16LE(at + 4) !== 0 || tail.readUInt16LE(at + 6) !== 0) throw new ZipError('Zip archives split over several disks are not supported');
  let entries = tail.readUInt16LE(at + 10);
  let length = tail.readUInt32LE(at + 12);
  let offset = tail.readUInt32LE(at + 16);
  if (entries === U16 || length === U32 || offset === U32) {
    // ZIP64: its end record, found through the locator right before the classic one.
    const locAt = size - tailLength + at - 20;
    if (locAt < 0) throw new ZipError('Corrupt ZIP64 archive');
    const loc = await readAt(fh, locAt, 20);
    if (loc.readUInt32LE(0) !== EOCD64_LOCATOR) throw new ZipError('Corrupt ZIP64 archive');
    const rec = await readAt(fh, u64(loc, 8), 56);
    if (rec.readUInt32LE(0) !== EOCD64) throw new ZipError('Corrupt ZIP64 archive');
    entries = u64(rec, 32);
    length = u64(rec, 40);
    offset = u64(rec, 48);
  }
  if (offset + length > size) throw new ZipError('Corrupt zip archive (central directory out of bounds)');
  return { offset, length, entries };
}

/** Every entry of a zip archive, in the order its central directory lists them. */
export async function readZipDirectory(fh: FileHandle): Promise<ZipEntry[]> {
  const { size } = await fh.stat();
  const d = await findDirectory(fh, size);
  const cd = await readAt(fh, d.offset, d.length);
  const out: ZipEntry[] = [];
  let at = 0;
  for (let n = 0; n < d.entries; n++) {
    if (at + 46 > cd.length || cd.readUInt32LE(at) !== CENTRAL) throw new ZipError('Corrupt zip archive (central directory)');
    const madeBy = cd.readUInt16LE(at + 4);
    const flags = cd.readUInt16LE(at + 8);
    const method = cd.readUInt16LE(at + 10);
    const crc = cd.readUInt32LE(at + 16);
    let compressedSize = cd.readUInt32LE(at + 20);
    let entrySize = cd.readUInt32LE(at + 24);
    const nameLength = cd.readUInt16LE(at + 28);
    const extraLength = cd.readUInt16LE(at + 30);
    const commentLength = cd.readUInt16LE(at + 32);
    const disk = cd.readUInt16LE(at + 34);
    const external = cd.readUInt32LE(at + 38);
    let localOffset = cd.readUInt32LE(at + 42);
    const end = at + 46 + nameLength + extraLength + commentLength;
    if (end > cd.length) throw new ZipError('Corrupt zip archive (central directory)');
    const raw = cd.subarray(at + 46, at + 46 + nameLength);
    // Bit 11: the name is UTF-8; otherwise the old DOS code page, of which only ASCII is read as such.
    const name = raw.toString(flags & 0x800 ? 'utf8' : 'latin1');
    if (flags & 0x1) throw new ZipError(`Encrypted zip entries are not supported: ${name}`);
    if (method !== 0 && method !== 8) throw new ZipError(`Unsupported compression method ${method}: ${name}`);
    // The ZIP64 extra field holds, in order, whichever of these the fixed fields left at their maximum.
    const extra = cd.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e);
      const len = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let p = e + 4;
        const next = () => {
          if (p + 8 > e + 4 + len) throw new ZipError(`Corrupt ZIP64 field: ${name}`);
          const v = u64(extra, p);
          p += 8;
          return v;
        };
        if (entrySize === U32) entrySize = next();
        if (compressedSize === U32) compressedSize = next();
        if (localOffset === U32) localOffset = next();
      }
      e += 4 + len;
    }
    if (disk !== 0 && disk !== U16) throw new ZipError('Zip archives split over several disks are not supported');
    const unixMode = madeBy >> 8 === HOST_UNIX ? external >>> 16 : null;
    const dir = name.endsWith('/') || (unixMode !== null ? (unixMode & 0o170000) === 0o040000 : (external & 0x10) !== 0);
    out.push({ name, dir, unixMode: unixMode || null, method, crc32: crc, compressedSize, size: entrySize, localOffset });
    at = end;
  }
  return out;
}

/**
 * The bytes of one entry, uncompressed. The stream errors when they don't
 * match the directory's size or CRC (a corrupt or tampered archive).
 */
export async function openZipEntry(file: string, fh: FileHandle, e: ZipEntry): Promise<Readable> {
  const local = await readAt(fh, e.localOffset, 30);
  if (local.readUInt32LE(0) !== LOCAL) throw new ZipError(`Corrupt zip archive (local header): ${e.name}`);
  const start = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  let got = 0;
  let crc = 0;
  const check = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      got += chunk.length;
      if (got > e.size) return cb(new ZipError(`More bytes than the zip directory says: ${e.name}`));
      crc = crc32(chunk, crc);
      cb(null, chunk);
    },
    flush(cb) {
      if (got !== e.size) return cb(new ZipError(`Fewer bytes than the zip directory says: ${e.name}`));
      if (crc >>> 0 !== e.crc32 >>> 0) return cb(new ZipError(`CRC mismatch: ${e.name}`));
      cb();
    },
  });
  if (e.compressedSize === 0) {
    // An empty entry (stored, or a deflated stream can't be this short).
    if (e.size !== 0 || e.crc32 !== 0) throw new ZipError(`Corrupt zip entry ${e.name}`);
    return Readable.from([]);
  }
  const raw = createReadStream(file, { start, end: start + e.compressedSize - 1 });
  const source = e.method === 8 ? raw.pipe(createInflateRaw()) : raw;
  const fail = (err: Error) => check.destroy(err instanceof ZipError ? err : new ZipError(`Corrupt zip entry ${e.name}: ${err.message}`));
  raw.on('error', fail);
  source.on('error', fail);
  check.on('close', () => raw.destroy());
  return source.pipe(check);
}
