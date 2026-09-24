import { nowIso, type Db } from './db/db';

export interface AuditEntry {
  id: number;
  at: string;
  userId: number | null;
  username: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  ok: boolean;
}

export interface AuditInput {
  user?: { id: number; username: string } | null;
  action: string;
  target?: string | null;
  /** Free text or an object (stored as JSON). Never put secrets here. */
  detail?: unknown;
  ip?: string | null;
  ok?: boolean;
}

type Listener = (e: AuditEntry) => void;

export class Audit {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly db: Db) {}

  log(e: AuditInput): AuditEntry {
    const detail = e.detail === undefined || e.detail === null ? null : typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail);
    const at = nowIso();
    const r = this.db
      .prepare('INSERT INTO audit (at, user_id, username, action, target, detail, ip, ok) VALUES (?,?,?,?,?,?,?,?)')
      .run(at, e.user?.id ?? null, e.user?.username ?? null, e.action, e.target ?? null, detail?.slice(0, 4000) ?? null, e.ip ?? null, e.ok === false ? 0 : 1);
    const entry: AuditEntry = {
      id: Number(r.lastInsertRowid),
      at,
      userId: e.user?.id ?? null,
      username: e.user?.username ?? null,
      action: e.action,
      target: e.target ?? null,
      detail,
      ip: e.ip ?? null,
      ok: e.ok !== false,
    };
    for (const l of this.listeners) l(entry);
    return entry;
  }

  list(opts: { limit?: number; beforeId?: number; action?: string } = {}): AuditEntry[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.beforeId) {
      where.push('id < ?');
      args.push(opts.beforeId);
    }
    if (opts.action) {
      where.push('action LIKE ?');
      args.push(`${opts.action}%`);
    }
    const sql = `SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      at: r.at as string,
      userId: (r.user_id as number | null) ?? null,
      username: (r.username as string | null) ?? null,
      action: r.action as string,
      target: (r.target as string | null) ?? null,
      detail: (r.detail as string | null) ?? null,
      ip: (r.ip as string | null) ?? null,
      ok: r.ok === 1,
    }));
  }

  onEntry(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
