import type { Deps } from '../http/deps';

/**
 * First boot: create the owner from PANEL_OWNER_USERNAME/PASSWORD. The
 * password must be changed at first login and 2FA enrolled, so the value in
 * .env stops mattering after that. Later boots ignore these variables.
 */
export async function bootstrapOwner(deps: Pick<Deps, 'users' | 'audit' | 'env'>): Promise<'created' | 'exists' | 'missing-env'> {
  if (deps.users.count() > 0) return 'exists';
  if (!deps.env.owner) {
    console.warn('No panel users yet: set PANEL_OWNER_USERNAME and PANEL_OWNER_PASSWORD to create the owner account.');
    return 'missing-env';
  }
  const u = await deps.users.create({ username: deps.env.owner.username, password: deps.env.owner.password, role: 'owner', lang: 'es', mustChangePassword: true });
  deps.audit.log({ user: { id: u.id, username: u.username }, action: 'user.bootstrap-owner', target: u.username });
  console.log(`Created owner account "${u.username}"; change its password at first login.`);
  return 'created';
}
