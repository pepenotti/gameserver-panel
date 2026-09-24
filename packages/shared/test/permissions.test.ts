import { describe, expect, it } from 'vitest';
import { can, isRole, permissionsFor, requiresTotp, ROLES } from '../src/permissions';

describe('permissions', () => {
  it('lets higher roles inherit everything lower roles can do', () => {
    for (let i = 1; i < ROLES.length; i++) {
      const lower = new Set(permissionsFor(ROLES[i - 1]!));
      const higher = new Set(permissionsFor(ROLES[i]!));
      for (const p of lower) expect(higher.has(p)).toBe(true);
    }
  });

  it('keeps destructive and account-level actions owner-only', () => {
    for (const p of ['reset.full', 'reset.factory', 'backups.upload', 'users.manage'] as const) {
      expect(can('admin', p)).toBe(false);
      expect(can('owner', p)).toBe(true);
    }
  });

  it('matches the approved matrix at the role boundaries', () => {
    expect(can('viewer', 'log.view')).toBe(false);
    expect(can('operator', 'server.control')).toBe(true);
    expect(can('operator', 'console.raw')).toBe(false);
    expect(can('operator', 'config.edit')).toBe(false);
    expect(can('admin', 'reset.world')).toBe(true);
    expect(can('admin', 'backups.restore')).toBe(true);
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
