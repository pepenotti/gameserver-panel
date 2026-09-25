// The panel's agent client as the registry uses it (M2): an address that is
// known only once the orchestrator told, and one event stream per client
// however often a server's context is rebuilt around it.
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { AgentClient } from '../src/agent/client';
import { fakeStatus, until } from './harness';

/** An agent that answers /v1/status and holds /v1/events open, counting live subscriptions. */
async function fakeAgentServer() {
  const open = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    if (req.url === '/v1/status') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(fakeStatus()));
      return;
    }
    if (req.url?.startsWith('/v1/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ seq: 1, at: '', event: { type: 'log', stream: 'out', line: 'hello' } })}\n\n`);
      open.add(res);
      res.on('close', () => open.delete(res));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    open,
    close: () => {
      for (const r of open) r.destroy();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('AgentClient', () => {
  it('keeps exactly one subscription when its stream is stopped and started again (a rebuilt context)', async () => {
    const agent = await fakeAgentServer();
    const client = new AgentClient(agent.url, 'x'.repeat(40));
    try {
      client.startStream();
      await until(() => client.connected && agent.open.size === 1);
      client.stopStream();
      client.startStream();
      await until(() => client.connected && agent.open.size === 1);
      // A stray loop would reconnect after its 1 s back-off: give it the time.
      await new Promise((r) => setTimeout(r, 1500));
      expect(agent.open.size).toBe(1);
      expect(client.recentLogs().map((e) => e.event)).toEqual([{ type: 'log', stream: 'out', line: 'hello' }]);
      client.stopStream();
      await until(() => agent.open.size === 0);
      expect(client.connected).toBe(false);
    } finally {
      client.stopStream();
      await agent.close();
    }
  });

  it('fails as unreachable until its address is known, then reaches it', async () => {
    const agent = await fakeAgentServer();
    let url = '';
    const client = new AgentClient(() => url, 'x'.repeat(40));
    try {
      await expect(client.status()).rejects.toMatchObject({ status: 503, code: 'unreachable' });
      url = agent.url;
      await expect(client.status()).resolves.toMatchObject({ state: 'stopped' });
    } finally {
      await agent.close();
    }
  });
});
