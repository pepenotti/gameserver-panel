import type { FormatId, I18n, OptionMeta, RootId, Scalar } from '@gsp/adapter-api';
import type { DataShape, Highlight, ParseIssue } from '@gsp/formats';
import type { ReadonlyReason } from '../files/policy';

/**
 * The server's settings as routes and other services use them. Services
 * depend on this interface, not on the class.
 *
 * Every method that touches the server's files is asynchronous: they are
 * read and written through `ServerFiles`, which reaches them through the
 * server's agent from M2 (D11). History, the pending-restart badge and the
 * adapter's declarations live in the panel and stay synchronous.
 */

export interface PendingRestart {
  since: string;
  reasons: string[];
}

/** A version of a file: `file` is a declared id (`ini`) or `path:<root>/<rel>`. */
export interface VersionRow {
  id: number;
  file: string;
  at: string;
  username: string | null;
  note: string | null;
  size: number;
}

export interface ApplyResult {
  /** `live`: the running server re-read it; `next-start`: takes effect when it (re)starts. */
  applied: 'live' | 'next-start' | 'unchanged';
  /** Options the game rejected when re-reading (from its log). */
  warnings: string[];
  restartNeeded: boolean;
}

// ------------------------------------------------------- the editor (CFG-07)

/** A panel-managed key the panel put back on save (CFG-04, CFG-08). */
export interface ReappliedKey {
  key: string;
  /** What it is now (masked when secret); null when the key was removed. */
  value: string | null;
  /** `set-by-panel`: the panel sets this value; `managed`: the panel owns the key, so it keeps what is on disk. */
  why: 'set-by-panel' | 'managed';
}

export interface DeclaredFile {
  id: string;
  /** The adapter's name for the file (`ConfigFileDecl.label`); null: show the file name. */
  label: I18n | null;
  root: RootId;
  rel: string;
  format: FormatId;
  highlight: Highlight;
  schemaId: string | null;
  exists: boolean;
  editable: boolean;
  /** Why it can't be edited; `missing` until the game first writes it. */
  reason: ReadonlyReason | 'missing' | null;
  managedKeys: string[];
  secretKeys: string[];
  restartKeys: string[] | '*';
}

export interface TreeEntry {
  name: string;
  /** Relative to the editable folder. */
  path: string;
  /** What `content` and proposals take: a declared id, or `path:<root>/<rel>`. */
  id: string;
  kind: 'file' | 'dir';
  size: number;
  editable: boolean;
  reason: ReadonlyReason | null;
  children?: TreeEntry[];
}

export interface EditableFolder {
  id: string;
  label: I18n;
  root: RootId;
  rel: string;
  entries: TreeEntry[];
  /** More files than the tree shows. */
  truncated: boolean;
}

export interface FileContent {
  id: string;
  /** Secrets masked. */
  text: string;
  format: FormatId;
  highlight: Highlight;
  /** Of the text with secrets masked: what a proposal's `baseSha256` must match. */
  sha256: string;
  managedKeys: string[];
  secretKeys: string[];
  /** Null when the file can be saved. */
  readonlyReason: ReadonlyReason | null;
  /** Problems of the text as it is on disk. */
  issues: ParseIssue[];
  /** The shape a file the game executes must keep (the editor checks it as you type). */
  dataOnly: DataShape | null;
}

export interface ConfigMeta {
  files: Pick<DeclaredFile, 'id' | 'label' | 'format' | 'schemaId' | 'managedKeys' | 'secretKeys' | 'restartKeys'>[];
  schemas: Record<string, OptionMeta[]>;
  presets: string[];
  /** The file presets apply to (the adapter's `config.presets.fileId`). */
  presetFile: string | null;
}

/** A change to one file: the whole new text, key changes (forms; null removes), a preset, or a version to go back to. */
export interface ChangeRequest {
  fileId: string;
  text?: string;
  changes?: Record<string, Scalar | null>;
  preset?: string;
  revert?: number;
  /** The `sha256` the change was made against; a different file on disk is `stale` (409). */
  baseSha256?: string;
  note?: string;
}

export interface PreparedChange {
  fileId: string;
  baseSha256: string;
  /** What to store until it is applied: secrets that didn't change stay masked (and come from disk then). */
  content: string;
  /** The file now and after the change, secrets masked, for the diff. */
  before: string;
  after: string;
  unchanged: boolean;
  /** Non-blocking problems (keys the game doesn't know); blocking ones are a 400 `invalid-file`. */
  issues: ParseIssue[];
  reapplied: ReappliedKey[];
  changedKeys: string[];
  /** When the change takes effect (CFG-05). */
  applies: 'live' | 'restart';
  /** The history note it will be written with. */
  note: string;
}

export interface CommitResult extends ApplyResult {
  reapplied: ReappliedKey[];
  changedKeys: string[];
  /** Of the file as written, secrets masked. */
  sha256: string;
}

export interface ConfigStore {
  // ------------------------------------------------------------------ files
  /** A file's text (a declared id or `path:<root>/<rel>`), or null when it doesn't exist. */
  read(fileId: string): Promise<string | null>;
  /** Writes each declared file's first-run `seed` where that file doesn't exist yet; true if one was written. */
  seedIfMissing(): Promise<boolean>;
  /**
   * Internal edits (resets, the mod list; the adapter's `ServerCtx.config`)
   * while the server is stopped: declared files only, no managed-key or busy
   * checks. A file that doesn't exist is left alone.
   */
  setDirect(fileId: string, values: Record<string, Scalar>, by: string | null, note: string): Promise<void>;

  // ---------------------------------------------------------------- history
  /** A file's versions, newest first. */
  historyOf(fileId: string): VersionRow[];
  /** A version and the one before it, secrets masked, for a diff view. */
  version(id: number): { row: VersionRow; content: string; previous: string | null };
  revert(id: number, by: string | null): Promise<ApplyResult>;

  // -------------------------------------------------------- pending restart
  pendingRestart(): PendingRestart | null;
  /** For other services (mods) whose changes need a restart. */
  markPendingPublic(reasons: string[]): void;

  // ---------------------------------------------------------------- presets
  /** The adapter's presets that load, listed now (one installed since the panel started counts). */
  presets(): Promise<string[]>;
  /** Copies a game preset's values onto the file presets apply to, for options both have. */
  applyPreset(name: string, by: string | null, opts?: { force?: boolean }): Promise<ApplyResult & { applied_keys: number }>;

  // ------------------------------------------------ the editor (CFG-01…10)
  /** Schemas, declared files and presets: what the forms are built from. */
  meta(): Promise<ConfigMeta>;
  /** A form's values (secrets masked). */
  values(fileId: string): Promise<{ values: Record<string, Scalar>; missing: boolean; sha256: string | null }>;
  /** Declared files and the editable folders' trees. */
  listFiles(): Promise<{ files: DeclaredFile[]; folders: EditableFolder[] }>;
  content(fileId: string): Promise<FileContent>;
  /** Validates a change and shows what it would write; writes nothing. */
  prepare(req: ChangeRequest): Promise<PreparedChange>;
  /** The one write path: validate, re-apply managed keys, history, atomic write, `afterWrite`, pending restart. */
  commit(fileId: string, content: string, by: string | null, note: string, o?: { baseSha256?: string }): Promise<CommitResult>;
  /** `content` against the file now, secrets masked on both sides. */
  compare(fileId: string, content: string): Promise<{ before: string; after: string; sha256: string | null }>;
}
