/**
 * The role matrix, defined once (PRD §5, ACC-02). The panel enforces it on
 * every route and websocket topic; the web UI only uses it to hide what the
 * server would refuse anyway.
 *
 * Two kinds of permission:
 *   - host permissions are about the whole host (accounts, creating servers,
 *     host settings) and need an account whose role applies everywhere
 *     (scope `all`);
 *   - server permissions are checked on one server, with the role the user
 *     has there (`roleOn`): its account role when its scope is `all`, or its
 *     grant for that server, whichever is higher.
 * A server a user has no role on doesn't exist for them (the panel answers
 * 404 `server-not-found`, never 403).
 */

export const ROLES = ['viewer', 'operator', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

/** What a per-server grant can give: there is one owner, and it acts everywhere. */
export const GRANT_ROLES = ['viewer', 'operator', 'admin'] as const;
export type GrantRole = (typeof GRANT_ROLES)[number];

/**
 * `all`: the account's role applies on every server (the owner always has
 * it); `granted`: only on the servers it holds a grant for.
 */
export const SCOPES = ['all', 'granted'] as const;
export type Scope = (typeof SCOPES)[number];

/** Host permissions, each mapped to the lowest role that holds it; they also need scope `all`. */
export const HOST_PERMISSIONS = {
  // The host overview: CPU, memory and disk of every server (HST-03, SRV-05).
  'host.view': 'admin',
  // Create servers (SRV-01): an admin on all servers.
  'servers.create': 'admin',
  // Host-wide settings (the Discord webhook, …).
  'host.settings': 'owner',
  // Accounts, roles and grants.
  'users.manage': 'owner',
} as const satisfies Record<string, Role>;

/** Server permissions, each mapped to the lowest role that holds it on that server; higher roles inherit. */
export const SERVER_PERMISSIONS = {
  // Viewers: see what's going on.
  'server.view': 'viewer',
  'players.view': 'viewer',
  'schedules.view': 'viewer',

  // Operators: run the server day to day.
  'log.view': 'operator',
  'accounts.view': 'operator',
  'server.control': 'operator', // start, stop, restart, save
  'server.broadcast': 'operator',
  'players.moderate': 'operator', // kick, ban, unban
  'backups.create': 'operator',

  // Admins: change how the server behaves.
  'console.raw': 'admin',
  'players.accessLevel': 'admin',
  'whitelist.manage': 'admin',
  'config.edit': 'admin',
  'mods.manage': 'admin',
  'schedules.manage': 'admin',
  'notifications.manage': 'admin',
  'server.update': 'admin', // update/verify, branch, memory
  'server.delete': 'admin', // SRV-04, after typing its name
  'backups.download': 'admin',
  'backups.delete': 'admin',
  'backups.restore': 'admin',
  'reset.world': 'admin',
  'audit.view': 'admin',

  // Owner only: irreversible, or brings outside files in.
  'reset.full': 'owner',
  'reset.factory': 'owner',
  'backups.upload': 'owner',
  // Accepting a game's license (EULA) for the host: the panel never does it on the owner's behalf (D6).
  'server.eula': 'owner',
} as const satisfies Record<string, Role>;

export type HostPermission = keyof typeof HOST_PERMISSIONS;
export type ServerPermission = keyof typeof SERVER_PERMISSIONS;
export type Permission = HostPermission | ServerPermission;

/** Every permission and its lowest role. */
export const PERMISSIONS: Readonly<Record<Permission, Role>> = { ...SERVER_PERMISSIONS, ...HOST_PERMISSIONS };

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isGrantRole(value: unknown): value is GrantRole {
  return typeof value === 'string' && (GRANT_ROLES as readonly string[]).includes(value);
}

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value);
}

export function isHostPermission(p: string): p is HostPermission {
  return Object.hasOwn(HOST_PERMISSIONS, p);
}

export function isServerPermission(p: string): p is ServerPermission {
  return Object.hasOwn(SERVER_PERMISSIONS, p);
}

export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

/** Whether `role` holds `permission` (wherever that role applies). */
export function can(role: Role, permission: Permission): boolean {
  return roleRank(role) >= roleRank(PERMISSIONS[permission]);
}

/** Every permission `role` holds, host and server alike. */
export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}

/** Admin and owner accounts must enrol an authenticator app before doing anything else. */
export function requiresTotp(role: Role): boolean {
  return roleRank(role) >= roleRank('admin');
}

// ------------------------------------------------------ per-server roles

/** An account as the matrix sees it. */
export interface Principal {
  role: Role;
  scope: Scope;
}

/** A role on one server. */
export interface ServerGrant {
  serverId: string;
  role: GrantRole;
}

/** The owner acts everywhere, whatever its stored scope. */
export function scopeOf(user: Principal): Scope {
  return user.role === 'owner' ? 'all' : user.scope;
}

/**
 * The role `user` acts with on `serverId`: the higher of its account role
 * (when its scope is `all`) and its grant there. Null: the server is not
 * theirs to see at all.
 */
export function roleOn(user: Principal, grants: readonly ServerGrant[], serverId: string): Role | null {
  const fromScope = scopeOf(user) === 'all' ? user.role : null;
  const fromGrant = grants.find((g) => g.serverId === serverId)?.role ?? null;
  if (fromScope === null) return fromGrant;
  if (fromGrant === null) return fromScope;
  return roleRank(fromGrant) > roleRank(fromScope) ? fromGrant : fromScope;
}

/** Whether `user` holds a server permission on `serverId`. */
export function canOn(user: Principal, grants: readonly ServerGrant[], serverId: string, permission: ServerPermission): boolean {
  const role = roleOn(user, grants, serverId);
  return role !== null && can(role, permission);
}

/**
 * Whether `user` holds `permission` on the host: a host permission, or a
 * server permission on every server (and so on ones created later). Both
 * need scope `all`.
 */
export function canHost(user: Principal, permission: Permission): boolean {
  return scopeOf(user) === 'all' && can(user.role, permission);
}

/** The server permissions `user` holds on `serverId` (empty: the server isn't theirs to see). */
export function permissionsOn(user: Principal, grants: readonly ServerGrant[], serverId: string): ServerPermission[] {
  const role = roleOn(user, grants, serverId);
  return role === null ? [] : (Object.keys(SERVER_PERMISSIONS) as ServerPermission[]).filter((p) => can(role, p));
}

/** What `user` holds on the host (`canHost`): host permissions, and server permissions that hold on every server. */
export function hostPermissionsFor(user: Principal): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => canHost(user, p));
}

/**
 * The account role to store for a scope-`granted` user: its highest grant
 * (viewer without any), so role-wide rules such as `requiresTotp` still
 * hold for what it can do somewhere.
 */
export function roleForGrants(grants: readonly Pick<ServerGrant, 'role'>[]): GrantRole {
  let best: GrantRole = 'viewer';
  for (const g of grants) if (roleRank(g.role) > roleRank(best)) best = g.role;
  return best;
}
