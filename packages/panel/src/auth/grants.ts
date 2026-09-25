import { isGrantRole, roleForGrants, type GrantRole, type Role, type ServerGrant } from '@gsp/shared';
import type { Db } from '../db/db';
import { UserError, type Users } from './users';

/**
 * Per-server roles (`server_grants`, ACC-02): what a scope-`granted`
 * account may do on each server, or more than its account role on one
 * server for a scope-`all` account. Rows go with their user or server.
 */
export class ServerGrants {
  constructor(private readonly db: Db) {}

  /** A user's grants, by server. */
  forUser(userId: number): ServerGrant[] {
    return (this.db.prepare('SELECT server_id, role FROM server_grants WHERE user_id = ? ORDER BY server_id').all(userId) as { server_id: string; role: GrantRole }[]).map((r) => ({
      serverId: r.server_id,
      role: r.role,
    }));
  }

  /** Who holds a grant on a server. */
  forServer(serverId: string): { userId: number; role: GrantRole }[] {
    return (this.db.prepare('SELECT user_id, role FROM server_grants WHERE server_id = ? ORDER BY user_id').all(serverId) as { user_id: number; role: GrantRole }[]).map((r) => ({
      userId: r.user_id,
      role: r.role,
    }));
  }

  /** Give (or change) a user's role on a server. */
  set(userId: number, serverId: string, role: GrantRole): void {
    if (!isGrantRole(role)) throw new UserError('invalid-role');
    this.db
      .prepare('INSERT INTO server_grants (user_id, server_id, role) VALUES (?, ?, ?) ON CONFLICT(user_id, server_id) DO UPDATE SET role = excluded.role')
      .run(userId, serverId, role);
  }

  /** Take a user's role on a server away; true if there was one. */
  remove(userId: number, serverId: string): boolean {
    return Number(this.db.prepare('DELETE FROM server_grants WHERE user_id = ? AND server_id = ?').run(userId, serverId).changes) > 0;
  }
}

/**
 * Keeps a scope-`granted` account's role at its highest grant
 * (`roleForGrants`), so role-wide rules such as mandatory 2FA follow what it
 * can do somewhere (ACC-01, ACC-02). Call after its grants or scope change,
 * and after a server it had a grant on is removed. Returns its role now.
 */
export function syncRoleWithGrants(users: Users, grants: ServerGrants, userId: number): Role | null {
  const u = users.byId(userId);
  if (!u) return null;
  if (u.role === 'owner' || u.scope !== 'granted') return u.role;
  const role = roleForGrants(grants.forUser(userId));
  if (role !== u.role) users.setRole(userId, role);
  return role;
}
