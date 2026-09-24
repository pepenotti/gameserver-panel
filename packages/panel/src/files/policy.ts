/**
 * What the text editor may open and save (CFG-07, CFG-08), on top of the path
 * rules every `ServerFiles` enforces (relative paths, no symbolic links):
 *   - only files inside an adapter's editable folders, matching their globs;
 *   - text only: no NUL bytes, valid UTF-8, at most 1 MiB;
 *   - never binaries or code: `.jar .dll .so .exe` can't be opened, scripts
 *     (`.sh .bat .ps1 .py .js .mjs`, and `.lua` unless the adapter declares
 *     the file data-only) are shown read-only;
 *   - nothing under the game install, which a validate would overwrite.
 */
import type { EditableRoot, RootId } from '@gsp/adapter-api';

export const MAX_TEXT_BYTES = 1024 * 1024;
const BINARY_EXTENSIONS = new Set(['.jar', '.dll', '.so', '.exe']);
const SCRIPT_EXTENSIONS = new Set(['.sh', '.bat', '.ps1', '.py', '.js', '.mjs', '.lua']);

/** Why a file can't be edited (the web translates these). */
export type ReadonlyReason = 'outside-roots' | 'install-root' | 'symlink' | 'not-a-file' | 'too-large' | 'binary' | 'script' | 'not-utf8';

/** Reasons a file can't even be shown. */
export const UNREADABLE: ReadonlySet<ReadonlyReason> = new Set(['outside-roots', 'symlink', 'not-a-file', 'too-large', 'binary', 'not-utf8']);

const extOf = (name: string) => /\.[^./]+$/.exec(name)?.[0]?.toLowerCase() ?? '';

/** A glob relative to an editable folder: `*` and `?` stay inside one folder, `**` crosses folders. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const matchers = new Map<string, RegExp>();
function matches(glob: string, rel: string): boolean {
  let re = matchers.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    matchers.set(glob, re);
  }
  return re.test(rel);
}

/** `rel` (from its root) relative to an editable folder, or null when it is not inside it. */
export function relativeTo(folder: EditableRoot, root: RootId, rel: string): string | null {
  if (folder.root !== root) return null;
  const base = folder.rel.replace(/^\/+|\/+$/g, '');
  if (base === '') return rel;
  return rel.startsWith(`${base}/`) ? rel.slice(base.length + 1) : null;
}

/** Whether a file inside an editable folder is listed there (its include globs, minus its exclude globs). */
export function included(folder: EditableRoot, inner: string): boolean {
  return folder.include.some((g) => matches(g, inner)) && !folder.exclude.some((g) => matches(g, inner));
}

/** Whether a folder inside an editable folder is excluded (so it isn't walked). */
export function excludedDir(folder: EditableRoot, inner: string): boolean {
  return folder.exclude.some((g) => matches(g, inner) || matches(g, `${inner}/`));
}

/** The editable folder a file belongs to, if any. */
export function editableFolderOf(folders: EditableRoot[], root: RootId, rel: string): EditableRoot | null {
  for (const f of folders) {
    const inner = relativeTo(f, root, rel);
    if (inner !== null && inner !== '' && included(f, inner)) return f;
  }
  return null;
}

/** What a file's name says about it; `dataOnly` when the adapter declares it a data-only Lua file. */
export function nameReason(root: RootId, rel: string, o: { dataOnly?: boolean } = {}): ReadonlyReason | null {
  const ext = extOf(rel);
  if (BINARY_EXTENSIONS.has(ext)) return 'binary';
  if (SCRIPT_EXTENSIONS.has(ext) && !(ext === '.lua' && o.dataOnly)) return 'script';
  if (root === 'install') return 'install-root';
  return null;
}

/** The file's bytes as text, or why they aren't text. A byte-order mark is kept so saving writes it back. */
export function decodeText(buf: Buffer): { text: string } | { reason: 'binary' | 'not-utf8' | 'too-large' } {
  if (buf.length > MAX_TEXT_BYTES) return { reason: 'too-large' };
  if (buf.includes(0)) return { reason: 'binary' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf) };
  } catch {
    return { reason: 'not-utf8' };
  }
}

/** Why a text can't be saved as a file, or null. */
export function textProblem(text: string): 'binary' | 'too-large' | null {
  if (text.includes('\0')) return 'binary';
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return 'too-large';
  return null;
}
