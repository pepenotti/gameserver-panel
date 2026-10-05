// Shared installs as the web shows them (HST-09): what an install holds in a
// few words, what a server's install line and the create form say, and
// which installs the owner may remove. Game-neutral: every name comes from
// the install's key or its adapter. Pure: no React, so tests can import it.
import type { InstallKey, InstallPlan, InstallProgress, InstallView, InstallWanted, ServerInstallView } from '../api/installs';

/**
 * What an install holds, as people read it: its version, branch and build,
 * the ones the game has (`26.3 · 0.19.5`, `public · 25485538`); null when
 * nothing is known yet.
 */
export function installLabel(key: Pick<InstallKey, 'version' | 'build' | 'branch'> | null | undefined): string | null {
  if (!key) return null;
  const parts = [key.version, key.branch, key.build].filter((x): x is string => typeof x === 'string' && x !== '');
  return parts.length ? parts.join(' · ') : null;
}

/** What an install being made was asked for (no key yet): what the launch pinned, else null ("the newest"). */
export function wantedLabel(w: InstallWanted | null | undefined): string | null {
  if (!w) return null;
  const pinned = installLabel(w);
  return pinned === null ? null : w.channel ? `${pinned} (${w.channel})` : pinned;
}

/** A job's progress as a percentage for a bar, or null when the job doesn't say (an indeterminate bar). */
export function jobPercent(job: InstallProgress | null | undefined): number | null {
  if (!job || job.progress === null || !Number.isFinite(job.progress)) return null;
  return Math.max(0, Math.min(100, Math.round(job.progress)));
}

export type ServerInstallLine =
  /** On a shared install: what it holds, shared with how many. */
  | { kind: 'shared'; label: string | null; sharedWith: number; bytes: number | null }
  /** Waiting for its install, being made now (a new server). */
  | { kind: 'installing'; job: InstallProgress | null }
  /** Its install's job failed: the next start (or the move action) tries again. */
  | { kind: 'failed'; error: string | null }
  /** On an install of its own. */
  | { kind: 'own' };

/** The main line of a server's install card. */
export function serverInstallLine(v: ServerInstallView): ServerInstallLine {
  if (v.mode === 'own') return { kind: 'own' };
  if (v.state === 'failed') return { kind: 'failed', error: v.error };
  if (v.state === 'installing' || v.waiting) return { kind: 'installing', job: v.job };
  return { kind: 'shared', label: installLabel(v.key), sharedWith: v.sharedWith, bytes: v.bytes };
}

/**
 * What a server's waiting move says (`ServerInstallView.next`), as a
 * translation key and its values: off its own install, to another version,
 * to another copy of the same version (a file check's), or to other files
 * whose version isn't known yet; null when nothing waits.
 */
export function nextMoveLine(v: ServerInstallView): { key: 'server.install.ownMoves' | 'server.install.next' | 'server.install.nextSame' | 'server.install.nextOther'; values: Record<string, string> } | null {
  if (!v.next) return null;
  if (v.next.id === null) return { key: 'server.install.ownMoves', values: {} };
  const to = installLabel(v.next.key);
  if (!to) return { key: 'server.install.nextOther', values: {} };
  if (to === installLabel(v.key)) return { key: 'server.install.nextSame', values: { label: to } };
  return { key: 'server.install.next', values: { label: to } };
}

/** Whether the server page offers to put a server on its shared install now: one on its own install that moves to one, one whose install failed, one with a move waiting. */
export function canMoveNow(v: ServerInstallView): boolean {
  return v.next !== null || v.state === 'failed';
}

/** The create form's line about a new server's game files (`InstallPlan`), as a translation key and its values; null when there is nothing to say. */
export function planLine(plan: InstallPlan | null | undefined, bytes: (n: number) => string): { key: 'create.installExisting' | 'create.installInstalling' | 'create.installDownload' | 'create.installDownloadUnknown'; values: Record<string, string | number> } | null {
  if (!plan) return null;
  switch (plan.mode) {
    case 'existing':
      return { key: 'create.installExisting', values: { size: plan.bytes === null ? '—' : bytes(plan.bytes), count: plan.servers } };
    case 'installing':
      return { key: 'create.installInstalling', values: { count: plan.servers } };
    case 'download':
      return plan.bytes === null ? { key: 'create.installDownloadUnknown', values: {} } : { key: 'create.installDownload', values: { size: bytes(plan.bytes) } };
    default:
      return null;
  }
}

/** The installs the owner may remove now (nobody uses them, no job runs), and how much they free. */
export function removable(installs: readonly InstallView[]): { ids: string[]; bytes: number } {
  const list = installs.filter((i) => i.removable);
  return { ids: list.map((i) => i.id), bytes: list.reduce((n, i) => n + (i.bytes ?? 0), 0) };
}
