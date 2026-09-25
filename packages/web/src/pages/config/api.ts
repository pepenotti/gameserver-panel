// The config API as the web uses it: forms, the text editor and proposals
// (CFG-01…10, AST-03). Types mirror packages/panel/src/config/store.ts and
// packages/panel/src/proposals/service.ts.
import { useTranslation } from 'react-i18next';
import type { DataShape, FormatId, Highlight, OptionMeta, ParseIssue } from '@gsp/formats';
import type { DiffLine } from '@gsp/shared';
import type { ServerApi } from '../../api/http';

export type Value = string | number | boolean | null;

export interface ApplyResult {
  applied: 'live' | 'next-start' | 'unchanged';
  warnings: string[];
  restartNeeded: boolean;
}

export interface ReappliedKey {
  key: string;
  value: string | null;
  why: 'set-by-panel' | 'managed';
}

export interface FileDecl {
  id: string;
  format: FormatId;
  schemaId: string | null;
  managedKeys: string[];
  secretKeys: string[];
  restartKeys: string[] | '*';
}

export interface ConfigMeta {
  files: FileDecl[];
  schemas: Record<string, OptionMeta[]>;
  presets: string[];
  presetFile: string | null;
}

export type ReadonlyReason = 'outside-roots' | 'install-root' | 'symlink' | 'not-a-file' | 'too-large' | 'binary' | 'script' | 'not-utf8';

export interface DeclaredFile extends FileDecl {
  root: string;
  rel: string;
  highlight: Highlight;
  exists: boolean;
  editable: boolean;
  reason: ReadonlyReason | 'missing' | null;
}

export interface TreeEntry {
  name: string;
  path: string;
  id: string;
  kind: 'file' | 'dir';
  size: number;
  editable: boolean;
  reason: ReadonlyReason | null;
  children?: TreeEntry[];
}

export interface EditableFolder {
  id: string;
  label: { en: string; es: string };
  root: string;
  rel: string;
  entries: TreeEntry[];
  truncated: boolean;
}

export interface FilesView {
  files: DeclaredFile[];
  folders: EditableFolder[];
}

export interface FileContent {
  id: string;
  text: string;
  format: FormatId;
  highlight: Highlight;
  sha256: string;
  managedKeys: string[];
  secretKeys: string[];
  readonlyReason: ReadonlyReason | null;
  issues: ParseIssue[];
  dataOnly: DataShape | null;
}

export interface ProposalPreview {
  /** Null when nothing would change. */
  id: string | null;
  fileId: string;
  diff: (DiffLine | null)[];
  issues: ParseIssue[];
  reapplied: ReappliedKey[];
  changedKeys: string[];
  applies: 'live' | 'restart';
}

export interface Proposal {
  id: string;
  fileId: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  actorType: string;
  status: 'pending' | 'applied' | 'rejected' | 'stale' | 'expired';
}

export type ProposalView = Proposal & Omit<ProposalPreview, 'id' | 'fileId'>;

export type ApplyOutcome = ApplyResult & { reapplied: ReappliedKey[]; changedKeys: string[]; proposal: Proposal };

export interface ChangeBody {
  fileId: string;
  text?: string;
  changes?: Record<string, Value>;
  preset?: string;
  revert?: number;
  baseSha256?: string;
  note?: string;
}

// The server's config routes (`sapi`: the page's server, from `useServerApi()`).
export const propose = (sapi: ServerApi, body: ChangeBody) => sapi<ProposalPreview>('POST', '/config/proposals', body);
export const applyProposal = (sapi: ServerApi, id: string) => sapi<ApplyOutcome>('POST', `/config/proposals/${id}/apply`, {});
export const rejectProposal = (sapi: ServerApi, id: string) => sapi<Proposal>('POST', `/config/proposals/${id}/reject`, {});
export const getProposal = (sapi: ServerApi, id: string) => sapi<ProposalView>('GET', `/config/proposals/${id}`);
export const getContent = (sapi: ServerApi, id: string) => sapi<FileContent>('GET', `/config/files/content?id=${encodeURIComponent(id)}`);

/** A file's name for people: the declared files have one; others show their path. */
export function useFileLabel(): (id: string) => string {
  const { t } = useTranslation();
  return (id) => {
    if (id.startsWith('path:')) return id.slice('path:'.length).replace(/^[^/]+\//, '');
    return t(`config.files.${id}`, { defaultValue: id });
  };
}
