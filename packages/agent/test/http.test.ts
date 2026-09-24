import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentStatus } from '@gsp/shared';
import { createAgentServer } from '../src/http';
import { envelope, launch, makeHarness, type Harness } from './helpers';

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

describe('adapter routes', () => {
  const post = (path: string, body: unknown = {}, method = 'POST') => fetch(`${base}${path}`, { method, headers: auth(), body: JSON.stringify(body) });

  it('takes the launch as an envelope or as bare params', async () => {
    await setup();
    const wrong = await post('/v1/launch', { adapter: 'minecraft', params: launch }, 'PUT');
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toMatch(/runs "pz"/);

    const bare = await post('/v1/launch', launch, 'PUT');
    expect(bare.status).toBe(200);
    const s = (await bare.json()) as AgentStatus;
    expect(s.launch).toMatchObject({ serverName: 'testsrv', branch: 'public' });
    expect(s.launch).not.toHaveProperty('adminPassword');

    const env = await post('/v1/launch', envelope({ branch: 'legacy41' }), 'PUT');
    expect(((await env.json()) as AgentStatus).launch?.branch).toBe('legacy41');
  });

  it('installs and lists versions for the stored launch or the given one', async () => {
    await setup();
    const none = await post('/v1/install');
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: 'no-launch', code: 'conflict' });
    expect((await post('/v1/versions')).status).toBe(409);

    const inst = await post('/v1/install', { launch: envelope({ branch: 'legacy41' }) });
    expect(await inst.json()).toEqual({ ok: true });
    const v = await post('/v1/versions', { launch: envelope() });
    expect(v.status).toBe(200);
    expect(await v.json()).toMatchObject({ installed: { channel: 'legacy41', build: '24909800' }, versions: [{ id: 'public' }, { id: 'legacy41' }] });
    const status = (await (await fetch(`${base}/v1/status`, { headers: auth() })).json()) as AgentStatus;
    expect(status.installedInfo).toMatchObject({ channel: 'legacy41' });
    expect(status.installed).toEqual({ buildId: '24909800', branch: 'legacy41' });
  });

  it('no longer answers the pre-adapter steamcmd routes', async () => {
    await setup();
    await post('/v1/launch', envelope(), 'PUT');
    for (const path of ['/v1/steamcmd/install', '/v1/steamcmd/appinfo', '/v1/steamcmd/workshop']) {
      const r = await post(path, { ids: ['2503622437'] });
      expect(r.status, path).toBe(404);
      expect(await r.json()).toMatchObject({ code: 'not-found' });
    }
  });

  it('runs adapter actions and saves', async () => {
    await setup();
    const unknown = await post('/v1/actions/nope', { input: {} });
    expect(unknown.status).toBe(404);
    expect((await post('/v1/actions/Bad.Name', { input: {} })).status).toBe(404);
    expect((await post('/v1/actions/accounts', { input: { serverName: '../x' } })).status).toBe(400);
    expect((await post('/v1/save')).status).toBe(503);

    await post('/v1/start', { launch: envelope() });
    await h.waitFor((s) => s.state === 'running');
    const accounts = await post('/v1/actions/accounts', { input: { serverName: 'testsrv' } });
    expect(await accounts.json()).toEqual({ result: [{ username: 'admin', displayName: null, role: 'admin', lastConnection: null, steamId: null }] });
    const bans = await post('/v1/actions/bans', { input: { serverName: 'testsrv' } });
    expect(await bans.json()).toEqual({ result: { steamIds: [], ips: [] } });
    const ws = await post('/v1/actions/workshop-download', { input: { ids: ['2503622437'] } });
    expect(await ws.json()).toEqual({ result: { ok: true } });
    expect(await (await post('/v1/save', { timeoutMs: 5_000 })).json()).toEqual({ ok: true });
  });
});
