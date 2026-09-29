import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { ExtractRequest, ExtractResult } from '@gsp/adapter-api';
import { unpack } from './tar';
import { openZipEntry, readZipDirectory, ZipError } from './zip';

/**
 * Unpacks an install's archive (UPD-01, `InstallCtx.extract`): zip, tar or
 * gzipped tar, plain files and folders only. The whole archive is refused
 * when an entry is a link or another special file, is absolute, climbs out
 * with `..`, or would land outside `dest` (also through a link already
 * there). Files are 0755 when the archive marks them executable, else 0644.
 */

export class ExtractError extends Error {}

/** More than any game's install holds; an archive claiming more is refused before anything is written. */
const MAX_ENTRIES = 200_000;
const MAX_TOTAL_BYTES = 16 * 1024 ** 3;
// Where the platform has it, the file itself can't be a link swapped in under us.
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);

/** An entry's path as segments; refused when it can't be a relative path inside the destination. */
function entrySegments(name: string): string[] {
  if (name.length > 4096 || /[\x00-\x1f\x7f\\]/.test(name)) throw new ExtractError(`Refusing an entry with an unusual name: ${JSON.stringify(name.slice(0, 200))}`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new ExtractError(`Refusing an absolute path in the archive: ${name}`);
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) throw new ExtractError(`Refusing a path that climbs out with "..": ${name}`);
  return parts;
}

/** The folder under which entries are taken (`only`), as segments. */
function onlySegments(only: string | undefined): string[] {
  if (only === undefined) return [];
  return entrySegments(only);
}

interface Placed {
  /** Absolute target. */
  target: string;
  /** Segments below the destination. */
  rel: string[];
}

/** Where an entry goes, or null when `only`/`strip` leave it out. */
function place(dest: string, name: string, only: string[], strip: number): Placed | null {
  const segs = entrySegments(name);
  if (only.some((s, i) => segs[i] !== s)) return null;
  const rel = segs.slice(strip);
  if (rel.length === 0) return null;
  const target = path.join(dest, ...rel);
  const back = path.relative(dest, target);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) throw new ExtractError(`Refusing a path outside the destination: ${name}`);
  return { target, rel };
}

/** Makes `rel`'s folders under `dest` and checks that none of them is a link (an earlier install's or anyone's). */
async function ensureDirs(dest: string, realDest: string, rel: string[]): Promise<void> {
  if (rel.length === 0) return;
  const dir = path.join(dest, ...rel);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const real = await realpath(dir);
  if (path.relative(path.join(realDest, ...rel), real) !== '') throw new ExtractError(`Refusing to write through a link: ${rel.join('/')}`);
}

/**
 * Creates the file (0755 or 0644 whatever the umask) and writes `data` into
 * it, or returns where to write its bytes when there is no `data` (a tar
 * entry). `data` is opened only once the file is: a stream that fails early
 * (a bad CRC on a tiny entry) must have its reader already listening.
 */
async function writeFile(p: Placed, dest: string, realDest: string, executable: boolean, data: (() => Promise<Readable>) | null): Promise<Writable | null> {
  await ensureDirs(dest, realDest, p.rel.slice(0, -1));
  const existing = await lstat(p.target).catch(() => null);
  if (existing && !existing.isFile()) throw new ExtractError(`Refusing to replace something that isn't a file: ${p.rel.join('/')}`);
  const mode = executable ? 0o755 : 0o644;
  const fh = await open(p.target, WRITE_FLAGS, mode);
  try {
    // The umask may have taken bits away; the archive's say goes.
    await fh.chmod(mode);
  } catch (e) {
    await fh.close();
    throw e;
  }
  const out = fh.createWriteStream();
  if (data === null) return out;
  let source: Readable;
  try {
    source = await data();
  } catch (e) {
    out.destroy();
    throw e;
  }
  await pipeline(source, out);
  return null;
}

async function extractZip(req: ExtractRequest, realDest: string, only: string[], strip: number): Promise<ExtractResult> {
  const fh = await open(req.file, 'r');
  const result: ExtractResult = { files: 0, dirs: 0 };
  try {
    const entries = await readZipDirectory(fh);
    if (entries.length > MAX_ENTRIES) throw new ExtractError(`The archive has too many entries (${entries.length})`);
    let total = 0;
    // Everything is checked before anything is written: a bad entry anywhere refuses the whole archive.
    const plan: { e: (typeof entries)[number]; p: Placed }[] = [];
    for (const e of entries) {
      const type = e.unixMode === null ? 0 : e.unixMode & 0o170000;
      if (type === 0o120000) throw new ExtractError(`Refusing a link in the archive: ${e.name}`);
      if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw new ExtractError(`Refusing a special file in the archive: ${e.name}`);
      const p = place(req.dest, e.name, only, strip);
      if (!p) continue;
      total += e.size;
      if (total > MAX_TOTAL_BYTES) throw new ExtractError('The archive unpacks to more than an install may hold');
      plan.push({ e, p });
    }
    for (const { e, p } of plan) {
      if (e.dir) {
        await ensureDirs(req.dest, realDest, p.rel);
        result.dirs++;
        continue;
      }
      await writeFile(p, req.dest, realDest, e.unixMode !== null && (e.unixMode & 0o111) !== 0, () => openZipEntry(req.file, fh, e));
      result.files++;
    }
    return result;
  } catch (e) {
    if (e instanceof ZipError) throw new ExtractError(`${path.basename(req.file)}: ${e.message}`);
    throw e;
  } finally {
    await fh.close();
  }
}

async function extractTar(req: ExtractRequest, realDest: string, only: string[], strip: number): Promise<ExtractResult> {
  const result: ExtractResult = { files: 0, dirs: 0 };
  const raw = createReadStream(req.file, { highWaterMark: 1 << 20 });
  const input = req.format === 'tar.gz' ? raw.pipe(createGunzip()) : raw;
  raw.on('error', (e) => input.destroy(e));
  try {
    // `unpack` refuses links and every other special entry itself; a tar is read once, so a bad entry
    // late in it stops the extraction there (the adapter unpacks into a staging folder it throws away).
    await unpack(input, async (e) => {
      const p = place(req.dest, e.name, only, strip);
      if (!p) return null;
      if (e.type === 'dir') {
        await ensureDirs(req.dest, realDest, p.rel);
        result.dirs++;
        return null;
      }
      result.files++;
      return writeFile(p, req.dest, realDest, (e.mode & 0o111) !== 0, null);
    });
    return result;
  } catch (e) {
    throw e instanceof ExtractError ? e : new ExtractError(`${path.basename(req.file)}: ${(e as Error).message}`);
  } finally {
    input.destroy();
    raw.destroy();
  }
}

export async function extractArchive(req: ExtractRequest): Promise<ExtractResult> {
  if (!path.isAbsolute(req.file) || !path.isAbsolute(req.dest)) throw new ExtractError('The archive and its destination must be absolute paths');
  const strip = req.strip ?? 0;
  if (!Number.isInteger(strip) || strip < 0 || strip > 32) throw new ExtractError('strip must be a small whole number');
  const only = onlySegments(req.only);
  await mkdir(req.dest, { recursive: true, mode: 0o755 });
  const realDest = await realpath(req.dest);
  if (req.format === 'zip') return extractZip(req, realDest, only, strip);
  if (req.format === 'tar' || req.format === 'tar.gz') return extractTar(req, realDest, only, strip);
  throw new ExtractError(`Unknown archive format: ${String(req.format)}`);
}
