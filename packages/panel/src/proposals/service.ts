import type { RootId, Scalar } from '@gsp/adapter-api';
import { HttpError } from '../http/context';

/**
 * Change proposals (AST-03): a settings or file change is submitted, shown
 * as a diff, and applied only when a person approves it. The text editor's
 * preview (CFG-07) goes through the same flow. Placeholder types: the
 * implementation (M1-C) refines them and adds the `proposals` table
 * (migration 5, reserved in db/db.ts).
 */

export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'stale';

/** What a proposal changes: a declared config file (by id) or a file in an editable folder. */
export type ProposalTarget = { kind: 'config'; fileId: string } | { kind: 'file'; root: RootId; rel: string };

export interface ProposalInput {
  target: ProposalTarget;
  /** The whole new text (raw editor)… */
  text?: string;
  /** …or key changes (forms); null removes a key. */
  changes?: Record<string, Scalar | null>;
  note?: string;
}

export interface Proposal {
  id: number;
  status: ProposalStatus;
  target: ProposalTarget;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  /** Text before and after, secrets masked, for the diff view. */
  before: string | null;
  after: string;
}

export interface ProposalService {
  propose(input: ProposalInput, by: string | null): Promise<Proposal>;
  apply(id: number, by: string | null): Promise<Proposal>;
  reject(id: number, by: string | null): Promise<Proposal>;
  list(opts?: { status?: ProposalStatus }): Proposal[];
  get(id: number): Proposal;
}

/** Stands in until proposals are implemented (M1-C): every call answers 501. */
export class UnimplementedProposals implements ProposalService {
  private no(): never {
    throw new HttpError(501, 'not-implemented');
  }
  async propose(): Promise<Proposal> {
    return this.no();
  }
  async apply(): Promise<Proposal> {
    return this.no();
  }
  async reject(): Promise<Proposal> {
    return this.no();
  }
  list(): Proposal[] {
    return this.no();
  }
  get(): Proposal {
    return this.no();
  }
}
