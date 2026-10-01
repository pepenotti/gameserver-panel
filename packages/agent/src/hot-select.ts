import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { INTERNAL_DIR, isSafeName } from '@gsp/archive';

/**
 * A running backup narrowed by the game's adapter (`hotCopy.select`, BAK-02):
 * the files it picks are hard-linked into a folder of their own before the
 * copy starts, so the game may delete or rewrite them meanwhile (Valheim
 * writes a new save set, then deletes the previous one) and the copy still
 * holds them as they were. Links share the file, never its future: a file
 * the game replaces through a rename stays as linked; one it rewrites in
 * place would show the rewrite, which is why a game's selection names files
 * it no longer writes.
 */

/** The data root's folder for these links (next to the archive's own staging, trash and snapshots). */
export const SELECTED_DIR = 'selected';
/** Leftovers of a crash are dropped after an hour. */
const STALE_MS = 3_600_000;

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** `inner` is `outer` or inside it (absolute paths). */
function within(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/** A selected file vanished between the listing and its link: the game moved on to another save. */
export class VanishedError extends Error {
  constructor(readonly rel: string) {
    super(`${rel} vanished while the backup picked its files`);
  }
}

export interface SelectOptions {
  /** The data root (absolute). */
  data: string;
  /** Folders never listed (the agent's state). */
  hidden: readonly string[];
  /** The request's paths, relative to the data root, already checked. */
  rels: readonly string[];
  /** The adapter's choice among the files listed. */
  select(files: string[]): Promise<string[]>;
}

/**
 * Every regular file under `rels` (data-root paths, `/`-separated, sorted),
 * walked as a pack walks: links, devices and names a restore would refuse
 * are skipped, never followed; the archive's folder and hidden ones too.
 */
export async function listFiles(data: string, rels: readonly string[], hidden: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const hide = hidden.map((h) => path.resolve(h));
  const walk = async (rel: string): Promise<void> => {
    const abs = path.join(data, ...rel.split('/'));
    if (hide.some((h) => within(h, abs))) return;
    let st;
    try {
      st = await lstat(abs);
    } catch {
      return;
    }
    if (st.isFile()) {
      out.push(rel);
      return;
    }
    if (!st.isDirectory()) return;
    let names: string[];
    try {
      names = (await readdir(abs)).sort();
    } catch {
      return;
    }
    for (const n of names) if (isSafeName(n)) await walk(`${rel}/${n}`);
  };
  for (const rel of [...rels].sort()) {
    if (rel.split('/')[0] === INTERNAL_DIR) continue;
    await walk(rel);
  }
  return [...new Set(out)].sort();
}

/** Hard-links `picked` (data-root paths) into `dest`, keeping their folders; a picked file that is gone throws `VanishedError`. */
async function linkAll(data: string, dest: string, picked: readonly string[]): Promise<void> {
  const root = await realpath(data);
  for (const rel of picked) {
    const src = path.join(data, ...rel.split('/'));
    // A folder on the way swapped for a link since the listing would lead out of the data root: refused.
    let parent: string;
    try {
      parent = await realpath(path.dirname(src));
    } catch (e) {
      if (errno(e) === 'ENOENT') throw new VanishedError(rel);
      throw e;
    }
    if (!within(root, parent)) throw new Error(`${rel} is no longer inside the data folder`);
    const to = path.join(dest, ...rel.split('/'));
    await mkdir(path.dirname(to), { recursive: true });
    try {
      await link(src, to);
    } catch (e) {
      if (errno(e) === 'ENOENT') throw new VanishedError(rel);
      throw e;
    }
  }
}

/** Folders of `dir` older than an hour: left behind by a crash. */
async function dropStale(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const st = await lstat(path.join(dir, n)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > STALE_MS) await rm(path.join(dir, n), { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Lists the request's files, lets the adapter pick, and links the picks into
 * a new folder under `<data>/.gsp-files/selected`, which it returns (its
 * caller removes it). A picked file that vanished before its link means a
 * save moved on: everything is listed and picked again, once; `onRetry`
 * hears why. A second vanishing throws `VanishedError`.
 */
export async function linkSelection(o: SelectOptions, onRetry?: (e: VanishedError) => void): Promise<string> {
  const parent = path.join(o.data, INTERNAL_DIR, SELECTED_DIR);
  await mkdir(parent, { recursive: true });
  await dropStale(parent);
  for (let attempt = 1; ; attempt++) {
    const dir = path.join(parent, randomUUID());
    await mkdir(dir);
    try {
      const files = await listFiles(o.data, o.rels, o.hidden);
      const offered = new Set(files);
      // Only what was listed: a selection narrows, it never reaches anything else.
      const picked = [...new Set(await o.select(files))].filter((f) => offered.has(f)).sort();
      await linkAll(o.data, dir, picked);
      return dir;
    } catch (e) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (!(e instanceof VanishedError) || attempt >= 2) throw e;
      onRetry?.(e);
    }
  }
}
