import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
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

/**
 * `rel` as path segments. Paths are relative with `/` separators; absolute
 * paths, drive letters, backslashes, NUL and `..` are refused.
 */
function segments(rel: string): string[] {
  if (typeof rel !== 'string' || rel.length > MAX_REL || /[\0\\]/.test(rel) || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
    throw new ServerFilesError('invalid-path', `Invalid path: ${JSON.stringify(rel)}`);
  }
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) throw new ServerFilesError('invalid-path', `Invalid path: ${JSON.stringify(rel)}`);
  return parts;
}

function isInside(parent: string, child: string): boolean {
  const r = path.relative(parent, child);
  return r === '' || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
}

function kindOf(st: Stats): FileKind {
  return st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
}

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/**
 * `ServerFiles` on the panel's own disk, rooted at the folders the panel
 * mounts today (env data and install dirs). D11 moves file access behind
 * each server's agent; this keeps the same interface until then.
 */
export class LocalServerFiles implements ServerFiles {
  constructor(private readonly roots: FileRoots) {}

  private base(root: RootId): string {
    const dir = root === 'data' ? this.roots.data : root === 'install' ? this.roots.install : this.roots.extra?.[root];
    if (!dir) throw new ServerFilesError('unknown-root', `Unknown root: ${root}`);
    return path.resolve(dir);
  }

  /** Absolute path of `rel` in `root`, refusing anything that ends up outside it (symlinks included). */
  private async resolve(root: RootId, rel: string, opts: { notRoot?: boolean } = {}): Promise<string> {
    const base = this.base(root);
    const parts = segments(rel);
    if (opts.notRoot && parts.length === 0) throw new ServerFilesError('invalid-path', 'The root itself is not a file');
    const abs = path.join(base, ...parts);
    const realBase = await realpath(base).catch(() => base);
    // The nearest existing ancestor decides: a symlink anywhere on the way out is caught by realpath.
    for (let p = abs; ; p = path.dirname(p)) {
      const real = await realpath(p).catch(() => null);
      if (real !== null) {
        if (!isInside(realBase, real)) throw new ServerFilesError('outside-root', `Path leaves its root: ${rel}`);
        break;
      }
      if (p === base || path.dirname(p) === p) break;
    }
    return abs;
  }

  async stat(root: RootId, rel: string): Promise<FileStat | null> {
    const abs = await this.resolve(root, rel);
    try {
      const st = await lstat(abs);
      return { kind: kindOf(st), size: st.size, mtimeMs: st.mtimeMs };
    } catch (e) {
      if (code(e) === 'ENOENT') return null;
      throw e;
    }
  }

  async list(root: RootId, rel: string): Promise<DirEntry[]> {
    const abs = await this.resolve(root, rel);
    let names: string[];
    try {
      names = await readdir(abs);
    } catch (e) {
      if (code(e) === 'ENOENT') return [];
      if (code(e) === 'ENOTDIR') throw new ServerFilesError('not-a-dir', `Not a folder: ${rel}`);
      throw e;
    }
    const out: DirEntry[] = [];
    for (const name of names.sort()) {
      try {
        const st = await lstat(path.join(abs, name));
        out.push({ name, kind: kindOf(st), size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // Gone between readdir and lstat.
      }
    }
    return out;
  }

  async read(root: RootId, rel: string, o: { maxBytes?: number } = {}): Promise<Buffer | null> {
    const abs = await this.resolve(root, rel, { notRoot: true });
    let st: Stats;
    try {
      st = await stat(abs);
    } catch (e) {
      if (code(e) === 'ENOENT') return null;
      throw e;
    }
    if (!st.isFile()) throw new ServerFilesError('not-a-file', `Not a file: ${rel}`);
    if (o.maxBytes !== undefined && st.size > o.maxBytes) throw new ServerFilesError('too-large', `${rel} is larger than ${o.maxBytes} bytes`);
    return readFile(abs);
  }

  async writeAtomic(root: RootId, rel: string, data: Buffer | string): Promise<void> {
    const abs = await this.resolve(root, rel, { notRoot: true });
    await mkdir(path.dirname(abs), { recursive: true });
    // Rename replaces a symlink at `abs` instead of writing through it.
    const tmp = `${abs}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, abs);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async remove(root: RootId, rels: string[]): Promise<void> {
    const targets: string[] = [];
    for (const rel of rels) targets.push(await this.resolve(root, rel, { notRoot: true }));
    for (const abs of targets) await rm(abs, { recursive: true, force: true });
  }

  // Archives, staging and trash arrive with the text editor and restores
  // through the agent (M1-C/M2-C).
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
