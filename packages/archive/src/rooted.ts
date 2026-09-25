import { randomUUID } from 'node:crypto';
import { constants, createWriteStream, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DirEntry, FileKind, FileRoots, FileStat, PackRequest, RootId, ServerFiles } from '@gsp/adapter-api';
import { FS_WRITE_MAX_BYTES } from '@gsp/shared';
import { globToRegExp, matchesAny } from './glob';
import { isFolderId, isSafeName, segments, ServerFilesError } from './paths';
import { END_OF_ARCHIVE, headerFor, padding, unpack } from './tar';

/**
 * The data root's own folder for staging, trash and database snapshots. It is
 * never reachable through `ServerFiles`: not listed, read, written, packed or
 * restored into.
 */
export const INTERNAL_DIR = '.gsp-files';
/** Largest file `read` returns, whatever `maxBytes` asks for. */
export const READ_MAX_BYTES = FS_WRITE_MAX_BYTES;
/** Most paths one call takes (`remove`, `pack`, `stage`, `swap`). */
export const MAX_RELS = 1000;
const MAX_GLOBS = 50;
const CHUNK = 1 << 20;
/** Leftover staging folders and snapshots older than this are dropped (a crash, a restore that never swapped). */
const STALE_MS = 3_600_000;

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;
/** Nothing there (or a file where a folder should be). */
const missing = (e: unknown) => errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR';
const sameName = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function kindOf(st: Stats): FileKind {
  return st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
}
const statOf = (st: Stats): FileStat => ({ kind: kindOf(st), size: st.size, mtimeMs: st.mtimeMs });
// Where the platform has it, the last component can't be swapped for a link between the check and the open.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

function invalid(message: string): never {
  throw new ServerFilesError('invalid-path', message);
}

/** A consistent copy of a SQLite database, even while the game writes to it (one read transaction). */
function snapshotSqlite(src: string, dest: string): void {
  // node:sqlite's async backup() sometimes stalled for minutes in testing; VACUUM INTO did not.
  const db = new DatabaseSync(src, { readOnly: true, timeout: 10_000 });
  try {
    db.prepare('VACUUM INTO ?').run(dest);
  } finally {
    db.close();
  }
}

/** Exactly `size` bytes of an open file: cut when it grew, zero-filled when it shrank (a hot copy), so the archive stays well-formed. */
async function* fileChunks(fh: FileHandle, size: number): AsyncGenerator<Buffer> {
  let pos = 0;
  while (pos < size) {
    const want = Math.min(CHUNK, size - pos);
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await fh.read(buf, 0, want, pos);
    if (bytesRead === 0) break;
    pos += bytesRead;
    yield bytesRead === want ? buf : buf.subarray(0, bytesRead);
  }
  while (pos < size) {
    const n = Math.min(CHUNK, size - pos);
    yield Buffer.alloc(n);
    pos += n;
  }
}

async function writeAll(fh: FileHandle, buf: Buffer): Promise<void> {
  let off = 0;
  while (off < buf.length) off += (await fh.write(buf, off, buf.length - off)).bytesWritten;
}

/** `rels` without duplicates and without paths inside another of them (covered already). */
function outermost(rels: string[]): string[] {
  const sorted = [...new Set(rels)].sort();
  return sorted.filter((r) => !sorted.some((o) => o !== r && r.startsWith(`${o}/`)));
}

/** Refuses paths that repeat or contain one another (a swap would move one twice). */
function disjoint(rels: string[]): string[] {
  for (const a of rels) for (const b of rels) if (a !== b && b.startsWith(`${a}/`)) invalid(`Overlapping paths: ${a}, ${b}`);
  if (new Set(rels).size !== rels.length) invalid('A path is given twice');
  return rels;
}

/** Steps around a running game's copy: `before` makes the files consistent, `after` always runs. */
export interface HotCopy {
  before(): Promise<void>;
  after(): Promise<void>;
  /** Globs (relative to the packed root) of SQLite databases, snapshotted besides the request's. */
  sqlite?: readonly string[];
}

export interface RootedFilesOptions {
  /** The roots; a function is asked on every call (an agent's roots follow its stored launch). */
  roots: FileRoots | (() => FileRoots);
  /** Absolute folders never reachable, even inside a root (the agent's state). */
  hidden?: readonly string[];
  /** Roots that are only read (default `install`: a validate would overwrite it). */
  readOnly?: readonly RootId[];
  /**
   * Asked by every `pack`: null copies plain files (nothing writes them);
   * otherwise the request's `sqlite` globs (and the hooks') are copied as
   * snapshots, between the hooks' `before` and `after`.
   */
  hot?: () => HotCopy | null;
}

interface PackCtx {
  base: string;
  prefix: string;
  sqlite: RegExp[];
  snapDir: string | null;
  n: number;
}

/**
 * `ServerFiles` on a local disk, for whoever sits next to the files: the
 * agent (D11) and the panel's tests and dev loop. Every path is relative to
 * a root; every component below the root is checked with `lstat`, and
 * symbolic links (and Windows junctions) are never followed: not in reads,
 * writes, packing or unpacking (CFG-08). Staging, swap and trash work in
 * `<data>/.gsp-files`, on the data volume, so swaps are renames.
 */
export class RootedFiles implements ServerFiles {
  /** Staging folders being written right now (never dropped as stale). */
  private readonly staging = new Set<string>();

  constructor(private readonly o: RootedFilesOptions) {}

  private roots(): FileRoots {
    return typeof this.o.roots === 'function' ? this.o.roots() : this.o.roots;
  }

  private base(root: RootId): string {
    const r = this.roots();
    const dir = typeof root !== 'string' ? undefined : root === 'data' ? r.data : root === 'install' ? r.install : r.extra && Object.hasOwn(r.extra, root) ? r.extra[root] : undefined;
    if (!dir) throw new ServerFilesError('unknown-root', `Unknown root: ${String(root)}`);
    return path.resolve(dir);
  }

  private hidden(abs: string): boolean {
    for (const h of this.o.hidden ?? []) {
      const rel = path.relative(path.resolve(h), abs);
      if (rel === '' || !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) return true;
    }
    return false;
  }

  /** Refuses the data root's own folder and hidden folders. */
  private reserved(root: RootId, parts: string[], abs: string, rel: string): void {
    if (root === 'data' && parts.length > 0 && sameName(parts[0]!, INTERNAL_DIR)) invalid(`Reserved path: ${JSON.stringify(rel)}`);
    if (this.hidden(abs)) throw new ServerFilesError('outside-root', `Not reachable: ${JSON.stringify(rel)}`);
  }

  /** Each existing component of `parts` below `base`, with lstat: no symbolic link anywhere (the last one may be one when `finalLink`). */
  private async noLinks(base: string, parts: string[], rel: string, finalLink = false): Promise<void> {
    let cur = base;
    for (let i = 0; i < parts.length; i++) {
      cur = path.join(cur, parts[i]!);
      const st = await lstatOrNull(cur);
      // The rest doesn't exist yet: nothing there can be a link.
      if (!st) return;
      if (st.isSymbolicLink() && !(finalLink && i === parts.length - 1)) throw new ServerFilesError('outside-root', `Symbolic links are not followed: ${rel}`);
    }
  }

  /** Absolute path of `rel` in `root`; refuses bad names, reserved folders and any symbolic link on the way. */
  private async resolve(root: RootId, rel: string, o: { notRoot?: boolean; finalLink?: boolean } = {}): Promise<{ abs: string; parts: string[] }> {
    const base = this.base(root);
    const parts = segments(rel);
    if (o.notRoot && parts.length === 0) invalid('The root itself is not a file');
    const abs = path.join(base, ...parts);
    this.reserved(root, parts, abs, rel);
    await this.noLinks(base, parts, rel, o.finalLink);
    return { abs, parts };
  }

  private writable(root: RootId): void {
    if ((this.o.readOnly ?? ['install']).includes(root)) throw new ServerFilesError('outside-root', `The ${root} root is read-only`);
  }

  private checkFile(st: Stats, rel: string, maxBytes: number): void {
    if (st.isSymbolicLink()) throw new ServerFilesError('outside-root', `Symbolic links are not followed: ${rel}`);
    if (!st.isFile()) throw new ServerFilesError('not-a-file', `Not a file: ${rel}`);
    if (st.size > maxBytes) throw new ServerFilesError('too-large', `${rel} is larger than ${maxBytes} bytes`);
  }

  /** Data-root paths for staging and swaps: at least one, none of them the root or reserved. */
  private dataRels(rels: unknown): string[] {
    if (!Array.isArray(rels) || rels.length === 0 || rels.length > MAX_RELS) invalid(`Expected 1-${MAX_RELS} paths`);
    const base = this.base('data');
    return rels.map((r: unknown) => {
      const parts = segments(r as string);
      if (parts.length === 0) invalid('The root itself is not a file');
      this.reserved('data', parts, path.join(base, ...parts), r as string);
      return parts.join('/');
    });
  }

  /** `<data>/.gsp-files/<kind>` (made when `create`); refused when a part of it is not a plain folder. */
  private async internal(kind: 'staging' | 'trash' | 'snapshots', create: boolean): Promise<string> {
    const base = this.base('data');
    if (create) await mkdir(base, { recursive: true });
    let cur = base;
    for (const part of [INTERNAL_DIR, kind]) {
      cur = path.join(cur, part);
      const st = await lstatOrNull(cur);
      if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new ServerFilesError('outside-root', `${INTERNAL_DIR}/${kind} is not a plain folder`);
      if (!st && create) {
        await mkdir(cur).catch((e: unknown) => {
          if (errno(e) !== 'EEXIST') throw e;
        });
      }
    }
    return cur;
  }

  /** Folders of `dir` older than an hour, except `keep`: left behind by a crash. */
  private async dropStale(dir: string, keep: ReadonlySet<string>): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (keep.has(name)) continue;
      const st = await lstatOrNull(path.join(dir, name));
      if (st && Date.now() - st.mtimeMs > STALE_MS) await rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ files

  async stat(root: RootId, rel: string): Promise<FileStat | null> {
    const { abs } = await this.resolve(root, rel);
    const st = await lstatOrNull(abs);
    return st ? statOf(st) : null;
  }

  async list(root: RootId, rel: string): Promise<DirEntry[]> {
    const { abs, parts } = await this.resolve(root, rel);
    let names: string[];
    try {
      names = await readdir(abs);
    } catch (e) {
      if (errno(e) === 'ENOENT') return [];
      if (errno(e) === 'ENOTDIR') throw new ServerFilesError('not-a-dir', `Not a folder: ${rel}`);
      throw e;
    }
    const out: DirEntry[] = [];
    for (const name of names.sort()) {
      if (root === 'data' && parts.length === 0 && sameName(name, INTERNAL_DIR)) continue;
      const child = path.join(abs, name);
      if (this.hidden(child)) continue;
      // Gone between readdir and lstat: left out.
      const st = await lstatOrNull(child);
      if (st) out.push({ name, ...statOf(st) });
    }
    return out;
  }

  async read(root: RootId, rel: string, o: { maxBytes?: number } = {}): Promise<Buffer | null> {
    const { abs } = await this.resolve(root, rel, { notRoot: true });
    const cap = Math.min(o.maxBytes ?? READ_MAX_BYTES, READ_MAX_BYTES);
    const st = await lstatOrNull(abs);
    if (!st) return null;
    this.checkFile(st, rel, cap);
    let fh: FileHandle;
    try {
      fh = await open(abs, READ_FLAGS);
    } catch (e) {
      if (missing(e)) return null;
      if (errno(e) === 'ELOOP') throw new ServerFilesError('outside-root', `Symbolic links are not followed: ${rel}`);
      throw e;
    }
    try {
      const fst = await fh.stat();
      this.checkFile(fst, rel, cap);
      const buf = Buffer.alloc(fst.size);
      let off = 0;
      while (off < buf.length) {
        const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      return off === buf.length ? buf : buf.subarray(0, off);
    } finally {
      await fh.close();
    }
  }

  async writeAtomic(root: RootId, rel: string, data: Buffer | string): Promise<void> {
    await this.writeFrom(root, rel, [typeof data === 'string' ? Buffer.from(data, 'utf8') : data]);
  }

  /**
   * `writeAtomic` from a stream (an agent's request body): through a
   * temporary file and a rename, at most `FS_WRITE_MAX_BYTES`.
   */
  async writeFrom(root: RootId, rel: string, chunks: AsyncIterable<Buffer> | Iterable<Buffer>): Promise<void> {
    this.writable(root);
    const { abs } = await this.resolve(root, rel, { notRoot: true });
    const st = await lstatOrNull(abs);
    if (st && !st.isFile()) throw new ServerFilesError('not-a-file', `Not a file: ${rel}`);
    await mkdir(path.dirname(abs), { recursive: true });
    // `wx` never opens an existing file or link; the rename replaces a link at `abs` instead of writing through it.
    const tmp = `${abs}.${randomUUID()}.tmp`;
    const fh = await open(tmp, 'wx', 0o644);
    let closed = false;
    try {
      let n = 0;
      for await (const c of chunks) {
        n += c.length;
        if (n > FS_WRITE_MAX_BYTES) throw new ServerFilesError('too-large', `${rel}: more than ${FS_WRITE_MAX_BYTES} bytes`);
        await writeAll(fh, c);
      }
      closed = true;
      await fh.close();
      await rename(tmp, abs);
    } catch (e) {
      if (!closed) await fh.close().catch(() => undefined);
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async remove(root: RootId, rels: string[]): Promise<void> {
    this.writable(root);
    if (!Array.isArray(rels) || rels.length > MAX_RELS) invalid(`Expected at most ${MAX_RELS} paths`);
    const targets: string[] = [];
    // A link itself may go (rm never follows it); nothing is removed through one.
    for (const rel of rels) targets.push((await this.resolve(root, rel, { notRoot: true, finalLink: true })).abs);
    for (const abs of targets) await rm(abs, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- archives

  async pack(req: PackRequest): Promise<AsyncIterable<Buffer>> {
    if (typeof req !== 'object' || req === null) invalid('Expected a pack request');
    const base = this.base(req.root);
    if (!Array.isArray(req.rels) || req.rels.length > MAX_RELS) invalid(`Expected at most ${MAX_RELS} paths`);
    const rels: string[] = [];
    for (const rel of req.rels) rels.push((await this.resolve(req.root, rel, { notRoot: true })).parts.join('/'));
    const prefixParts = req.prefix === undefined ? [] : segments(req.prefix);
    const globs = req.sqlite ?? [];
    if (!Array.isArray(globs) || globs.length > MAX_GLOBS || globs.some((g) => typeof g !== 'string' || g.length > 256)) invalid('Expected up to 50 SQLite globs');
    const ctx: PackCtx = { base, prefix: prefixParts.length ? `${prefixParts.join('/')}/` : '', sqlite: [], snapDir: null, n: 0 };
    return this.packStream(ctx, outermost(rels), globs);
  }

  private async *packStream(ctx: PackCtx, rels: string[], globs: string[]): AsyncGenerator<Buffer> {
    const hot = this.o.hot?.() ?? null;
    if (hot) ctx.sqlite = [...globs, ...(hot.sqlite ?? [])].map(globToRegExp);
    try {
      if (hot) await hot.before();
      for (const rel of rels) yield* this.walk(ctx, rel);
      yield END_OF_ARCHIVE;
    } finally {
      if (ctx.snapDir) await rm(ctx.snapDir, { recursive: true, force: true }).catch(() => undefined);
      if (hot) await hot.after();
    }
  }

  /** A file or folder (walked, sorted) as tar entries; links, devices and sockets are skipped, never followed. */
  private async *walk(ctx: PackCtx, rel: string): AsyncGenerator<Buffer> {
    const abs = path.join(ctx.base, ...rel.split('/'));
    if (this.hidden(abs)) return;
    const st = await lstatOrNull(abs);
    if (!st) return;
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = (await readdir(abs)).sort();
      } catch (e) {
        if (missing(e)) return;
        throw e;
      }
      const unsafe = names.filter((n) => !isSafeName(n));
      const meta = unsafe.length ? { 'GSP.warning': `${rel}: skipped ${unsafe.length} name(s) a restore would refuse: ${unsafe.slice(0, 3).map((n) => JSON.stringify(n)).join(', ')}` } : undefined;
      yield headerFor({ name: `${ctx.prefix}${rel}/`, type: 'dir', size: 0, mode: 0o755, mtime: st.mtimeMs / 1000, meta });
      for (const n of names) if (isSafeName(n)) yield* this.walk(ctx, `${rel}/${n}`);
    } else if (st.isFile()) {
      yield* this.packFile(ctx, abs, rel, st);
    }
  }

  private async snapshotDir(): Promise<string> {
    const snapshots = await this.internal('snapshots', true);
    await this.dropStale(snapshots, new Set());
    const dir = path.join(snapshots, randomUUID());
    await mkdir(dir);
    return dir;
  }

  private async *packFile(ctx: PackCtx, abs: string, rel: string, st: Stats): AsyncGenerator<Buffer> {
    let src = abs;
    let snap = false;
    let meta: Record<string, string> | undefined;
    if (ctx.sqlite.length > 0 && matchesAny(rel, ctx.sqlite)) {
      try {
        ctx.snapDir ??= await this.snapshotDir();
        const dest = path.join(ctx.snapDir, `${ctx.n++}.db`);
        snapshotSqlite(abs, dest);
        src = dest;
        snap = true;
      } catch (e) {
        // Not a SQLite file after all (or locked): a plain copy rather than a failed backup.
        meta = { 'GSP.warning': `${rel}: copied as a plain file (${(e as Error).message})` };
      }
    }
    let fh: FileHandle;
    try {
      fh = await open(src, READ_FLAGS);
    } catch (e) {
      // Gone, or swapped for a link, since it was listed.
      if (missing(e) || errno(e) === 'ELOOP') return;
      throw e;
    }
    try {
      const fst = await fh.stat();
      // Replaced by something else since it was listed: not followed.
      if (!fst.isFile() || (!snap && (fst.ino !== st.ino || fst.dev !== st.dev))) return;
      const size = snap ? fst.size : st.size;
      yield headerFor({ name: `${ctx.prefix}${rel}`, type: 'file', size, mode: 0o644, mtime: st.mtimeMs / 1000, meta });
      yield* fileChunks(fh, size);
      const pad = padding(size);
      if (pad.length) yield pad;
    } finally {
      await fh.close();
      if (snap) await rm(src, { force: true });
    }
  }

  async stage(archive: AsyncIterable<Buffer>, allow: string[]): Promise<{ stagingId: string; entries: number }> {
    const allowed = this.dataRels(allow);
    const root = await this.internal('staging', true);
    const id = randomUUID();
    this.staging.add(id);
    try {
      await this.dropStale(root, this.staging);
      const dir = path.join(root, id);
      await mkdir(dir);
      let entries = 0;
      // Folders of the staging tree already checked (or made) by this stage.
      const plain = new Set<string>(['']);
      try {
        await unpack(archive, async (e) => {
          const name = e.type === 'dir' ? e.name.replace(/\/$/, '') : e.name;
          let parts: string[];
          try {
            parts = segments(name);
          } catch {
            throw new ServerFilesError('invalid-path', `Unsafe path in archive: ${JSON.stringify(e.name)}`);
          }
          const rel = parts.join('/');
          if (parts.length === 0 || rel !== name) throw new ServerFilesError('invalid-path', `Unsafe path in archive: ${JSON.stringify(e.name)}`);
          if (!allowed.some((a) => rel === a || rel.startsWith(`${a}/`))) throw new ServerFilesError('outside-root', `Not a path this restore may write: ${rel}`);
          const parent = parts.slice(0, -1).join('/');
          if (!plain.has(parent)) {
            await this.noLinks(dir, parts.slice(0, -1), rel);
            plain.add(parent);
          }
          const dest = path.join(dir, ...parts);
          const there = await lstatOrNull(dest);
          if (there && !(e.type === 'dir' && there.isDirectory())) throw new ServerFilesError('invalid-path', `The archive holds ${rel} twice`);
          entries++;
          if (e.type === 'dir') {
            await mkdir(dest, { recursive: true });
            plain.add(rel);
            return null;
          }
          await mkdir(path.dirname(dest), { recursive: true });
          // `wx`: a second entry of the same name (or anything already there) is an error, never an overwrite.
          return createWriteStream(dest, { flags: 'wx', mode: 0o644 });
        });
      } catch (e) {
        await rm(dir, { recursive: true, force: true });
        throw e;
      }
      return { stagingId: id, entries };
    } finally {
      this.staging.delete(id);
    }
  }

  async swap(stagingId: string, rels: string[]): Promise<{ trashId: string }> {
    if (!isFolderId(stagingId)) invalid('Invalid staging id');
    const list = disjoint(this.dataRels(rels));
    const staged = path.join(await this.internal('staging', false), stagingId);
    const sst = await lstatOrNull(staged);
    if (!sst?.isDirectory()) invalid(`No staging folder ${stagingId}`);
    const base = this.base('data');
    const trashId = randomUUID();
    const tdir = path.join(await this.internal('trash', true), trashId);
    const done: { from: string; to: string }[] = [];
    const move = async (from: string, to: string) => {
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
      done.push({ from, to });
    };
    try {
      await mkdir(path.join(tdir, 'files'), { recursive: true });
      // Written first, so an undo knows what to put back even after a crash mid-swap.
      await writeFile(path.join(tdir, 'rels.json'), JSON.stringify({ rels: list, at: new Date().toISOString() }));
      for (const rel of list) {
        const parts = rel.split('/');
        await this.noLinks(base, parts, rel, true);
        await this.noLinks(staged, parts, rel);
        const live = path.join(base, ...parts);
        const next = path.join(staged, ...parts);
        if (await lstatOrNull(live)) await move(live, path.join(tdir, 'files', ...parts));
        if (await lstatOrNull(next)) await move(next, live);
      }
    } catch (e) {
      for (const m of done.reverse()) await rename(m.to, m.from).catch(() => undefined);
      await rm(tdir, { recursive: true, force: true });
      throw e;
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
    return { trashId };
  }

  async undo(trashId: string): Promise<void> {
    if (!isFolderId(trashId)) invalid('Invalid trash id');
    const tdir = path.join(await this.internal('trash', false), trashId);
    const tst = await lstatOrNull(tdir);
    if (!tst?.isDirectory()) invalid(`No trash folder ${trashId}`);
    let rels: string[];
    try {
      rels = this.dataRels((JSON.parse(await readFile(path.join(tdir, 'rels.json'), 'utf8')) as { rels?: unknown }).rels);
    } catch (e) {
      if (e instanceof ServerFilesError) throw e;
      invalid(`Trash folder ${trashId} is incomplete`);
    }
    const base = this.base('data');
    for (const rel of rels) {
      const parts = rel.split('/');
      await this.noLinks(base, parts, rel, true);
      const live = path.join(base, ...parts);
      const kept = path.join(tdir, 'files', ...parts);
      await rm(live, { recursive: true, force: true });
      if (await lstatOrNull(kept)) {
        await mkdir(path.dirname(live), { recursive: true });
        await rename(kept, live);
      }
    }
    await rm(tdir, { recursive: true, force: true });
  }

  async purgeTrash(trashId?: string): Promise<void> {
    if (trashId !== undefined && !isFolderId(trashId)) invalid('Invalid trash id');
    const trash = await this.internal('trash', false);
    await rm(trashId === undefined ? trash : path.join(trash, trashId), { recursive: true, force: true });
  }
}

/** Stops an archive stream early (a generator's `finally`, an HTTP body's socket); harmless on one that ended. */
export async function closeIterable(it: unknown): Promise<void> {
  const ret = (it as { return?: () => unknown }).return;
  if (typeof ret === 'function') await ret.call(it);
  const destroy = (it as { destroy?: () => void }).destroy;
  if (typeof destroy === 'function') destroy.call(it);
}
