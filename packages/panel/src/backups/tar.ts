import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import type { Writable } from 'node:stream';

/**
 * Minimal streaming tar (POSIX ustar + PAX extended headers), enough for
 * backups: regular files and directories only. Reading rejects every other
 * entry type (links, devices), so a crafted archive can't smuggle one in.
 */

const BLOCK = 512;
const ZERO = Buffer.alloc(BLOCK);

export interface TarEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
  mode: number;
  mtime: number;
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
  h.write(octal(Math.floor(mtime), 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

/** Header block(s) for an entry, with a PAX header when the name or size don't fit ustar. */
export function headerFor(e: TarEntry): Buffer {
  const nameBytes = Buffer.byteLength(e.name);
  const needsPax = nameBytes > 99 || e.size > 0o77777777777 || /[^\x20-\x7e]/.test(e.name);
  const type = e.type === 'dir' ? '5' : '0';
  if (!needsPax) return rawHeader(e.name, e.type === 'dir' ? 0 : e.size, type, e.mode, e.mtime);
  const records = [paxRecord('path', e.name)];
  if (e.size > 0o77777777777) records.push(paxRecord('size', String(e.size)));
  const pax = Buffer.concat(records);
  const paxBlocks = Buffer.alloc(Math.ceil(pax.length / BLOCK) * BLOCK);
  pax.copy(paxBlocks);
  const shortName = e.name.replace(/[^\x20-\x7e]/g, '_').slice(-99);
  return Buffer.concat([
    rawHeader('PaxHeader', pax.length, 'x', 0o644, e.mtime),
    paxBlocks,
    rawHeader(shortName, e.type === 'dir' ? 0 : Math.min(e.size, 0o77777777777), type, e.mode, e.mtime),
  ]);
}

export class TarPacker {
  bytes = 0;

  constructor(private readonly out: Writable) {}

  private async write(buf: Buffer): Promise<void> {
    this.bytes += buf.length;
    if (!this.out.write(buf)) await once(this.out, 'drain');
  }

  async addDir(name: string, mtimeSec: number): Promise<void> {
    await this.write(headerFor({ name: name.endsWith('/') ? name : `${name}/`, type: 'dir', size: 0, mode: 0o755, mtime: mtimeSec }));
  }

  async addBuffer(name: string, data: Buffer, mtimeSec: number): Promise<void> {
    await this.write(headerFor({ name, type: 'file', size: data.length, mode: 0o644, mtime: mtimeSec }));
    await this.write(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) await this.write(ZERO.subarray(0, pad));
  }

  /**
   * Stream a file. If it changes size while being read (a hot backup), exactly
   * `size` bytes are still written — truncated or zero-padded — so the archive
   * stays well-formed.
   */
  async addFile(name: string, absPath: string, size: number, mtimeSec: number): Promise<void> {
    await this.write(headerFor({ name, type: 'file', size, mode: 0o644, mtime: mtimeSec }));
    let written = 0;
    if (size > 0) {
      for await (const chunk of createReadStream(absPath, { end: size - 1, highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
        const part = chunk.subarray(0, size - written);
        await this.write(part);
        written += part.length;
        if (written >= size) break;
      }
    }
    while (written < size) {
      const n = Math.min(size - written, 1 << 20);
      await this.write(Buffer.alloc(n));
      written += n;
    }
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad) await this.write(ZERO.subarray(0, pad));
  }

  async finish(): Promise<void> {
    await this.write(Buffer.concat([ZERO, ZERO]));
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

/**
 * Read a tar stream entry by entry. `onEntry` returns where to write a file's
 * bytes (or null to skip them). Any entry that isn't a plain file or
 * directory is an error.
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
      else buf = buf.length ? Buffer.concat([buf, r.value]) : r.value;
    }
    return buf.length >= n;
  };
  const take = (n: number): Buffer => {
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
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
      if (++zeros === 2) return count;
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
      if (size > 1 << 20) throw new TarError('PAX header too large');
      if (!(await fill(size))) throw new TarError('Truncated archive');
      const data = take(size);
      const padBytes = (BLOCK - (size % BLOCK)) % BLOCK;
      if (padBytes && !(await fill(padBytes))) throw new TarError('Truncated archive');
      take(padBytes);
      if (type === 'x') pax = parsePax(data);
      continue;
    }
    if (pax.path) name = pax.path;
    if (pax.size) size = Number(pax.size);
    pax = {};

    let entryType: TarEntry['type'];
    if (type === '0' || type === '\0' || type === '7') entryType = 'file';
    else if (type === '5') entryType = 'dir';
    else throw new TarError(`Unsupported entry type "${type}" for ${name}`);
    if (entryType === 'dir') size = 0;

    const entry: TarEntry = { name, type: entryType, size, mode: parseOctal(h.subarray(100, 108)), mtime: parseOctal(h.subarray(136, 148)) };
    count++;
    const sink = await onEntry(entry);
    let left = size;
    while (left > 0) {
      if (buf.length === 0 && !(await fill(1))) throw new TarError('Truncated archive');
      const part = take(Math.min(left, buf.length));
      left -= part.length;
      if (sink && !sink.write(part)) await once(sink, 'drain');
    }
    if (sink) {
      sink.end();
      await once(sink, 'finish');
    }
    const padBytes = (BLOCK - (size % BLOCK)) % BLOCK;
    if (padBytes) {
      if (!(await fill(padBytes))) throw new TarError('Truncated archive');
      take(padBytes);
    }
  }
}
