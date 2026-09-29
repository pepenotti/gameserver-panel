import { randomUUID } from 'node:crypto';
import type { ResetDecl } from '@gsp/adapter-api';
import { isFolderId } from '@gsp/archive';
import type { AgentStatus } from '@gsp/shared';
import type { AgentApi } from '../agent/client';
import type { Control, GameLang } from '../control/control';
import type { AgentFeed } from '../http/deps';
import { HttpError } from '../http/context';
import type { OpContext, OpRunner } from '../ops/runner';
import type { OpState } from '../ops/bus';
import type { ServerHandle } from '../server/handle';
import type { KeyValueSettings } from '../settings';
import type { ConfigStore } from '../config/store';
import type { BackupInfo, BackupPart, BackupService, BackupTrigger } from './service';

/** A reset scope id, from the adapter's `resets`. */
export type ResetScope = string;

export interface LastRestore {
  id: string;
  backup: string;
  parts: BackupPart[];
  at: string;
  /** The trash folder (next to the server's data) holding what the restore replaced; present until the restored server has started once. */
  trash: string | null;
}

export interface FlowDeps {
  agent: AgentApi;
  feed: AgentFeed;
  ops: OpRunner;
  control: Control;
  backups: BackupService;
  /** The server's own settings. */
  settings: KeyValueSettings;
  config: ConfigStore;
  server: ServerHandle;
}

/** Resolves with the status once `pred` holds, or rejects after `timeoutMs`. */
export function waitForStatus(feed: AgentFeed, pred: (s: AgentStatus) => boolean, timeoutMs: number): Promise<AgentStatus> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const s = feed.status_;
      if (s && pred(s)) {
        cleanup();
        resolve(s);
      }
    };
    const off = feed.onEvent(() => check());
    const poll = setInterval(check, 1000);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for the server'));
    }, timeoutMs);
    const cleanup = () => {
      off();
      clearInterval(poll);
      clearTimeout(timer);
    };
    check();
  });
}

export class BackupFlows {
  private purging: Promise<void> | null = null;

  constructor(private readonly d: FlowDeps) {}

  private get state(): string | undefined {
    return this.d.feed.status_?.state;
  }

  /**
   * One backup. Running server: a hot copy, made consistent by the game's
   * own method next to the data (the agent runs the adapter's `hotCopy`
   * around the pack: PZ saves first; BAK-02), so the panel doesn't save
   * too. Stopped server: hold the agent lock so nobody starts it mid-copy.
   */
  async backupNow(ctx: OpContext | null, trigger: BackupTrigger): Promise<BackupInfo> {
    const running = this.state === 'running';
    if (running && !this.d.server.has('hotBackup')) throw new HttpError(409, 'capability-unsupported', undefined, { capability: 'hotBackup' });
    let lockId: string | null = null;
    try {
      if (!running) lockId = (await this.d.agent.lock(`backup: ${trigger}`, 2 * 3_600_000)).id;
      ctx?.step('archiving', { progress: 0 });
      let last = 0;
      return await this.d.backups.create({
        trigger,
        hot: running,
        onProgress: (f) => {
          if (f - last >= 0.02 || f === 1) {
            last = f;
            ctx?.step('archiving', { progress: Math.round(f * 100) });
          }
        },
      });
    } finally {
      if (lockId) await this.d.agent.unlock(lockId).catch(() => undefined);
    }
  }

  startBackup(by: string | null): OpState {
    return this.d.ops.start('backup', by, async (ctx) => {
      await this.backupNow(ctx, 'manual');
    });
  }

  /**
   * Restore chosen parts of a backup (BAK-03). The archive's checksum is
   * verified, the server is stopped (players warned), a safety backup is
   * taken, the archive is staged next to the server's data and swapped in by
   * rename; the old files stay in a trash folder until the server has
   * started again, so a bad restore can be undone.
   */
  startRestore(by: string | null, name: string, parts: BackupPart[], opts: { countdownSec: number; lang: GameLang }): OpState {
    const info = this.d.backups.get(name);
    const status = this.d.feed.status_;
    const installedBuild = status?.installedInfo?.build;
    const newerBuild = info.manifest.buildId && installedBuild && Number(info.manifest.buildId) > Number(installedBuild);
    if (newerBuild) throw new HttpError(409, 'backup-from-newer-build');
    const known = this.d.backups.parts();
    const usable = parts.filter((p) => known.includes(p) && info.manifest.parts.includes(p));
    if (usable.length === 0) throw new HttpError(400, 'nothing-to-restore');

    return this.d.ops.start(
      'restore',
      by,
      async (ctx) => {
        ctx.step('verifying');
        if (info.sha256 && (await this.d.backups.sha256(name)) !== info.sha256) throw new Error('The backup file is damaged (checksum mismatch)');

        const lock = await this.d.agent.lock('restore', 3 * 3_600_000);
        const wasRunning = ['running', 'starting'].includes(this.state ?? '');
        try {
          await this.d.control.countdown(ctx, 'restore', opts.countdownSec, opts.lang);
          if (wasRunning) {
            ctx.step('stopping');
            await this.d.agent.stop({ reason: 'restore' }, lock.id);
          }
          ctx.step('safety-backup', { cancellable: false });
          await this.d.backups.create({ trigger: 'pre-restore', hot: false });

          ctx.step('extracting', { progress: 0 });
          let last = 0;
          const { stagingId, rels } = await this.d.backups.stage(name, usable, (f) => {
            if (f - last >= 0.02 || f === 1) {
              last = f;
              ctx.step('extracting', { progress: Math.round(f * 100) });
            }
          });
          ctx.step('swapping', { progress: null });
          const { trashId } = await this.d.backups.swap(stagingId, rels);
          // The restored files are what the owner chose: settings the panel saved before don't go back over them.
          this.d.config.forgetPanelEdits(rels);
          // Only the latest restore can be undone: an older one's trash goes.
          const previous = this.lastRestore()?.trash;
          if (previous) await this.d.backups.purgeTrash(previous).catch(() => undefined);
          this.d.settings.setRaw<LastRestore>('lastRestore', { id: randomUUID(), backup: name, parts: usable, at: new Date().toISOString(), trash: trashId });

          if (wasRunning) {
            ctx.step('starting');
            await this.d.control.startAgent({ lockId: lock.id, by });
            const s = await waitForStatus(this.d.feed, (x) => x.state === 'running' || x.state === 'failed', 30 * 60_000);
            if (s.state !== 'running') throw new Error('Restored, but the server did not start. Use "undo restore" to go back.');
            await this.purgeTrash();
          }
        } finally {
          await this.d.agent.unlock(lock.id).catch(() => undefined);
        }
      },
      { cancellable: opts.countdownSec > 0 },
    );
  }

  /** The adapter's reset scopes for this server's flavour. */
  resets(): ResetDecl[] {
    return this.d.server.resets();
  }

  /**
   * Reset the server to one of the adapter's scopes. Every scope first takes a
   * cold backup (and aborts if it can't), so a reset can always be undone by
   * restoring it; then the scope's parts are deleted and its `after` step runs.
   */
  async startReset(by: string | null, scope: ResetScope, opts: { countdownSec: number; lang: GameLang; newSeed: boolean; preset?: string }): Promise<OpState> {
    const decl = this.resets().find((r) => r.id === scope);
    if (!decl) throw new HttpError(400, 'unknown-reset');
    // Listed now, so a preset installed since the panel started is known; an unknown one is refused before anything is deleted.
    if (opts.preset && !(await this.d.config.presets()).includes(opts.preset)) throw new HttpError(400, 'unknown-preset');
    return this.d.ops.start(
      'reset',
      by,
      async (ctx) => {
        const lock = await this.d.agent.lock(`reset: ${scope}`, 3 * 3_600_000);
        const wasRunning = ['running', 'starting'].includes(this.state ?? '');
        try {
          await this.d.control.countdown(ctx, 'reset', opts.countdownSec, opts.lang);
          if (wasRunning) {
            ctx.step('stopping');
            await this.d.agent.stop({ reason: `reset (${scope})` }, lock.id);
          }
          ctx.step('safety-backup', { cancellable: false });
          await this.d.backups.create({ trigger: 'pre-reset', hot: false });

          ctx.step('deleting');
          await this.d.backups.removeParts(decl.removeParts);
          this.d.config.forgetPanelEdits(decl.removeParts.flatMap((p) => this.d.backups.partPaths(p)));
          await decl.after?.(this.d.server.ctx(by), { newSeed: opts.newSeed, ...(opts.preset ? { preset: opts.preset } : {}) });
          this.d.settings.setRaw('pendingRestart', null);

          if (wasRunning) {
            ctx.step('starting');
            await this.d.control.startAgent({ lockId: lock.id, by });
          }
        } finally {
          await this.d.agent.unlock(lock.id).catch(() => undefined);
        }
      },
      { cancellable: opts.countdownSec > 0 },
    );
  }

  lastRestore(): LastRestore | null {
    const last = this.d.settings.getRaw<LastRestore>('lastRestore');
    // Before D11 the trash was a folder path on the panel's disk; that one can't be undone through the agent.
    if (last?.trash && !isFolderId(last.trash)) return { ...last, trash: null };
    return last;
  }

  /**
   * Drop the pre-restore files once the restored world has proven it starts.
   * Never fails: an agent that can't be reached keeps the trash until the
   * next start. One at a time: the restore and the server's first "running"
   * both ask for it.
   */
  purgeTrash(): Promise<void> {
    this.purging ??= this.purgeTrashNow().finally(() => {
      this.purging = null;
    });
    return this.purging;
  }

  private async purgeTrashNow(): Promise<void> {
    const last = this.lastRestore();
    if (!last?.trash) return;
    try {
      await this.d.backups.purgeTrash(last.trash);
    } catch {
      return;
    }
    // Unless a newer restore replaced it meanwhile.
    if (this.lastRestore()?.id === last.id) this.d.settings.setRaw<LastRestore>('lastRestore', { ...last, trash: null });
  }

  /** Put back what the last restore replaced (only while its trash still exists). */
  startUndoRestore(by: string | null): OpState {
    const last = this.lastRestore();
    if (!last?.trash) throw new HttpError(409, 'nothing-to-undo');
    const trash = last.trash;
    return this.d.ops.start('restore', by, async (ctx) => {
      const lock = await this.d.agent.lock('undo restore', 3_600_000);
      try {
        if (['running', 'starting'].includes(this.state ?? '')) {
          ctx.step('stopping');
          await this.d.agent.stop({ reason: 'undo restore' }, lock.id);
        }
        ctx.step('swapping');
        await this.d.backups.undo(trash);
        this.d.settings.setRaw<LastRestore>('lastRestore', { ...last, trash: null });
      } finally {
        await this.d.agent.unlock(lock.id).catch(() => undefined);
      }
    });
  }
}
