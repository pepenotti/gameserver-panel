// The panel half of Terraria (M5 phase 3), held to what the real servers
// wrote and answered (fixtures/terraria/1.4.5.8, docs/verification/
// terraria-1.4.5.8.md): launch settings and the versions the create form
// offers (from the fake download services), the config files and their
// forms, moderation per flavour (the console's IP bans, TShock's REST
// actions), messages to players, backups and resets, update checks and the
// console catalog.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCommand, CommandResponse, ServerCtx, ServerRef, VersionsResponse } from '@gsp/adapter-api';
import { memoryServerFiles } from '@gsp/adapter-api/testing/panel-suite-config';
import { formatFor, RconProtocolError } from '@gsp/formats';
import type { AgentStatus } from '@gsp/shared';
import { startFakeDownloads, type FakeDownloads } from '../../../tools/fake-terraria/downloads.mjs';
import {
  clearChoicesCache,
  LEFT_MS,
  parseBanlist,
  SAY_MAX,
  SERVERCONFIG_MANAGED,
  SERVERCONFIG_SCHEMA,
  SERVERCONFIG_TML_SCHEMA,
  terrariaAnnounce,
  terrariaBroadcast,
  terrariaChoices,
  terrariaManagedValues,
  terrariaPanelAdapter as adapter,
  terrariaPlayersOf,
  terrariaRefused,
  terrariaToAgent,
  TSHOCK_SCHEMA,
  unbanChanges,
  type TerrariaLaunchSettings,
} from '../src/panel';
import { DATA, MANAGED_SERVERCONFIG, VANILLA_PINS, display } from '../src/shared';
import { downloadEnv, fixture, fixtureLines } from './helpers';

type Flavour = 'vanilla' | 'tshock' | 'tmodloader';
const FLAVOURS: Flavour[] = ['vanilla', 'tshock', 'tmodloader'];
const srv = (flavour: Flavour | null, gameName = 'friends'): ServerRef => ({ id: gameName, gameName, flavour });
const settings = (over: Partial<TerrariaLaunchSettings> = {}): TerrariaLaunchSettings => ({ ...adapter.launch.defaults(), ...over });

interface TestCtx extends ServerCtx {
  commands: AgentCommand[];
  actions: [string, unknown][];
  sets: [string, Record<string, unknown>, string][];
  files: ReturnType<typeof memoryServerFiles>;
  /** Log lines to print (as the agent shows them) after a command. */
  replies: Map<string, string[]>;
  state: AgentStatus['state'] | null;
}

/** A server whose files are `files` (by `<root>/<rel>`); `answer` answers its runtime actions. */
function ctxFor(flavour: Flavour, o: { files?: Record<string, string>; answer?: (name: string, input: unknown) => unknown; versions?: VersionsResponse; state?: AgentStatus['state'] | null } = {}): TestCtx {
  const listeners = new Set<(line: string) => void>();
  const ctx: TestCtx = {
    srv: srv(flavour),
    files: memoryServerFiles(o.files ?? {}),
    actor: 'test',
    state: o.state === undefined ? 'running' : o.state,
    status: () => (ctx.state === null ? null : ({ state: ctx.state } as AgentStatus)),
    commands: [],
    actions: [],
    sets: [],
    replies: new Map(),
    command: async (c): Promise<CommandResponse> => {
      ctx.commands.push(c);
      const lines = ctx.replies.get(c.command) ?? [];
      setTimeout(() => {
        for (const l of lines) for (const f of listeners) f(display(l));
      }, 5);
      return { via: 'stdin', output: null };
    },
    action: async (name, input) => {
      ctx.actions.push([name, input]);
      return o.answer?.(name, input) ?? null;
    },
    versions: async () => o.versions ?? { installed: null, versions: [] },
    launchSettings: () => settings(),
    config: {
      set: async (fileId, values, note) => {
        ctx.sets.push([fileId, values, note]);
        const decl = adapter.config.files(ctx.srv).find((f) => f.id === fileId)!;
        const cur = (await ctx.files.read(decl.root, decl.rel))?.toString('utf8');
        if (cur !== undefined) await ctx.files.writeAtomic(decl.root, decl.rel, formatFor(decl).edit(cur, values));
      },
      seedIfMissing: async () => false,
      applyPreset: async () => undefined,
    },
    onLog: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return ctx;
}

let downloads: FakeDownloads;
beforeAll(async () => {
  downloads = await startFakeDownloads({ fail: '' });
});
afterAll(() => downloads.close());
beforeEach(() => clearChoicesCache());

const choicesCtx = (url = downloads.url) => ({ fetch: (u: string) => fetch(u, { headers: { 'user-agent': 'gameserver-panel/test' } }), env: downloadEnv(url) });
const githubCalls = () => downloads.requests.filter((r) => r.path.startsWith('/repos/')).length;

// ------------------------------------------------------------------ launch

describe('launch settings (SRV-01, SRV-05, UPD-02)', () => {
  it('turn into the params the runtime half takes: the flavour is the server’s, the world its game name, the password always given', () => {
    expect(terrariaToAgent(srv('vanilla'), settings())).toEqual({ flavour: 'vanilla', version: null, channel: null, world: 'friends', worldSize: 2, maxPlayers: 8, password: '', memoryMb: 2048 });
    expect(terrariaToAgent(srv('tshock'), settings({ version: 'v6.2.1', password: 'join-us', maxPlayers: 16 }))).toMatchObject({ flavour: 'tshock', version: 'v6.2.1', channel: null, password: 'join-us', maxPlayers: 16 });
    expect(terrariaToAgent(srv('tmodloader'), settings({ version: 'v2026.08.2.2', channel: 'preview' }))).toMatchObject({ flavour: 'tmodloader', version: 'v2026.08.2.2', channel: 'preview' });
    // A channel is tModLoader's alone.
    expect(terrariaToAgent(srv('vanilla'), settings({ channel: 'preview' })).channel).toBeNull();
  });

  it('refuses what the game can’t take: a large world in less than 2 GiB, a version of another flavour, no flavour (SRV-05, PRD §7)', () => {
    expect(() => terrariaToAgent(srv('vanilla'), settings({ worldSize: 3, memoryMb: 1024 }))).toThrow(/large world .* at least 2048/);
    expect(terrariaToAgent(srv('vanilla'), settings({ worldSize: 3, memoryMb: 2048 })).worldSize).toBe(3);
    expect(() => terrariaToAgent(srv('vanilla'), settings({ version: 'v6.2.1' }))).toThrow(/Terraria version such as 1\.4\.5\.8/);
    expect(() => terrariaToAgent(srv('tshock'), settings({ version: '1.4.5.8' }))).toThrow(/release tag/);
    expect(() => terrariaToAgent(srv(null), settings())).toThrow(/needs a flavour/);
    expect(() => terrariaToAgent(srv('vanilla'), settings({ password: ' spaced ' }))).toThrow(/password/);
    expect(() => terrariaToAgent(srv('vanilla'), settings({ memoryMb: 2000 }))).toThrow(/multiple of 256/);
  });

  it('asks for flavour-less settings once, the channel for tModLoader only, and keeps the password secret', () => {
    const schema = adapter.launch.schema;
    expect(schema.map((o) => o.key)).toEqual(['version', 'channel', 'worldSize', 'maxPlayers', 'password', 'memoryMb']);
    expect(schema.find((o) => o.key === 'channel')!.flavours).toEqual(['tmodloader']);
    expect(schema.find((o) => o.key === 'password')).toMatchObject({ type: 'string', secret: true, default: '' });
    expect(schema.find((o) => o.key === 'memoryMb')).toMatchObject({ role: 'memory', min: 1024, step: 256, unit: 'MiB' });
    expect(schema.find((o) => o.key === 'worldSize')!.options!.map((x) => x.value)).toEqual([1, 2, 3]);
    expect(adapter.launch.secrets ?? []).toEqual([]);
  });
});

describe('the versions the create form offers (UPD-02)', () => {
  it('vanilla: "newest" first, then every version measured and the one terraria.org names, newest first', async () => {
    const c = await terrariaChoices({ flavour: 'vanilla', version: null }, choicesCtx());
    expect(c.version![0]).toMatchObject({ value: '', detail: '1.4.5.8', label: { en: expect.stringMatching(/Newest/) } });
    expect(c.version!.slice(1).map((v) => v.value)).toEqual(
      Object.keys(VANILLA_PINS)
        .map((id) => id.split('').join('.'))
        .sort((a, b) => (a < b ? 1 : -1)),
    );
    expect(c.version!.some((v) => v.warning)).toBe(false);
    expect(c.channel).toBeUndefined();
  });

  it('vanilla: a newer version terraria.org names than the ones checked carries its warning, "newest" too', async () => {
    const newer = async (u: string) => (u.endsWith('/api/get/dedicated-servers-names') ? Response.json(['terraria-server-1459.zip']) : fetch(u));
    const c = await terrariaChoices({ flavour: 'vanilla', version: null }, { fetch: newer, env: downloadEnv(downloads.url) });
    expect(c.version!.slice(0, 2)).toEqual([expect.objectContaining({ value: '', detail: '1.4.5.9', warning: 'unverified-download' }), { value: '1.4.5.9', warning: 'unverified-download' }]);
    expect(adapter.launch.warnings!['unverified-download']).toMatchObject({ en: expect.any(String), es: expect.any(String) });
  });

  it('TShock: its releases with the Terraria each is for, pre-releases warned; "newest" is the newest full release', async () => {
    const c = await terrariaChoices({ flavour: 'tshock', version: null }, choicesCtx());
    expect(c.version!.map((v) => v.value)).toEqual(['', 'v6.2.1', 'v6.1.0', 'v6.0.0-pre3', 'v5.2.4']);
    expect(c.version![0]).toMatchObject({ detail: 'v6.2.1' });
    expect(c.version![1]).toMatchObject({ detail: 'for Terraria 1.4.5.8, 2026-09-27', channel: 'stable' });
    expect(c.version![3]).toMatchObject({ channel: 'prerelease', warning: 'tshock-prerelease' });
  });

  it('tModLoader: stable and preview releases, a preview bringing its channel along; the channels themselves', async () => {
    const c = await terrariaChoices({ flavour: 'tmodloader', version: null }, choicesCtx());
    expect(c.version!.map((v) => [v.value, v.warning ?? null, v.implies?.channel])).toEqual([
      ['', null, 'stable'],
      ['v2026.08.2.2', 'tml-preview', 'preview'],
      ['v2026.07.3.0', null, 'stable'],
      ['v2026.06.3.6', null, 'stable'],
    ]);
    expect(c.version![0]!.detail).toBe('v2026.07.3.0');
    expect(c.channel).toEqual([
      { value: 'stable', label: expect.anything() },
      { value: 'preview', label: expect.anything(), warning: 'tml-preview-channel' },
    ]);
  });

  it("keeps GitHub's answers for a while, whatever else is asked, and honours its limit (60 an hour, 304s counted)", async () => {
    const before = githubCalls();
    await terrariaChoices({ flavour: 'tshock', version: null }, choicesCtx());
    await terrariaChoices({ flavour: 'tshock', version: 'v6.2.1' }, choicesCtx());
    await terrariaChoices({ flavour: 'tshock', version: 'v6.1.0' }, choicesCtx());
    expect(githubCalls() - before).toBe(1);

    const limited = await startFakeDownloads({ fail: 'rate-limit' });
    try {
      clearChoicesCache();
      await expect(terrariaChoices({ flavour: 'tmodloader', version: null }, choicesCtx(limited.url))).rejects.toThrow(/60 an hour/);
      const asked = limited.requests.length;
      await expect(terrariaChoices({ flavour: 'tshock', version: null }, choicesCtx(limited.url))).rejects.toThrow(/60 an hour/);
      // Not asked again until the reset GitHub gave.
      expect(limited.requests.length).toBe(asked);
    } finally {
      await limited.close();
    }
  });
});

// ------------------------------------------------------------------ config

describe('config files and forms (CFG-01…10)', () => {
  it('declares each flavour’s files: serverconfig.txt for all, the ban list for the console’s bans, TShock’s and tModLoader’s own', () => {
    const ids = (f: Flavour) => adapter.config.files(srv(f)).map((x) => [x.id, x.rel, x.format]);
    expect(ids('vanilla')).toEqual([
      ['serverconfig', 'serverconfig.txt', 'ini'],
      ['banlist', 'banlist.txt', 'lines'],
    ]);
    expect(ids('tshock')).toEqual([
      ['serverconfig', 'serverconfig.txt', 'ini'],
      ['tshock-config', 'tshock/config.json', 'json'],
      ['tshock-ssc', 'tshock/sscconfig.json', 'json'],
      ['tshock-motd', 'tshock/motd.txt', 'text'],
      ['tshock-rules', 'tshock/rules.txt', 'text'],
      ['tshock-whitelist', 'tshock/whitelist.txt', 'lines'],
    ]);
    expect(ids('tmodloader')).toEqual([
      ['serverconfig', 'serverconfig.txt', 'ini'],
      ['banlist', 'banlist.txt', 'lines'],
      ['tml-mods', 'Mods/enabled.json', 'json'],
    ]);
    // The ban list is the game's memory: changed only while it is stopped.
    expect(adapter.config.files(srv('vanilla')).find((f) => f.id === 'banlist')).toMatchObject({ stoppedOnly: true, restartKeys: '*' });
  });

  it('locks the keys the agent writes and the launch flags decide, with the password secret (CFG-04)', () => {
    const cfg = adapter.config.files(srv('vanilla')).find((f) => f.id === 'serverconfig')!;
    expect(cfg.managedKeys).toEqual([...MANAGED_SERVERCONFIG, 'password', 'maxplayers', 'worldname']);
    expect(cfg.managedKeys).toEqual([...SERVERCONFIG_MANAGED]);
    expect(cfg.secretKeys).toEqual(['password']);
    expect(cfg.note?.en).toMatch(/never writes it/);
    // Every key the game knows is in the form (the sample file's, tModLoader's two more).
    const known = 'world worldpath worldname autocreate seed difficulty maxplayers port password motd banlist secure language upnp npcstream priority worldrollbackstokeep'.split(' ');
    expect(SERVERCONFIG_SCHEMA.map((o) => o.key).sort()).toEqual([...known].sort());
    expect(SERVERCONFIG_TML_SCHEMA.map((o) => o.key).sort()).toEqual([...known, 'modpath', 'modpack'].sort());
    expect(adapter.config.files(srv('tmodloader'))[0]).toMatchObject({ schemaId: 'serverconfig-tml', managedKeys: expect.arrayContaining(['modpath', 'modpack']) });
    expect(terrariaManagedValues(srv('vanilla'))).toEqual({ serverconfig: { language: 'en-US', upnp: '0' } });
    expect(terrariaManagedValues(srv('tshock'))).toEqual({ serverconfig: { language: 'en-US', upnp: '0' }, 'tshock-config': { 'Settings.RestApiEnabled': 'true' } });
  });

  it("hides TShock's REST tokens whole, locks the agent's REST settings and says TShock drops unknown keys (CON-04, CFG-09)", () => {
    const t = adapter.config.files(srv('tshock')).find((f) => f.id === 'tshock-config')!;
    expect(t.secretTrees).toEqual(['Settings.ApplicationRestTokens']);
    expect(t.managedKeys).toEqual(['Settings.ServerPort', 'Settings.MaxSlots', 'Settings.RestApiEnabled', 'Settings.RestApiPort', 'Settings.ApplicationRestTokens']);
    expect(t.secretKeys).toEqual(expect.arrayContaining(['Settings.ServerPassword', 'Settings.MySqlPassword', 'Settings.PostgresPassword']));
    expect(t.note?.en).toMatch(/drops anything it doesn’t know/);
  });

  it("TShock's form takes the defaults and types TShock wrote, for keys it has", () => {
    const written = JSON.parse(fixture('tshock', 'config', 'config.json.generated')) as { Settings: Record<string, unknown> };
    for (const o of TSHOCK_SCHEMA) {
      const k = o.key.replace(/^Settings\./, '');
      expect(Object.keys(written.Settings), o.key).toContain(k);
      if (o.default !== undefined) expect(String(written.Settings[k]), o.key).toBe(o.default);
      const type = typeof written.Settings[k];
      if (type === 'boolean') expect(o.type, o.key).toBe('boolean');
      if (type === 'number') expect(o.type, o.key).toBe('integer');
    }
  });

  it('lets the text editor reach only text files: never worlds, databases, mods, plugins or binaries (CFG-08)', () => {
    for (const f of FLAVOURS) {
      for (const r of adapter.config.roots(srv(f))) {
        for (const g of r.include) expect(g, `${f} ${r.id}`).toMatch(/\.(txt|json)$/);
      }
    }
    expect(adapter.config.roots(srv('tshock')).find((r) => r.id === 'tshock')!.exclude).toEqual(expect.arrayContaining(['logs', 'setup-code.txt']));
  });
});

// ------------------------------------------------------------------ players

describe('moderation on the console: vanilla and tModLoader (PLY-03, PRD §7)', () => {
  const ops = terrariaPlayersOf('vanilla')!;
  const lines = (from: string, to: string) => {
    const all = fixtureLines('vanilla', 'logs', 'players.log');
    return all.slice(all.findIndex((l) => l.startsWith(from)), all.findIndex((l) => l.includes(to)) + 1);
  };

  afterEach(() => void vi.useRealTimers());

  it('bans by name an online player, whose address the game bans: a UI warns first; unbans wait for a stopped game', () => {
    expect(ops).toBe(terrariaPlayersOf('tmodloader'));
    expect(ops).toMatchObject({ banTargets: ['username'], banByAddress: true, stoppedOnly: ['unban'] });
    expect(ops.accessLevels).toBeUndefined();
  });

  it('kicks and bans as measured, watching the log for the player leaving', async () => {
    const banned = fixture('vanilla', 'files', 'banlist.txt');
    const ctx = ctxFor('vanilla', { files: { 'data/banlist.txt': banned } });
    ctx.replies.set('kick gspffbob', lines('192.0.2.1:55634 was booted', 'gspffbob has left.'));
    ctx.replies.set('ban gspffcarol', lines('192.0.2.1:55646 was booted', 'gspffcarol has left.'));
    expect(await ops.kick!(ctx, 'gspffbob', 'afk')).toBe('Kicked gspffbob');
    expect(await ops.ban!(ctx, { username: 'gspffcarol' }, 'griefing')).toBe('Banned gspffcarol (address 192.0.2.1)');
    // The console takes no reason: the name is all it gets.
    expect(ctx.commands).toEqual([
      { command: 'kick gspffbob', via: 'stdin' },
      { command: 'ban gspffcarol', via: 'stdin' },
    ]);
  });

  it('says a player isn’t online when the game says nothing, and that it failed when it can’t write its ban list', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ctx = ctxFor('vanilla');
    const kick = ops.kick!(ctx, 'nobody');
    await vi.advanceTimersByTimeAsync(LEFT_MS + 10);
    const reply = await kick;
    expect(reply).toBe('(player-not-online) nobody is not online');
    expect(terrariaRefused('kick', reply)).toBe('player-not-online');
    vi.useRealTimers();
    ctx.replies.set('ban gspffcarol', ['Invalid command.']);
    const failed = await ops.ban!(ctx, { username: 'gspffcarol' });
    expect(terrariaRefused('ban', failed)).toBe('failed');
  });

  it('reads the ban list as the game writes it, an address with the names banned from it', async () => {
    const ctx = ctxFor('vanilla', { files: { 'data/banlist.txt': '//gspffcarol\r\n192.0.2.1\r\n//gspffdave\r\n192.0.2.1\r\n//gspffeve\r\n203.0.113.9\r\n' } });
    expect(await ops.bans!(ctx)).toEqual({
      steamIds: [],
      ips: [
        { ip: '192.0.2.1', username: 'gspffcarol, gspffdave', reason: null },
        { ip: '203.0.113.9', username: 'gspffeve', reason: null },
      ],
    });
    expect(parseBanlist(fixture('vanilla', 'files', 'banlist.txt'))).toEqual([{ ip: '192.0.2.1', names: ['gspffcarol'] }]);
  });

  it('lifts a ban by editing the ban list through the panel while stopped: the address, and every name banned from it', async () => {
    const text = '//gspffcarol\n192.0.2.1\n//gspffdave\n192.0.2.1\n//gspffeve\n203.0.113.9\n';
    const ctx = ctxFor('vanilla', { files: { 'data/banlist.txt': text }, state: 'stopped' });
    expect(await ops.unban!(ctx, { username: 'gspffdave' })).toBe('Lifted the ban on 192.0.2.1 (gspffcarol, gspffdave)');
    expect(ctx.sets).toEqual([['banlist', { '//gspffcarol': false, '192.0.2.1': false, '//gspffdave': false }, 'unbanned 192.0.2.1']]);
    expect((await ctx.files.read('data', 'banlist.txt'))!.toString()).toBe('//gspffeve\n203.0.113.9\n');
    expect(await ops.unban!(ctx, { ip: '203.0.113.9' })).toBe('Lifted the ban on 203.0.113.9 (gspffeve)');
    expect(terrariaRefused('unban', await ops.unban!(ctx, { ip: '203.0.113.9' }))).toBe('no-change');
    // A running game keeps its bans in memory.
    ctx.state = 'running';
    await expect(ops.unban!(ctx, { ip: '198.51.100.1' })).rejects.toThrow(/stopped/);
    expect(ctx.commands).toEqual([]);
  });

  it('keeps a name that is also above an address that stays', () => {
    expect(unbanChanges('//a\n1.1.1.1\n//a\n2.2.2.2\n', new Set(['1.1.1.1']))).toEqual({ '1.1.1.1': false });
  });

  it('refuses what the console can’t take: another kind of target, quotes, line breaks', async () => {
    const ctx = ctxFor('vanilla');
    for (const t of [{ ip: '192.0.2.1' }, { uuid: 'abcdef012345' }, { account: 'Rick' }, { username: 'a"b' }, { username: 'a\nexit' }]) await expect(ops.ban!(ctx, t)).rejects.toBeInstanceOf(RconProtocolError);
    expect(ctx.commands).toEqual([]);
  });
});

describe("moderation through TShock's REST API (PLY-03, CON-04)", () => {
  const ops = terrariaPlayersOf('tshock')!;

  it('kicks with a reason, and bans and unbans by name, address, UUID or account through the runtime’s actions', async () => {
    const ctx = ctxFor('tshock', {
      answer: (name) =>
        name === 'tshock-ban' ? { ok: true, message: 'Banned name:gspffbob (ticket 3)', ticket: 3, kicked: ['gspffbob'] } : name === 'tshock-kick' ? { ok: true, message: 'Player gspffbob was kicked' } : { ok: true, message: 'Lifted ticket 3', tickets: [3] },
    });
    expect(ops.banTargets).toEqual(['username', 'ip', 'uuid', 'account']);
    expect(await ops.kick!(ctx, 'gspffbob', 'afk')).toBe('Player gspffbob was kicked');
    expect(await ops.ban!(ctx, { username: 'gspffbob' }, 'griefing')).toBe('Banned name:gspffbob (ticket 3); kicked gspffbob');
    await ops.ban!(ctx, { ip: '203.0.113.7' });
    await ops.ban!(ctx, { uuid: 'c0ffee00-1234' });
    await ops.ban!(ctx, { account: 'Rick' });
    expect(await ops.unban!(ctx, { account: 'Rick' })).toBe('Lifted ticket 3');
    expect(ctx.actions).toEqual([
      ['tshock-kick', { name: 'gspffbob', reason: 'afk' }],
      ['tshock-ban', { target: { kind: 'name', value: 'gspffbob' }, reason: 'griefing' }],
      ['tshock-ban', { target: { kind: 'ip', value: '203.0.113.7' } }],
      ['tshock-ban', { target: { kind: 'uuid', value: 'c0ffee00-1234' } }],
      ['tshock-ban', { target: { kind: 'account', value: 'Rick' } }],
      ['tshock-unban', { target: { kind: 'account', value: 'Rick' } }],
    ]);
    // Nothing typed on its console, which logs every command.
    expect(ctx.commands).toEqual([]);
  });

  it('maps the actions’ refusals: nobody by that name online, already so, not stored', async () => {
    let reply: unknown;
    const ctx = ctxFor('tshock', { answer: () => reply });
    reply = { ok: false, reason: 'player-not-found', message: 'Player nobody was not found' };
    expect(terrariaRefused('kick', await ops.kick!(ctx, 'nobody'))).toBe('player-not-online');
    reply = { ok: false, reason: 'no-change', message: 'Already banned (ticket 1)' };
    expect(terrariaRefused('ban', await ops.ban!(ctx, { username: 'bob' }))).toBe('no-change');
    reply = { ok: false, reason: 'failed', message: 'TShock did not store the ban' };
    const failed = await ops.ban!(ctx, { username: 'bob' });
    expect([terrariaRefused('ban', failed), failed]).toEqual(['failed', '(failed) TShock did not store the ban']);
    reply = { ok: false, reason: 'no-change', message: 'Not banned' };
    expect(terrariaRefused('unban', await ops.unban!(ctx, { ip: '203.0.113.7' }))).toBe('no-change');
  });

  it('lists the bans in force by what each names', async () => {
    const bans = [
      { ticket: 1, kind: 'name', value: 'gspffbob', identifier: 'name:gspffbob', reason: 'griefing', by: 'gameserver-panel', since: null, until: null },
      { ticket: 2, kind: 'ip', value: '203.0.113.7', identifier: 'ip:203.0.113.7', reason: 'Banned', by: 'x', since: null, until: null },
      { ticket: 3, kind: 'uuid', value: 'c0ffee00-1234', identifier: 'uuid:c0ffee00-1234', reason: '', by: 'x', since: null, until: null },
      { ticket: 4, kind: 'account', value: 'Rick', identifier: 'acc:Rick', reason: 'x', by: 'x', since: null, until: null },
      { ticket: 5, kind: null, value: 'odd:thing', identifier: 'odd:thing', reason: '', by: 'x', since: null, until: null },
    ];
    const ctx = ctxFor('tshock', { answer: () => ({ bans }) });
    expect(await ops.bans!(ctx)).toEqual({
      steamIds: [],
      usernames: [{ username: 'gspffbob', id: null, reason: 'griefing' }],
      ips: [{ ip: '203.0.113.7', username: null, reason: 'Banned' }],
      uuids: [{ uuid: 'c0ffee00-1234', reason: '' }],
      accounts: [{ account: 'Rick', reason: 'x' }],
    });
  });
});

// ------------------------------------------------------------------ messages

describe('messages to players (CON-03, CON-04)', () => {
  it('counts down in both languages', () => {
    expect(terrariaAnnounce('restart', 300, 'en')).toBe('Server restarting in 5 minutes.');
    expect(terrariaAnnounce('reset', 30, 'es')).toBe('El mundo se reinicia en 30 segundos. Todo lo construido se va a perder.');
  });

  it('says on the console, as every flavour takes it, and refuses what it can’t send', () => {
    expect(terrariaBroadcast('  Hola a todos ☃ ')).toEqual({ command: 'say Hola a todos ☃', via: 'stdin' });
    for (const bad of ['', '   ', 'a\nexit', 'x'.repeat(SAY_MAX + 1)]) expect(() => terrariaBroadcast(bad)).toThrow(RconProtocolError);
  });

  it("sends TShock's through its REST API, and the others' on the console", async () => {
    const send = adapter.messages.send!;
    const tshock = ctxFor('tshock', { answer: () => ({ ok: true, message: 'The message was broadcasted successfully' }) });
    await send(tshock, 'Restarting soon');
    expect([tshock.actions, tshock.commands]).toEqual([[['tshock-broadcast', { message: 'Restarting soon' }]], []]);
    const vanilla = ctxFor('vanilla');
    await send(vanilla, 'Restarting soon');
    expect([vanilla.actions, vanilla.commands]).toEqual([[], [{ command: 'say Restarting soon', via: 'stdin' }]]);
    await expect(send(ctxFor('tshock', { answer: () => ({ ok: false, reason: 'failed', message: 'nope' }) }), 'hi')).rejects.toThrow(/nope/);
  });
});

// ------------------------------------------------------------------ backups and resets

describe('backups and resets (BAK-01…04)', () => {
  const paths = (f: Flavour) => Object.fromEntries(adapter.backups.parts.map((p) => [p.id, p.paths(srv(f))]));

  it('copies the world without the game’s own .bak files, the settings, TShock’s database through SQLite and its plugins, tModLoader’s mod list (MOD-03, MOD-06)', () => {
    expect(paths('vanilla')).toEqual({ world: ['Worlds/friends.wld'], settings: ['serverconfig.txt', 'banlist.txt'], database: [], plugins: [], mods: [] });
    expect(paths('tmodloader')).toEqual({ world: ['Worlds/friends.wld', 'Worlds/friends.twld'], settings: ['serverconfig.txt', 'banlist.txt'], database: [], plugins: [], mods: ['Mods/enabled.json', 'ModConfigs'] });
    expect(paths('tshock')).toMatchObject({ world: ['Worlds/friends.wld'], database: [DATA.tshockDb], plugins: ['tshock/plugins'], mods: [] });
    expect(paths('tshock').settings).toEqual(expect.arrayContaining([DATA.tshockConfig, DATA.tshockSetupLock, 'tshock/whitelist.txt']));
    expect(adapter.backups.parts.find((p) => p.id === 'database')!.sqlite).toEqual([DATA.tshockDb]);
    // Never the Workshop cache, logs, tModLoader's own world zips, or uploads on their way in.
    const all = FLAVOURS.flatMap((f) => Object.values(paths(f)).flat());
    for (const p of all) expect(p).not.toMatch(/^(\.workshop|\.gsp-uploads|Worlds\/Backups|tshock\/logs)|ServerLog|\.bak/);
  });

  it('resets the world for every flavour, TShock’s players too, or everything, plugins and the mod list included', async () => {
    expect(adapter.resets.map((r) => [r.id, r.permission, r.removeParts, r.flavours ?? null])).toEqual([
      ['world', 'reset.world', ['world'], null],
      ['players', 'reset.full', ['world', 'database'], ['tshock']],
      ['factory', 'reset.factory', ['world', 'settings', 'database', 'plugins', 'mods'], null],
    ]);
    // A new seed: a fresh random one in serverconfig.txt; otherwise the one set stays.
    const ctx = ctxFor('vanilla');
    await adapter.resets[0]!.after!(ctx, { newSeed: true });
    await adapter.resets[0]!.after!(ctx, { newSeed: false });
    expect(ctx.sets).toEqual([['serverconfig', { seed: expect.stringMatching(/^\d{1,10}$/) }, 'reset (world): a new random seed']]);
  });
});

// ------------------------------------------------------------------ updates and the console

describe('update checks (UPD-03)', () => {
  const tshockVersions: VersionsResponse = {
    installed: { version: '1.4.5.8', channel: 'tshock', build: 'v6.1.0' },
    versions: [
      { id: 'v6.3.0-pre1', channel: 'prerelease', warning: 'tshock-prerelease' },
      { id: 'v6.2.1', channel: 'stable' },
      { id: 'v6.1.0', channel: 'stable' },
    ],
  };
  const check = adapter.updates!.check;

  it('following the newest: the flavour’s newest full release when it isn’t the one installed', async () => {
    expect(await check(ctxFor('tshock', { versions: tshockVersions }), settings())).toEqual({ available: true, current: 'v6.1.0', latest: 'v6.2.1', channel: 'stable' });
    const up = { ...tshockVersions, installed: { ...tshockVersions.installed!, build: 'v6.2.1' } };
    expect(await check(ctxFor('tshock', { versions: up }), settings())).toMatchObject({ available: false, current: 'v6.2.1' });
    const vanilla: VersionsResponse = { installed: { version: '1.4.5.7', channel: 'vanilla' }, versions: [{ id: '1.4.5.8', build: '1458' }, { id: '1.4.5.7', build: '1457' }] };
    expect(await check(ctxFor('vanilla', { versions: vanilla }), settings())).toEqual({ available: true, current: '1.4.5.7', latest: '1.4.5.8' });
    const tml: VersionsResponse = { installed: { version: '1.4.4.9', channel: 'tmodloader', build: 'v2026.07.3.0' }, versions: [{ id: 'v2026.08.2.2', channel: 'preview' }, { id: 'v2026.07.3.0', channel: 'stable' }] };
    expect(await check(ctxFor('tmodloader', { versions: tml }), settings())).toMatchObject({ available: false });
    expect(await check(ctxFor('tmodloader', { versions: tml }), settings({ channel: 'preview' }))).toMatchObject({ available: true, latest: 'v2026.08.2.2' });
  });

  it('a pinned version: only when something else is installed, never a newer one on its own', async () => {
    expect(await check(ctxFor('tshock', { versions: tshockVersions }), settings({ version: 'v6.1.0' }))).toEqual({ available: false, current: 'v6.1.0', latest: 'v6.1.0', channel: 'stable' });
    expect(await check(ctxFor('tshock', { versions: tshockVersions }), settings({ version: 'v6.2.1' }))).toMatchObject({ available: true, latest: 'v6.2.1' });
    // Nothing installed yet: the pinned one is what an update installs.
    expect(await check(ctxFor('tshock', { versions: { installed: null, versions: tshockVersions.versions } }), settings({ version: 'v6.2.1' }))).toMatchObject({ available: true, current: null });
  });
});

describe('the console catalog (AST-04)', () => {
  it('lists each flavour’s own console commands; the password ones keep their arguments out of the audit log', () => {
    const names = (f: Flavour) => (adapter.consoleCatalog ?? []).filter((c) => !c.flavours || c.flavours.includes(f)).map((c) => c.name);
    expect(names('vanilla')).toEqual(expect.arrayContaining(['playing', 'kick', 'ban', 'password', 'say', 'save', 'exit']));
    expect(names('vanilla')).not.toContain('modlist');
    expect(names('tmodloader')).toContain('modlist');
    expect(names('tshock')).toEqual(expect.arrayContaining(['who', 'ban add', 'ban del', 'broadcast', 'serverpassword']));
    expect(names('tshock')).not.toContain('password');
    expect((adapter.consoleCatalog ?? []).filter((c) => c.secretArgs).map((c) => c.name)).toEqual(['password', 'serverpassword']);
  });
});

describe('the install a launch wants (HST-09, D12)', () => {
  const wanted = (flavour: string, s: Partial<TerrariaLaunchSettings> = {}) => adapter.install!.wanted({ ...adapter.launch.defaults(), ...s }, { flavour });
  it('names the flavour, the version it pins (none: the newest), and the channel tModLoader takes', () => {
    expect(wanted('vanilla')).toEqual({ flavour: 'vanilla', version: null, build: null, branch: null, channel: null });
    expect(wanted('vanilla', { version: '1.4.5.8' })).toEqual({ flavour: 'vanilla', version: '1.4.5.8', build: null, branch: null, channel: null });
    expect(wanted('tshock', { version: 'v6.2.1' })).toEqual({ flavour: 'tshock', version: 'v6.2.1', build: null, branch: null, channel: null });
    expect(wanted('tmodloader')).toEqual({ flavour: 'tmodloader', version: null, build: null, branch: null, channel: 'stable' });
    expect(wanted('tmodloader', { channel: 'preview' })).toMatchObject({ channel: 'preview' });
    // The world, its size, the password and the memory are no part of the install.
    expect(wanted('vanilla', { worldSize: 3, password: 'secret-123', memoryMb: 2048 })).toEqual(wanted('vanilla'));
    expect(() => wanted('vanilla', { version: 'v6.2.1' })).toThrow(/version/);
  });
});
