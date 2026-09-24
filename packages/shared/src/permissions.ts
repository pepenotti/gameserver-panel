/**
 * The role matrix, defined once. The panel enforces it on every route and
 * websocket topic; the web UI only uses it to hide what the server would
 * refuse anyway.
 */

export const ROLES = ['viewer', 'operator', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

/** Each permission maps to the lowest role that holds it; higher roles inherit. */
export const PERMISSIONS = {
  // Everyone signed in.
  'dashboard.view': 'viewer',
  'players.view': 'viewer',
  'schedules.view': 'viewer',
  'profile.manage': 'viewer',

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
  'backups.download': 'admin',
  'backups.delete': 'admin',
  'backups.restore': 'admin',
  'reset.world': 'admin',
  'audit.view': 'admin',

  // Owner only: irreversible or account-level.
  'reset.full': 'owner',
  'reset.factory': 'owner',
  'backups.upload': 'owner',
  'users.manage': 'owner',
} as const satisfies Record<string, Role>;

export type Permission = keyof typeof PERMISSIONS;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

export function can(role: Role, permission: Permission): boolean {
  return roleRank(role) >= roleRank(PERMISSIONS[permission]);
}

export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}

/** Admin and owner accounts must enrol an authenticator app before doing anything else. */
export function requiresTotp(role: Role): boolean {
  return roleRank(role) >= roleRank('admin');
}
