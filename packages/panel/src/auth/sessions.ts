import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/db';

export const SESSION_COOKIE = '__Host-pzsid';
const IDLE_MS = 7 * 24 * 3_600_000;
const ABSOLUTE_MS = 30 * 24 * 3_600_000;
/** Pending (password-only) sessions waiting for a 2FA code expire quickly. */
const PENDING_MFA_MS = 10 * 60_000;

export interface SessionRow {
  id_hash: string;
  user_id: number;
  csrf: string;
  mfa_ok: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export class Sessions {
  constructor(private readonly db: Db) {}

  /** Returns the raw token for the cookie; only its hash is stored. */
  create(userId: number, opts: { mfaOk: boolean; ip: string | null; userAgent: string | null }): { token: string; csrf: string } {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const now = Date.now();
    const expires = opts.mfaOk ? now + ABSOLUTE_MS : now + PENDING_MFA_MS;
    this.db
      .prepare('INSERT INTO sessions (id_hash, user_id, csrf, mfa_ok, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(hashToken(token), userId, csrf, opts.mfaOk ? 1 : 0, now, now, expires, opts.ip, opts.userAgent?.slice(0, 200) ?? null);
    return { token, csrf };
  }

  /** Looks up a live session and slides its idle window. */
  get(token: string | undefined): SessionRow | null {
    if (!token || token.length > 100) return null;
    const row = this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(hashToken(token)) as SessionRow | undefined;
    if (!row) return null;
    const now = Date.now();
    if (row.expires_at <= now || (row.mfa_ok && now - row.last_seen_at > IDLE_MS)) {
      this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(row.id_hash);
      return null;
    }
    if (now - row.last_seen_at > 60_000) this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, row.id_hash);
    return row;
  }

  /** After 2FA succeeds: the pending session becomes a full one. */
  completeMfa(idHash: string): void {
    const now = Date.now();
    this.db.prepare('UPDATE sessions SET mfa_ok = 1, created_at = ?, expires_at = ? WHERE id_hash = ?').run(now, now + ABSOLUTE_MS, idHash);
  }

  revoke(idHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }

  revokeAllForUser(userId: number, exceptIdHash?: string): number {
    const r = exceptIdHash
      ? this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(userId, exceptIdHash)
      : this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return Number(r.changes);
  }

  listForUser(userId: number): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions WHERE user_id = ? AND mfa_ok = 1 ORDER BY last_seen_at DESC').all(userId) as unknown as SessionRow[];
  }

  purgeExpired(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }
}
