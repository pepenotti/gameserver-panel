import { randomBytes } from 'node:crypto';
import { Audit } from '../audit';
import { Sessions } from '../auth/sessions';
import { Users } from '../auth/users';
import { backupPanelDb } from '../backups/panel-db';
import type { Db } from '../db/db';

export const USAGE = `panelctl — recover access to the panel from the host

  users                     list accounts
  reset-password <user>     set a temporary password (must be changed at login)
  reset-2fa <user>          remove 2FA; admins and the owner enrol again at login
  backup-db                 copy the panel database into the backups folder now

Every command signs the user out everywhere and is written to the audit log.`;

/** Runs one panelctl command. Returns the process exit code. */
export async function runCli(argv: string[], ctx: { db: Db; backupDir: string; out: (line: string) => void }): Promise<number> {
  const users = new Users(ctx.db);
  const sessions = new Sessions(ctx.db);
  const audit = new Audit(ctx.db);
  const [cmd, name] = argv;
  const target = () => {
    const u = name ? users.byName(name) : null;
    if (!u) ctx.out(name ? `No user named ${name}. Run "panelctl users".` : 'Which user?');
    return u;
  };

  switch (cmd) {
    case 'users': {
      for (const u of users.list()) {
        ctx.out(`${u.username.padEnd(20)} ${u.role.padEnd(9)} 2FA ${u.totpEnabled ? 'on ' : 'off'}${u.disabled ? '  disabled' : ''}${u.mustChangePassword ? '  must change password' : ''}`);
      }
      return 0;
    }
    case 'reset-password': {
      const u = target();
      if (!u) return 1;
      const temp = randomBytes(12).toString('base64url');
      await users.setPassword(u.id, temp, { mustChange: true });
      const n = sessions.revokeAllForUser(u.id);
      audit.log({ action: 'cli.reset-password', target: u.username, detail: { sessionsRevoked: n } });
      ctx.out(`Temporary password for ${u.username}: ${temp}`);
      ctx.out('It must be changed at the next sign-in.');
      return 0;
    }
    case 'reset-2fa': {
      const u = target();
      if (!u) return 1;
      users.disableTotp(u.id);
      const n = sessions.revokeAllForUser(u.id);
      audit.log({ action: 'cli.reset-2fa', target: u.username, detail: { sessionsRevoked: n } });
      ctx.out(`2FA removed for ${u.username}.${u.role === 'admin' || u.role === 'owner' ? ' They will set it up again right after signing in.' : ''}`);
      return 0;
    }
    case 'backup-db': {
      const file = backupPanelDb(ctx.db, ctx.backupDir);
      audit.log({ action: 'cli.backup-db', detail: file });
      ctx.out(`Saved ${file}`);
      return 0;
    }
    default:
      ctx.out(USAGE);
      return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2;
  }
}
