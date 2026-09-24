import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseIni, iniToRecord } from '@pz/formats';
import { AgentError } from '../src/agent';
import { launch, makeHarness, type Harness } from './helpers';

let h: Harness;
const setScenario = (s: string | undefined, extra: Record<string, string> = {}) => {
  delete process.env.FAKE_PZ_SCENARIO;
  delete process.env.FAKE_PZ_PLAYERS;
  delete process.env.FAKE_PZ_CRASH_MS;
  if (s) process.env.FAKE_PZ_SCENARIO = s;
  Object.assign(process.env, extra);
};

beforeEach(() => setScenario(undefined));
afterEach(async () => {
  await h?.cleanup();
  setScenario(undefined);
});

describe('first start', () => {
  it('installs, enforces the managed ini keys, starts and becomes ready', async () => {
    setScenario('normal', { FAKE_PZ_PLAYERS: 'alice,bob' });
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    const s = await h.waitFor((x) => x.state === 'running');
    expect(s.installed).toEqual({ buildId: '24909800', branch: 'public' });
    expect(s.gameVersion).toBe('42.20.4');
    expect(s.desired).toBe('running');
    expect(s.launch).not.toHaveProperty('adminPassword');

    const ini = iniToRecord(parseIni(readFileSync(path.join(h.cfg.dataDir, 'Server', 'testsrv.ini'), 'utf8')));
    expect(ini).toMatchObject({ RCONPort: String(h.cfg.rconPort), RCONPassword: h.store.get().rconPassword, UPnP: 'false', DefaultPort: '16261' });

    // JVM flags go before "--", game flags after.
    expect(h.logs().find((l) => l.includes('JVM args:'))).toMatch(/-Xms2048m -Xmx2048m -Duser\.language=en -Duser\.country=US$/);

    const withPlayers = await h.waitFor((x) => x.players?.count === 2);
    expect(withPlayers.players!.names).toEqual(['alice', 'bob']);
    expect(withPlayers.rcon.connected).toBe(true);
  });

  it('never leaks the admin or RCON password into the log stream', async () => {
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    const all = h.logs().join('\n');
    expect(all).toContain('-adminpassword <redacted>');
    expect(all).not.toContain(launch.adminPassword);
    expect(all).not.toContain(h.store.get().rconPassword);
  });
});

describe('commands', () => {
  it('reassembles a long RCON reply split across packets', async () => {
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    const r = await h.agent.command('help', undefined);
    expect(r.via).toBe('rcon');
    expect(Buffer.byteLength(r.output!)).toBeGreaterThan(4086);
    expect(r.output).toContain('* comando149 : Descripción número 149 — ñandú');
    expect((await h.agent.command('servermsg "hola"', 'rcon')).output).toBe('Message sent.');
  });

  it('can use the console directly', async () => {
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    expect(await h.agent.command('save', 'stdin')).toEqual({ via: 'stdin', output: null });
    await h.waitEvent((e) => e.event.type === 'log' && e.event.line.includes('(System.in): "save"'));
  });

  it('rejects multi-line commands and commands while stopped', async () => {
    h = await makeHarness();
    await expect(h.agent.command('players', undefined)).rejects.toThrow(/not running/);
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    await expect(h.agent.command('save\nquit', undefined)).rejects.toThrow(/single line/);
  });

  it('reports join and leave as players events', async () => {
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running' && x.players !== null);
    await h.agent.command('fake-join carol', 'rcon');
    await h.waitEvent((e) => e.event.type === 'players' && e.event.names.includes('carol'));
    await h.agent.command('fake-leave carol', 'rcon');
    await h.waitEvent((e) => e.event.type === 'players' && e.event.count === 0);
  });
});

describe('stopping', () => {
  it('saves and quits over RCON', async () => {
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    await h.agent.stop({}, undefined);
    const s = h.agent.status();
    expect(s.state).toBe('stopped');
    expect(s.desired).toBe('stopped');
    expect(s.lastExit).toMatchObject({ code: 0, expected: true });
    expect(h.logs().some((l) => l.includes('World saved'))).toBe(true);
  });

  it('escalates to SIGTERM when quit is ignored', async () => {
    setScenario('ignore-quit');
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    await h.agent.stop({ timeoutMs: 500 }, undefined);
    expect(h.agent.status().state).toBe('stopped');
    expect(h.logs().some((l) => l.includes('sending SIGTERM'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('escalates to SIGKILL when SIGTERM is ignored too', async () => {
    setScenario('ignore-term');
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    await h.agent.stop({ timeoutMs: 300 }, undefined);
    expect(h.agent.status().lastExit?.signal).toBe('SIGKILL');
  });

  it('restarts', async () => {
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    const first = await h.waitFor((x) => x.state === 'running');
    await h.agent.restart(undefined);
    const second = await h.waitFor((x) => x.state === 'running');
    expect(second.pid).not.toBe(first.pid);
    expect(second.desired).toBe('running');
  });
});

describe('the watchdog', () => {
  it('restarts after a crash', async () => {
    setScenario('crash-after-ready', { FAKE_PZ_CRASH_MS: '300' });
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    await h.waitEvent((e) => e.event.type === 'alert' && e.event.kind === 'crash');
    await h.waitEvent((e) => e.event.type === 'state' && e.event.status.state === 'starting' && e.event.status.recentCrashes.length === 1);
  });

  it('gives up after a crash loop and forgets the running intent', async () => {
    setScenario('crash-after-ready', { FAKE_PZ_CRASH_MS: '50' });
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    const s = await h.waitFor((x) => x.state === 'failed', 15_000);
    expect(s.failure).toMatch(/Crashed 3 times/);
    expect(s.desired).toBe('stopped');
    expect(h.events.some((e) => e.event.type === 'alert' && e.event.kind === 'crash-loop')).toBe(true);
  });

  it('does not restart while a maintenance lock is held', async () => {
    setScenario('crash-after-ready', { FAKE_PZ_CRASH_MS: '200' });
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    h.agent.acquireLock('backup', 60_000);
    await h.waitFor((x) => x.state === 'crashed');
    await new Promise((r) => setTimeout(r, 500));
    expect(h.agent.status().state).toBe('crashed');
    expect(h.logs().some((l) => l.includes('maintenance lock is held'))).toBe(true);
  });

  it('fails fast when the server asks for an admin password on the console', async () => {
    setScenario('admin-prompt');
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    const s = await h.waitFor((x) => x.state === 'failed');
    expect(s.failure).toMatch(/admin password/);
  });

  it('fails when the server never becomes ready', async () => {
    setScenario('never-ready');
    h = await makeHarness({ readyTimeoutMs: 800 });
    await h.agent.start(launch, undefined);
    const s = await h.waitFor((x) => x.state === 'failed');
    expect(s.failure).toMatch(/did not finish starting/);
  });
});

describe('locks and installs', () => {
  it('refuses control without the lock id while locked', async () => {
    h = await makeHarness();
    const lock = h.agent.acquireLock('restore', 60_000);
    expect(() => h.agent.start(launch, undefined)).toThrow(AgentError);
    await h.agent.start(launch, lock.id);
    await h.waitFor((x) => x.state === 'running');
    expect(h.agent.status().lock?.holder).toBe('restore');
    expect(() => h.agent.acquireLock('other', 60_000)).toThrow(/Already locked/);
    h.agent.releaseLock(lock.id);
    expect(h.agent.status().lock).toBeNull();
  });

  it('refuses to update a running server', async () => {
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    await expect(h.agent.install({ validate: false }, undefined)).rejects.toThrow(/Stop the server/);
  });

  it('reports install progress and failures', async () => {
    h = await makeHarness();
    const ok = await h.agent.install({ branch: 'legacy41', validate: true }, undefined);
    expect(ok).toEqual({ ok: true });
    expect(h.agent.status().installed).toEqual({ buildId: '24909800', branch: 'legacy41' });
    expect(h.events.some((e) => e.event.type === 'job' && e.event.job.progress !== null && e.event.job.progress > 50)).toBe(true);

    process.env.FAKE_STEAMCMD_FAIL = 'disk';
    try {
      const bad = await h.agent.install({ validate: false }, undefined);
      expect(bad.ok).toBe(false);
      expect(bad.error).toMatch(/0x202/);
    } finally {
      delete process.env.FAKE_STEAMCMD_FAIL;
    }
  });

  it('reads the latest builds per branch', async () => {
    h = await makeHarness();
    process.env.FAKE_LATEST_BUILDID = '25000000';
    try {
      const info = await h.agent.appInfo();
      expect(info.branches.find((b) => b.name === 'public')?.buildId).toBe('25000000');
    } finally {
      delete process.env.FAKE_LATEST_BUILDID;
    }
  });

  it('downloads workshop items into the cache', async () => {
    h = await makeHarness();
    expect(await h.agent.downloadWorkshop(['2503622437'])).toEqual({ ok: true });
    expect(() => h.agent.downloadWorkshop([])).toThrow(/1-100/);
  });
});

describe('persistence', () => {
  it('resumes a running server after the agent restarts', async () => {
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    // Simulate `docker stop`: the game stops cleanly but the intent survives.
    await h.agent.shutdown();
    expect(h.store.get().desired).toBe('running');
    const again = h.reopen();
    await again.agent.init();
    await again.waitFor((x) => x.state === 'running');
    h = again;
  });

  it('keeps the RCON secret stable across restarts', async () => {
    h = await makeHarness();
    const pw = h.store.get().rconPassword;
    expect(pw).toHaveLength(48);
    const again = h.reopen();
    expect(again.store.get().rconPassword).toBe(pw);
  });
});
