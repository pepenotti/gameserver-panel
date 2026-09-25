import { describe, expect, it } from 'vitest';
import {
  can,
  canHost,
  canOn,
  GRANT_ROLES,
  HOST_PERMISSIONS,
  hostPermissionsFor,
  isHostPermission,
  isRole,
  isServerPermission,
  PERMISSIONS,
  permissionsFor,
  permissionsOn,
  requiresTotp,
  roleForGrants,
  roleOn,
  ROLES,
  SERVER_PERMISSIONS,
  type Principal,
  type ServerGrant,
  type ServerPermission,
} from '../src/permissions';

const all = (role: Principal['role']): Principal => ({ role, scope: 'all' });
const granted = (role: Principal['role']): Principal => ({ role, scope: 'granted' });

describe('permissions', () => {
  it('lets higher roles inherit everything lower roles can do', () => {
    for (let i = 1; i < ROLES.length; i++) {
      const lower = new Set(permissionsFor(ROLES[i - 1]!));
      const higher = new Set(permissionsFor(ROLES[i]!));
      for (const p of lower) expect(higher.has(p)).toBe(true);
    }
  });

  it('splits host and server permissions, with no name in both', () => {
    const host = Object.keys(HOST_PERMISSIONS);
    const server = Object.keys(SERVER_PERMISSIONS);
    expect(host.filter((p) => server.includes(p))).toEqual([]);
    expect(Object.keys(PERMISSIONS).sort()).toEqual([...host, ...server].sort());
    expect(host.sort()).toEqual(['host.settings', 'host.view', 'servers.create', 'users.manage']);
    expect(isHostPermission('users.manage')).toBe(true);
    expect(isServerPermission('server.view')).toBe(true);
    expect(isServerPermission('users.manage')).toBe(false);
    expect(isHostPermission('toString')).toBe(false);
  });

  it('keeps destructive and account-level actions owner-only', () => {
    for (const p of ['reset.full', 'reset.factory', 'backups.upload', 'users.manage', 'host.settings'] as const) {
      expect(can('admin', p)).toBe(false);
      expect(can('owner', p)).toBe(true);
    }
  });

  it('lets only the owner accept a game license, on any server (D6)', () => {
    expect(isServerPermission('server.eula')).toBe(true);
    for (const r of ['viewer', 'operator', 'admin'] as const) expect(can(r, 'server.eula'), r).toBe(false);
    expect(can('owner', 'server.eula')).toBe(true);
  });

  it('matches the approved matrix at the role boundaries', () => {
    expect(can('viewer', 'server.view')).toBe(true);
    expect(can('viewer', 'log.view')).toBe(false);
    expect(can('operator', 'server.control')).toBe(true);
    expect(can('operator', 'console.raw')).toBe(false);
    expect(can('operator', 'config.edit')).toBe(false);
    expect(can('operator', 'server.delete')).toBe(false);
    expect(can('admin', 'server.delete')).toBe(true);
    expect(can('admin', 'reset.world')).toBe(true);
    expect(can('admin', 'backups.restore')).toBe(true);
    expect(can('admin', 'servers.create')).toBe(true);
  });

  it('requires 2FA from admin up', () => {
    expect(ROLES.map(requiresTotp)).toEqual([false, false, true, true]);
  });

  it('recognises only known roles', () => {
    expect(isRole('admin')).toBe(true);
    expect(isRole('root')).toBe(false);
    expect(isRole(3)).toBe(false);
  });
});

describe('roles per server (ACC-02)', () => {
  const grants: ServerGrant[] = [
    { serverId: 'alpha', role: 'admin' },
    { serverId: 'beta', role: 'viewer' },
  ];

  it('gives scope-all accounts their role everywhere, and granted ones only where granted', () => {
    for (const role of ROLES) {
      expect(roleOn(all(role), [], 'alpha')).toBe(role);
      expect(roleOn(all(role), [], 'anything')).toBe(role);
    }
    expect(roleOn(granted('admin'), grants, 'alpha')).toBe('admin');
    expect(roleOn(granted('admin'), grants, 'beta')).toBe('viewer');
    expect(roleOn(granted('admin'), grants, 'gamma')).toBeNull();
    expect(roleOn(granted('viewer'), [], 'alpha')).toBeNull();
  });

  it('takes the higher of the account role and the grant', () => {
    expect(roleOn(all('viewer'), grants, 'alpha')).toBe('admin');
    expect(roleOn(all('operator'), grants, 'beta')).toBe('operator');
  });

  it('treats the owner as scope all whatever is stored', () => {
    expect(roleOn(granted('owner'), [], 'gamma')).toBe('owner');
    expect(canHost(granted('owner'), 'users.manage')).toBe(true);
  });

  it('checks every server permission against the role on that server', () => {
    for (const grant of GRANT_ROLES) {
      const u = granted(grant);
      const g: ServerGrant[] = [{ serverId: 'alpha', role: grant }];
      for (const p of Object.keys(SERVER_PERMISSIONS) as ServerPermission[]) {
        expect(canOn(u, g, 'alpha', p), `${grant} ${p} on alpha`).toBe(can(grant, p));
        // Nothing at all on a server without a grant, not even seeing it.
        expect(canOn(u, g, 'beta', p), `${grant} ${p} on beta`).toBe(false);
      }
    }
  });

  it('never lets a grant reach owner-only server actions', () => {
    const u = granted('admin');
    const g: ServerGrant[] = [{ serverId: 'alpha', role: 'admin' }];
    expect(canOn(u, g, 'alpha', 'reset.world')).toBe(true);
    for (const p of ['reset.full', 'reset.factory', 'backups.upload'] as const) expect(canOn(u, g, 'alpha', p)).toBe(false);
    expect(canOn(all('owner'), [], 'alpha', 'reset.factory')).toBe(true);
  });

  it('holds host permissions only with scope all', () => {
    expect(canHost(all('admin'), 'servers.create')).toBe(true);
    expect(canHost(granted('admin'), 'servers.create')).toBe(false);
    expect(canHost(all('admin'), 'users.manage')).toBe(false);
    expect(canHost(all('owner'), 'users.manage')).toBe(true);
    // A server permission on the host means "on every server".
    expect(canHost(all('admin'), 'audit.view')).toBe(true);
    expect(canHost(granted('admin'), 'audit.view')).toBe(false);
    expect(hostPermissionsFor(granted('admin'))).toEqual([]);
    expect(hostPermissionsFor(all('viewer'))).toEqual(['server.view', 'players.view', 'schedules.view']);
  });

  it('lists what a user holds on a server for the UI', () => {
    expect(permissionsOn(granted('operator'), [{ serverId: 'alpha', role: 'operator' }], 'alpha')).toContain('server.control');
    expect(permissionsOn(granted('operator'), [{ serverId: 'alpha', role: 'operator' }], 'beta')).toEqual([]);
    expect(permissionsOn(all('owner'), [], 'beta')).toEqual(Object.keys(SERVER_PERMISSIONS));
  });

  it('stores the highest grant as the account role of a granted user', () => {
    expect(roleForGrants([])).toBe('viewer');
    expect(roleForGrants([{ role: 'operator' }, { role: 'admin' }, { role: 'viewer' }])).toBe('admin');
    expect(requiresTotp(roleForGrants([{ role: 'admin' }]))).toBe(true);
  });
});
