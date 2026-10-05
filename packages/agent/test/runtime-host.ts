import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstallCtx, LineSignal, RuntimeAdapter } from '@gsp/adapter-api';
import type { LiveGame, RuntimeHost } from '@gsp/adapter-api/testing/runtime-suite';
import { GameRun } from '../src/game';
import { makeDownload, makeExec, makeExtract, makeFetch } from '../src/install-tools';
import { SteamcmdDriver } from '../src/steamcmd';
import { freePortsFor } from './ports';

function baseEnv(): Record<string, string | undefined> {
  const { AGENT_TOKEN: _token, ...rest } = process.env;
  return rest;
}

export interface AgentHostOptions {
  /** Added to the environment adapters and the game see (download URLs, the fake's knobs). */
  env?: Record<string, string>;
  /** The owner accepted the game's agreement (D6), as a panel's launch would say. */
  eulaAccepted?: boolean;
  /** The server's flavour (`GAME_FLAVOUR`): its own image family, when it names one, picks the install tools. */
  flavour?: string;
}

/**
 * The runtime contract suite's host, made of the agent's own parts: the
 * GameRun behind every ControlHandle, the steamcmd driver, and the download
 * and tool-running helpers. Tools point at a game's fake server (and fake
 * steamcmd or download services).
 */
export function agentHost(tools: { launcher: string[]; steamcmd: string[] }, o: AgentHostOptions = {}): RuntimeHost {
  const dirs: string[] = [];
  const runs: GameRun[] = [];
  // A server's container carries its flavour in its environment, as the agent's does.
  const env = () => ({ ...baseEnv(), ...(o.flavour ? { GAME_FLAVOUR: o.flavour } : {}), ...o.env });
  return {
    async context(adapter: RuntimeAdapter): Promise<InstallCtx> {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-contract-'));
      dirs.push(dir);
      // The image's volumes exist, empty, before the first install.
      const roots = { data: path.join(dir, 'data'), install: path.join(dir, 'install') };
      mkdirSync(roots.data, { recursive: true });
      mkdirSync(roots.install, { recursive: true });
      // Free ports, as the panel gives them, each on its own protocol (a UDP port taken while TCP's is free fails Avorion's start).
      const ports = await freePortsFor(adapter.meta.ports);
      const home = path.join(dir, 'home');
      const noop = () => undefined;
      const get = makeFetch({ userAgent: 'gameserver-panel/test', baseDelayMs: 50 });
      return {
        roots,
        stateDir: path.join(dir, 'state'),
        ports,
        state: { controlSecret: randomBytes(24).toString('hex'), gameVersion: null },
        tools: { ...tools, home },
        env: env(),
        ...(o.eulaAccepted === undefined ? {} : { eulaAccepted: o.eulaAccepted }),
        log: noop,
        onLine: noop,
        progress: noop,
        steam:
          (adapter.meta.flavours.find((f) => f.id === o.flavour)?.runtime ?? adapter.meta.runtime) === 'steam'
            ? new SteamcmdDriver({ steamcmd: tools.steamcmd, home, installDir: roots.install, workshopDir: path.join(roots.data, '.workshop') })
            : undefined,
        fetch: get,
        download: makeDownload({ fetch: get }),
        extract: makeExtract(() => [roots.install, roots.data]),
        exec: makeExec({ env: env(), onLine: noop, cwd: roots.install }),
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
