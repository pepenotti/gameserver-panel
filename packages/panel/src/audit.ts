import { nowIso, type Db } from './db/db';

/**
 * Who acted (AST-02): a person, a schedule, the host recovery tool
 * (panelctl), a future assistant acting for a person, or the panel itself.
 */
export type ActorType = 'user' | 'schedule' | 'recovery' | 'assistant' | 'system';
export const ACTOR_TYPES: readonly ActorType[] = ['user', 'schedule', 'recovery', 'assistant', 'system'];

export interface Actor {
  type: ActorType;
  /** The person (type `user`); null when nobody is signed in (a failed login for an unknown name). */
  user?: { id: number; username: string } | null;
  /** The person an `assistant` acts for (their user id). */
  onBehalfOf?: number | null;
}

export const SCHEDULE: Actor = { type: 'schedule' };
export const RECOVERY: Actor = { type: 'recovery' };
export const SYSTEM: Actor = { type: 'system' };

export function userActor(user: { id: number; username: string } | null): Actor {
  return { type: 'user', user: user ? { id: user.id, username: user.username } : null };
}

export interface AuditEntry {
  id: number;
  at: string;
  /** The server it was about; null for host actions (accounts, sign-ins, host settings). */
  serverId: string | null;
  actorType: ActorType;
  userId: number | null;
  username: string | null;
  onBehalfOf: number | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  ok: boolean;
}

export interface AuditInput {
  actor: Actor;
  /** The server it was about (ACC-03); omit for host actions. */
  serverId?: string | null;
  action: string;
  target?: string | null;
  /** Free text or an object (stored as JSON). Never put secrets here. */
  detail?: unknown;
  ip?: string | null;
  ok?: boolean;
}

export interface AuditQuery {
  limit?: number;
  beforeId?: number;
  /** Actions starting with this. */
  action?: string;
  /** Only this server's entries (ACC-03). */
  serverId?: string;
  /** Only entries about one of these servers (or none: host entries are left out). */
  serverIds?: readonly string[];
}

type Listener = (e: AuditEntry) => void;

export class Audit {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly db: Db) {}

  log(e: AuditInput): AuditEntry {
    const detail = e.detail === undefined || e.detail === null ? null : typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail);
    const at = nowIso();
    const user = e.actor.user ?? null;
    const entry: Omit<AuditEntry, 'id'> = {
      at,
      serverId: e.serverId ?? null,
      actorType: e.actor.type,
      userId: user?.id ?? null,
      username: user?.username ?? null,
      onBehalfOf: e.actor.onBehalfOf ?? null,
      action: e.action,
      target: e.target ?? null,
      detail: detail?.slice(0, 4000) ?? null,
      ip: e.ip ?? null,
      ok: e.ok !== false,
    };
    const r = this.db
      .prepare('INSERT INTO audit (at, server_id, actor_type, user_id, username, on_behalf_of, action, target, detail, ip, ok) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(entry.at, entry.serverId, entry.actorType, entry.userId, entry.username, entry.onBehalfOf, entry.action, entry.target, entry.detail, entry.ip, entry.ok ? 1 : 0);
    const full: AuditEntry = { id: Number(r.lastInsertRowid), ...entry, detail };
    for (const l of this.listeners) l(full);
    return full;
  }

  list(opts: AuditQuery = {}): AuditEntry[] {
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
    if (opts.serverId !== undefined) {
      where.push('server_id = ?');
      args.push(opts.serverId);
    }
    if (opts.serverIds !== undefined) {
      if (opts.serverIds.length === 0) return [];
      where.push(`server_id IN (${opts.serverIds.map(() => '?').join(',')})`);
      args.push(...opts.serverIds);
    }
    const sql = `SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      at: r.at as string,
      serverId: (r.server_id as string | null) ?? null,
      actorType: r.actor_type as ActorType,
      userId: (r.user_id as number | null) ?? null,
      username: (r.username as string | null) ?? null,
      onBehalfOf: (r.on_behalf_of as number | null) ?? null,
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
