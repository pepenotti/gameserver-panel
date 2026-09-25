import path from 'node:path';
import { Cron } from 'croner';
import { SCHEDULE, type Audit } from '../audit';

export interface HostJobsDeps {
  audit: Audit;
  /** Nightly copy of the panel's own database; see backups/panel-db.ts. */
  backupPanelDb: () => string;
  timezone?: string;
}

/**
 * Jobs of the host rather than of a server (BAK-06): the nightly copy of
 * the panel's database. Always on: losing it means re-creating every
 * account and 2FA.
 */
export class HostJobs {
  private cron: Cron | null = null;

  constructor(private readonly d: HostJobsDeps) {}

  start(): void {
    this.stop();
    this.cron = new Cron('30 4 * * *', { timezone: this.d.timezone ?? (process.env.TZ || 'UTC'), protect: true }, () => this.runPanelDbBackup());
  }

  stop(): void {
    this.cron?.stop();
    this.cron = null;
  }

  nextRuns(): { panelDb: string | null } {
    return { panelDb: this.cron?.nextRun()?.toISOString() ?? null };
  }

  runPanelDbBackup(): void {
    try {
      const file = this.d.backupPanelDb();
      this.d.audit.log({ actor: SCHEDULE, action: 'schedule.panelDb', detail: path.basename(file) });
    } catch (e) {
      this.d.audit.log({ actor: SCHEDULE, action: 'schedule.panelDb', detail: (e as Error).message, ok: false });
    }
  }
}
