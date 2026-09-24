import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { parseLogLine, PZ_PATTERNS } from '@pz/formats';
import type { AgentStatus } from '@pz/shared';
import type { AgentApi } from '../agent/client';
import type { Control, GameLang } from '../control/control';
import type { AgentFeed } from '../http/deps';
import { HttpError } from '../http/context';
import type { OpContext, OpRunner } from '../ops/runner';
import type { OpState } from '../ops/bus';
import type { Settings } from '../settings';
import type { ConfigService } from '../config/service';
import type { BackupInfo, BackupPart, BackupService, BackupTrigger } from './service';

export type ResetScope = 'world' | 'full' | 'factory';

/** A worldgen seed in PZ's format: 16 letters. */
function randomSeed(): string {
  const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => a[b % a.length]).join('');
}

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
  config: ConfigService;
  pzDataDir: string;
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

/** Ask the running server to save and wait for PZ's "Saving finish" (or 20 s). */
export async function saveNow(d: Pick<FlowDeps, 'agent' | 'feed'>): Promise<void> {
  const finished = new Promise<void>((resolve) => {
    const t = setTimeout(done, 20_000);
    const off = d.feed.onEvent((e) => {
      if (e.event.type === 'log' && PZ_PATTERNS.saveFinished.test(parseLogLine(e.event.line).message)) done();
    });
    function done() {
      clearTimeout(t);
      off();
      resolve();
    }
  });
  await d.agent.command('save');
  await finished;
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
    let lockId: string | null = null;
    try {
      if (running) {
        ctx?.step('saving');
        await saveNow(this.d);
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
    const newerBuild = info.manifest.buildId && this.d.feed.status_?.installed?.buildId && Number(info.manifest.buildId) > Number(this.d.feed.status_.installed.buildId);
    if (newerBuild) throw new HttpError(409, 'backup-from-newer-build');
    const usable = parts.filter((p) => info.manifest.parts.includes(p));
    if (usable.length === 0) throw new HttpError(400, 'nothing-to-restore');

    return this.d.ops.start(
      'restore',
      by,
      async (ctx) => {
        ctx.step('verifying');
        if (info.sha256 && (await this.d.backups.sha256(name)) !== info.sha256) throw new Error('The backup file is damaged (checksum mismatch)');

        const lock = await this.d.agent.lock('restore', 3 * 3_600_000);
        const id = randomUUID();
        const staging = path.join(this.d.pzDataDir, '.staging', id);
        const trash = path.join(this.d.pzDataDir, '.trash', id);
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
            await this.d.agent.start(this.d.control.launchParams(), lock.id);
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

  /**
   * Reset the server. Every scope first takes a cold backup (and aborts if it
   * can't), so a reset can always be undone by restoring it.
   *   world   — new world; accounts, whitelist, bans, settings and mods stay
   *   full    — also wipes accounts/whitelist/bans (admin is recreated at start)
   *   factory — also deletes the settings files; a first-run ini is written
   */
  startReset(by: string | null, scope: ResetScope, opts: { countdownSec: number; lang: GameLang; newSeed: boolean; preset?: string }): OpState {
    if (opts.preset && !this.d.config.presets().includes(opts.preset)) throw new HttpError(400, 'unknown-preset');
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
          const parts: BackupPart[] = scope === 'world' ? ['world'] : scope === 'full' ? ['world', 'accounts'] : ['world', 'accounts', 'configs'];
          for (const part of parts) for (const rel of this.d.backups.partPaths(part)) rmSync(path.join(this.d.pzDataDir, rel), { recursive: true, force: true });

          if (scope === 'factory') {
            this.d.config.seedIniIfMissing();
          } else {
            // A new ResetID tells returning players' games this is a fresh world.
            const changes: Record<string, string> = { ResetID: String(100_000_000 + Math.floor(Math.random() * 899_999_999)) };
            if (opts.newSeed) changes.Seed = randomSeed();
            this.d.config.setIniDirect(changes, by, `reset (${scope})`);
            if (opts.preset) this.d.config.applyPreset(opts.preset, by, { force: true });
          }
          this.d.settings.setRaw('pendingRestart', null);

          if (wasRunning) {
            ctx.step('starting');
            this.d.config.seedIniIfMissing();
            await this.d.agent.start(this.d.control.launchParams(), lock.id);
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
