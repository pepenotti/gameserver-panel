// CON-01: a run of progress lines is one line of the live log all the way to
// the browser. The panel's agent client mirrors an agent's event hub (the
// agent's own, behind a stand-in of its /v1/events): the run's latest line
// replaces its line in the backlog new browsers get, in the run's place, and
// a client that reconnects gets the run's latest line after what it saw.
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { SeqEvent } from '@gsp/shared';
import { EventHub } from '../../agent/src/events';
import { AgentClient, placeLog } from '../src/agent/client';
import { fakeStatus, until } from './harness';

const log = (line: string, run?: number) => ({ type: 'log' as const, stream: 'out' as const, line, ...(run !== undefined ? { run } : {}) });
const ev = (seq: number, line: string, run?: number): SeqEvent => ({ seq, at: '', event: log(line, run) });
const lines = (logs: SeqEvent[]) => logs.map((e) => (e.event.type === 'log' ? e.event.line : ''));

/** An agent's /v1/status and /v1/events over a real event hub, as the agent streams it. */
async function agentOver(hub: EventHub) {
  const open = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    if (req.url === '/v1/status') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(fakeStatus()));
      return;
    }
    if (req.url?.startsWith('/v1/events')) {
      const since = Number(new URL(req.url, 'http://x').searchParams.get('since') ?? 0);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const e of hub.since(since).events) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      const off = hub.subscribe((e) => res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`));
      open.add(res);
      res.on('close', () => {
        off();
        open.delete(res);
      });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    open,
    close: () => {
      for (const r of open) r.destroy();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('progress runs in the panel (CON-01)', () => {
  it('keeps a run as its latest line in the backlog, forwards every update, and catches up after a reconnect', async () => {
    const hub = new EventHub(100, { progressIntervalMs: 0 });
    const agent = await agentOver(hub);
    const client = new AgentClient(agent.url, 'x'.repeat(40));
    const forwarded: SeqEvent[] = [];
    client.onEvent((e) => forwarded.push(e));
    try {
      hub.emit(log('Starting'));
      hub.progress('gen', log('gen 1%'));
      client.startStream();
      await until(() => client.recentLogs().length === 2);
      for (let i = 2; i <= 50; i++) hub.progress('gen', log(`gen ${i}%`));
      hub.endRuns();
      hub.emit(log('Server started'));
      await until(() => lines(client.recentLogs()).includes('Server started'));
      expect(lines(client.recentLogs())).toEqual(['Starting', 'gen 50%', 'Server started']);
      // Browsers get every update, each naming its run, to replace the line in place.
      expect(forwarded.filter((e) => e.event.type === 'log' && e.event.run === 2)).toHaveLength(50);

      // Away while a new run goes on: back, the client gets its latest line only, and puts it in place.
      client.stopStream();
      hub.progress('save', log('save 10%'));
      client.startStream();
      await until(() => lines(client.recentLogs()).includes('save 10%'));
      client.stopStream();
      for (let i = 20; i <= 100; i += 10) hub.progress('save', log(`save ${i}%`));
      hub.endRuns();
      hub.emit(log('Saved'));
      client.startStream();
      await until(() => lines(client.recentLogs()).includes('Saved'));
      expect(lines(client.recentLogs())).toEqual(['Starting', 'gen 50%', 'Server started', 'save 100%', 'Saved']);
    } finally {
      client.stopStream();
      await agent.close();
    }
  });

  it('puts a run first seen late in its place, and a run seen before in the place of its line', () => {
    const logs: SeqEvent[] = [ev(1, 'Starting'), ev(3, 'agent says')];
    // The run began at seq 2, before a line the client has: its latest line goes between them.
    placeLog(logs, ev(9, 'gen 90%', 2));
    expect(lines(logs)).toEqual(['Starting', 'gen 90%', 'agent says']);
    placeLog(logs, ev(10, 'gen 100%', 2));
    placeLog(logs, ev(11, 'Server started'));
    expect(logs.map((e) => e.seq)).toEqual([1, 10, 3, 11]);
    expect(lines(logs)).toEqual(['Starting', 'gen 100%', 'agent says', 'Server started']);
  });
});
