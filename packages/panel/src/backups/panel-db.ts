import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/db';

const NAME = /^panel-\d{8}T\d{6}Z\.sqlite$/;

/**
 * Copy of the panel's own database (users, 2FA secrets, settings, config
 * history, audit log) into `<backups>/panel/`. Kept apart from the game
 * backups and never offered for download: it holds password hashes and TOTP
 * secrets, so the file is owner-only. Returns the new file's path.
 */
export function backupPanelDb(db: Db, backupDir: string, keep = 7, now = new Date()): string {
  const dir = path.join(backupDir, 'panel');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `panel-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.sqlite`);
  if (existsSync(file)) rmSync(file); // VACUUM INTO refuses to overwrite
  // A consistent snapshot even while the panel keeps writing.
  db.prepare('VACUUM INTO ?').run(file);
  chmodSync(file, 0o600);
  const old = readdirSync(dir)
    .filter((f) => NAME.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) rmSync(path.join(dir, f), { force: true });
  return file;
}
