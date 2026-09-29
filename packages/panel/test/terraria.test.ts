// Terraria in the panel (M5 phase 3), through the API with the harness's
// fake agents: the game listed with its flavours and the versions each
// offers (from the fake download services), x86-64 hosts only; servers
// created per flavour (tModLoader in the steam image), their meta, the
// secret server password, TShock's config with its REST token hidden
// whole, moderation per flavour (the console's IP bans, TShock's REST
// actions), TShock's broadcasts through its REST API. The whole way through
// a real agent and the fake server is terraria-e2e.test.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearChoicesCache } from '@gsp/adapter-terraria/panel';
import type { LaunchEnvelope, SeqEvent } from '@gsp/shared';
import { startFakeDownloads, type FakeDownloads } from '../../../tools/fake-terraria/downloads.mjs';
import { MASK } from '../src/config/service';
import { LAUNCH_MASK } from '../src/server/handle';
import { fakeStatus, makePanel, ownerReady, type Client, type TestPanel } from './harness';

const FIXTURES = path.resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'terraria', '1.4.5.8');
const fixture = (...p: string[]) => readFileSync(path.join(FIXTURES, ...p), 'utf8');

let downloads: FakeDownloads;
beforeAll(async () => {
  downloads = await startFakeDownloads({ fail: '' });
});
afterAll(() => downloads.close());
beforeEach(() => clearChoicesCache());

const downloadEnv = () => ({ GAME_TERRARIA_ORG_URL: downloads.url, GAME_TERRARIA_GITHUB_URL: downloads.url });

async function panel() {
  const p = await makePanel({}, { downloads: { fetch, env: downloadEnv() } });
  const { client: owner } = await ownerReady(p);
  return { p, owner };
}

const launch = (over: Record<string, unknown> = {}) => ({ version: '', channel: 'stable', worldSize: 1, maxPlayers: 8, password: '', memoryMb: 2048, ...over });
const create = (c: Client, id: string, flavour: string, over: Record<string, unknown> = {}) => c.post('/api/servers', { id, name: id, adapter: 'terraria', flavour, launch: launch(), ...over });
const running = (p: TestPanel, id: string) => {
  p.fakes(id).feed.status_ = fakeStatus({ state: 'running', installedInfo: { version: '1.4.5.8', channel: 'vanilla' }, control: { kind: 'stdin', connected: true, lastError: null } });
};

describe('Terraria offered in the panel (M5, SRV-01, HST-05, UPD-02)', () => {
  it('lists Terraria with its flavours, tModLoader in the steam image, no license, and x86-64 hosts only', async () => {
    const { p, owner } = await panel();
    const tr = async () => ((await owner.get('/api/adapters')).json() as { adapters: Record<string, unknown>[] }).adapters.find((a) => a.id === 'terraria')!;
    expect(await tr()).toMatchObject({
      runtime: 'native',
      arch: ['amd64'],
      supported: true,
      flavours: [{ id: 'vanilla' }, { id: 'tshock' }, { id: 'tmodloader', runtime: 'steam' }],
      eula: false,
      agreement: null,
      memory: { minMb: 1024, defaultMb: 2048, overheadMb: 256 },
      launch: { secrets: [], choices: true, warnings: expect.objectContaining({ 'tml-preview': expect.objectContaining({ en: expect.any(String), es: expect.any(String) }) }) },
    });
    // The password is a setting people choose, kept secret.
    expect(((await tr()).launch as { schema: { key: string; secret?: boolean }[] }).schema.find((o) => o.key === 'password')).toMatchObject({ secret: true });
    // Vanilla's server is an x86-64 build: an ARM64 host says no, and why (HST-05).
    p.orch.arch = 'arm64';
    expect(await tr()).toMatchObject({ supported: false });
    expect((await create(owner, 'tr-arm', 'vanilla')).json()).toEqual({ error: 'arch-unsupported', arch: 'arm64', supported: ['amd64'] });
  });

  it('offers each flavour’s versions from its download services, keeping GitHub’s answers (UPD-02)', async () => {
    const { owner } = await panel();
    const choices = async (q: string) => (await owner.get(`/api/adapters/terraria/choices?${q}`)).json() as { version: { value: string; warning?: string }[]; channel?: { value: string }[] };
    expect((await choices('flavour=vanilla')).version.slice(0, 2).map((v) => v.value)).toEqual(['', '1.4.5.8']);
    expect((await choices('flavour=tshock')).version.map((v) => [v.value, v.warning ?? null])).toEqual([
      ['', null],
      ['v6.2.1', null],
      ['v6.1.0', null],
      ['v6.0.0-pre3', 'tshock-prerelease'],
      ['v5.2.4', null],
    ]);
    const asked = downloads.requests.filter((r) => r.path.startsWith('/repos/')).length;
    const tml = await choices('flavour=tmodloader&version=v2026.07.3.0');
    expect(tml.channel?.map((c) => c.value)).toEqual(['stable', 'preview']);
    await choices('flavour=tmodloader&version=v2026.08.2.2');
    expect(downloads.requests.filter((r) => r.path.startsWith('/repos/')).length - asked).toBe(1);
  });

  it('creates a server of each flavour: its world is named after it, tModLoader runs in the steam image (SRV-01, HST-05)', async () => {
    const { p, owner } = await panel();
    for (const [i, flavour] of ['vanilla', 'tshock', 'tmodloader'].entries()) {
      const r = await create(owner, `tr-${flavour}`, flavour);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ adapter: 'terraria', flavour, managed: true, memLimitMb: 2048 + 256, eula: null, ports: [{ id: 'game', port: 7777 + i, proto: 'tcp' }] });
      const spec = p.orch.containers.get(`tr-${flavour}`)!.spec;
      expect(spec).toMatchObject({ runtime: flavour === 'tmodloader' ? 'steam' : 'native', env: { GAME_ADAPTER: 'terraria', GAME_FLAVOUR: flavour, GAME_PORT_GAME: '7777' }, ports: [{ container: 7777, host: 7777 + i, proto: 'tcp' }] });
    }
    // A flavour is needed, one of the three; a large world needs 2 GiB; a version must be the flavour's.
    expect((await create(owner, 'tr-none', undefined as unknown as string, { flavour: null })).json()).toMatchObject({ error: 'unknown-flavour' });
    expect((await create(owner, 'tr-large', 'vanilla', { launch: launch({ worldSize: 3, memoryMb: 1024 }) })).json()).toMatchObject({ error: 'invalid-options', message: expect.stringMatching(/at least 2048/) });
    expect((await create(owner, 'tr-wrong', 'tshock', { launch: launch({ version: '1.4.5.8' }) })).json()).toMatchObject({ error: 'invalid-options', message: expect.stringMatching(/release tag/) });

    // Started: the agent gets the flavour, the world named after the server, and the password (never shown again).
    expect((await create(owner, 'tr-secret', 'tshock', { launch: launch({ version: 'v6.2.1', password: 'join-us-2026' }) })).statusCode).toBe(200);
    expect((await owner.get('/api/servers/tr-secret/server/launch')).json()).toMatchObject({ password: LAUNCH_MASK, version: 'v6.2.1' });
    const seen: LaunchEnvelope[] = [];
    p.fakes('tr-secret').agent.start = async (l?: LaunchEnvelope) => (l && seen.push(l), fakeStatus());
    expect((await owner.post('/api/servers/tr-secret/server/start')).statusCode).toBe(200);
    await p.deps.servers.get('tr-secret')!.ops.idle();
    expect(seen).toEqual([{ adapter: 'terraria', params: { flavour: 'tshock', version: 'v6.2.1', channel: null, world: 'tr-secret', worldSize: 1, maxPlayers: 8, password: 'join-us-2026', memoryMb: 2048 } }]);
    expect(JSON.stringify(p.deps.audit.list({}))).not.toContain('join-us-2026');
  });

  it('describes each flavour’s moderation, parts, resets and console (AST-04, PLY-03, BAK-04)', async () => {
    const { owner } = await panel();
    for (const f of ['vanilla', 'tshock', 'tmodloader']) await create(owner, `tr-${f}`, f);
    type Meta = { banTargets: string[]; banByAddress: boolean; stoppedOnly: string[]; backupParts: { id: string }[]; resets: { id: string }[]; consoleCatalog: { name: string }[]; capabilities: string[] };
    const meta = async (id: string) => (await owner.get(`/api/servers/${id}/meta`)).json() as Meta;
    const vanilla = await meta('tr-vanilla');
    expect(vanilla).toMatchObject({ banTargets: ['username'], banByAddress: true, stoppedOnly: ['unban'] });
    expect(vanilla.backupParts.map((x) => x.id)).toEqual(['world', 'settings']);
    expect(vanilla.resets.map((x) => x.id)).toEqual(['world', 'factory']);
    expect(vanilla.consoleCatalog.map((x) => x.name)).toContain('password');
    expect(vanilla.capabilities).toEqual(expect.arrayContaining(['kick', 'ban', 'broadcast', 'settingsForms', 'updateCheck']));
    expect(vanilla.capabilities).not.toContain('restApi');
    const tshock = await meta('tr-tshock');
    expect(tshock).toMatchObject({ banTargets: ['username', 'ip', 'uuid', 'account'], banByAddress: false, stoppedOnly: [] });
    expect(tshock.backupParts.map((x) => x.id)).toEqual(['world', 'settings', 'database']);
    expect(tshock.resets.map((x) => x.id)).toEqual(['world', 'players', 'factory']);
    expect(tshock.consoleCatalog.map((x) => x.name)).toEqual(expect.arrayContaining(['who', 'ban add']));
    expect(tshock.consoleCatalog.map((x) => x.name)).not.toContain('password');
    expect((await meta('tr-tmodloader')).consoleCatalog.map((x) => x.name)).toContain('modlist');
    // A players reset is TShock's alone.
    expect((await owner.post('/api/servers/tr-vanilla/reset', { scope: 'players', confirm: 'tr-vanilla' })).json()).toMatchObject({ message: 'unknown reset scope' });
  });
});

describe("TShock's config: the agent's REST token hidden whole (CFG-04, CON-04)", () => {
  it('shows neither the token nor its key in the form, the editor or history, and keeps it through edits', async () => {
    const { p, owner } = await panel();
    await create(owner, 'tr-tshock', 'tshock');
    const data = p.fakes('tr-tshock').dataDir;
    mkdirSync(path.join(data, 'tshock'), { recursive: true });
    // What TShock wrote, with the agent's REST settings and token as its prepare leaves them.
    const written = JSON.parse(fixture('tshock', 'config', 'config.json.generated')) as { Settings: Record<string, unknown> };
    const token = 'd41f0c8e2b7a4f5e9c3a1b2c3d4e5f60718293a4b5c6d7e8';
    Object.assign(written.Settings, { RestApiEnabled: true, ServerPassword: 'tshock-own-pw', ApplicationRestTokens: { [token]: { Username: 'gameserver-panel', UserGroupName: 'superadmin' } } });
    const file = path.join(data, 'tshock', 'config.json');
    writeFileSync(file, JSON.stringify(written, null, 2));
    const url = (x: string) => `/api/servers/tr-tshock${x}`;
    const values = ((await owner.get(url('/config/values?id=tshock-config'))).json() as { values: Record<string, unknown> }).values;
    expect(values).toMatchObject({ 'Settings.ApplicationRestTokens': MASK, 'Settings.ServerPassword': MASK, 'Settings.RestApiEnabled': true, 'Settings.MaxSlots': 8 });
    const text = ((await owner.get(url('/config/files/content?id=tshock-config'))).json() as { text: string; note: { en: string } }).text;
    // Changing a setting in the text keeps the token as it is.
    const proposed = await owner.post(url('/config/proposals'), { fileId: 'tshock-config', text: text.replace('"ServerName": ""', '"ServerName": "Friends"') });
    expect(proposed.json()).toMatchObject({ changedKeys: ['Settings.ServerName'], reapplied: [] });
    expect((await owner.post(url(`/config/proposals/${(proposed.json() as { id: string }).id}/apply`))).statusCode).toBe(200);
    const after = JSON.parse(readFileSync(file, 'utf8')) as { Settings: Record<string, unknown> };
    expect(after.Settings).toMatchObject({ ServerName: 'Friends', ServerPassword: 'tshock-own-pw', ApplicationRestTokens: { [token]: { Username: 'gameserver-panel' } } });
    // A form can't change what the agent owns.
    expect((await owner.post(url('/config/proposals'), { fileId: 'tshock-config', changes: { 'Settings.RestApiPort': 1 } })).json()).toMatchObject({ error: 'invalid-options', fields: { 'Settings.RestApiPort': 'managed' } });
    const seen = JSON.stringify([values, text, await (await owner.get(url('/config/meta'))).json(), ...(await Promise.all(p.deps.servers.get('tr-tshock')!.config.historyOf('tshock-config').map((v) => owner.get(url(`/config/history/${v.id}`)).then((r) => r.json()))))]);
    expect(seen).not.toContain(token);
    expect(seen).not.toContain('tshock-own-pw');
    expect(seen).toContain('drops anything it doesn’t know');
  });
});

describe('moderating Terraria through the API (PLY-03, CON-04, PRD §7)', () => {
  it('vanilla: kicks and bans an online player on the console, and lifts bans from the ban list only while stopped', async () => {
    const { p, owner } = await panel();
    await create(owner, 'tr-vanilla', 'vanilla');
    running(p, 'tr-vanilla');
    const fake = p.fakes('tr-vanilla');
    const data = fake.dataDir;
    mkdirSync(data, { recursive: true });
    let seq = 0;
    const log = (line: string) => fake.feed.emit({ type: 'log', stream: 'out', line } as SeqEvent['event']);
    fake.agent.command = async (c, via) => {
      fake.agent.calls.push(`command:${c}:${via}`);
      const who = /^(?:kick|ban) (.+)$/.exec(c)?.[1];
      if (who && who !== 'nobody') {
        if (c.startsWith('ban')) writeFileSync(path.join(data, 'banlist.txt'), `//${who}\n192.0.2.1\n`, { flag: 'a' });
        setTimeout(() => {
          log(`192.0.2.1:${30000 + ++seq} was booted: ${c.startsWith('ban') ? 'Banned' : 'Kicked'} from server.`);
          log(`${who} has left.`);
        }, 10);
      }
      return { via: 'stdin', output: null };
    };
    const post = async (x: string, body: unknown) => {
      const r = await owner.post(`/api/servers/tr-vanilla/players${x}`, body);
      return [r.statusCode, r.json()];
    };
    expect(await post('/kick', { username: 'gspffbob', reason: 'afk' })).toEqual([200, { output: 'Kicked gspffbob' }]);
    expect(await post('/ban', { username: 'gspffcarol' })).toEqual([200, { output: 'Banned gspffcarol (address 192.0.2.1)' }]);
    expect(await post('/ban', { ip: '203.0.113.7' })).toMatchObject([400, { error: 'invalid-argument' }]);
    expect(fake.agent.calls.filter((c) => c.startsWith('command:'))).toEqual(['command:kick gspffbob:stdin', 'command:ban gspffcarol:stdin']);
    expect(((await owner.get('/api/servers/tr-vanilla/players')).json() as { bans: unknown }).bans).toEqual({ steamIds: [], ips: [{ ip: '192.0.2.1', username: 'gspffcarol', reason: null }] });
    // The running game keeps its bans in memory.
    expect(await post('/unban', { ip: '192.0.2.1' })).toEqual([409, { error: 'server-running' }]);
    fake.feed.status_ = fakeStatus({ state: 'stopped' });
    expect(await post('/unban', { ip: '192.0.2.1' })).toEqual([200, { output: 'Lifted the ban on 192.0.2.1 (gspffcarol)' }]);
    expect(readFileSync(path.join(data, 'banlist.txt'), 'utf8').trim()).toBe('');
    expect(p.deps.servers.get('tr-vanilla')!.config.historyOf('banlist')[0]).toMatchObject({ username: 'alice', note: 'unbanned 192.0.2.1' });
    expect(await post('/unban', { username: 'gspffcarol' })).toEqual([409, { error: 'not-banned', output: '(no-change) gspffcarol is not banned' }]);
  }, 30_000);

  it('TShock: kicks, bans and unbans by name, IP, UUID or account through its REST actions; broadcasts too', async () => {
    const { p, owner } = await panel();
    await create(owner, 'tr-tshock', 'tshock');
    running(p, 'tr-tshock');
    const agent = p.fakes('tr-tshock').agent;
    const actions: [string, unknown][] = [];
    let reply: unknown = { ok: true, message: 'done' };
    agent.action = async (name, input) => (actions.push([name, input]), name === 'tshock-bans' ? { bans: [{ ticket: 1, kind: 'uuid', value: 'c0ffee00-1234', reason: 'x' }] } : reply);
    const post = async (x: string, body: unknown) => {
      const r = await owner.post(`/api/servers/tr-tshock${x}`, body);
      return [r.statusCode, r.json()];
    };
    expect(await post('/players/kick', { username: 'gspffbob', reason: 'afk' })).toEqual([200, { output: 'done' }]);
    expect(await post('/players/ban', { uuid: 'c0ffee00-1234', reason: 'griefing' })).toEqual([200, { output: 'done' }]);
    expect(await post('/players/ban', { account: 'Rick' })).toEqual([200, { output: 'done' }]);
    expect(await post('/players/unban', { ip: '203.0.113.7' })).toEqual([200, { output: 'done' }]);
    reply = { ok: false, reason: 'player-not-found', message: 'Player nobody was not found' };
    expect(await post('/players/kick', { username: 'nobody' })).toEqual([409, { error: 'player-not-online', output: '(player-not-online) Player nobody was not found' }]);
    reply = { ok: false, reason: 'failed', message: 'TShock did not store the ban: HTTP 500' };
    expect(await post('/players/ban', { username: 'bob' })).toEqual([502, { error: 'player-op-failed', output: '(failed) TShock did not store the ban: HTTP 500' }]);
    reply = { ok: true, message: 'The message was broadcasted successfully' };
    expect(await post('/server/broadcast', { message: 'Restarting soon' })).toEqual([200, { ok: true }]);
    expect(((await owner.get('/api/servers/tr-tshock/players')).json() as { bans: unknown }).bans).toMatchObject({ uuids: [{ uuid: 'c0ffee00-1234', reason: 'x' }] });
    expect(actions.map(([n, i]) => [n, i])).toEqual([
      ['tshock-kick', { name: 'gspffbob', reason: 'afk' }],
      ['tshock-ban', { target: { kind: 'uuid', value: 'c0ffee00-1234' }, reason: 'griefing' }],
      ['tshock-ban', { target: { kind: 'account', value: 'Rick' } }],
      ['tshock-unban', { target: { kind: 'ip', value: '203.0.113.7' } }],
      ['tshock-kick', { name: 'nobody' }],
      ['tshock-ban', { target: { kind: 'name', value: 'bob' } }],
      ['tshock-broadcast', { message: 'Restarting soon' }],
      ['tshock-bans', {}],
    ]);
    // Nothing typed on TShock's console.
    expect(agent.calls.filter((c) => c.startsWith('command:'))).toEqual([]);
  });
});
