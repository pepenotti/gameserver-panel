// Escape hatch for a locked-out owner: needs a shell on the host, which is
// the right bar for resetting passwords and 2FA.
//
//   docker compose exec panel node /app/panelctl.mjs users
//   docker compose exec panel node /app/panelctl.mjs reset-2fa owner
import { openDb } from '../db/db';
import { runCli } from './commands';

const db = openDb(process.env.PANEL_DATA_DIR ?? '/var/lib/panel');
const code = await runCli(process.argv.slice(2), { db, backupDir: process.env.BACKUP_DIR ?? '/backups', out: (l) => console.log(l) });
db.close();
process.exit(code);
