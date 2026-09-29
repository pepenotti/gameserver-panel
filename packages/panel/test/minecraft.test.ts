// Minecraft in the panel (M3 phase 3), through the API with the harness's
// fake agents: the game listed with its loaders and the versions each
// offers (from the fake download services), servers created per loader
// with the owner's EULA, their meta, moderation by name or IP, the
// whitelist without passwords and switched live, the lists the running
// game rewrites, and the update check's channel and warning. The whole way
// through a real agent and the fake server is minecraft-e2e.test.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LaunchEnvelope } from '@gsp/shared';
import { startFakeDownloads, type FakeDownloads } from '../../../tools/fake-minecraft/downloads.mjs';
import { fakeStatus, friend, makePanel, ownerReady, type TestPanel } from './harness';

const FIXTURES = path.resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'minecraft', '26.3');
const fixture = (...p: string[]) => readFileSync(path.join(FIXTURES, ...p), 'utf8');

let downloads: FakeDownloads;
beforeAll(async () => {
  downloads = await startFakeDownloads({ fail: '' });
});
afterAll(() => downloads.close());

const downloadEnv = () => ({ GAME_MC_MOJANG_URL: downloads.url, GAME_MC_PAPER_URL: downloads.url, GAME_MC_FABRIC_URL: downloads.url });

async function panel(o: { network?: boolean } = {}) {
  const p = await makePanel({}, o.network === false ? {} : { downloads: { fetch, env: downloadEnv() } });
  const { client: owner } = await ownerReady(p);
  return { p, owner };
}

const launch = (over: Record<string, unknown> = {}) => ({ version: '26.2', channel: 'STABLE', loaderVersion: '', memoryMb: 2048, ...over });

async function create(c: Awaited<ReturnType<typeof panel>>['owner'], id: string, flavour: string, over: Record<string, unknown> = {}) {
  return c.post('/api/servers', { id, name: id, adapter: 'minecraft', flavour, launch: launch(), eulaAccepted: true, ...over });
}

/** The server's agent is up with its game running (the fake agent answers whatever the test sets). */
function running(p: TestPanel, id: string): void {
  p.fakes(id).feed.status_ = fakeStatus({ state: 'running', installedInfo: { version: '26.2', channel: 'vanilla' } });
}

describe('Minecraft offered in the panel (M3, SRV-01, UPD-06, HST-05)', () => {
  it('lists Minecraft with its loaders, its agreement, whether this host runs it, and its version choices', async () => {
    const { p, owner } = await panel();
    const mc = () => owner.get('/api/adapters').then((r) => (r.json() as { adapters: Record<string, unknown>[] }).adapters.find((a) => a.id === 'minecraft')!);
    expect(await mc()).toMatchObject({
      runtime: 'java',
      supported: true,
      flavours: [{ id: 'vanilla' }, { id: 'paper' }, { id: 'fabric' }],
      eula: true,
      agreement: { url: 'https://aka.ms/MinecraftEULA' },
      memory: { minMb: 1024, defaultMb: 2048, overheadMb: 1024 },
      launch: { secrets: [], choices: true, warnings: expect.objectContaining({ 'paper-no-stable-build': expect.objectContaining({ en: expect.any(String), es: expect.any(String) }) }) },
    });
    // Its jars are Java with ARM64 natives: an ARM64 host runs it too.
    p.orch.arch = 'arm64';
    expect(await mc()).toMatchObject({ supported: true });
  });

  it('offers the versions of a loader and what depends on the one picked, kept a few minutes (UPD-02, UPD-05, Q13)', async () => {
    const { p, owner } = await panel();
    const r = await owner.get('/api/adapters/minecraft/choices?flavour=paper&version=26.3');
    expect(r.statusCode).toBe(200);
    const c = r.json() as { version: { value: string; warning?: string; implies?: Record<string, string> }[]; channel: { value: string; warning?: string }[] };
    expect(c.version.map((v) => v.value)).toEqual(['26.3', '26.2', '1.21.11']);
    expect(c.version[0]).toMatchObject({ warning: 'paper-no-stable-build', implies: { channel: 'ALPHA' } });
    expect(c.channel.find((x) => x.value === 'STABLE')).toMatchObject({ warning: 'paper-channel-empty' });
    // Asked again: the panel's answer, not the services'.
    const asked = downloads.requests.length;
    expect((await owner.get('/api/adapters/minecraft/choices?flavour=paper&version=26.3')).json()).toEqual(c);
    expect(downloads.requests.length).toBe(asked);
    // The panel names itself to the services.
    expect(downloads.requests.at(-1)!.userAgent).toBe('gameserver-panel/test');
    const fabric = (await owner.get('/api/adapters/minecraft/choices?flavour=fabric&version=26.3')).json() as { loaderVersion: { value: string }[] };
    expect(fabric.loaderVersion.map((l) => l.value)).toEqual(['', '0.19.5', '0.19.4']);

    expect((await owner.get('/api/adapters/pz/choices')).json()).toEqual({ error: 'choices-unsupported' });
    expect((await owner.get('/api/adapters/nope/choices?flavour=paper')).json()).toEqual({ error: 'unknown-adapter' });
    expect((await owner.get('/api/adapters/minecraft/choices?flavour=forge')).json()).toMatchObject({ error: 'unknown-flavour' });
    expect((await owner.get('/api/adapters/minecraft/choices?flavour=paper&version=26.3%0Aquit')).statusCode).toBe(400);
    // Who can't create servers can't ask either.
    const granted = await friend(p, owner, 'granted-admin', 'admin', 'admin');
    expect((await granted.get('/api/adapters/minecraft/choices?flavour=paper')).json()).toEqual({ error: 'forbidden' });
  });

  it('says so when the download services cannot be reached (UPD-02)', async () => {
    const { owner } = await panel({ network: false });
    const r = await owner.get('/api/adapters/minecraft/choices?flavour=vanilla');
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ error: 'choices-unavailable', message: expect.stringMatching(/no network/) });
  });

  it('creates a server of each loader: its flavour is its loader, the owner accepts the EULA, the java runtime runs it (D6)', async () => {
    const { p, owner } = await panel();
    for (const [i, flavour] of ['vanilla', 'paper', 'fabric'].entries()) {
      const r = await create(owner, `mc-${flavour}`, flavour);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ adapter: 'minecraft', flavour, managed: true, memLimitMb: 2048 + 1024, eula: { url: 'https://aka.ms/MinecraftEULA', acceptedBy: 'alice' } });
      const spec = p.orch.containers.get(`mc-${flavour}`)!.spec;
      expect(spec).toMatchObject({ runtime: 'java', env: { GAME_ADAPTER: 'minecraft', GAME_FLAVOUR: flavour, GAME_PORT_GAME: '25565' }, ports: [{ container: 25565, host: 25565 + i, proto: 'tcp' }] });
    }
    // The loader is picked when the server is created (UPD-06): one is needed, and it must be one of the three.
    expect((await create(owner, 'mc-none', undefined as unknown as string, { flavour: null })).json()).toMatchObject({ error: 'unknown-flavour' });
    expect((await create(owner, 'mc-forge', 'forge')).json()).toMatchObject({ error: 'unknown-flavour' });
    expect((await create(owner, 'mc-noeula', 'vanilla', { eulaAccepted: undefined })).json()).toEqual({ error: 'eula-required' });
    expect((await create(owner, 'mc-old', 'vanilla', { launch: launch({ version: '1.12.2' }) })).json()).toMatchObject({ error: 'invalid-options', message: expect.stringMatching(/1\.16\.5 or newer/) });
    expect((await create(owner, 'mc-typo', 'paper', { launch: launch({ channel: 'stable' }) })).json()).toMatchObject({ error: 'invalid-options' });

    // Started: the agent gets the loader, Paper's channel and the owner's acceptance.
    const seen: LaunchEnvelope[] = [];
    p.fakes('mc-paper').agent.start = async (l?: LaunchEnvelope) => (l && seen.push(l), fakeStatus());
    expect((await owner.post('/api/servers/mc-paper/server/start')).statusCode).toBe(200);
    await p.deps.servers.get('mc-paper')!.ops.idle();
    expect(seen).toEqual([{ adapter: 'minecraft', params: { version: '26.2', loader: 'paper', channel: 'STABLE', build: null, loaderVersion: null, memoryMb: 2048 }, eulaAccepted: true }]);
  });

  it("describes each server's parts, whitelist and levels as its loader has them (AST-04, PLY-03)", async () => {
    const { owner } = await panel();
    await create(owner, 'mc-vanilla', 'vanilla');
    await create(owner, 'mc-paper', 'paper');
    const meta = async (id: string) => (await owner.get(`/api/servers/${id}/meta`)).json() as Record<string, unknown> & { backupParts: { id: string }[]; resets: { id: string; removeParts: string[] }[] };
    const v = await meta('mc-vanilla');
    expect(v.backupParts.map((x) => x.id)).toEqual(['world', 'config']);
    expect(v.resets).toEqual([expect.objectContaining({ id: 'world', removeParts: ['world'] }), expect.objectContaining({ id: 'factory', removeParts: ['world', 'config'] })]);
    expect(v).toMatchObject({ banTargets: ['username', 'ip'], whitelist: { password: false, toggle: true, list: true }, levelHolders: true, accessLevels: [{ id: 'player' }, { id: 'operator' }] });
    expect((await meta('mc-paper')).backupParts.map((x) => x.id)).toEqual(['world', 'config', 'plugins']);
    // PZ as it was: whitelist entries are accounts with a password.
    expect(await meta('default')).toMatchObject({ whitelist: { password: true, toggle: false, list: false }, levelHolders: false });
  });
});

describe('moderating a Minecraft server through the API (PLY-01, PLY-03)', () => {
  it('bans and pardons by name or by address, whitelists by name, switches the whitelist, and reads the lists the game wrote', async () => {
    const { p, owner } = await panel();
    await create(owner, 'mc-vanilla', 'vanilla');
    running(p, 'mc-vanilla');
    const agent = p.fakes('mc-vanilla').agent;
    const post = (url: string, body: unknown) => owner.post(`/api/servers/mc-vanilla${url}`, body);
    expect((await post('/players/ban', { username: 'gspffBob', reason: 'griefing' })).json()).toEqual({ output: 'ok' });
    await post('/players/ban', { ip: '203.0.113.7' });
    await post('/players/unban', { ip: '203.0.113.7' });
    await post('/players/unban', { username: 'gspffBob' });
    await post('/players/whitelist', { username: 'gspffCarol' });
    await post('/players/access', { username: 'gspffCarol', level: 'operator' });
    await post('/players/whitelist/enabled', { enabled: false });
    await post('/players/kick', { username: 'gspffCarol', reason: 'afk' });
    expect(agent.calls.filter((c) => c.startsWith('command:'))).toEqual([
      'command:ban gspffBob griefing',
      'command:ban-ip 203.0.113.7',
      'command:pardon-ip 203.0.113.7',
      'command:pardon gspffBob',
      'command:whitelist add gspffCarol',
      'command:op gspffCarol',
      'command:whitelist off',
      'command:kick gspffCarol afk',
    ]);
    // What the game can't take is refused before it is sent.
    const before = agent.calls.length;
    expect((await post('/players/ban', { ip: 'not an ip' })).statusCode).toBe(400);
    expect((await post('/players/ban', { ip: '999.0.0.1' })).json()).toMatchObject({ error: 'invalid-argument' });
    expect((await post('/players/ban', { steamId: '76561198000000000' })).json()).toMatchObject({ error: 'invalid-argument' });
    expect((await post('/players/access', { username: 'gspffCarol', level: 'admin' })).json()).toMatchObject({ error: 'validation' });
    expect(agent.calls.length).toBe(before);
    expect(p.deps.audit.list({ action: 'player.ban' })[1]).toMatchObject({ serverId: 'mc-vanilla', target: 'gspffBob' });
    expect(p.deps.audit.list({ action: 'player.ban' })[0]).toMatchObject({ target: '203.0.113.7' });
    expect(p.deps.audit.list({ action: 'player.whitelist-off' })).toHaveLength(1);

    // The lists, as the game wrote them.
    const data = p.fakes('mc-vanilla').dataDir;
    mkdirSync(data, { recursive: true });
    // Paper's files: it keeps names as typed (vanilla lower-cases offline ones).
    for (const f of ['whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json']) writeFileSync(path.join(data, f), fixture('paper', 'files', f));
    writeFileSync(path.join(data, 'server.properties'), fixture('vanilla', 'config', 'server.properties.after'));
    const players = (await owner.get('/api/servers/mc-vanilla/players')).json() as Record<string, unknown>;
    expect(players).toMatchObject({
      whitelist: { usernames: ['gspffAlice', 'gspffBob'] },
      levelHolders: [{ username: 'gspffAlice', level: 'operator' }],
      bans: { steamIds: [], usernames: [{ username: 'gspffBob', reason: 'Testing a ban' }], ips: [{ ip: '203.0.113.7', username: null }] },
    });
  });

  it('answers what the game refused with an error, not a 200 with its reply (PLY-03)', async () => {
    const { p, owner } = await panel();
    await create(owner, 'mc-vanilla', 'vanilla');
    running(p, 'mc-vanilla');
    const agent = p.fakes('mc-vanilla').agent;
    const said = (reply: string) => {
      agent.command = async (c) => (agent.calls.push(`command:${c}`), { via: 'rcon' as const, output: reply });
    };
    const post = async (url: string, body: unknown) => {
      const r = await owner.post(`/api/servers/mc-vanilla${url}`, body);
      return [r.statusCode, r.json()];
    };
    // What the owner met: a name the game can't look up (measured replies, fixtures/minecraft/26.3/*/rcon/moderation.json).
    said('That player does not exist');
    expect(await post('/players/whitelist', { username: 'gspffNoSuchPlr7' })).toEqual([404, { error: 'player-not-found', output: 'That player does not exist' }]);
    expect(await post('/players/ban', { username: 'gspffNoSuchPlr7' })).toEqual([404, { error: 'player-not-found', output: 'That player does not exist' }]);
    expect(await post('/players/access', { username: 'gspffNoSuchPlr7', level: 'operator' })).toEqual([404, { error: 'player-not-found', output: 'That player does not exist' }]);
    said('No player was found');
    expect(await post('/players/kick', { username: 'gspffNoSuchPlr7' })).toEqual([409, { error: 'player-not-online', output: 'No player was found' }]);
    said('Nothing changed. The player is already an operator');
    expect(await post('/players/access', { username: 'gspffAlice', level: 'operator' })).toEqual([409, { error: 'level-unchanged', output: 'Nothing changed. The player is already an operator' }]);
    said('Whitelist is already turned on');
    expect(await post('/players/whitelist/enabled', { enabled: true })).toEqual([409, { error: 'whitelist-unchanged', output: 'Whitelist is already turned on' }]);
    // Refused commands aren't moderation that happened.
    expect(p.deps.audit.list({ action: 'player.' })).toEqual([]);
    said('Added gspffAlice to the whitelist');
    expect(await post('/players/whitelist', { username: 'gspffAlice' })).toEqual([200, { output: 'Added gspffAlice to the whitelist' }]);
  });

  it('keeps PZ’s whitelist as it was: accounts with a password, and no switch', async () => {
    const { p, owner } = await panel();
    p.feed.status_ = fakeStatus({ state: 'running' });
    expect((await owner.post('/api/servers/default/players/whitelist', { username: 'rick' })).json()).toMatchObject({ error: 'validation', message: 'password is required' });
    expect((await owner.post('/api/servers/default/players/whitelist', { username: 'rick', password: 'hunter22' })).json()).toEqual({ output: 'ok' });
    expect(p.agent.calls.at(-1)).toBe('command:adduser "rick" "hunter22"');
    expect((await owner.post('/api/servers/default/players/whitelist/enabled', { enabled: true })).json()).toMatchObject({ error: 'capability-unsupported' });
    expect((await owner.post('/api/servers/default/players/ban', { ip: '203.0.113.7' })).json()).toMatchObject({ error: 'invalid-argument' });
  });
});

describe('Minecraft config files through the API (CFG-04, CFG-05, D6)', () => {
  async function withFiles() {
    const { p, owner } = await panel();
    await create(owner, 'mc-vanilla', 'vanilla');
    const data = p.fakes('mc-vanilla').dataDir;
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(data, 'server.properties'), fixture('vanilla', 'config', 'server.properties.after'));
    writeFileSync(path.join(data, 'eula.txt'), fixture('vanilla', 'config', 'eula.txt.generated'));
    writeFileSync(path.join(data, 'ops.json'), fixture('vanilla', 'files', 'ops.json'));
    const propose = async (fileId: string, body: Record<string, unknown>) => {
      const r = await owner.post('/api/servers/mc-vanilla/config/proposals', { fileId, ...body });
      if (r.statusCode !== 200) return r;
      const { id } = r.json() as { id: string | null };
      return id ? owner.post(`/api/servers/mc-vanilla/config/proposals/${id}/apply`) : r;
    };
    return { p, owner, data, propose };
  }

  it('changes the operator list only while the game is stopped: it writes the list back from memory', async () => {
    const { p, data, propose } = await withFiles();
    running(p, 'mc-vanilla');
    const r = await propose('ops', { text: '[]' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'config-stopped-only', file: 'ops' });
    p.fakes('mc-vanilla').feed.status_ = fakeStatus({ state: 'stopped' });
    expect((await propose('ops', { text: '[]' })).statusCode).toBe(200);
    expect(readFileSync(path.join(data, 'ops.json'), 'utf8')).toBe('[]');
  });

  it('keeps the agent’s keys and the owner’s EULA acceptance whatever the text editor saves (CFG-04, D6)', async () => {
    const { owner, data, propose } = await withFiles();
    const props = readFileSync(path.join(data, 'server.properties'), 'utf8');
    const text = props.replace(/^motd=.*$/m, 'motd=Mi servidor').replace('enable-rcon=true', 'enable-rcon=false').replace(/^level-name=.*$/m, 'level-name=other');
    // The preview says which keys the panel puts back, and why.
    const preview = (await owner.post('/api/servers/mc-vanilla/config/proposals', { fileId: 'properties', text })).json() as { reapplied: { key: string; why: string }[] };
    expect(preview.reapplied.map((x) => [x.key, x.why]).sort()).toEqual([
      ['enable-rcon', 'set-by-panel'],
      ['level-name', 'set-by-panel'],
    ]);
    const r = await propose('properties', { text });
    expect(r.statusCode, r.body).toBe(200);
    const after = readFileSync(path.join(data, 'server.properties'), 'utf8');
    expect(after).toMatch(/^motd=Mi servidor$/m);
    expect(after).toMatch(/^enable-rcon=true$/m);
    expect(after).toMatch(/^level-name=world$/m);
    // A form can't touch them at all, and says why.
    expect((await propose('properties', { changes: { 'rcon.port': 1 } })).json()).toMatchObject({ error: 'invalid-options', fields: { 'rcon.port': 'managed' } });
    // eula=true typed in the editor stays what the owner's acceptance made it.
    expect((await propose('eula', { text: 'eula=true\n' })).statusCode).toBe(200);
    expect(readFileSync(path.join(data, 'eula.txt'), 'utf8')).toMatch(/^eula=false$/m);
  });

  it('refuses lists the game could not load, a whitelist of bare names first, and says to use the Players page (CFG-02, CFG-08)', async () => {
    const { owner, data, propose } = await withFiles();
    const listed = fixture('vanilla', 'files', 'whitelist.json');
    writeFileSync(path.join(data, 'whitelist.json'), listed);
    writeFileSync(path.join(data, 'banned-ips.json'), '[]');
    // What the owner saved in the acceptance run: the game would run with an empty whitelist.
    for (const fileId of ['whitelist', 'path:data/whitelist.json']) {
      const r = await propose(fileId, { text: '["gspffAlice"]' });
      expect(r.statusCode, fileId).toBe(400);
      expect(r.json()).toEqual({
        error: 'invalid-file',
        issues: [{ line: 1, col: 2, message: expect.stringMatching(/Players page/), localized: { en: expect.stringMatching(/Players page/), es: expect.stringMatching(/página Jugadores/) } }],
      });
    }
    expect(readFileSync(path.join(data, 'whitelist.json'), 'utf8')).toBe(listed);
    expect((await propose('ops', { text: '[{"name": "gspffAlice", "level": 4}]' })).json()).toMatchObject({ error: 'invalid-file', issues: [{ line: 1 }] });
    expect((await propose('banned-ips', { text: '[{"ip": "gspffAlice"}]' })).json()).toMatchObject({ error: 'invalid-file' });
    // A list as the game writes it is taken.
    expect((await propose('whitelist', { text: fixture('paper', 'files', 'whitelist.json') })).statusCode).toBe(200);
    // One already broken on disk opens with what is wrong with it.
    writeFileSync(path.join(data, 'whitelist.json'), '[\n  "gspffAlice"\n]');
    const content = (await owner.get('/api/servers/mc-vanilla/config/files/content?id=whitelist')).json() as { issues: { line: number; localized?: unknown }[] };
    expect(content.issues).toEqual([expect.objectContaining({ line: 2, col: 3, localized: expect.objectContaining({ es: expect.stringMatching(/entrada 1/) }) })]);
  });

  it("puts back the settings saved since the start that an operator's whitelist switch in game wrote over; not over a restored file (CFG-05)", async () => {
    const { p, owner, data, propose } = await withFiles();
    const srv = p.deps.servers.get('mc-vanilla')!;
    const file = path.join(data, 'server.properties');
    const original = readFileSync(file, 'utf8');
    const value = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'))?.[1];
    const start = async () => {
      expect((await owner.post('/api/servers/mc-vanilla/server/start')).statusCode).toBe(200);
      await srv.ops.idle();
      expect(srv.ops.last()).toMatchObject({ kind: 'start', ok: true });
    };
    const stopped = () => (p.fakes('mc-vanilla').feed.status_ = fakeStatus({ state: 'stopped' }));
    // A backup of the settings as they are (stopped: a cold copy).
    expect((await owner.post('/api/servers/mc-vanilla/backups')).statusCode).toBe(200);
    await srv.ops.idle();
    const backup = srv.backups.list()[0]!;

    running(p, 'mc-vanilla');
    expect((await propose('properties', { changes: { motd: 'Saved while running', difficulty: 'hard' } })).statusCode).toBe(200);
    // An operator types "whitelist on" in game: the game writes the file from what it loaded at its start.
    writeFileSync(file, original.replace(/^white-list=.*$/m, 'white-list=true'));
    stopped();
    await start();
    // The panel's settings are back; the whitelist stays as the operator switched it.
    expect([value('motd'), value('difficulty'), value('white-list')]).toEqual(['Saved while running', 'hard', 'true']);
    expect(srv.config.historyOf('properties')[0]!.note).toBe('kept the settings saved in the panel since the last start (the game rewrote the file): difficulty, motd');

    // The panel's own whitelist switch is something the game holds: an operator switching it back in game later wins.
    running(p, 'mc-vanilla');
    p.fakes('mc-vanilla').agent.command = async (c) => {
      if (c === 'whitelist off') writeFileSync(file, readFileSync(file, 'utf8').replace(/^white-list=.*$/m, 'white-list=false'));
      return { via: 'rcon', output: 'Whitelist is now turned off' };
    };
    expect((await owner.post('/api/servers/mc-vanilla/players/whitelist/enabled', { enabled: false })).statusCode).toBe(200);
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^white-list=.*$/m, 'white-list=true'));
    stopped();
    await start();
    expect(value('white-list')).toBe('true');

    // Saved while running, then the settings restored from the backup: the restored file stays as it was backed up.
    running(p, 'mc-vanilla');
    expect((await propose('properties', { changes: { motd: 'Saved before the restore' } })).statusCode).toBe(200);
    stopped();
    expect((await owner.post(`/api/servers/mc-vanilla/backups/${encodeURIComponent(backup.name)}/restore`, { parts: ['config'] })).statusCode).toBe(200);
    await srv.ops.idle();
    expect(srv.ops.last()).toMatchObject({ kind: 'restore', ok: true });
    await start();
    expect(value('motd')).toBe('Servidor de prueba Ñandú ☃');
  });

  it('checks the difficulty and game mode against their words (CFG-01)', async () => {
    const { data, propose } = await withFiles();
    expect((await propose('properties', { changes: { difficulty: 'hard', gamemode: 'creative' } })).statusCode).toBe(200);
    expect(readFileSync(path.join(data, 'server.properties'), 'utf8')).toMatch(/^difficulty=hard$/m);
    expect((await propose('properties', { changes: { difficulty: '3' } })).json()).toMatchObject({ error: 'invalid-options', fields: { difficulty: 'is not one of the allowed choices' } });
  });
});

describe('the update check and version choices of a Minecraft server (UPD-02, UPD-03, UPD-05, Q13)', () => {
  it("shows the pinned version's channel and warning, and the newest build of the pinned channel", async () => {
    const { p, owner } = await panel();
    await create(owner, 'mc-paper', 'paper', { launch: launch({ version: '26.3', channel: 'ALPHA' }) });
    p.fakes('mc-paper').agent.versions = async () => ({
      installed: { version: '26.3', channel: 'paper', build: '40' },
      versions: [
        { id: '26.3', build: '41', channel: 'ALPHA', warning: 'paper-no-stable-build', builds: [41, 40].map((id) => ({ id, channel: 'ALPHA', timeUpdated: 0 })) } as never,
        { id: '26.2', build: '129', channel: 'STABLE' },
      ],
    });
    const u = (await owner.get('/api/servers/mc-paper/server/updates')).json() as Record<string, unknown>;
    expect(u).toMatchObject({
      updateAvailable: true,
      check: { available: true, current: '26.3-40', latest: '26.3-41', channel: 'ALPHA' },
      pinned: { id: '26.3', build: '41', channel: 'ALPHA', warning: { en: expect.stringMatching(/no stable build/), es: expect.any(String) } },
    });
    // The server's own version choices, for its loader.
    const c = (await owner.get('/api/servers/mc-paper/server/launch/choices?version=26.2')).json() as { channel: { value: string; warning?: string }[] };
    expect(c.channel.map((x) => [x.value, x.warning ?? null])).toEqual([
      ['STABLE', null],
      ['BETA', 'paper-unstable-channel'],
      ['ALPHA', 'paper-unstable-channel'],
    ]);
    expect((await owner.get('/api/servers/default/server/launch/choices')).json()).toMatchObject({ error: 'capability-unsupported' });
  });
});
