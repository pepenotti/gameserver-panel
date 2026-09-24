import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseIni, iniToRecord } from '@gsp/formats';
import { AgentError } from '../src/agent';
import { envelope, launch, makeHarness, type Harness } from './helpers';

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

    expect(s.installedInfo).toEqual({ version: '42.20.4', channel: 'public', build: '24909800' });
    expect(s.control).toMatchObject({ kind: 'rcon' });

    const ini = iniToRecord(parseIni(readFileSync(path.join(h.cfg.dataDir!, 'Server', 'testsrv.ini'), 'utf8')));
    expect(ini).toMatchObject({ RCONPort: String(h.cfg.ports.rcon), RCONPassword: h.store.controlSecret, UPnP: 'false', DefaultPort: '16261' });

    // JVM flags go before "--", game flags after.
    expect(h.logs().find((l) => l.includes('JVM args:'))).toMatch(/-Xms2048m -Xmx2048m -Duser\.language=en -Duser\.country=US$/);

    const withPlayers = await h.waitFor((x) => x.players?.count === 2);
    expect(withPlayers.players!.names).toEqual(['alice', 'bob']);
    expect(withPlayers.rcon.connected).toBe(true);
    expect(withPlayers.control).toEqual({ kind: 'rcon', connected: true, lastError: null });
  });

  it('takes the launch as an envelope for its adapter, and refuses another adapter', async () => {
    h = await makeHarness();
    expect(() => h.agent.setLaunch({ adapter: 'minecraft', params: launch })).toThrow(/runs "pz"/);
    expect(() => h.agent.setLaunch(envelope({ memoryMb: 1 }))).toThrow(/memoryMb/);
    expect(h.agent.status().launch).toBeNull();
    await h.agent.start(envelope(), undefined);
    const s = await h.waitFor((x) => x.state === 'running');
    expect(s.launch).toEqual({ serverName: 'testsrv', adminUsername: 'admin', memoryMb: 2048, branch: 'public', updateOnStart: false });
    expect(h.store.get().launch).toEqual({ adapter: 'pz', params: launch });
  });

  it('never leaks the admin or RCON password into the log stream', async () => {
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    const all = h.logs().join('\n');
    expect(all).toContain('-adminpassword <redacted>');
    expect(all).not.toContain(launch.adminPassword);
    expect(all).not.toContain(h.store.controlSecret);
  });
});

describe('install before start', () => {
  it('fails the start when the required install fails', async () => {
    process.env.FAKE_STEAMCMD_FAIL = 'disk';
    try {
      h = await makeHarness();
      await h.agent.start(launch, undefined);
      const s = await h.waitFor((x) => x.state === 'failed');
      expect(s.failure).toMatch(/Game install failed: .*0x202/);
      expect(s.desired).toBe('stopped');
      expect(s.pid).toBeNull();
    } finally {
      delete process.env.FAKE_STEAMCMD_FAIL;
    }
  });

  it('reinstalls when the branch changes', async () => {
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    await h.agent.stop({}, undefined);
    await h.agent.start({ ...launch, branch: 'legacy41' }, undefined);
    const s = await h.waitFor((x) => x.state === 'running');
    expect(s.installed).toEqual({ buildId: '24909800', branch: 'legacy41' });
    expect(h.events.filter((e) => e.event.type === 'job' && e.event.job.kind === 'install' && e.event.result?.ok)).toHaveLength(2);
  });

  it('updates on start when asked, and starts the installed build if the update fails', async () => {
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    await h.agent.stop({}, undefined);
    process.env.FAKE_STEAMCMD_FAIL = 'disk';
    try {
      await h.agent.start({ ...launch, updateOnStart: true }, undefined);
      await h.waitFor((x) => x.state === 'running');
    } finally {
      delete process.env.FAKE_STEAMCMD_FAIL;
    }
    expect(h.logs().some((l) => /Update failed \(.*0x202.*\); starting the installed build/.test(l))).toBe(true);
    expect(h.events.filter((e) => e.event.type === 'job' && e.event.job.kind === 'install' && e.event.result)).toHaveLength(2);
  });

  it('starts without steamcmd when the install is current', async () => {
    h = await makeHarness();
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    await h.agent.restart(undefined);
    await h.waitFor((x) => x.state === 'running');
    expect(h.events.filter((e) => e.event.type === 'job' && e.event.result)).toHaveLength(1);
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
    await expect(h.agent.install({ validate: false }, undefined)).rejects.toThrow(/no-launch/);
    h.agent.setLaunch(envelope({ branch: 'legacy41' }));
    const ok = await h.agent.install({ validate: true }, undefined);
    expect(ok).toEqual({ ok: true });
    expect(h.agent.status().installed).toEqual({ buildId: '24909800', branch: 'legacy41' });
    expect(h.events.some((e) => e.event.type === 'job' && e.event.job.kind === 'validate' && e.event.job.progress !== null && e.event.job.progress > 50)).toBe(true);
    expect(h.logs().some((l) => l.startsWith('[steamcmd] Success! App'))).toBe(true);

    process.env.FAKE_STEAMCMD_FAIL = 'disk';
    try {
      const bad = await h.agent.install({ validate: false }, undefined);
      expect(bad.ok).toBe(false);
      expect(bad.error).toMatch(/0x202/);
    } finally {
      delete process.env.FAKE_STEAMCMD_FAIL;
    }
  });

  it('installs for other params than the stored ones', async () => {
    h = await makeHarness();
    h.agent.setLaunch(envelope());
    expect(await h.agent.install({ validate: false, launch: envelope({ branch: 'legacy41' }) }, undefined)).toEqual({ ok: true });
    expect(h.agent.status().installedInfo).toMatchObject({ channel: 'legacy41' });
    expect(h.agent.status().launch?.branch).toBe('public');
  });

  it('reads the latest builds per branch', async () => {
    h = await makeHarness();
    await expect(async () => h.agent.versions()).rejects.toThrow(/no-launch/);
    h.agent.setLaunch(envelope());
    process.env.FAKE_LATEST_BUILDID = '25000000';
    try {
      const info = await h.agent.versions();
      expect(info.versions.find((v) => v.id === 'public')?.build).toBe('25000000');
      expect(info.versions.map((v) => v.id)).toEqual(['public', 'legacy41']);
      expect(info.installed).toBeNull();
    } finally {
      delete process.env.FAKE_LATEST_BUILDID;
    }
    expect(h.events.some((e) => e.event.type === 'job' && e.event.job.kind === 'appinfo' && e.event.result?.ok)).toBe(true);
  });

  it('downloads workshop items into the cache', async () => {
    h = await makeHarness();
    expect(await h.agent.action('workshop-download', { ids: ['2503622437'] })).toEqual({ ok: true });
    expect(existsSync(path.join(h.cfg.dataDir!, '.workshop', 'steamapps', 'workshop', 'content', '108600', '2503622437'))).toBe(true);
    expect(h.events.some((e) => e.event.type === 'job' && e.event.job.kind === 'workshop' && e.event.result?.ok)).toBe(true);
    await expect(h.agent.action('workshop-download', { ids: [] })).rejects.toThrow(/1-100/);
    await expect(h.agent.action('nope', {})).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('saves and actions', () => {
  it('saves the running world and waits for the game to finish', async () => {
    h = await makeHarness();
    await expect(h.agent.save()).rejects.toMatchObject({ code: 'unavailable' });
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    expect(await h.agent.save()).toEqual({ ok: true });
    expect(h.logs().some((l) => l.includes('Saving finish'))).toBe(true);
  });

  it('reads accounts and bans from the game database', async () => {
    h = await makeHarness();
    expect(await h.agent.action('accounts', { serverName: 'testsrv' })).toEqual([]);
    await h.agent.start(launch, undefined);
    await h.waitFor((x) => x.state === 'running');
    const accounts = (await h.agent.action('accounts', { serverName: 'testsrv' })) as { username: string; role: string }[];
    expect(accounts).toEqual([{ username: 'admin', displayName: null, role: 'admin', lastConnection: null, steamId: null }]);
    expect(await h.agent.action('bans', { serverName: 'testsrv' })).toEqual({ steamIds: [], ips: [] });
    await expect(h.agent.action('bans', { serverName: '../x' })).rejects.toMatchObject({ code: 'bad-request' });
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
    const pw = h.store.controlSecret;
    expect(pw).toHaveLength(48);
    const again = h.reopen();
    expect(again.store.controlSecret).toBe(pw);
  });

  it('keeps the stored launch across restarts, and drops one that no longer parses', async () => {
    h = await makeHarness();
    h.agent.setLaunch(envelope());
    expect(h.reopen().agent.status().launch).toMatchObject({ serverName: 'testsrv' });
    h.store.update({ launch: { adapter: 'pz', params: { ...launch, memoryMb: 1 } } });
    const again = h.reopen();
    expect(again.agent.status().launch).toBeNull();
    // Logged while the agent was being built: read the hub's backlog.
    expect(again.hub.since(0).events.some((e) => e.event.type === 'log' && e.event.line.includes('no longer valid'))).toBe(true);
  });
});
