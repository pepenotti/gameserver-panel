import { randomUUID } from 'node:crypto';
import type { Scalar } from '@gsp/adapter-api';
import type { ParseIssue } from '@gsp/formats';
import { diffLines, withContext, type DiffLine } from '@gsp/shared';
import type { CommitResult, ConfigStore, ReappliedKey } from '../config/store';
import { nowIso, type Db } from '../db/db';
import { HttpError } from '../http/context';

/**
 * Change proposals (AST-03): a settings or file change is submitted, shown
 * as a diff, and applied only when a person approves it. Forms, the text
 * editor, presets and reverts all go through it (CFG-07), and so will a
 * future assistant (D8), acting as the signed-in user.
 */

export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'stale' | 'expired';
export const PROPOSAL_STATUSES: readonly ProposalStatus[] = ['pending', 'applied', 'rejected', 'stale', 'expired'];

/** Who submitted it (AST-02 grows this list). */
export type ActorType = 'user' | 'schedule' | 'assistant';

/** Pending proposals older than this can no longer be applied. */
export const PROPOSAL_TTL_MS = 7 * 24 * 3_600_000;
const KEEP_DECIDED = 500;

export interface ProposalInput {
  /** A declared config file id (`ini`) or `path:<root>/<rel>` in an editable folder. */
  fileId: string;
  /** The whole new text (text editor)… */
  text?: string;
  /** …or key changes (forms); null removes a key… */
  changes?: Record<string, Scalar | null>;
  /** …or a preset's values… */
  preset?: string;
  /** …or a history version to go back to. */
  revert?: number;
  /** The file the change was made against (`sha256` of the content view); another one on disk is `stale`. */
  baseSha256?: string;
  note?: string;
}

export interface Proposal {
  id: string;
  serverId: string | null;
  fileId: string;
  baseSha256: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  actorType: string;
  status: ProposalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  /** What applying it did (`ApplyResult` plus re-applied keys), or why it failed. */
  result: unknown;
}

/** What a submitted change would do. `id` is null when it would change nothing. */
export interface ProposalPreview {
  id: string | null;
  fileId: string;
  /** Changed lines with three lines of context; null marks a gap. Secrets masked. */
  diff: (DiffLine | null)[];
  /** Non-blocking problems; blocking ones are a 400 `invalid-file` with `issues`. */
  issues: ParseIssue[];
  reapplied: ReappliedKey[];
  changedKeys: string[];
  applies: 'live' | 'restart';
}

export interface ProposalView extends Proposal {
  /** Against the file as it is now. */
  diff: (DiffLine | null)[];
}

export type ProposalOutcome = Omit<CommitResult, 'sha256'> & { proposal: Proposal };

export interface ProposalService {
  propose(input: ProposalInput, by: string | null, actorType?: ActorType): Promise<ProposalPreview>;
  apply(id: string, by: string | null): Promise<ProposalOutcome>;
  reject(id: string, by: string | null): Proposal;
  list(opts?: { status?: ProposalStatus; fileId?: string }): Proposal[];
  get(id: string): Promise<ProposalView>;
}

interface Row {
  id: string;
  server_id: string | null;
  file_id: string;
  base_sha256: string;
  content: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  actor_type: string;
  status: ProposalStatus;
  decided_by: string | null;
  decided_at: string | null;
  result: string | null;
}

const COLUMNS = 'id, server_id, file_id, base_sha256, content, note, created_by, created_at, actor_type, status, decided_by, decided_at, result';

function toProposal(r: Row): Proposal {
  return {
    id: r.id,
    serverId: r.server_id,
    fileId: r.file_id,
    baseSha256: r.base_sha256,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
    actorType: r.actor_type,
    status: r.status,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    result: r.result === null ? null : (JSON.parse(r.result) as unknown),
  };
}

export interface ProposalDeps {
  db: Db;
  /** The config store proposals are validated and applied by (a getter: it is built next to this service). */
  config: () => ConfigStore;
  /** Null while there is one server (M1). */
  serverId?: string | null;
}

export class ConfigProposals implements ProposalService {
  /** Proposals being applied right now: a second apply of one of them is refused. */
  private readonly applying = new Set<string>();

  constructor(private readonly d: ProposalDeps) {}

  private row(id: string): Row {
    this.expireOld();
    const r = this.d.db.prepare(`SELECT ${COLUMNS} FROM proposals WHERE id = ?`).get(id) as Row | undefined;
    if (!r) throw new HttpError(404, 'not-found');
    return r;
  }

  private expireOld(): void {
    const cutoff = new Date(Date.now() - PROPOSAL_TTL_MS).toISOString();
    this.d.db.prepare("UPDATE proposals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at < ?").run(nowIso(), cutoff);
  }

  private decide(id: string, status: ProposalStatus, by: string | null, result: unknown): void {
    this.d.db.prepare('UPDATE proposals SET status = ?, decided_by = ?, decided_at = ?, result = ? WHERE id = ?').run(status, by, nowIso(), result === undefined ? null : JSON.stringify(result), id);
  }

  async propose(input: ProposalInput, by: string | null, actorType: ActorType = 'user'): Promise<ProposalPreview> {
    const p = await this.d.config().prepare(input);
    const preview = { fileId: p.fileId, issues: p.issues, reapplied: p.reapplied, changedKeys: p.changedKeys, applies: p.applies };
    if (p.unchanged) return { id: null, diff: [], ...preview };
    const id = randomUUID();
    this.d.db
      .prepare('INSERT INTO proposals (id, server_id, file_id, base_sha256, content, note, created_by, created_at, actor_type, status) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, this.d.serverId ?? null, p.fileId, p.baseSha256, p.content, p.note, by, nowIso(), actorType, 'pending');
    this.d.db
      .prepare(`DELETE FROM proposals WHERE status != 'pending' AND id NOT IN (SELECT id FROM proposals WHERE status != 'pending' ORDER BY created_at DESC LIMIT ${KEEP_DECIDED})`)
      .run();
    return { id, diff: withContext(diffLines(p.before, p.after)), ...preview };
  }

  async apply(id: string, by: string | null): Promise<ProposalOutcome> {
    const row = this.row(id);
    if (row.status !== 'pending' || this.applying.has(id)) throw new HttpError(409, row.status === 'expired' ? 'expired' : 'not-pending', undefined, { status: row.status });
    this.applying.add(id);
    try {
      let r: CommitResult;
      try {
        r = await this.d.config().commit(row.file_id, row.content, by, row.note ?? 'raw edit', { baseSha256: row.base_sha256 });
      } catch (e) {
        if (e instanceof HttpError && e.code === 'stale') this.decide(id, 'stale', by, { error: 'stale' });
        throw e;
      }
      const { sha256, ...result } = r;
      this.decide(id, 'applied', by, result);
      // Other pending changes to this file were made against the text it had before.
      this.d.db
        .prepare("UPDATE proposals SET status = 'stale', decided_at = ? WHERE file_id = ? AND status = 'pending' AND id != ? AND base_sha256 != ?")
        .run(nowIso(), row.file_id, id, sha256);
      return { ...result, proposal: toProposal(this.row(id)) };
    } finally {
      this.applying.delete(id);
    }
  }

  reject(id: string, by: string | null): Proposal {
    const row = this.row(id);
    if (row.status !== 'pending' || this.applying.has(id)) throw new HttpError(409, 'not-pending', undefined, { status: row.status });
    this.decide(id, 'rejected', by, undefined);
    return toProposal(this.row(id));
  }

  list(opts: { status?: ProposalStatus; fileId?: string } = {}): Proposal[] {
    this.expireOld();
    const where: string[] = [];
    const args: string[] = [];
    if (opts.status) {
      where.push('status = ?');
      args.push(opts.status);
    }
    if (opts.fileId) {
      where.push('file_id = ?');
      args.push(opts.fileId);
    }
    const sql = `SELECT ${COLUMNS} FROM proposals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT 200`;
    return (this.d.db.prepare(sql).all(...args) as unknown as Row[]).map(toProposal);
  }

  async get(id: string): Promise<ProposalView> {
    const row = this.row(id);
    const { before, after } = await this.d.config().compare(row.file_id, row.content);
    return { ...toProposal(row), diff: withContext(diffLines(before, after)) };
  }
}
