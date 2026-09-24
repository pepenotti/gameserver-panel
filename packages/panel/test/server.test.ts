import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announcement } from '../src/control/control';
import { auditableCommand } from '../src/routes/server';
import { fakeStatus, makePanel, ownerReady, type TestPanel } from './harness';

let p: TestPanel;

async function ready() {
  p = await makePanel();
  const { client } = await ownerReady(p);
  return client;
}

describe('in-game announcements', () => {
  it('reads naturally in both languages', () => {
    expect(announcement('restart', 300, 'es')).toBe('El servidor se reinicia en 5 minutos. Busquen un lugar seguro.');
    expect(announcement('stop', 60, 'es')).toBe('El servidor se apaga en 1 minuto. Busquen un lugar seguro.');
    expect(announcement('update', 30, 'en')).toBe('Server updating in 30 seconds. Find somewhere safe.');
  });
});

describe('server controls', () => {
  it('starts with the launch settings and the admin password from the environment', async () => {
    const c = await ready();
    let launched: unknown;
    p.agent.start = async (l) => {
      launched = l;
      return fakeStatus({ state: 'starting' });
    };
    const r = await c.post('/api/server/start');
    expect(r.json()).toMatchObject({ kind: 'start', done: false });
    await p.deps.ops.idle();
    expect(launched).toEqual({ serverName: 'zomboid', adminUsername: 'admin', adminPassword: 'AdminPw-123456', memoryMb: 8192, branch: 'public', updateOnStart: true });
    expect(p.deps.audit.list({ action: 'server.' })[0]).toMatchObject({ action: 'server.start', username: 'alice' });
  });

  it('restarts immediately when nobody is online, even with a countdown', async () => {
    const c = await ready();
    p.feed.status_ = fakeStatus({ state: 'running', players: { count: 0, names: [], at: '' } });
    await c.post('/api/server/restart', { countdownSec: 300 });
    await p.deps.ops.idle();
    expect(p.agent.calls).toEqual(['stop', 'start']);
    expect(p.agent.calls.some((x) => x.startsWith('command:servermsg'))).toBe(false);
  });

  describe('with players online', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    it('warns players on the way down, then restarts', async () => {
      const c = await ready();
      p.feed.status_ = fakeStatus({ state: 'running', players: { count: 2, names: ['a', 'b'], at: '' } });
      const op = (await c.post('/api/server/restart', { countdownSec: 60 })).json() as { id: string; cancellable: boolean };
      expect(op.cancellable).toBe(true);
      await vi.advanceTimersByTimeAsync(61_000);
      await p.deps.ops.idle();
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
      const op = (await c.post('/api/server/stop', { countdownSec: 300 })).json() as { id: string };
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await c.post(`/api/ops/${op.id}/cancel`)).statusCode).toBe(200);
      await p.deps.ops.idle();
      expect(p.agent.calls).not.toContain('stop');
      expect(p.agent.calls.at(-1)).toBe('command:servermsg "Se canceló el reinicio del servidor."');
      expect(p.deps.bus.currentOp()).toMatchObject({ step: 'cancelled', done: true, ok: false });
    });

    it('runs one operation at a time', async () => {
      const c = await ready();
      p.feed.status_ = fakeStatus({ state: 'running', players: { count: 1, names: ['a'], at: '' } });
      await c.post('/api/server/restart', { countdownSec: 60 });
      const second = await c.post('/api/server/stop');
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: 'busy', op: { kind: 'restart' } });
      await vi.advanceTimersByTimeAsync(61_000);
      await p.deps.ops.idle();
    });
  });

  it('updates: stop, install the configured branch, start again', async () => {
    const c = await ready();
    p.feed.status_ = fakeStatus({ state: 'running', players: { count: 0, names: [], at: '' } });
    let installed: unknown;
    p.agent.install = async (o) => {
      installed = o;
      p.agent.calls.push('install');
      return { ok: true };
    };
    await c.req('PUT', '/api/server/launch', { memoryMb: 6144, branch: 'legacy41', updateOnStart: false });
    await c.post('/api/server/update', { validate: true });
    await p.deps.ops.idle();
    expect(p.agent.calls).toEqual(['stop', 'install', 'start']);
    expect(installed).toEqual({ branch: 'legacy41', validate: true });
  });

  it('keeps the old build running if the update fails', async () => {
    const c = await ready();
    p.feed.status_ = fakeStatus({ state: 'running' });
    p.agent.install = async () => ({ ok: false, error: "Error! App '380870' state is 0x202 after update job." });
    await c.post('/api/server/update', {});
    await p.deps.ops.idle();
    expect(p.agent.calls).toEqual(['stop', 'start']);
    expect(p.deps.bus.currentOp()).toMatchObject({ ok: false, error: expect.stringContaining('0x202') });
  });

  it('validates launch settings', async () => {
    const c = await ready();
    expect((await c.req('PUT', '/api/server/launch', { memoryMb: 1000, branch: 'public', updateOnStart: true })).statusCode).toBe(400);
    expect((await c.req('PUT', '/api/server/launch', { memoryMb: 8192, branch: 'x; rm -rf', updateOnStart: true })).statusCode).toBe(400);
    expect((await c.req('PUT', '/api/server/launch', { memoryMb: 10240, branch: 'public', updateOnStart: false })).json()).toEqual({ memoryMb: 10240, branch: 'public', updateOnStart: false });
  });

  it('reports whether an update is available for the configured branch', async () => {
    const c = await ready();
    p.agent.appInfo = async () => ({
      installed: { buildId: '24909800', branch: 'public' },
      branches: [
        { name: 'public', buildId: '25000000', passwordRequired: false },
        { name: 'internal', buildId: '1', passwordRequired: true },
      ],
    });
    const r = (await c.get('/api/server/updates')).json() as { updateAvailable: boolean; branches: { name: string }[] };
    expect(r.updateAvailable).toBe(true);
    expect(r.branches.map((b) => b.name)).toEqual(['public']);
  });
});

describe('console and broadcast', () => {
  it('sends quoted broadcasts and refuses quote injection', async () => {
    const c = await ready();
    expect((await c.post('/api/server/broadcast', { message: 'Reinicio a las 6' })).statusCode).toBe(200);
    expect(p.agent.calls.at(-1)).toBe('command:servermsg "Reinicio a las 6"');
    expect((await c.post('/api/server/broadcast', { message: 'x" ; quit "' })).json()).toEqual({ error: 'invalid-message' });
  });

  it('runs raw commands for admins and hides secret arguments in the audit log', async () => {
    const c = await ready();
    expect((await c.post('/api/server/command', { command: '/players' })).json()).toEqual({ via: 'rcon', output: 'ok' });
    expect(p.agent.calls.at(-1)).toBe('command:players');
    await c.post('/api/server/command', { command: 'setpassword "bob" "hunter22"' });
    const last = p.deps.audit.list({ action: 'server.command' })[0]!;
    expect(last.detail).toBe('setpassword <arguments hidden>');
    expect((await c.post('/api/server/command', { command: 'save\nquit' })).statusCode).toBe(400);
  });

  it('keeps raw console away from operators', async () => {
    const c = await ready();
    await c.post('/api/users', { username: 'op1', password: 'Temporal-12345', role: 'operator' });
    const { Client } = await import('./harness');
    const op = new Client(p.app);
    await op.post('/api/auth/login', { username: 'op1', password: 'Temporal-12345' });
    await op.post('/api/auth/password', { current: 'Temporal-12345', next: 'Operador-propio-1' });
    expect((await op.post('/api/server/command', { command: 'players' })).statusCode).toBe(403);
    expect((await op.post('/api/server/kill')).statusCode).toBe(403);
    expect((await op.post('/api/server/broadcast', { message: 'hola' })).statusCode).toBe(200);
  });

  it('hides arguments of sensitive commands', () => {
    expect(auditableCommand('adduser bob pw')).toBe('adduser <arguments hidden>');
    expect(auditableCommand('changeoption Password "x"')).toBe('changeoption <arguments hidden>');
    expect(auditableCommand('kickuser bob')).toBe('kickuser bob');
  });
});
