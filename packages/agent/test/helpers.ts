import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentStatus, LaunchParams, SeqEvent } from '@pz/shared';
import { Agent } from '../src/agent';
import type { AgentConfig } from '../src/config';
import { EventHub } from '../src/events';
import { StateStore } from '../src/state-store';

const tools = fileURLToPath(new URL('../../../tools/fake-pz/', import.meta.url));

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

export const launch: LaunchParams = {
  serverName: 'testsrv',
  adminUsername: 'admin',
  adminPassword: 'Adm1nPassw0rd!',
  memoryMb: 2048,
  branch: 'public',
  updateOnStart: false,
};

export interface Harness {
  dir: string;
  cfg: AgentConfig;
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

export async function makeHarness(overrides: Partial<AgentConfig> = {}): Promise<Harness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pz-agent-'));
  const cfg: AgentConfig = {
    version: 'test',
    token: 'x'.repeat(40),
    host: '127.0.0.1',
    port: 0,
    installDir: path.join(dir, 'install'),
    dataDir: path.join(dir, 'data'),
    stateDir: path.join(dir, 'state'),
    steamcmd: [process.execPath, path.join(tools, 'steamcmd.mjs')],
    appId: '380870',
    gamePort: 16261,
    udpPort: 16262,
    rconPort: await freePort(),
    startCommand: [process.execPath, path.join(tools, 'server.mjs')],
    readyTimeoutMs: 5_000,
    stopTimeoutMs: 2_000,
    termTimeoutMs: 1_000,
    crashLoop: { count: 3, windowMs: 60_000 },
    restartDelayMs: 150,
    playersPollMs: 150,
    unresponsiveAfter: 3,
    logBufferLines: 5000,
    baseJvmArgs: ['-Duser.language=en', '-Duser.country=US'],
    ...overrides,
  };
  return build(dir, cfg);
}

function build(dir: string, cfg: AgentConfig): Harness {
  const hub = new EventHub(cfg.logBufferLines);
  const store = new StateStore(cfg.stateDir);
  const agent = new Agent(cfg, store, hub);
  const events: SeqEvent[] = [];
  hub.subscribe((e) => events.push(e));

  const h: Harness = {
    dir,
    cfg,
    hub,
    store,
    agent,
    events,
    waitFor(pred, timeoutMs = 8_000) {
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
    waitEvent(pred, timeoutMs = 8_000) {
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
      return build(dir, cfg);
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
