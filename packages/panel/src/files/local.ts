import { randomUUID } from 'node:crypto';
import { constants, lstatSync, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DirEntry, FileKind, FileRoots, FileStat, PackRequest, RootId, ServerFiles, ServerFilesErrorCode } from '@gsp/adapter-api';

export class ServerFilesError extends Error {
  constructor(
    readonly code: ServerFilesErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const MAX_REL = 1024;
// Windows maps these names to devices in any folder, with or without an extension.
const DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function invalid(rel: string): never {
  throw new ServerFilesError('invalid-path', `Invalid path: ${JSON.stringify(rel)}`);
}

/**
 * `rel` as path segments. Paths are relative with `/` separators. Refused:
 * absolute paths, drive letters, backslashes, NUL and other control
 * characters, `..`, and names Windows would read differently from Linux
 * (`a.txt:stream`, a trailing dot or space, device names), so a check on the
 * name is a check on the file that gets opened.
 */
export function segments(rel: string): string[] {
  if (typeof rel !== 'string' || rel.length > MAX_REL || /[\x00-\x1f\x7f\\]/.test(rel) || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) invalid(rel);
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..' || /[:<>"|?*]/.test(p) || /[. ]$/.test(p) || DEVICE_NAMES.test(p)) invalid(rel);
  }
  return parts;
}

function kindOf(st: Stats): FileKind {
  return st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
}

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;
const missing = (e: unknown) => code(e) === 'ENOENT';
const statOf = (st: Stats): FileStat => ({ kind: kindOf(st), size: st.size, mtimeMs: st.mtimeMs });
// Where the platform has it, the last component can't be swapped for a link between the check and the open.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/**
 * `ServerFiles` on the panel's own disk, rooted at the folders the panel
 * mounts today (env data and install dirs). D11 moves file access behind
 * each server's agent; this keeps the same interface until then.
 *
 * Every path component below the root is checked with `lstat`: symbolic links
 * (and Windows junctions) are never followed, wherever they point (CFG-08).
 */
export class LocalServerFiles implements ServerFiles {
  constructor(private readonly roots: FileRoots) {}

  private base(root: RootId): string {
    const dir = root === 'data' ? this.roots.data : root === 'install' ? this.roots.install : this.roots.extra?.[root];
    if (!dir) throw new ServerFilesError('unknown-root', `Unknown root: ${root}`);
    return path.resolve(dir);
  }

  /** Absolute path of `rel` in `root`; refuses bad names and any symbolic link on the way. */
  private resolve(root: RootId, rel: string, opts: { notRoot?: boolean } = {}): string {
    const base = this.base(root);
    const parts = segments(rel);
    if (opts.notRoot && parts.length === 0) throw new ServerFilesError('invalid-path', 'The root itself is not a file');
    let cur = base;
    for (const part of parts) {
      cur = path.join(cur, part);
      let st: Stats;
      try {
        st = lstatSync(cur);
      } catch (e) {
        // The rest doesn't exist yet: nothing there can be a link.
        if (missing(e) || code(e) === 'ENOTDIR') break;
        throw e;
      }
      if (st.isSymbolicLink()) throw new ServerFilesError('outside-root', `Symbolic links are not followed: ${rel}`);
    }
    return path.join(base, ...parts);
  }

  private checkFile(st: Stats, rel: string, maxBytes: number | undefined): void {
    if (st.isSymbolicLink()) throw new ServerFilesError('outside-root', `Symbolic links are not followed: ${rel}`);
    if (!st.isFile()) throw new ServerFilesError('not-a-file', `Not a file: ${rel}`);
    if (maxBytes !== undefined && st.size > maxBytes) throw new ServerFilesError('too-large', `${rel} is larger than ${maxBytes} bytes`);
  }

  // ------------------------------------------------------------------ async

  async stat(root: RootId, rel: string): Promise<FileStat | null> {
    const abs = this.resolve(root, rel);
    try {
      return statOf(await lstat(abs));
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  }

  async list(root: RootId, rel: string): Promise<DirEntry[]> {
    const abs = this.resolve(root, rel);
    let names: string[];
    try {
      names = await readdir(abs);
    } catch (e) {
      if (missing(e)) return [];
      if (code(e) === 'ENOTDIR') throw new ServerFilesError('not-a-dir', `Not a folder: ${rel}`);
      throw e;
    }
    const out: DirEntry[] = [];
    for (const name of names.sort()) {
      try {
        out.push({ name, ...statOf(await lstat(path.join(abs, name))) });
      } catch {
        // Gone between readdir and lstat.
      }
    }
    return out;
  }

  async read(root: RootId, rel: string, o: { maxBytes?: number } = {}): Promise<Buffer | null> {
    const abs = this.resolve(root, rel, { notRoot: true });
    try {
      this.checkFile(await lstat(abs), rel, o.maxBytes);
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
    const fh = await open(abs, READ_FLAGS);
    try {
      const st = await fh.stat();
      this.checkFile(st, rel, o.maxBytes);
      return await fh.readFile();
    } finally {
      await fh.close();
    }
  }

  async writeAtomic(root: RootId, rel: string, data: Buffer | string): Promise<void> {
    const abs = this.resolve(root, rel, { notRoot: true });
    await mkdir(path.dirname(abs), { recursive: true });
    // `wx` never opens an existing file or link; the rename replaces a link at `abs` instead of writing through it.
    const tmp = `${abs}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, data, { flag: 'wx' });
      await rename(tmp, abs);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async remove(root: RootId, rels: string[]): Promise<void> {
    const targets = rels.map((rel) => this.resolve(root, rel, { notRoot: true }));
    for (const abs of targets) await rm(abs, { recursive: true, force: true });
  }

  // Archives, staging and trash arrive with restores through the agent (M2).
  async pack(_req: PackRequest): Promise<AsyncIterable<Buffer>> {
    throw new Error('pack: not implemented yet');
  }

  async stage(_archive: AsyncIterable<Buffer>, _allow: string[]): Promise<{ stagingId: string; entries: number }> {
    throw new Error('stage: not implemented yet');
  }

  async swap(_stagingId: string, _rels: string[]): Promise<{ trashId: string }> {
    throw new Error('swap: not implemented yet');
  }

  async undo(_trashId: string): Promise<void> {
    throw new Error('undo: not implemented yet');
  }

  async purgeTrash(_trashId?: string): Promise<void> {
    throw new Error('purgeTrash: not implemented yet');
  }
}
