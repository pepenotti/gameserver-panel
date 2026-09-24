import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentServer } from '../src/http';
import { launch, makeHarness, type Harness } from './helpers';

let h: Harness;
let server: http.Server;
let base: string;

async function setup() {
  h = await makeHarness();
  server = createAgentServer(h.agent, h.hub, h.cfg.token);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const auth = () => ({ authorization: `Bearer ${h.cfg.token}`, 'content-type': 'application/json' });

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  await h?.cleanup();
});

describe('agent HTTP API', () => {
  it('requires the bearer token except for health', async () => {
    await setup();
    expect((await fetch(`${base}/v1/health`)).status).toBe(200);
    expect((await fetch(`${base}/v1/status`)).status).toBe(401);
    expect((await fetch(`${base}/v1/status`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    const ok = await fetch(`${base}/v1/status`, { headers: auth() });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { state: string }).state).toBe('stopped');
  });

  it('validates launch parameters and maps agent errors to status codes', async () => {
    await setup();
    const bad = await fetch(`${base}/v1/start`, { method: 'POST', headers: auth(), body: JSON.stringify({ launch: { ...launch, adminPassword: 'short' } }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'bad-request', error: expect.stringMatching(/adminPassword/) });

    const cmd = await fetch(`${base}/v1/command`, { method: 'POST', headers: auth(), body: JSON.stringify({ command: 'players' }) });
    expect(cmd.status).toBe(503);

    const lock = (await (await fetch(`${base}/v1/lock`, { method: 'POST', headers: auth(), body: JSON.stringify({ holder: 'test' }) })).json()) as { id: string };
    const locked = await fetch(`${base}/v1/start`, { method: 'POST', headers: auth(), body: JSON.stringify({ launch }) });
    expect(locked.status).toBe(423);
    await fetch(`${base}/v1/lock`, { method: 'DELETE', headers: { ...auth(), 'x-lock-id': lock.id } });
    expect((await fetch(`${base}/v1/nope`, { headers: auth() })).status).toBe(404);
  });

  it('refuses non-JSON bodies', async () => {
    await setup();
    const r = await fetch(`${base}/v1/command`, { method: 'POST', headers: { authorization: `Bearer ${h.cfg.token}`, 'content-type': 'text/plain' }, body: 'command=quit' });
    expect(r.status).toBe(415);
  });

  it('streams events with a resumable sequence', async () => {
    await setup();
    await fetch(`${base}/v1/start`, { method: 'POST', headers: auth(), body: JSON.stringify({ launch }) });
    await h.waitFor((s) => s.state === 'running');

    const ctrl = new AbortController();
    const res = await fetch(`${base}/v1/events?since=0`, { headers: auth(), signal: ctrl.signal });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('SERVER STARTED')) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids.length).toBeGreaterThan(3);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    // Resuming from the last id replays nothing older.
    const last = ids.at(-1)!;
    const ctrl2 = new AbortController();
    const res2 = await fetch(`${base}/v1/events`, { headers: { ...auth(), 'last-event-id': String(last) }, signal: ctrl2.signal });
    await h.agent.command('servermsg "x"', 'rcon');
    const reader2 = res2.body!.getReader();
    const chunk = new TextDecoder().decode((await reader2.read()).value);
    ctrl2.abort();
    const first = Number(/^id: (\d+)$/m.exec(chunk)?.[1] ?? last + 1);
    expect(first).toBeGreaterThan(last);
  });
});
