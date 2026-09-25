// Escape hatch for a locked-out owner: needs a shell on the host, which is
// the right bar for resetting passwords and 2FA.
//
//   docker compose exec panel node /app/panelctl.mjs users
//   docker compose exec panel node /app/panelctl.mjs reset-2fa owner
//
// Also the container's healthcheck, which needs no database:
//   node /app/panelctl.mjs health
import { openDb } from '../db/db';
import { parseListen, probeHealth } from '../listen';
import { runCli } from './commands';

const argv = process.argv.slice(2);
if (argv[0] === 'health') {
  // Wherever PANEL_LISTEN says the panel listens: a TCP port or its unix socket.
  process.exit((await probeHealth(parseListen(process.env))) ? 0 : 1);
}
const db = openDb(process.env.PANEL_DATA_DIR ?? '/var/lib/panel');
const code = await runCli(argv, { db, backupDir: process.env.BACKUP_DIR ?? '/backups', out: (l) => console.log(l) });
db.close();
process.exit(code);
