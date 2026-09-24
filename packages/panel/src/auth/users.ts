import { isRole, type Role } from '@pz/shared';
import { nowIso, tx, type Db } from '../db/db';
import { checkPasswordPolicy, hashPassword, type PasswordProblem } from './passwords';
import { delayAfter } from './throttle';
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, verifyTotp } from './totp';

export type Lang = 'en' | 'es';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  lang: Lang;
  totp_secret: string | null;
  totp_enabled: number;
  totp_last_step: number;
  must_change_password: number;
  disabled: number;
  failed_logins: number;
  locked_until: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface PublicUser {
  id: number;
  username: string;
  role: Role;
  lang: Lang;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export class UserError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

const USERNAME = /^[\p{L}\p{N}_.-]{3,32}$/u;

export function toPublic(u: UserRow): PublicUser {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    lang: u.lang,
    totpEnabled: u.totp_enabled === 1,
    mustChangePassword: u.must_change_password === 1,
    disabled: u.disabled === 1,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

function policyError(p: PasswordProblem): never {
  throw new UserError(`password-${p.code}`);
}

export class Users {
  constructor(private readonly db: Db) {}

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  byId(id: number): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
  }

  byName(username: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as UserRow | undefined) ?? null;
  }

  list(): PublicUser[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY id').all() as unknown as UserRow[]).map(toPublic);
  }

  async create(input: { username: string; password: string; role: Role; lang?: Lang; mustChangePassword?: boolean }): Promise<UserRow> {
    const username = input.username.trim();
    if (!USERNAME.test(username)) throw new UserError('invalid-username');
    if (!isRole(input.role)) throw new UserError('invalid-role');
    const problem = checkPasswordPolicy(input.password, username);
    if (problem) policyError(problem);
    if (this.byName(username)) throw new UserError('username-taken');
    if (input.role === 'owner' && this.db.prepare("SELECT 1 FROM users WHERE role = 'owner'").get()) throw new UserError('owner-exists');
    const hash = await hashPassword(input.password);
    const now = nowIso();
    const r = this.db
      .prepare('INSERT INTO users (username, password_hash, role, lang, must_change_password, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(username, hash, input.role, input.lang ?? 'es', input.mustChangePassword ? 1 : 0, now, now);
    return this.byId(Number(r.lastInsertRowid))!;
  }

  async setPassword(id: number, password: string, opts: { mustChange?: boolean } = {}): Promise<void> {
    const u = this.byId(id);
    if (!u) throw new UserError('not-found');
    const problem = checkPasswordPolicy(password, u.username);
    if (problem) policyError(problem);
    const hash = await hashPassword(password);
    this.db
      .prepare('UPDATE users SET password_hash = ?, must_change_password = ?, failed_logins = 0, locked_until = 0, updated_at = ? WHERE id = ?')
      .run(hash, opts.mustChange ? 1 : 0, nowIso(), id);
  }

  setRole(id: number, role: Role): void {
    const u = this.byId(id);
    if (!u) throw new UserError('not-found');
    if (u.role === 'owner' || role === 'owner') throw new UserError('owner-immutable');
    this.db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, nowIso(), id);
  }

  setLang(id: number, lang: Lang): void {
    this.db.prepare('UPDATE users SET lang = ?, updated_at = ? WHERE id = ?').run(lang, nowIso(), id);
  }

  setDisabled(id: number, disabled: boolean): void {
    const u = this.byId(id);
    if (!u) throw new UserError('not-found');
    if (u.role === 'owner') throw new UserError('owner-immutable');
    this.db.prepare('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?').run(disabled ? 1 : 0, nowIso(), id);
  }

  delete(id: number): void {
    const u = this.byId(id);
    if (!u) throw new UserError('not-found');
    if (u.role === 'owner') throw new UserError('owner-immutable');
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------ login state

  recordFailure(id: number): number {
    const u = this.byId(id)!;
    const failures = u.failed_logins + 1;
    const until = Date.now() + delayAfter(failures);
    this.db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(failures, until, id);
    return until;
  }

  recordSuccess(id: number): void {
    this.db.prepare('UPDATE users SET failed_logins = 0, locked_until = 0, last_login_at = ? WHERE id = ?').run(nowIso(), id);
  }

  // ------------------------------------------------------------------- TOTP

  /** Start (or restart) enrolment; the secret is only active after enableTotp. */
  beginTotp(id: number): string {
    const u = this.byId(id);
    if (!u) throw new UserError('not-found');
    if (u.totp_enabled) throw new UserError('totp-already-enabled');
    const secret = newTotpSecret();
    this.db.prepare('UPDATE users SET totp_secret = ?, updated_at = ? WHERE id = ?').run(secret, nowIso(), id);
    return secret;
  }

  /** Confirms enrolment with a first code; returns the one-time recovery codes. */
  enableTotp(id: number, code: string, nowMs = Date.now()): string[] {
    const u = this.byId(id);
    if (!u?.totp_secret) throw new UserError('totp-not-started');
    if (u.totp_enabled) throw new UserError('totp-already-enabled');
    const step = verifyTotp(u.totp_secret, code, nowMs);
    if (step === null) throw new UserError('totp-invalid');
    const codes = newRecoveryCodes();
    tx(this.db, () => {
      this.db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ?, updated_at = ? WHERE id = ?').run(step, nowIso(), id);
      this.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(id);
      const ins = this.db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
      for (const c of codes) ins.run(id, hashRecoveryCode(c));
    });
    return codes;
  }

  disableTotp(id: number): void {
    tx(this.db, () => {
      this.db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0, updated_at = ? WHERE id = ?').run(nowIso(), id);
      this.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(id);
    });
  }

  /** Accepts a fresh TOTP code (never the same step twice) or an unused recovery code. */
  checkSecondFactor(id: number, input: string, nowMs = Date.now()): 'totp' | 'recovery' | null {
    const u = this.byId(id);
    if (!u?.totp_enabled || !u.totp_secret) return null;
    const code = input.trim().replace(/\s/g, '');
    if (/^\d{6}$/.test(code)) {
      const step = verifyTotp(u.totp_secret, code, nowMs);
      if (step === null || step <= u.totp_last_step) return null;
      this.db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, id);
      return 'totp';
    }
    const r = this.db.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').run(nowIso(), id, hashRecoveryCode(code));
    return Number(r.changes) === 1 ? 'recovery' : null;
  }

  unusedRecoveryCodes(id: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(id) as { n: number }).n;
  }
}
