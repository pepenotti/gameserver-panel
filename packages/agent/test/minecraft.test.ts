// The agent running Minecraft (M3) end to end against the fake server and
// the fake download services: install before start, readiness over RCON,
// players, a hot backup through the archive route, stop; the owner's EULA
// (D6); and exits nobody asked for, which the game makes with code 0.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFakeDownloads, type FakeDownloads } from '../../../tools/fake-minecraft/downloads.mjs';
import { freePort, makeHarness, tools, type Harness } from './helpers';

const fakeJava = [process.execPath, path.join(tools, '..', 'fake-minecraft', 'server.mjs')];
const KEYS = ['GAME_MC_MOJANG_URL', 'GAME_MC_PAPER_URL', 'GAME_MC_FABRIC_URL', 'FAKE_MC_PLAYERS', 'FAKE_MC_SCENARIO', 'FAKE_MC_CRASH_MS', 'FAKE_MC_BOOT_MS'];

let downloads: FakeDownloads;
let h: Harness | undefined;
beforeAll(async () => {
  downloads = await startFakeDownloads({ fail: '' });
});
afterAll(() => downloads.close());
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  for (const k of KEYS) delete process.env[k];
});

/** The agent's environment is the process's: download URLs and the fake's knobs go there. */
function env(extra: Record<string, string> = {}): void {
  Object.assign(process.env, { GAME_MC_MOJANG_URL: downloads.url, GAME_MC_PAPER_URL: downloads.url, GAME_MC_FABRIC_URL: downloads.url, FAKE_MC_BOOT_MS: '100', ...extra });
}

async function harness(): Promise<Harness> {
  h = await makeHarness({ adapter: 'minecraft', launcher: fakeJava, ports: { game: await freePort(), rcon: await freePort() }, restartDelayMs: 60_000 });
  return h;
}

const envelope = (params: Record<string, unknown>, eulaAccepted = true) => ({ adapter: 'minecraft', params: { version: '26.3', loader: 'vanilla', memoryMb: 1024, ...params }, eulaAccepted });

async function drain(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts);
}

describe('the agent runs Minecraft (M3)', () => {
  it('installs, starts, reports the version and players over RCON, backs up while running with saving off, and stops (UPD-01, CON-01, PLY-01, BAK-02)', async () => {
    env({ FAKE_MC_PLAYERS: 'gspffAlice' });
    await harness();
    await h!.agent.start(envelope({}), undefined);
    const s = await h!.waitFor((x) => x.state === 'running');
    expect(s.installedInfo).toEqual({ version: '26.3', channel: 'vanilla' });
    expect(s.control).toMatchObject({ kind: 'rcon' });
    expect(h!.store.get().gameVersion).toBe('26.3');
    expect(existsSync(path.join(h!.cfg.dataDir!, 'eula.txt'))).toBe(true);
    const withPlayers = await h!.waitFor((x) => x.players?.count === 1);
    expect(withPlayers.players!.names).toEqual(['gspffAlice']);
    expect(withPlayers.control).toEqual({ kind: 'rcon', connected: true, lastError: null });
    expect(await h!.agent.command('list', 'rcon')).toEqual({ via: 'rcon', output: 'There are 1 of a max of 20 players online: gspffAlice' });

    // A hot copy through the archive route (D11): save-off and a flush before, save-on after.
    const tar = await drain(await h!.agent.files.pack({ root: 'data', rels: ['world', 'server.properties'] }));
    expect(tar.includes(Buffer.from('world/level.dat'))).toBe(true);
    const logs = h!.logs();
    const at = (re: RegExp) => logs.findIndex((l) => re.test(l));
    expect(at(/\[Rcon: Automatic saving is now disabled\]/)).toBeGreaterThanOrEqual(0);
    expect(at(/\[Rcon: Saved the game\]/)).toBeGreaterThan(at(/\[Rcon: Automatic saving is now disabled\]/));
    expect(at(/\[Rcon: Automatic saving is now enabled\]/)).toBeGreaterThan(at(/\[Rcon: Saved the game\]/));
    expect(await h!.agent.save()).toEqual({ ok: true });

    // The control secret never reaches the log.
    expect(logs.join('\n')).not.toContain(h!.store.controlSecret);

    await h!.agent.stop({}, undefined);
    const stopped = await h!.waitFor((x) => x.state === 'stopped');
    expect(stopped.lastExit).toMatchObject({ code: 0, expected: true });
  });

  it("refuses to start before the owner accepted the EULA, with the panel's reason, and tells the game nothing (D6)", async () => {
    env();
    await harness();
    await h!.agent.start(envelope({}, false), undefined);
    const s = await h!.waitFor((x) => x.state === 'failed');
    expect(s.failure).toMatch(/owner has not accepted the Minecraft EULA/);
    expect(s.pid).toBeNull();
    expect(existsSync(path.join(h!.cfg.dataDir!, 'eula.txt'))).toBe(false);
  });

  it('counts an exit nobody asked for as a crash, even with code 0, and names the fatal line (SRV-07)', async () => {
    env({ FAKE_MC_SCENARIO: 'crash-after-ready', FAKE_MC_CRASH_MS: '300' });
    await harness();
    await h!.agent.start(envelope({}), undefined);
    const s = await h!.waitFor((x) => x.state === 'crashed');
    expect(s.lastExit).toMatchObject({ code: 0, expected: false });
    expect(h!.events.some((e) => e.event.type === 'alert' && e.event.kind === 'fatal' && /Encountered an unexpected exception/.test(e.event.message))).toBe(true);
  });

  it('fails the start with the reason when Paper has no build in the pinned channel (UPD-05, Q13)', async () => {
    env();
    await harness();
    await h!.agent.start(envelope({ loader: 'paper' }), undefined);
    const s = await h!.waitFor((x) => x.state === 'failed');
    expect(s.failure).toBe('Game install failed: Paper has no STABLE build of Minecraft 26.3 yet (the newest, 41, is ALPHA); choose the ALPHA channel to install it, or another version');
  });

  it('lists the versions it can install for the stored launch (UPD-02)', async () => {
    env();
    await harness();
    h!.agent.setLaunch(envelope({ loader: 'paper', channel: 'ALPHA' }));
    const r = await h!.agent.versions();
    expect(r.versions.map((v) => v.id)).toEqual(['26.3', '26.2', '1.21.11']);
    expect(r.versions[0]).toMatchObject({ build: '41', channel: 'ALPHA', warning: 'paper-no-stable-build' });
    expect(r.installed).toBeNull();
  });
});
