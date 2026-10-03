import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeAdapter } from '@gsp/adapter-api';
import { runtimeAdapter } from '@gsp/adapters/runtime';
import type { PzLaunch } from '@gsp/adapter-pz/shared';
import type { AgentStatus, SeqEvent } from '@gsp/shared';
import { Agent } from '../src/agent';
import type { AgentConfig } from '../src/config';
import { EventHub } from '../src/events';
import { StateStore } from '../src/state-store';

export const tools = fileURLToPath(new URL('../../../tools/fake-pz/', import.meta.url));
export const fakeServer = [process.execPath, path.join(tools, 'server.mjs')];
export const fakeSteamcmd = [process.execPath, path.join(tools, 'steamcmd.mjs')];

/**
 * Stretches timeouts (not poll intervals) when the machine is busy, e.g.
 * several worktrees testing at once: TEST_TIME_SCALE=2 doubles them.
 */
export const TIME_SCALE = Number(process.env.TEST_TIME_SCALE) || 1;

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export const launch: PzLaunch = {
  serverName: 'testsrv',
  adminUsername: 'admin',
  adminPassword: 'Adm1nPassw0rd!',
  memoryMb: 2048,
  branch: 'public',
  updateOnStart: false,
};

/** The same launch, as the panel sends it once it runs adapters. */
export const envelope = (params: Partial<PzLaunch> = {}) => ({ adapter: 'pz', params: { ...launch, ...params } });

export interface Harness {
  dir: string;
  cfg: AgentConfig;
  adapter: RuntimeAdapter;
  hub: EventHub;
  store: StateStore;
  agent: Agent;
  events: SeqEvent[];
  waitFor(pred: (s: AgentStatus) => boolean, timeoutMs?: number): Promise<AgentStatus>;
  waitEvent(pred: (e: SeqEvent) => boolean, timeoutMs?: number): Promise<SeqEvent>;
  logs(): string[];
  /** A second agent on the same directories, as after a container restart. */
  reopen(): Harness;
  cleanup(): Promise<void>;
}

/** `adapter` wraps the configured runtime adapter (spies on its steps). */
export async function makeHarness(overrides: Partial<AgentConfig> = {}, o: { adapter?: (a: RuntimeAdapter) => RuntimeAdapter } = {}): Promise<Harness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-agent-'));
  const cfg: AgentConfig = {
    version: 'test',
    token: 'x'.repeat(40),
    host: '127.0.0.1',
    port: 0,
    adapter: 'pz',
    flavour: null,
    mode: 'server',
    installShared: false,
    installDir: path.join(dir, 'install'),
    dataDir: path.join(dir, 'data'),
    stateDir: path.join(dir, 'state'),
    steamcmd: fakeSteamcmd,
    home: path.join(dir, 'home'),
    launcher: fakeServer,
    ports: { rcon: await freePort() },
    readyTimeoutMs: 5_000 * TIME_SCALE,
    stopTimeoutMs: 2_000 * TIME_SCALE,
    termTimeoutMs: 1_000 * TIME_SCALE,
    crashLoop: { count: 3, windowMs: 60_000 },
    restartDelayMs: 150,
    playersPollMs: 150,
    unresponsiveAfter: 3,
    channelGraceMs: 10_000,
    logBufferLines: 5000,
    ...overrides,
  };
  return build(dir, cfg, o.adapter ?? ((a) => a));
}

function build(dir: string, cfg: AgentConfig, wrap: (a: RuntimeAdapter) => RuntimeAdapter): Harness {
  const adapter = wrap(runtimeAdapter(cfg.adapter));
  const hub = new EventHub(cfg.logBufferLines);
  const store = new StateStore(cfg.stateDir, { adapter: adapter.meta.id });
  const agent = new Agent(cfg, adapter, store, hub);
  const events: SeqEvent[] = [];
  hub.subscribe((e) => events.push(e));

  const h: Harness = {
    dir,
    cfg,
    adapter,
    hub,
    store,
    agent,
    events,
    waitFor(pred, timeoutMs = 8_000 * TIME_SCALE) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const s = agent.status();
          if (pred(s)) {
            clearInterval(t);
            clearTimeout(to);
            resolve(s);
          }
        };
        const t = setInterval(check, 25);
        const to = setTimeout(() => {
          clearInterval(t);
          reject(new Error(`Timed out; state=${agent.status().state} failure=${agent.status().failure}\n${h.logs().slice(-15).join('\n')}`));
        }, timeoutMs);
        check();
      });
    },
    waitEvent(pred, timeoutMs = 8_000 * TIME_SCALE) {
      return new Promise((resolve, reject) => {
        const hit = events.find(pred);
        if (hit) return resolve(hit);
        const off = hub.subscribe((e) => {
          if (pred(e)) {
            off();
            clearTimeout(to);
            resolve(e);
          }
        });
        const to = setTimeout(() => {
          off();
          reject(new Error('Timed out waiting for event'));
        }, timeoutMs);
      });
    },
    logs() {
      return events.flatMap((e) => (e.event.type === 'log' ? [e.event.line] : []));
    },
    reopen() {
      return build(dir, cfg, wrap);
    },
    async cleanup() {
      try {
        agent.kill(undefined);
      } catch {
        // locked or already gone
      }
      await new Promise((r) => setTimeout(r, 100));
      await agent.shutdown().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  return h;
}
