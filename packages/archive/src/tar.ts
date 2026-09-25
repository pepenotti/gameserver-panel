import { once } from 'node:events';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

/**
 * Minimal streaming tar (POSIX ustar + PAX extended headers), enough for
 * backups: regular files and directories only. Reading rejects every other
 * entry type (links, devices), so a crafted archive can't smuggle one in.
 *
 * Vendor PAX records (`GSP.<key>`) carry notes about one entry, such as a
 * database that was copied without a snapshot; other readers ignore them.
 */

export const BLOCK = 512;
const ZERO = Buffer.alloc(BLOCK);
/** The two zero blocks that end an archive. */
export const END_OF_ARCHIVE: Buffer = Buffer.alloc(2 * BLOCK);
const MAX_USTAR_SIZE = 0o77777777777;
const MAX_PAX_BYTES = 1 << 20;
const META_KEY = /^GSP\.[A-Za-z0-9._-]{1,64}$/;

export interface TarEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
  mode: number;
  mtime: number;
  /** Notes about the entry, as `GSP.*` PAX records (`GSP.warning`). */
  meta?: Record<string, string>;
}

export class TarError extends Error {}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function paxRecord(key: string, value: string): Buffer {
  // "<len> key=value\n" where len counts itself.
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return Buffer.from(`${len}${body}`, 'utf8');
}

function rawHeader(name: string, size: number, type: string, mode: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(Math.max(0, Math.floor(mtime)), 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

/** Header block(s) for an entry, with a PAX header when the name, size or notes don't fit ustar. */
export function headerFor(e: TarEntry): Buffer {
  const size = e.type === 'dir' ? 0 : e.size;
  const meta = Object.entries(e.meta ?? {}).filter(([k]) => META_KEY.test(k));
  const needsPax = Buffer.byteLength(e.name) > 99 || size > MAX_USTAR_SIZE || /[^\x20-\x7e]/.test(e.name) || meta.length > 0;
  const type = e.type === 'dir' ? '5' : '0';
  if (!needsPax) return rawHeader(e.name, size, type, e.mode, e.mtime);
  const records = [paxRecord('path', e.name)];
  if (size > MAX_USTAR_SIZE) records.push(paxRecord('size', String(size)));
  for (const [k, v] of meta) records.push(paxRecord(k, v.replace(/[\r\n]+/g, ' ').slice(0, 2000)));
  const pax = Buffer.concat(records);
  const paxBlocks = Buffer.alloc(Math.ceil(pax.length / BLOCK) * BLOCK);
  pax.copy(paxBlocks);
  const shortName = e.name.replace(/[^\x20-\x7e]/g, '_').slice(-99);
  return Buffer.concat([rawHeader('PaxHeader', pax.length, 'x', 0o644, e.mtime), paxBlocks, rawHeader(shortName, Math.min(size, MAX_USTAR_SIZE), type, e.mode, e.mtime)]);
}

/** Zero bytes that fill a file's data up to the next block. */
export function padding(size: number): Buffer {
  return ZERO.subarray(0, (BLOCK - (size % BLOCK)) % BLOCK);
}

/** Writes an archive into a stream (a zstd compressor, a file). */
export class TarPacker {
  bytes = 0;

  constructor(private readonly out: Writable) {}

  private async write(buf: Buffer): Promise<void> {
    if (buf.length === 0) return;
    this.bytes += buf.length;
    if (!this.out.write(buf)) await once(this.out, 'drain');
  }

  async addDir(name: string, mtimeSec: number, meta?: Record<string, string>): Promise<void> {
    await this.write(headerFor({ name: name.endsWith('/') ? name : `${name}/`, type: 'dir', size: 0, mode: 0o755, mtime: mtimeSec, meta }));
  }

  async addBuffer(name: string, data: Buffer, mtimeSec: number): Promise<void> {
    await this.write(headerFor({ name, type: 'file', size: data.length, mode: 0o644, mtime: mtimeSec }));
    await this.write(data);
    await this.write(padding(data.length));
  }

  /**
   * Starts a file entry and returns where its bytes go: exactly `size` of
   * them, then `end()` (what `unpack` does with a sink), which pads the entry.
   */
  async addFile(name: string, size: number, mtimeSec: number): Promise<Writable> {
    await this.write(headerFor({ name, type: 'file', size, mode: 0o644, mtime: mtimeSec }));
    let written = 0;
    return new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        written += chunk.length;
        if (written > size) return cb(new TarError(`More bytes than announced for ${name}`));
        this.write(chunk).then(() => cb(), cb);
      },
      final: (cb) => {
        if (written !== size) return cb(new TarError(`Fewer bytes than announced for ${name}`));
        this.write(padding(size)).then(() => cb(), cb);
      },
    });
  }

  async finish(): Promise<void> {
    await this.write(END_OF_ARCHIVE);
  }
}

function parseOctal(buf: Buffer): number {
  const s = buf.toString('ascii').replace(/\0.*$/s, '').trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError('Corrupt tar header');
  return parseInt(s, 8);
}

function parsePax(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(buf.subarray(i, sp).toString('ascii'));
    if (!Number.isInteger(len) || len <= 0 || i + len > buf.length) throw new TarError('Corrupt PAX header');
    const rec = buf.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Writes `part` into `sink`, waiting while it is full; rejects with the sink's error. */
async function feed(sink: Writable, part: Buffer, failed: () => Error | null): Promise<void> {
  const err = failed();
  if (err) throw err;
  if (!sink.write(part)) await once(sink, 'drain');
}

/**
 * Read a tar stream entry by entry. `onEntry` returns where to write a file's
 * bytes (or null to skip them). Any entry that isn't a plain file or
 * directory is an error. After the end of the archive the rest of the input
 * is read too (whoever produces it finishes cleanly); on an error the input
 * is left as it is, and closing it is the caller's.
 */
export async function unpack(input: AsyncIterable<Buffer>, onEntry: (e: TarEntry) => Promise<Writable | null>): Promise<number> {
  const it = input[Symbol.asyncIterator]();
  let buf: Buffer = Buffer.alloc(0);
  let done = false;
  let count = 0;

  const fill = async (n: number): Promise<boolean> => {
    while (buf.length < n && !done) {
      const r = await it.next();
      if (r.done) done = true;
      else {
        const chunk = Buffer.isBuffer(r.value) ? r.value : Buffer.from((r.value as Uint8Array).buffer, (r.value as Uint8Array).byteOffset, (r.value as Uint8Array).byteLength);
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      }
    }
    return buf.length >= n;
  };
  const take = (n: number): Buffer => {
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
  const drain = async (): Promise<number> => {
    while (!done) {
      if ((await it.next()).done) done = true;
    }
    return count;
  };

  let pax: Record<string, string> = {};
  let zeros = 0;
  for (;;) {
    if (!(await fill(BLOCK))) {
      if (buf.length === 0 && zeros > 0) return count;
      throw new TarError('Truncated archive');
    }
    const h = take(BLOCK);
    if (h.equals(ZERO)) {
      if (++zeros === 2) return drain();
      continue;
    }
    zeros = 0;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (sum !== parseOctal(h.subarray(148, 156))) throw new TarError('Bad tar checksum');
    const type = String.fromCharCode(h[156]!);
    let size = parseOctal(h.subarray(124, 136));
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    let name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (prefix) name = `${prefix}/${name}`;

    if (type === 'x' || type === 'g') {
      if (size > MAX_PAX_BYTES) throw new TarError('PAX header too large');
      if (!(await fill(size))) throw new TarError('Truncated archive');
      const data = take(size);
      const padBytes = (BLOCK - (size % BLOCK)) % BLOCK;
      if (padBytes && !(await fill(padBytes))) throw new TarError('Truncated archive');
      take(padBytes);
      if (type === 'x') pax = parsePax(data);
      continue;
    }
    if (pax.path !== undefined) name = pax.path;
    if (pax.size !== undefined) {
      size = Number(pax.size);
      if (!Number.isSafeInteger(size) || size < 0) throw new TarError('Corrupt PAX size');
    }
    const meta = Object.fromEntries(Object.entries(pax).filter(([k]) => META_KEY.test(k)));
    pax = {};

    let entryType: TarEntry['type'];
    if (type === '0' || type === '\0' || type === '7') entryType = 'file';
    else if (type === '5') entryType = 'dir';
    else throw new TarError(`Unsupported entry type "${type}" for ${name}`);
    if (entryType === 'dir') size = 0;

    const entry: TarEntry = { name, type: entryType, size, mode: parseOctal(h.subarray(100, 108)), mtime: parseOctal(h.subarray(136, 148)) };
    if (Object.keys(meta).length) entry.meta = meta;
    count++;
    const sink = await onEntry(entry);
    let sinkError: Error | null = null;
    sink?.on('error', (e) => {
      sinkError ??= e;
    });
    try {
      let left = size;
      while (left > 0) {
        if (buf.length === 0 && !(await fill(1))) throw new TarError('Truncated archive');
        const part = take(Math.min(left, buf.length));
        left -= part.length;
        if (sink) await feed(sink, part, () => sinkError);
      }
      if (sink) {
        sink.end();
        await finished(sink);
      }
    } catch (e) {
      sink?.destroy();
      throw e;
    }
    const padBytes = (BLOCK - (size % BLOCK)) % BLOCK;
    if (padBytes) {
      if (!(await fill(padBytes))) throw new TarError('Truncated archive');
      take(padBytes);
    }
  }
}
