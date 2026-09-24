import { createHash } from 'node:crypto';
import type { ConfigFileDecl, DirEntry, EditableRoot, PanelAdapter, RootId, Scalar, ServerCtx, ServerFiles, ServerRef } from '@gsp/adapter-api';
import { checkOptionValue, formatFor, formatIdForName, type ConfigFormat, type LuaEdit, type OptionMeta, type ParseIssue } from '@gsp/formats';
import { nowIso, type Db } from '../db/db';
import { segments, ServerFilesError, type SyncServerFiles } from '../files/local';
import { decodeText, editableFolderOf, excludedDir, included, MAX_TEXT_BYTES, nameReason, textProblem, UNREADABLE, type ReadonlyReason } from '../files/policy';
import { HttpError } from '../http/context';
import type { AgentFeed } from '../http/deps';
import type { Settings } from '../settings';
import type {
  ApplyResult,
  ChangeRequest,
  CommitResult,
  ConfigFile,
  ConfigMeta,
  ConfigStore,
  DeclaredFile,
  EditableFolder,
  FileContent,
  FileVersionRow,
  PendingRestart,
  PreparedChange,
  ReappliedKey,
  TreeEntry,
  VersionRow,
} from './store';

export type { ApplyResult, ConfigFile, PendingRestart, VersionRow };

/** What secret values look like in forms, the text editor, diffs and history. */
export const MASK = '••••••••';
/** A secret the change sets to a new value, in a diff. Never written. */
const MASK_CHANGED = `${MASK} (changed)`;
const HISTORY_KEEP = 100;
const TREE_MAX_ENTRIES = 1000;
const TREE_MAX_DEPTH = 8;

export interface ConfigDeps {
  db: Db;
  settings: Settings;
  feed: AgentFeed;
  /** The game adapter's panel half: its `config` drives everything here. */
  adapter: PanelAdapter;
  /** The server: its ref, and the context the adapter's `afterWrite` and presets run with. */
  server: { readonly ref: ServerRef; ctx(actor?: string | null): ServerCtx };
  files: ServerFiles & SyncServerFiles;
}

/** A file the store can read and write: a declared config file, or a file in an editable folder. */
interface Target {
  /** A declared id (`ini`) or `path:<root>/<rel>`. */
  id: string;
  decl: ConfigFileDecl | null;
  root: RootId;
  rel: string;
  format: ConfigFormat;
  /** Why it can't be saved, from its name and place (its bytes are checked when read). */
  reason: ReadonlyReason | null;
}

export function pathId(root: RootId, rel: string): string {
  return `path:${root}/${rel}`;
}

function parsePathId(id: string): { root: RootId; rel: string } | null {
  const m = /^path:([A-Za-z0-9_-]+)\/(.+)$/.exec(id);
  return m ? { root: m[1]!, rel: m[2]! } : null;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const invalidFile = (issues: ParseIssue[]) => new HttpError(400, 'invalid-file', undefined, { issues });
const same = (a: Scalar | undefined, b: Scalar | undefined) => (a === undefined || b === undefined ? a === b : String(a) === String(b));

/** `ServerFiles` refusals as HTTP errors. */
function filesError(e: unknown): unknown {
  if (!(e instanceof ServerFilesError)) return e;
  switch (e.code) {
    case 'invalid-path':
    case 'not-a-dir':
      return new HttpError(400, 'invalid-path');
    case 'unknown-root':
      return new HttpError(404, 'unknown-file');
    case 'outside-root':
      return new HttpError(403, 'not-editable', undefined, { reason: 'symlink' });
    case 'not-a-file':
      return new HttpError(403, 'not-editable', undefined, { reason: 'not-a-file' });
    case 'too-large':
      return new HttpError(403, 'not-editable', undefined, { reason: 'too-large' });
  }
}

/**
 * The server's config files, driven by the adapter's `config` (CFG-01…10):
 * declared files with their formats, schemas, managed and secret keys, the
 * editable folders, `afterWrite` and presets. Forms, the text editor,
 * reverts and presets all end in one write path (`commit`, or its
 * synchronous twin for the frozen methods): validate → re-apply managed keys
 * → history snapshot → atomic write → `afterWrite` → pending restart.
 */
export class ConfigService implements ConfigStore {
  constructor(private readonly d: ConfigDeps) {}

  // ------------------------------------------------------------ the adapter

  private get srv(): ServerRef {
    return this.d.server.ref;
  }

  private decls(): ConfigFileDecl[] {
    return this.d.adapter.config.files(this.srv);
  }

  private folders(): EditableRoot[] {
    return this.d.adapter.config.roots(this.srv);
  }

  private schemaOf(t: Target): OptionMeta[] | null {
    const id = t.decl?.schemaId;
    return id === undefined ? null : (this.d.adapter.config.schemas[id] ?? null);
  }

  private ctx(actor: string | null = null): ServerCtx {
    return this.d.server.ctx(actor);
  }

  // ---------------------------------------------------------------- targets

  private declTarget(decl: ConfigFileDecl): Target {
    return { id: decl.id, decl, root: decl.root, rel: decl.rel, format: formatFor(decl), reason: nameReason(decl.root, decl.rel, { dataOnly: !!decl.dataOnly }) };
  }

  /** A declared id, or `path:<root>/<rel>` inside an editable folder (a declared file's path means that file). */
  private target(fileId: string): Target {
    const decls = this.decls();
    const decl = decls.find((x) => x.id === fileId);
    if (decl) return this.declTarget(decl);
    const p = parsePathId(fileId);
    if (!p) throw new HttpError(404, 'unknown-file');
    let rel: string;
    try {
      rel = segments(p.rel).join('/');
    } catch (e) {
      throw filesError(e);
    }
    if (rel === '') throw new HttpError(400, 'invalid-path');
    const declared = decls.find((x) => x.root === p.root && x.rel === rel);
    if (declared) return this.declTarget(declared);
    if (!editableFolderOf(this.folders(), p.root, rel)) throw new HttpError(403, 'not-editable', undefined, { reason: 'outside-roots' });
    return { id: pathId(p.root, rel), decl: null, root: p.root, rel, format: formatFor(rel), reason: nameReason(p.root, rel) };
  }

  /** The file's text, or null when it doesn't exist; refused when it isn't text (CFG-08). */
  private readText(t: Target): string | null {
    let buf: Buffer | null;
    try {
      buf = this.d.files.readSync(t.root, t.rel, { maxBytes: MAX_TEXT_BYTES });
    } catch (e) {
      throw filesError(e);
    }
    if (buf === null) return null;
    const r = decodeText(buf);
    if ('reason' in r) throw new HttpError(403, 'not-editable', undefined, { reason: r.reason });
    return r.text;
  }

  private requireText(t: Target): string {
    const text = this.readText(t);
    if (text === null) throw t.decl ? new HttpError(409, 'config-missing') : new HttpError(404, 'not-found');
    return text;
  }

  private assertSavable(t: Target): void {
    if (t.reason) throw new HttpError(403, 'not-editable', undefined, { reason: t.reason });
  }

  /** The game rewrites these files while booting; writing then could be lost. */
  private assertWritable(): void {
    const st = this.d.feed.status_?.state;
    if (st === 'starting' || st === 'stopping' || st === 'installing') throw new HttpError(409, 'server-busy');
  }

  // ---------------------------------------------------------- keys & masks

  /** Every setting of a text; empty when it doesn't parse. */
  private flat(t: Target, text: string | null): Record<string, Scalar> {
    if (text === null) return {};
    const r = t.format.parse(text);
    return r.ok ? t.format.flatten(r.doc) : {};
  }

  /**
   * `text` with each non-empty secret masked; keys in `changed` get a marker
   * so a diff shows the secret changes without showing it.
   */
  private mask(t: Target, text: string, changed: ReadonlySet<string> = new Set()): string {
    const keys = t.decl?.secretKeys ?? [];
    if (keys.length === 0) return text;
    const r = t.format.parse(text);
    if (r.ok) {
      const flat = t.format.flatten(r.doc);
      const edits: Record<string, string> = {};
      for (const k of keys) if (flat[k] !== undefined && String(flat[k]) !== '') edits[k] = changed.has(k) ? MASK_CHANGED : MASK;
      try {
        return Object.keys(edits).length ? t.format.edit(text, edits) : text;
      } catch {
        // A secret the format can't hold as text: mask it line by line below.
      }
    }
    let out = text;
    for (const k of keys) out = out.replace(new RegExp(`^([ \\t]*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*[=:][ \\t]*)[^\\r\\n]+`, 'gm'), `$1${MASK}`);
    return out;
  }

  private shaOf(t: Target, text: string): string {
    return sha256(this.mask(t, text));
  }

  /** Secrets the change doesn't touch go back to the mask, so they come from disk when it is applied. */
  private remask(t: Target, next: string, disk: string): string {
    const keys = t.decl?.secretKeys ?? [];
    if (keys.length === 0) return next;
    const nextFlat = this.flat(t, next);
    const diskFlat = this.flat(t, disk);
    const edits: Record<string, string> = {};
    for (const k of keys) if (nextFlat[k] !== undefined && String(nextFlat[k]) !== '' && same(nextFlat[k], diskFlat[k])) edits[k] = MASK;
    try {
      return Object.keys(edits).length ? t.format.edit(next, edits) : next;
    } catch {
      return next;
    }
  }

  private managedValues(): Record<string, Record<string, string>> {
    return this.d.adapter.config.managedValues(this.srv);
  }

  // -------------------------------------------------------------- pipeline

  /** A form's key changes as the text they produce; field errors are a 400 `invalid-options` (CFG-01, CFG-04). */
  private proposedFromChanges(t: Target, disk: string, changes: Record<string, Scalar | null>): string {
    const schema = this.schemaOf(t);
    const current = this.flat(t, disk);
    const fields: Record<string, string> = {};
    const clean: Record<string, Scalar | null> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (t.decl?.managedKeys.includes(key)) {
        fields[key] = 'managed';
        continue;
      }
      // An untouched secret.
      if (value === MASK && t.decl?.secretKeys.includes(key)) continue;
      const meta = schema?.find((m) => m.key === key);
      if (!meta && !(key in current)) {
        fields[key] = 'unknown-option';
        continue;
      }
      if (value !== null) {
        const problem = checkOptionValue(meta ?? { type: 'string' }, String(value));
        if (problem) {
          fields[key] = problem;
          continue;
        }
      }
      if (value === null ? key in current : !same(current[key], value)) clean[key] = value;
    }
    if (Object.keys(fields).length) throw new HttpError(400, 'invalid-options', undefined, { fields });
    try {
      return t.format.edit(disk, clean);
    } catch (e) {
      throw new HttpError(400, 'invalid-options', (e as Error).message, { message: (e as Error).message });
    }
  }

  /**
   * Checks a proposed text and makes it what will be written: it must parse
   * (Lua as plain data, CFG-02), masked secrets come back from disk, and
   * managed keys are put back with a note (CFG-04, CFG-08). Changed values
   * are checked against the schema.
   */
  private prepareText(t: Target, disk: string | null, proposed: string, o: { managed?: boolean } = {}): { next: string; reapplied: ReappliedKey[]; changedKeys: string[]; warnings: ParseIssue[] } {
    const problem = textProblem(proposed);
    if (problem === 'too-large') throw new HttpError(413, 'too-large');
    if (problem === 'binary') throw invalidFile([{ line: proposed.slice(0, proposed.indexOf('\0')).split('\n').length, message: 'The text contains a NUL character; only text files can be edited' }]);
    const parsed = t.format.parse(proposed);
    if (!parsed.ok) throw invalidFile(parsed.issues);
    if (t.decl?.dataOnly && t.format.checkShape) {
      const issue = t.format.checkShape(parsed.doc, t.decl.dataOnly);
      if (issue) throw invalidFile([issue]);
    }
    const diskFlat = this.flat(t, disk);
    let next = proposed;
    let flat = t.format.flatten(parsed.doc);
    const edit = (changes: Record<string, Scalar | null>) => {
      try {
        next = t.format.edit(next, changes);
      } catch (e) {
        throw invalidFile([{ line: 1, message: (e as Error).message }]);
      }
      flat = this.flat(t, next);
    };

    const restore: Record<string, Scalar | null> = {};
    for (const k of t.decl?.secretKeys ?? []) if (flat[k] === MASK) restore[k] = diskFlat[k] ?? null;
    if (Object.keys(restore).length) edit(restore);

    const reapplied: ReappliedKey[] = [];
    if (t.decl && o.managed !== false) {
      const panel = this.managedValues()[t.id] ?? {};
      const fix: Record<string, Scalar | null> = {};
      for (const k of t.decl.managedKeys) {
        const want: Scalar | undefined = k in panel ? panel[k] : diskFlat[k];
        if (same(flat[k], want)) continue;
        fix[k] = want ?? null;
        reapplied.push({ key: k, value: want === undefined ? null : t.decl.secretKeys.includes(k) ? MASK : String(want), why: k in panel ? 'set-by-panel' : 'managed' });
      }
      if (Object.keys(fix).length) edit(fix);
    }

    const final = t.format.parse(next);
    if (!final.ok) throw invalidFile(final.issues);
    const nextFlat = t.format.flatten(final.doc);
    const changedKeys = [...new Set([...Object.keys(diskFlat), ...Object.keys(nextFlat)])].filter((k) => !same(diskFlat[k], nextFlat[k]));

    const schema = this.schemaOf(t);
    const errors: ParseIssue[] = [];
    const warnings: ParseIssue[] = [];
    if (schema) {
      for (const k of changedKeys) {
        if (nextFlat[k] === undefined) continue;
        const at = t.format.locate?.(final.doc, k) ?? { line: 1 };
        const meta = schema.find((m) => m.key === k);
        if (!meta) {
          if (!(k in diskFlat)) warnings.push({ ...at, message: `${k} is not a setting the game knows; it may drop it` });
          continue;
        }
        const p = checkOptionValue(meta, String(nextFlat[k]));
        if (p) errors.push({ ...at, message: `${k} ${p}` });
      }
    }
    if (errors.length) throw invalidFile(errors);
    return { next, reapplied, changedKeys, warnings };
  }

  /** Snapshot and write; what was on disk goes to the history first if the panel didn't write it. */
  private writeSync(t: Target, disk: string | null, next: string, by: string | null, note: string): void {
    if (disk !== null && disk !== this.latestContent(t.id)) this.snapshot(t.id, disk, null, 'on disk before this change');
    try {
      this.d.files.writeAtomicSync(t.root, t.rel, next);
    } catch (e) {
      throw filesError(e);
    }
    this.snapshot(t.id, next, by, note.slice(0, 300));
  }

  /** What a pending-restart badge lists for a change: the restart-only keys, or the file. */
  private restartReasons(t: Target, changedKeys: string[], everything: boolean): string[] {
    const whole = [t.decl ? t.id : t.rel];
    if (!t.decl || t.decl.restartKeys === '*') return whole;
    if (everything) return changedKeys.length ? changedKeys : whole;
    const only = t.decl.restartKeys;
    return changedKeys.filter((k) => only.includes(k));
  }

  /** When a change takes effect (CFG-05): live only when every changed key is live and the game can re-read the file. */
  private appliesOf(t: Target, changedKeys: string[]): 'live' | 'restart' {
    if (!t.decl || t.decl.restartKeys === '*' || !this.d.adapter.config.afterWrite || changedKeys.length === 0) return 'restart';
    const only = t.decl.restartKeys;
    return changedKeys.some((k) => only.includes(k)) ? 'restart' : 'live';
  }

  /** After a write: a running server re-reads the file (`afterWrite`) and the rest waits for a restart. */
  private async finish(t: Target, changedKeys: string[], by: string | null): Promise<ApplyResult> {
    if (this.d.feed.status_?.state !== 'running') return { applied: 'next-start', warnings: [], restartNeeded: false };
    let applied: 'live' | 'restart' = 'restart';
    let warnings: string[] = [];
    if (t.decl && this.d.adapter.config.afterWrite) ({ applied, warnings } = await this.d.adapter.config.afterWrite(this.ctx(by), t.id, changedKeys));
    const pending = this.restartReasons(t, changedKeys, applied === 'restart');
    this.markPending(pending);
    return { applied: applied === 'live' ? 'live' : 'next-start', warnings, restartNeeded: pending.length > 0 };
  }

  /** `finish` for the synchronous methods: no re-read, so a running server needs a restart. */
  private finishSync(t: Target, changedKeys: string[]): ApplyResult {
    if (!['running', 'starting'].includes(this.d.feed.status_?.state ?? '')) return { applied: 'next-start', warnings: [], restartNeeded: false };
    const pending = this.restartReasons(t, changedKeys, true);
    this.markPending(pending);
    return { applied: 'next-start', warnings: [], restartNeeded: pending.length > 0 };
  }

  private noteFor(changedKeys: string[], reapplied: ReappliedKey[]): string {
    const own = changedKeys.filter((k) => !reapplied.some((r) => r.key === k));
    return own.length ? `changed ${own.join(', ')}` : 'raw edit';
  }

  // ------------------------------------------------- the editor (CFG-07…09)

  async meta(): Promise<ConfigMeta> {
    const presets = await this.presets();
    return {
      files: this.decls().map((f) => ({
        id: f.id,
        label: f.label ?? null,
        format: f.format,
        schemaId: f.schemaId ?? null,
        managedKeys: f.managedKeys,
        secretKeys: f.secretKeys,
        restartKeys: f.restartKeys,
      })),
      schemas: this.d.adapter.config.schemas,
      presets,
      presetFile: this.d.adapter.config.presets?.fileId ?? null,
    };
  }

  private valuesSync(fileId: string): { values: Record<string, Scalar>; missing: boolean; sha256: string | null } {
    const t = this.target(fileId);
    const text = this.readText(t);
    if (text === null) return { values: {}, missing: true, sha256: null };
    const r = t.format.parse(text);
    if (!r.ok) throw new HttpError(409, 'invalid-file', undefined, { issues: r.issues });
    const values = t.format.flatten(r.doc);
    for (const k of t.decl?.secretKeys ?? []) if (values[k] !== undefined && String(values[k]) !== '') values[k] = MASK;
    return { values, missing: false, sha256: this.shaOf(t, text) };
  }

  async values(fileId: string): Promise<{ values: Record<string, Scalar>; missing: boolean; sha256: string | null }> {
    return this.valuesSync(fileId);
  }

  async listFiles(): Promise<{ files: DeclaredFile[]; folders: EditableFolder[] }> {
    const decls = this.decls();
    const files: DeclaredFile[] = [];
    for (const d of decls) {
      const t = this.declTarget(d);
      let exists = false;
      try {
        exists = (await this.d.files.stat(t.root, t.rel))?.kind === 'file';
      } catch {
        // A path the files refuse (a link on the way): not there as far as the editor goes.
      }
      files.push({
        id: d.id,
        label: d.label ?? null,
        root: d.root,
        rel: d.rel,
        format: d.format,
        highlight: t.format.highlight,
        schemaId: d.schemaId ?? null,
        exists,
        editable: exists && t.reason === null,
        reason: t.reason ?? (exists ? null : 'missing'),
        managedKeys: d.managedKeys,
        secretKeys: d.secretKeys,
        restartKeys: d.restartKeys,
      });
    }
    const folders: EditableFolder[] = [];
    for (const f of this.folders()) folders.push(await this.walk(f, decls));
    return { files, folders };
  }

  /** An editable folder's tree: files its globs include (with why each can't be edited), folders that hold some. */
  private async walk(folder: EditableRoot, decls: ConfigFileDecl[]): Promise<EditableFolder> {
    let count = 0;
    let truncated = false;
    const base = folder.rel.replace(/^\/+|\/+$/g, '');
    const full = (inner: string) => (base ? `${base}/${inner}` : inner);
    const visit = async (inner: string, depth: number): Promise<TreeEntry[]> => {
      let entries: DirEntry[];
      try {
        entries = await this.d.files.list(folder.root, inner ? full(inner) : base);
      } catch {
        return [];
      }
      const out: TreeEntry[] = [];
      for (const e of entries) {
        if (count >= TREE_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        const path = inner ? `${inner}/${e.name}` : e.name;
        const rel = full(path);
        try {
          segments(rel);
        } catch {
          continue;
        }
        if (e.kind === 'dir') {
          if (depth >= TREE_MAX_DEPTH || excludedDir(folder, path)) continue;
          const children = await visit(path, depth + 1);
          if (children.length) out.push({ name: e.name, path, id: pathId(folder.root, rel), kind: 'dir', size: 0, editable: false, reason: null, children });
          continue;
        }
        if (!included(folder, path)) continue;
        count++;
        const decl = decls.find((x) => x.root === folder.root && x.rel === rel);
        let reason: ReadonlyReason | null = e.kind === 'symlink' ? 'symlink' : e.kind !== 'file' ? 'not-a-file' : nameReason(folder.root, rel, { dataOnly: !!decl?.dataOnly });
        if (!reason && e.size > MAX_TEXT_BYTES) reason = 'too-large';
        out.push({ name: e.name, path, id: decl?.id ?? pathId(folder.root, rel), kind: 'file', size: e.size, editable: reason === null, reason });
      }
      return out;
    };
    const entries = await visit('', 0);
    return { id: folder.id, label: folder.label, root: folder.root, rel: base, entries, truncated };
  }

  async content(fileId: string): Promise<FileContent> {
    const t = this.target(fileId);
    if (t.reason && UNREADABLE.has(t.reason)) throw new HttpError(403, 'not-editable', undefined, { reason: t.reason });
    const text = this.requireText(t);
    const r = t.format.parse(text);
    return {
      id: t.id,
      text: this.mask(t, text),
      format: t.decl?.format ?? formatIdForName(t.rel),
      highlight: t.format.highlight,
      sha256: this.shaOf(t, text),
      managedKeys: t.decl?.managedKeys ?? [],
      secretKeys: t.decl?.secretKeys ?? [],
      readonlyReason: t.reason,
      issues: r.ok ? [] : r.issues,
      dataOnly: t.decl?.dataOnly ?? null,
    };
  }

  async prepare(req: ChangeRequest): Promise<PreparedChange> {
    const t = this.target(req.fileId);
    this.assertSavable(t);
    const disk = this.requireText(t);
    const baseSha256 = this.shaOf(t, disk);
    if (req.baseSha256 !== undefined && req.baseSha256 !== baseSha256) throw new HttpError(409, 'stale');
    let proposed: string;
    let note: string | null = null;
    if (req.text !== undefined) proposed = req.text;
    else if (req.changes) proposed = this.proposedFromChanges(t, disk, req.changes);
    else if (req.preset !== undefined) {
      const values = await this.loadPreset(req.preset, t.id);
      const current = this.flat(t, disk);
      proposed = this.proposedFromChanges(t, disk, Object.fromEntries(Object.entries(values).filter(([k]) => k in current)));
      note = `preset ${req.preset}`;
    } else if (req.revert !== undefined) {
      const row = this.d.db.prepare('SELECT content FROM config_versions WHERE id = ? AND file = ?').get(req.revert, t.id) as { content: string } | undefined;
      if (!row) throw new HttpError(404, 'not-found');
      proposed = row.content;
      note = `revert to version ${req.revert}`;
    } else throw new HttpError(400, 'validation');
    const p = this.prepareText(t, disk, proposed);
    const changed = new Set(p.changedKeys);
    return {
      fileId: t.id,
      baseSha256,
      content: this.remask(t, p.next, disk),
      before: this.mask(t, disk),
      after: this.mask(t, p.next, changed),
      unchanged: p.next === disk,
      issues: p.warnings,
      reapplied: p.reapplied,
      changedKeys: p.changedKeys,
      applies: this.appliesOf(t, p.changedKeys),
      note: (req.note?.trim() || note || this.noteFor(p.changedKeys, p.reapplied)).slice(0, 300),
    };
  }

  async commit(fileId: string, content: string, by: string | null, note: string, o: { baseSha256?: string; managed?: boolean } = {}): Promise<CommitResult> {
    const t = this.target(fileId);
    this.assertSavable(t);
    this.assertWritable();
    const disk = this.requireText(t);
    if (o.baseSha256 !== undefined && o.baseSha256 !== this.shaOf(t, disk)) throw new HttpError(409, 'stale');
    const p = this.prepareText(t, disk, content, { managed: o.managed });
    if (p.next === disk) return { applied: 'unchanged', warnings: [], restartNeeded: false, reapplied: p.reapplied, changedKeys: [], sha256: this.shaOf(t, disk) };
    this.writeSync(t, disk, p.next, by, note);
    const r = await this.finish(t, p.changedKeys, by);
    return { ...r, reapplied: p.reapplied, changedKeys: p.changedKeys, sha256: this.shaOf(t, p.next) };
  }

  async compare(fileId: string, content: string): Promise<{ before: string; after: string; sha256: string | null }> {
    const t = this.target(fileId);
    const disk = this.readText(t);
    return { before: disk === null ? '' : this.mask(t, disk), after: this.mask(t, content), sha256: disk === null ? null : this.shaOf(t, disk) };
  }

  // ---------------------------------------------------------------- history

  private snapshot(file: string, content: string, by: string | null, note: string): void {
    this.d.db.prepare('INSERT INTO config_versions (file, at, username, note, content) VALUES (?,?,?,?,?)').run(file, nowIso(), by, note, content);
    this.d.db
      .prepare('DELETE FROM config_versions WHERE file = ? AND id NOT IN (SELECT id FROM config_versions WHERE file = ? ORDER BY id DESC LIMIT ?)')
      .run(file, file, HISTORY_KEEP);
  }

  private latestContent(file: string): string | null {
    const r = this.d.db.prepare('SELECT content FROM config_versions WHERE file = ? ORDER BY id DESC LIMIT 1').get(file) as { content: string } | undefined;
    return r?.content ?? null;
  }

  historyOf(fileId: string): FileVersionRow[] {
    const t = this.target(fileId);
    return this.d.db.prepare('SELECT id, file, at, username, note, length(content) AS size FROM config_versions WHERE file = ? ORDER BY id DESC').all(t.id) as unknown as FileVersionRow[];
  }

  history(file: ConfigFile): VersionRow[] {
    return this.historyOf(file) as VersionRow[];
  }

  /** A version and the one before it, secrets masked, for a diff view. */
  version(id: number): { row: VersionRow; content: string; previous: string | null } {
    const row = this.d.db.prepare('SELECT id, file, at, username, note, length(content) AS size, content FROM config_versions WHERE id = ?').get(id) as
      | (VersionRow & { content: string })
      | undefined;
    if (!row) throw new HttpError(404, 'not-found');
    const prev = this.d.db.prepare('SELECT content FROM config_versions WHERE file = ? AND id < ? ORDER BY id DESC LIMIT 1').get(row.file, id) as { content: string } | undefined;
    let mask = (text: string) => text;
    try {
      const t = this.target(row.file);
      mask = (text) => this.mask(t, text);
    } catch {
      // A file no longer declared or editable has no secrets to mask.
    }
    const { content, ...meta } = row;
    return { row: meta, content: mask(content), previous: prev ? mask(prev.content) : null };
  }

  async revert(id: number, by: string | null): Promise<ApplyResult> {
    const row = this.d.db.prepare('SELECT file, content FROM config_versions WHERE id = ?').get(id) as { file: string; content: string } | undefined;
    if (!row) throw new HttpError(404, 'not-found');
    const { reapplied: _r, changedKeys: _c, sha256: _s, ...result } = await this.commit(row.file, row.content, by, `revert to version ${id}`);
    return result;
  }

  // -------------------------------------------------------- pending restart

  pendingRestart(): PendingRestart | null {
    const p = this.d.settings.getRaw<PendingRestart>('pendingRestart');
    if (!p) return null;
    const ready = this.d.feed.status_?.readyAt;
    if (ready && ready > p.since) {
      this.d.settings.setRaw('pendingRestart', null);
      return null;
    }
    return p;
  }

  /** For other services (mods) whose changes need a restart. */
  markPendingPublic(reasons: string[]): void {
    this.markPending(reasons);
  }

  private markPending(reasons: string[]): void {
    if (reasons.length === 0) return;
    const cur = this.pendingRestart();
    this.d.settings.setRaw<PendingRestart>('pendingRestart', {
      since: cur?.since ?? nowIso(),
      reasons: Array.from(new Set([...(cur?.reasons ?? []), ...reasons])).slice(0, 50),
    });
  }

  // ------------------------------------------------------------ first run

  async seedIfMissing(): Promise<boolean> {
    let seeded = false;
    for (const d of this.decls()) {
      const t = this.declTarget(d);
      if (!d.seed || !t.format.create || this.d.files.statSync(t.root, t.rel)) continue;
      this.writeSync(t, null, t.format.create(d.seed), null, 'first-run defaults');
      seeded = true;
    }
    return seeded;
  }

  async setDirect(fileId: string, values: Record<string, Scalar>, by: string | null, note: string): Promise<void> {
    const t = this.target(fileId);
    if (!t.decl) throw new HttpError(404, 'unknown-file');
    const disk = this.readText(t);
    if (disk === null) return;
    const next = t.format.edit(disk, values);
    if (next !== disk) this.writeSync(t, disk, next, by, note);
  }

  // ------------------------------------ frozen methods (other services, M1)

  read(file: ConfigFile): string | null {
    return this.readText(this.target(file));
  }

  iniMeta(): OptionMeta[] {
    return this.schemaOf(this.target('ini')) ?? [];
  }

  getIni(): { values: Record<string, string>; missing: boolean } {
    const { values, missing } = this.valuesSync('ini');
    return { values: values as Record<string, string>, missing };
  }

  async applyIni(changes: Record<string, string>, by: string | null): Promise<ApplyResult> {
    return this.applyChanges('ini', changes, by);
  }

  getIniRaw(): string {
    return this.mask(this.target('ini'), this.requireText(this.target('ini')));
  }

  async putIniRaw(text: string, by: string | null, note = 'raw edit', opts: { keepManagedFromDisk?: boolean } = {}): Promise<ApplyResult> {
    const { reapplied: _r, changedKeys: _c, sha256: _s, ...result } = await this.commit('ini', text, by, note, { managed: opts.keepManagedFromDisk !== false });
    return result;
  }

  sandboxMeta(): OptionMeta[] {
    return this.schemaOf(this.target('sandbox')) ?? [];
  }

  getSandbox(): { values: Record<string, string | number | boolean | null>; missing: boolean } {
    const { values, missing } = this.valuesSync('sandbox');
    return { values, missing };
  }

  applySandbox(changes: Record<string, LuaEdit>, by: string | null, opts: { force?: boolean } = {}): ApplyResult {
    return this.applyChangesSync('sandbox', changes, by, opts);
  }

  getLuaRaw(file: Exclude<ConfigFile, 'ini'>): string {
    return this.requireText(this.target(file));
  }

  async putLuaRaw(file: Exclude<ConfigFile, 'ini'>, text: string, by: string | null, note = 'raw edit'): Promise<ApplyResult> {
    const { reapplied: _r, changedKeys: _c, sha256: _s, ...result } = await this.commit(file, text, by, note);
    return result;
  }

  private async applyChanges(fileId: string, changes: Record<string, Scalar>, by: string | null): Promise<ApplyResult> {
    const t = this.target(fileId);
    this.assertSavable(t);
    this.assertWritable();
    const disk = this.requireText(t);
    const p = this.prepareText(t, disk, this.proposedFromChanges(t, disk, changes));
    if (p.next === disk) return { applied: 'unchanged', warnings: [], restartNeeded: false };
    this.writeSync(t, disk, p.next, by, this.noteFor(p.changedKeys, p.reapplied));
    return this.finish(t, p.changedKeys, by);
  }

  private applyChangesSync(fileId: string, changes: Record<string, Scalar>, by: string | null, opts: { force?: boolean; note?: string } = {}): ApplyResult {
    const t = this.target(fileId);
    this.assertSavable(t);
    if (!opts.force) this.assertWritable();
    const disk = this.requireText(t);
    const p = this.prepareText(t, disk, this.proposedFromChanges(t, disk, changes));
    if (p.next === disk) return { applied: 'unchanged', warnings: [], restartNeeded: false };
    this.writeSync(t, disk, p.next, by, opts.note ?? this.noteFor(p.changedKeys, p.reapplied));
    return this.finishSync(t, p.changedKeys);
  }

  // ---------------------------------------------------------------- presets

  /** The adapter's presets that load, listed now (a preset installed since the panel started counts). */
  async presets(): Promise<string[]> {
    const presets = this.d.adapter.config.presets;
    if (!presets) return [];
    const ctx = this.ctx();
    let names: string[];
    try {
      names = await presets.list(ctx);
    } catch {
      // No preset folder (nothing installed yet).
      return [];
    }
    const out: string[] = [];
    for (const name of names) {
      try {
        await presets.load(ctx, name);
        out.push(name);
      } catch {
        // A preset that doesn't load isn't offered.
      }
    }
    return out;
  }

  /** A preset's values for `fileId`, the file the adapter says presets apply to; 404 otherwise. */
  private async loadPreset(name: string, fileId: string): Promise<Record<string, Scalar>> {
    const presets = this.d.adapter.config.presets;
    if (!presets || presets.fileId !== fileId) throw new HttpError(404, 'not-found');
    const ctx = this.ctx();
    try {
      if (!(await presets.list(ctx)).includes(name)) throw new Error('not a preset');
      return await presets.load(ctx, name);
    } catch {
      throw new HttpError(404, 'not-found');
    }
  }

  /** Copies a game preset's values onto its file, for options both have. */
  async applyPreset(name: string, by: string | null, opts: { force?: boolean } = {}): Promise<ApplyResult & { applied_keys: number }> {
    const fileId = this.d.adapter.config.presets?.fileId;
    if (!fileId) throw new HttpError(404, 'not-found');
    const values = await this.loadPreset(name, fileId);
    const t = this.target(fileId);
    const current = this.flat(t, this.requireText(t));
    const changes = Object.fromEntries(Object.entries(values).filter(([k]) => k in current));
    const r = this.applyChangesSync(fileId, changes, by, { ...opts, note: `preset ${name}` });
    return { ...r, applied_keys: Object.keys(changes).length };
  }
}
