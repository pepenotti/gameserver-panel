import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstallCtx, LineSignal, RuntimeAdapter } from '@gsp/adapter-api';
import type { LiveGame, RuntimeHost } from '@gsp/adapter-api/testing/runtime-suite';
import { GameRun } from '../src/game';
import { SteamcmdDriver } from '../src/steamcmd';
import { freePort } from './helpers';

function env(): Record<string, string | undefined> {
  const { AGENT_TOKEN: _token, ...rest } = process.env;
  return rest;
}

/**
 * The runtime contract suite's host, made of the agent's own parts: the
 * GameRun behind every ControlHandle and the steamcmd driver. Tools point at
 * a game's fake server (and fake steamcmd).
 */
export function agentHost(tools: { launcher: string[]; steamcmd: string[] }): RuntimeHost {
  const dirs: string[] = [];
  const runs: GameRun[] = [];
  return {
    async context(adapter: RuntimeAdapter): Promise<InstallCtx> {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-contract-'));
      dirs.push(dir);
      // The image's volumes exist, empty, before the first install.
      const roots = { data: path.join(dir, 'data'), install: path.join(dir, 'install') };
      mkdirSync(roots.data, { recursive: true });
      mkdirSync(roots.install, { recursive: true });
      const ports: Record<string, number> = {};
      for (const decl of adapter.meta.ports) ports[decl.id] = await freePort();
      const home = path.join(dir, 'home');
      const noop = () => undefined;
      return {
        roots,
        stateDir: path.join(dir, 'state'),
        ports,
        state: { controlSecret: randomBytes(24).toString('hex'), gameVersion: null },
        tools: { ...tools, home },
        env: env(),
        log: noop,
        onLine: noop,
        progress: noop,
        steam:
          adapter.meta.runtime === 'steam'
            ? new SteamcmdDriver({ steamcmd: tools.steamcmd, home, installDir: roots.install, workshopDir: path.join(roots.data, '.workshop') })
            : undefined,
      };
    },

    async start(adapter, ctx, p): Promise<LiveGame> {
      const signals: LineSignal[] = [];
      const listeners = new Set<(s: LineSignal) => void>();
      const run = new GameRun({
        command: adapter.command(ctx, p),
        env: env(),
        classify: (line) => adapter.classify(line),
        channel: adapter.channel(ctx, p),
        onLine: (_raw, _stream, s) => {
          signals.push(s);
          for (const l of listeners) l(s);
        },
      });
      runs.push(run);
      return {
        ctl: run.handle(),
        markReady: () => {
          run.ready = true;
        },
        signals,
        onSignal: (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        exited: run.exited,
        kill: () => run.proc.signal('SIGKILL'),
      };
    },

    async dispose() {
      for (const run of runs) {
        run.proc.signal('SIGKILL');
        await Promise.race([run.exited, new Promise((r) => setTimeout(r, 5_000))]);
      }
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
