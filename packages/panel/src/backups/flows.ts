import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { ResetDecl } from '@gsp/adapter-api';
import type { AgentStatus } from '@gsp/shared';
import type { AgentApi } from '../agent/client';
import type { Control, GameLang } from '../control/control';
import type { AgentFeed } from '../http/deps';
import { HttpError } from '../http/context';
import type { OpContext, OpRunner } from '../ops/runner';
import type { OpState } from '../ops/bus';
import type { ServerHandle } from '../server/handle';
import type { Settings } from '../settings';
import type { ConfigStore } from '../config/store';
import type { BackupInfo, BackupPart, BackupService, BackupTrigger } from './service';

/** A reset scope id, from the adapter's `resets`. */
export type ResetScope = string;

export interface LastRestore {
  id: string;
  backup: string;
  parts: BackupPart[];
  at: string;
  /** Present until the restored server has started once. */
  trash: string | null;
}

export interface FlowDeps {
  agent: AgentApi;
  feed: AgentFeed;
  ops: OpRunner;
  control: Control;
  backups: BackupService;
  settings: Settings;
  config: ConfigStore;
  server: ServerHandle;
  /** The server's data folder (staging and trash live inside it, on the same volume). */
  dataDir: string;
}

/** How long a running server may take to save before the backup copies anyway. */
const SAVE_TIMEOUT_MS = 20_000;

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
  constructor(private readonly d: FlowDeps) {}

  private get state(): string | undefined {
    return this.d.feed.status_?.state;
  }

  /**
   * One backup. Running server: save first, then a hot copy. Stopped server:
   * hold the agent lock so nobody starts it mid-copy.
   */
  async backupNow(ctx: OpContext | null, trigger: BackupTrigger): Promise<BackupInfo> {
    const running = this.state === 'running';
    if (running && !this.d.server.has('hotBackup')) throw new HttpError(409, 'capability-unsupported', undefined, { capability: 'hotBackup' });
    let lockId: string | null = null;
    try {
      if (running) {
        if (this.d.server.has('save')) {
          ctx?.step('saving');
          // A save that doesn't finish in time still leaves the hot copy consistent per file.
          await this.d.agent.save({ timeoutMs: SAVE_TIMEOUT_MS });
        }
      } else {
        lockId = (await this.d.agent.lock(`backup (${trigger})`, 2 * 3_600_000)).id;
      }
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
   * Restore chosen parts of a backup. The server is stopped (players warned),
   * a safety backup is taken, the archive is unpacked to a staging folder and
   * swapped in by rename; the old files stay in a trash folder until the
   * server has started again, so a bad restore can be rolled back.
   */
  startRestore(by: string | null, name: string, parts: BackupPart[], opts: { countdownSec: number; lang: GameLang }): OpState {
    const info = this.d.backups.get(name);
    const status = this.d.feed.status_;
    const installedBuild = status?.installedInfo?.build ?? status?.installed?.buildId;
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
        const id = randomUUID();
        const staging = path.join(this.d.dataDir, '.staging', id);
        const trash = path.join(this.d.dataDir, '.trash', id);
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
          await this.d.backups.extract(name, usable, staging, (f) => ctx.step('extracting', { progress: Math.round(f * 100) }));
          ctx.step('swapping', { progress: null });
          this.d.backups.swapIn(usable, staging, trash);
          this.d.settings.setRaw<LastRestore>('lastRestore', { id, backup: name, parts: usable, at: new Date().toISOString(), trash });

          if (wasRunning) {
            ctx.step('starting');
            await this.d.control.startAgent({ lockId: lock.id, by });
            const s = await waitForStatus(this.d.feed, (x) => x.state === 'running' || x.state === 'failed', 30 * 60_000);
            if (s.state !== 'running') throw new Error('Restored, but the server did not start. Use "undo restore" to go back.');
            this.purgeTrash();
          }
        } finally {
          rmSync(staging, { recursive: true, force: true });
          await this.d.agent.unlock(lock.id).catch(() => undefined);
        }
      },
      { cancellable: opts.countdownSec > 0 },
    );
  }

  /** The adapter's reset scopes. */
  resets(): ResetDecl[] {
    return this.d.server.adapter.resets;
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
        const lock = await this.d.agent.lock(`reset (${scope})`, 3 * 3_600_000);
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
          for (const part of decl.removeParts) for (const rel of this.d.backups.partPaths(part)) rmSync(path.join(this.d.dataDir, rel), { recursive: true, force: true });
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
    return this.d.settings.getRaw<LastRestore>('lastRestore');
  }

  /** Drop the pre-restore files once the restored world has proven it starts. */
  purgeTrash(): void {
    const last = this.lastRestore();
    if (!last?.trash) return;
    rmSync(last.trash, { recursive: true, force: true });
    this.d.settings.setRaw<LastRestore>('lastRestore', { ...last, trash: null });
  }

  /** Put back what the last restore replaced (only while its trash still exists). */
  startUndoRestore(by: string | null): OpState {
    const last = this.lastRestore();
    if (!last?.trash) throw new HttpError(409, 'nothing-to-undo');
    return this.d.ops.start('restore', by, async (ctx) => {
      const lock = await this.d.agent.lock('undo restore', 3_600_000);
      try {
        if (['running', 'starting'].includes(this.state ?? '')) {
          ctx.step('stopping');
          await this.d.agent.stop({ reason: 'undo restore' }, lock.id);
        }
        ctx.step('swapping');
        this.d.backups.rollback(last.parts, last.trash!);
        rmSync(last.trash!, { recursive: true, force: true });
        this.d.settings.setRaw<LastRestore>('lastRestore', { ...last, trash: null });
      } finally {
        await this.d.agent.unlock(lock.id).catch(() => undefined);
      }
    });
  }
}
