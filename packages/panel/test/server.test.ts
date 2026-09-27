import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditableCommand } from '../src/routes/server';
import { fakeStatus, makePanel, ownerReady, type TestPanel } from './harness';

let p: TestPanel;

async function ready() {
  p = await makePanel();
  const { client } = await ownerReady(p);
  return client;
}

describe('server controls', () => {
  it('starts with the launch settings and the admin password from the environment', async () => {
    const c = await ready();
    let launched: unknown;
    p.agent.start = async (l) => {
      launched = l;
      return fakeStatus({ state: 'starting' });
    };
    const r = await c.post('/api/servers/default/server/start');
    expect(r.json()).toMatchObject({ kind: 'start', done: false });
    await p.srv.ops.idle();
    expect(launched).toEqual({
      adapter: 'pz',
      params: { serverName: 'zomboid', adminUsername: 'admin', adminPassword: 'AdminPw-123456', memoryMb: 8192, branch: 'public', updateOnStart: true },
    });
    expect(p.deps.audit.list({ action: 'server.' })[0]).toMatchObject({ action: 'server.start', username: 'alice' });
  });

  it("runs the adapter's before-start hook: a first start gets the first-run settings", async () => {
    const c = await ready();
    const ini = path.join(p.deps.env.pzDataDir, 'Server', 'zomboid.ini');
    expect(existsSync(ini)).toBe(false);
    await c.post('/api/servers/default/server/start');
    await p.srv.ops.idle();
    expect(readFileSync(ini, 'utf8')).toContain('SaveWorldEveryMinutes=10');
    expect(p.agent.calls).toEqual(['start']);
  });

  it('restarts immediately when nobody is online, even with a countdown', async () => {
    const c = await ready();
    p.feed.status_ = fakeStatus({ state: 'running', players: { count: 0, names: [], at: '' } });
    await c.post('/api/servers/default/server/restart', { countdownSec: 300 });
    await p.srv.ops.idle();
    expect(p.agent.calls).toEqual(['stop', 'start']);
    expect(p.agent.calls.some((x) => x.startsWith('command:servermsg'))).toBe(false);
  });

  describe('with players online', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    it('warns players on the way down, then restarts', async () => {
      const c = await ready();
      p.feed.status_ = fakeStatus({ state: 'running', players: { count: 2, names: ['a', 'b'], at: '' } });
      const op = (await c.post('/api/servers/default/server/restart', { countdownSec: 60 })).json() as { id: string; cancellable: boolean };
      expect(op.cancellable).toBe(true);
      await vi.advanceTimersByTimeAsync(61_000);
      await p.srv.ops.idle();
      const msgs = p.agent.calls.filter((x) => x.startsWith('command:servermsg'));
      expect(msgs).toEqual([
        'command:servermsg "El servidor se reinicia en 1 minuto. Busquen un lugar seguro."',
        'command:servermsg "El servidor se reinicia en 30 segundos. Busquen un lugar seguro."',
        'command:servermsg "El servidor se reinicia en 10 segundos. Busquen un lugar seguro."',
      ]);
      expect(p.agent.calls.slice(-2)).toEqual(['stop', 'start']);
    });

    it('can be cancelled, and tells the players', async () => {
      const c = await ready();
      p.feed.status_ = fakeStatus({ state: 'running', players: { count: 1, names: ['a'], at: '' } });
      const op = (await c.post('/api/servers/default/server/stop', { countdownSec: 300 })).json() as { id: string };
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await c.post(`/api/servers/default/ops/${op.id}/cancel`)).statusCode).toBe(200);
      await p.srv.ops.idle();
      expect(p.agent.calls).not.toContain('stop');
      expect(p.agent.calls.at(-1)).toBe('command:servermsg "Se canceló el reinicio del servidor."');
      expect(p.srv.ops.last()).toMatchObject({ step: 'cancelled', done: true, ok: false });
    });

    it('runs one operation at a time', async () => {
      const c = await ready();
      p.feed.status_ = fakeStatus({ state: 'running', players: { count: 1, names: ['a'], at: '' } });
      await c.post('/api/servers/default/server/restart', { countdownSec: 60 });
      const second = await c.post('/api/servers/default/server/stop');
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: 'busy', op: { kind: 'restart' } });
      await vi.advanceTimersByTimeAsync(61_000);
      await p.srv.ops.idle();
    });
  });

  it('updates: stop, install the configured branch, start again', async () => {
    const c = await ready();
    p.feed.status_ = fakeStatus({ state: 'running', players: { count: 0, names: [], at: '' } });
    let installed: unknown;
    const started: unknown[] = [];
    p.agent.install = async (o) => {
      installed = o;
      p.agent.calls.push('install');
      return { ok: true };
    };
    p.agent.start = async (l) => {
      started.push(l);
      p.agent.calls.push('start');
      return fakeStatus({ state: 'starting' });
    };
    await c.req('PUT', '/api/servers/default/server/launch', { memoryMb: 6144, branch: 'legacy41', updateOnStart: true });
    await c.post('/api/servers/default/server/update', { validate: true });
    await p.srv.ops.idle();
    expect(p.agent.calls).toEqual(['stop', 'install', 'start']);
    const params = { serverName: 'zomboid', adminUsername: 'admin', adminPassword: 'AdminPw-123456', memoryMb: 6144, branch: 'legacy41' };
    expect(installed).toEqual({ validate: true, launch: { adapter: 'pz', params: { ...params, updateOnStart: true } } });
    // Just installed: the start doesn't update again.
    expect(started).toEqual([{ adapter: 'pz', params: { ...params, updateOnStart: false } }]);
  });

  it('takes a cold safety backup before updating when there is a world to protect', async () => {
    const c = await ready();
    const world = path.join(p.deps.env.pzDataDir, 'Saves', 'Multiplayer', 'zomboid');
    mkdirSync(world, { recursive: true });
    writeFileSync(path.join(world, 'map_t.bin'), 'world');
    p.feed.status_ = fakeStatus({ state: 'running', players: { count: 0, names: [], at: '' } });
    p.agent.install = async () => {
      // The backup is already there when the install starts.
      p.agent.calls.push(`install after ${p.srv.backups.list().map((b) => `${b.manifest.trigger}/${b.manifest.mode}`).join(',')}`);
      return { ok: true };
    };
    await c.post('/api/servers/default/server/update', {});
    await p.srv.ops.idle();
    expect(p.agent.calls).toEqual(['stop', 'install after pre-update/cold', 'start']);
  });

  it('keeps the old build running if the update fails', async () => {
    const c = await ready();
    p.feed.status_ = fakeStatus({ state: 'running' });
    p.agent.install = async () => ({ ok: false, error: "Error! App '380870' state is 0x202 after update job." });
    await c.post('/api/servers/default/server/update', {});
    await p.srv.ops.idle();
    expect(p.agent.calls).toEqual(['stop', 'start']);
    expect(p.srv.ops.last()).toMatchObject({ ok: false, error: expect.stringContaining('0x202') });
  });

  it('validates launch settings', async () => {
    const c = await ready();
    expect((await c.req('PUT', '/api/servers/default/server/launch', { memoryMb: 1000, branch: 'public', updateOnStart: true })).statusCode).toBe(400);
    expect((await c.req('PUT', '/api/servers/default/server/launch', { memoryMb: 8192, branch: 'x; rm -rf', updateOnStart: true })).statusCode).toBe(400);
    expect((await c.req('PUT', '/api/servers/default/server/launch', { memoryMb: 10240, branch: 'public', updateOnStart: false })).json()).toEqual({ memoryMb: 10240, branch: 'public', updateOnStart: false });
  });

  it('reports whether an update is available for the configured branch', async () => {
    const c = await ready();
    const asked: unknown[] = [];
    p.agent.versions = async (req) => {
      asked.push(req);
      return {
        installed: { version: '42.20.4', channel: 'public', build: '24909800' },
        versions: [
          { id: 'public', build: '25000000', timeUpdated: 1758600000 },
          { id: 'internal', build: '1', passwordRequired: true },
        ],
      };
    };
    const r = (await c.get('/api/servers/default/server/updates')).json();
    // The response keeps its Steam-branch shape for the current web UI.
    expect(r).toEqual({
      installed: { buildId: '24909800', branch: 'public' },
      branch: 'public',
      latest: { name: 'public', buildId: '25000000', timeUpdated: 1758600000, passwordRequired: false },
      branches: [{ name: 'public', buildId: '25000000', timeUpdated: 1758600000 }],
      updateAvailable: true,
      // The same in any game's terms (UPD-03): the adapter's answer, and the pinned version as its source lists it.
      check: { available: true, current: '24909800', latest: '25000000', channel: 'public' },
      pinned: { id: 'public', build: '25000000', channel: null, warning: null },
    });
    // One versions call per request, for the stored launch settings.
    expect(asked).toEqual([{ launch: { adapter: 'pz', params: expect.objectContaining({ branch: 'public' }) } }]);

    p.agent.versions = async () => ({ installed: { version: null, channel: 'public', build: '25000000' }, versions: [{ id: 'public', build: '25000000' }] });
    expect(((await c.get('/api/servers/default/server/updates')).json() as { updateAvailable: boolean }).updateAvailable).toBe(false);
  });
});

describe('console and broadcast', () => {
  it('sends quoted broadcasts and refuses quote injection', async () => {
    const c = await ready();
    expect((await c.post('/api/servers/default/server/broadcast', { message: 'Reinicio a las 6' })).statusCode).toBe(200);
    expect(p.agent.calls.at(-1)).toBe('command:servermsg "Reinicio a las 6"');
    expect((await c.post('/api/servers/default/server/broadcast', { message: 'x" ; quit "' })).json()).toEqual({ error: 'invalid-message' });
  });

  it('runs raw commands for admins and hides secret arguments in the audit log', async () => {
    const c = await ready();
    expect((await c.post('/api/servers/default/server/command', { command: '/players' })).json()).toEqual({ via: 'rcon', output: 'ok' });
    expect(p.agent.calls.at(-1)).toBe('command:players');
    await c.post('/api/servers/default/server/command', { command: 'setpassword "bob" "hunter22"' });
    const last = p.deps.audit.list({ action: 'server.command' })[0]!;
    expect(last.detail).toBe('setpassword <arguments hidden>');
    expect((await c.post('/api/servers/default/server/command', { command: 'save\nquit' })).statusCode).toBe(400);
  });

  it('keeps raw console away from operators', async () => {
    const c = await ready();
    await c.post('/api/users', { username: 'op1', password: 'Temporal-12345', role: 'operator' });
    const { Client } = await import('./harness');
    const op = new Client(p.app);
    await op.post('/api/auth/login', { username: 'op1', password: 'Temporal-12345' });
    await op.post('/api/auth/password', { current: 'Temporal-12345', next: 'Operador-propio-1' });
    expect((await op.post('/api/servers/default/server/command', { command: 'players' })).statusCode).toBe(403);
    expect((await op.post('/api/servers/default/server/kill')).statusCode).toBe(403);
    expect((await op.post('/api/servers/default/server/broadcast', { message: 'hola' })).statusCode).toBe(200);
  });

  it('hides the arguments of commands the adapter marks as secret', async () => {
    const catalog = [
      { name: 'passwd', syntax: 'passwd <user> <pw>', description: { en: 'x', es: 'x' }, secretArgs: true },
      { name: 'kick', syntax: 'kick <user>', description: { en: 'x', es: 'x' } },
    ];
    expect(auditableCommand('passwd bob pw', catalog)).toBe('passwd <arguments hidden>');
    expect(auditableCommand('PASSWD bob pw', catalog)).toBe('PASSWD <arguments hidden>');
    expect(auditableCommand('kick bob', catalog)).toBe('kick bob');
    expect(auditableCommand('other bob', catalog)).toBe('other bob');

    // Through the route, with the game's own catalog.
    const c = await ready();
    p.feed.status_ = fakeStatus({ state: 'running' });
    await c.post('/api/servers/default/server/command', { command: 'setpassword "bob" "hunter2-secret"' });
    await c.post('/api/servers/default/server/command', { command: 'players' });
    const details = p.deps.audit.list({ action: 'server.command' }).map((a) => a.detail);
    expect(details).toEqual(expect.arrayContaining(['setpassword <arguments hidden>', 'players']));
    expect(details.join()).not.toContain('hunter2');
  });
});
