// Agent ↔ panel, end to end, without Docker: the real agent HTTP server with
// the Project Zomboid runtime adapter and tools/fake-pz, driven through the
// panel's AgentClient, its ServerHandle (launch envelope, ServerCtx) and the
// Project Zomboid panel adapter (players, messages, update check). M1, G3, D4.
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { panelAdapter } from '@gsp/adapters/panel';
import type { AgentStatus, SeqEvent } from '@gsp/shared';
import { createAgentServer } from '../../agent/src/http';
import { makeHarness, TIME_SCALE, type Harness } from '../../agent/test/helpers';
import { AgentClient } from '../src/agent/client';
import { openDb } from '../src/db/db';
import { LocalServerFiles } from '../src/files/local';
import { ServerHandle } from '../src/server/handle';
import { ServerSettings } from '../src/settings';

const ADMIN_PASSWORD = 'E2e-admin-pw-2026';
const WAIT_MS = 15_000 * TIME_SCALE;

let h: Harness | null = null;
let server: http.Server | null = null;
let client: AgentClient | null = null;

afterEach(async () => {
  client?.stopStream();
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  await h?.cleanup();
  h = server = client = null;
});

/**
 * Resolves once `pred` holds for the status the client mirrors (its first
 * status call, then the agent's event stream).
 */
function until(c: AgentClient, pred: (s: AgentStatus) => boolean, what: string): Promise<AgentStatus> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const s = c.status_;
      if (s && pred(s)) {
        cleanup();
        resolve(s);
      }
    };
    const off = c.onEvent(check);
    // The mirror also changes without an event (the stream's opening status call).
    const poll = setInterval(check, 25);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${what}; state=${c.status_?.state} failure=${c.status_?.failure}`));
    }, WAIT_MS);
    const cleanup = () => {
      off();
      clearInterval(poll);
      clearTimeout(timer);
    };
    check();
  });
}

/** The first event the client receives from now on that `pred` accepts. */
function nextEvent(c: AgentClient, pred: (e: SeqEvent['event']) => boolean, what: string): Promise<SeqEvent['event']> {
  return new Promise((resolve, reject) => {
    const off = c.onEvent((e) => {
      if (!pred(e.event)) return;
      off();
      clearTimeout(timer);
      resolve(e.event);
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timed out waiting for ${what}`));
    }, WAIT_MS);
  });
}

describe('agent and panel, end to end', () => {
  it(
    'launches, runs, saves, reads accounts, broadcasts and stops the fake server through the panel client',
    async () => {
      for (const k of ['FAKE_PZ_SCENARIO', 'FAKE_PZ_PLAYERS', 'FAKE_STEAMCMD_FAIL']) delete process.env[k];
      h = await makeHarness();
      server = createAgentServer(h.agent, h.hub, h.cfg.token);
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
      client = new AgentClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, h.cfg.token);
      client.startStream();
      await until(client, (s) => s.state === 'stopped', 'the first status');

      // The panel's side of the server: its adapter, launch settings and secrets, as wiring.ts builds it.
      const adapter = panelAdapter('pz');
      const handle = new ServerHandle({
        ref: { id: 'default', gameName: 'testsrv', flavour: null },
        secrets: () => ({ adminPassword: ADMIN_PASSWORD }),
        agent: client,
        feed: client,
        files: new LocalServerFiles({ data: h.cfg.dataDir!, install: h.cfg.installDir! }),
        settings: new ServerSettings(openDb(':memory:'), 'default'),
        config: () => {
          throw new Error('no config store in this test');
        },
        adapter,
      });
      handle.setLaunchSettings({ memoryMb: 2048, branch: 'public', updateOnStart: false });

      // Launch: the adapter's envelope, stored by the agent without its secrets.
      const envelope = handle.launchEnvelope();
      expect(envelope.adapter).toBe('pz');
      const stored = await client.setLaunch(envelope);
      expect(stored.launch).toMatchObject({ serverName: 'testsrv', branch: 'public', memoryMb: 2048 });
      expect(JSON.stringify(stored.launch)).not.toContain(ADMIN_PASSWORD);

      // Start: nothing is installed, so the agent installs first (fake steamcmd), then boots the game.
      await client.start();
      const running = await until(client, (s) => s.state === 'running', 'the server to be ready');
      expect(running.installedInfo).toMatchObject({ channel: 'public', build: '24909800', version: '42.20.4' });
      expect(running.control?.kind).toBe('rcon');

      // Players, from the agent's polls, as events.
      const joined = nextEvent(client, (e) => e.type === 'players' && e.names.includes('rick'), 'rick to join');
      expect(await client.command('fake-join rick')).toEqual({ via: 'rcon', output: 'ok' });
      expect(await joined).toMatchObject({ type: 'players', count: 1, names: ['rick'] });
      expect((await client.status()).control).toEqual({ kind: 'rcon', connected: true, lastError: null });

      // A save the game confirms.
      expect(await client.save({ timeoutMs: 10_000 * TIME_SCALE })).toEqual({ ok: true });

      // The adapter's reads of the game's own database, through the agent's actions.
      const ctx = handle.ctx('alice');
      expect(await adapter.players!.accounts!(ctx)).toEqual([{ username: 'admin', displayName: null, role: 'admin', lastConnection: null, steamId: null }]);
      expect(await adapter.players!.bans!(ctx)).toEqual({ steamIds: [], ips: [] });

      // A countdown message, as the adapter words and sends it.
      const text = adapter.messages.announce('restart', 300, 'es');
      const cmd = adapter.messages.broadcast!(text!);
      expect(await client.command(cmd.command, cmd.via)).toEqual({ via: 'rcon', output: 'Message sent.' });

      // The update check reads the versions for the stored launch (ServerCtx.versions).
      expect(await adapter.updates!.check(ctx, handle.launchSettings())).toEqual({ available: false, current: '24909800', latest: '24909800', channel: 'public' });

      // Stop: save and quit over RCON, a clean exit.
      await client.stop({ reason: 'end to end' });
      const stopped = await until(client, (s) => s.state === 'stopped', 'the server to stop');
      expect(stopped.lastExit).toMatchObject({ expected: true, signal: null });

      // Nothing the client saw carries a secret (CON-01).
      const lines = client.recentLogs().map((e) => (e.event.type === 'log' ? e.event.line : ''));
      expect(lines.some((l) => l.includes('SERVER STARTED'))).toBe(true);
      expect(lines.join('\n')).not.toContain(ADMIN_PASSWORD);
      expect(lines.join('\n')).not.toContain(h.store.controlSecret);
    },
    90_000 * TIME_SCALE,
  );
});
