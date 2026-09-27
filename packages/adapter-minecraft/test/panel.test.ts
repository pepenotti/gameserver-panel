// The panel half of Minecraft (M3 phase 3), held to what the real servers
// wrote and answered (fixtures/minecraft/26.3, docs/verification/minecraft-26.3.md):
// launch settings and the choices the create form offers (from the fake
// download services), the server.properties form, the config files and
// editable folders, moderation over RCON and the game's own lists,
// countdown messages, backups and resets, update checks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentCommand, CommandResponse, ServerCtx, ServerRef, VersionsResponse } from '@gsp/adapter-api';
import { memoryServerFiles } from '@gsp/adapter-api/testing/panel-suite-config';
import { parseProperties, propertiesToRecord, RconProtocolError } from '@gsp/formats';
import { startFakeDownloads, type FakeDownloads } from '../../../tools/fake-minecraft/downloads.mjs';
import {
  BSTATS_SCHEMA,
  DEFAULT_VERSION,
  MINECRAFT_PRESETS,
  minecraftChoices,
  minecraftManagedValues,
  minecraftPanelAdapter,
  minecraftToAgent,
  PROPERTIES_GROUPS,
  PROPERTIES_SCHEMA,
  PROPERTIES_SECRETS,
  SAY_MAX,
  type MinecraftLaunchSettings,
} from '../src/panel';
import { BSTATS_CONFIG, managedProperties, minecraftRuntimeAdapter } from '../src/runtime';
import { BSTATS_FILE, LEVEL_NAME, MANAGED_PROPERTIES, sourceUrls } from '../src/shared';
import { downloadEnv, fixture, testCtx } from './helpers';


const LOADERS = ['vanilla', 'paper', 'fabric'] as const;
type Loader = (typeof LOADERS)[number];
const srv = (flavour: Loader | null): ServerRef => ({ id: 'mc', gameName: 'mc', flavour });
const settings = (over: Partial<MinecraftLaunchSettings> = {}): MinecraftLaunchSettings => ({ ...minecraftPanelAdapter.launch.defaults(), ...over });
const props = (text: string) => propertiesToRecord(parseProperties(text));

interface TestCtx extends ServerCtx {
  commands: string[];
  sets: [string, Record<string, unknown>, string][];
  presets: string[];
  files: ReturnType<typeof memoryServerFiles>;
}

/** A server whose files are `files` (by `<root>/<rel>`); `reply` answers its commands (and may change its files, as the game does). */
function ctxFor(flavour: Loader, files: Record<string, string> = {}, reply: (cmd: string, ctx: TestCtx) => string = () => '', versions?: VersionsResponse): TestCtx {
  const commands: string[] = [];
  const sets: TestCtx['sets'] = [];
  const presets: string[] = [];
  const mem = memoryServerFiles(files);
  const ctx: TestCtx = {
    srv: srv(flavour),
    files: mem,
    actor: 'test',
    status: () => null,
    command: async (c: AgentCommand): Promise<CommandResponse> => {
      commands.push(c.command);
      return { via: 'rcon', output: reply(c.command, ctx) };
    },
    action: async () => Promise.reject(new Error('no actions')),
    versions: async () => versions ?? { installed: null, versions: [] },
    launchSettings: () => settings(),
    config: {
      set: async (fileId, values, note) => void sets.push([fileId, values, note]),
      seedIfMissing: async () => false,
      applyPreset: async (name) => void presets.push(name),
    },
    onLog: () => () => undefined,
    commands,
    sets,
    presets,
  };
  return ctx;
}

// ------------------------------------------------------------------ launch

describe('launch settings (UPD-02, UPD-06, Q11)', () => {
  it('turn into the params the runtime half takes, the loader being the server’s flavour', () => {
    const s = settings({ version: '26.3', memoryMb: 3072 });
    expect(minecraftToAgent(srv('vanilla'), s)).toEqual({ version: '26.3', loader: 'vanilla', channel: null, build: null, loaderVersion: null, memoryMb: 3072 });
    expect(minecraftToAgent(srv('paper'), { ...s, channel: 'ALPHA' })).toMatchObject({ loader: 'paper', channel: 'ALPHA', build: null, loaderVersion: null });
    expect(minecraftToAgent(srv('fabric'), s)).toMatchObject({ loader: 'fabric', channel: null, loaderVersion: null });
    expect(minecraftToAgent(srv('fabric'), { ...s, loaderVersion: '0.19.5' })).toMatchObject({ loaderVersion: '0.19.5' });
    // Settings of other loaders are left out, so the agent's own check takes them.
    for (const loader of LOADERS) {
      const params = minecraftToAgent(srv(loader), { ...s, channel: 'BETA', loaderVersion: '0.19.4' });
      expect(minecraftRuntimeAdapter.parseLaunch(params)).toEqual(params);
    }
  });

  it('refuse what the server can’t run: no loader, versions before 1.16.5, snapshots, odd memory', () => {
    expect(() => minecraftToAgent(srv(null), settings())).toThrow(/needs a loader/);
    expect(() => minecraftToAgent(srv('vanilla'), settings({ version: '1.16.4' }))).toThrow(/1\.16\.5 or newer/);
    expect(() => minecraftToAgent(srv('vanilla'), settings({ version: '26.4-snapshot-1' }))).toThrow(/release/);
    expect(() => minecraftToAgent(srv('vanilla'), settings({ memoryMb: 2000 }))).toThrow(/multiple of 256/);
    expect(() => minecraftToAgent(srv('vanilla'), settings({ memoryMb: 512 }))).toThrow(/memoryMb/);
    expect(() => minecraftToAgent(srv('paper'), { ...settings(), channel: 'stable' as never })).toThrow(/channel/);
  });

  it('show Paper’s channel to Paper servers and the loader version to Fabric ones only; memory as measured', () => {
    const byKey = Object.fromEntries(minecraftPanelAdapter.launch.schema.map((o) => [o.key, o]));
    expect(Object.keys(byKey)).toEqual(['version', 'channel', 'loaderVersion', 'memoryMb']);
    expect(byKey.version).toMatchObject({ role: 'version', default: DEFAULT_VERSION });
    expect(byKey.channel).toMatchObject({ flavours: ['paper'], default: 'STABLE', options: [{ value: 'STABLE' }, { value: 'BETA' }, { value: 'ALPHA' }] });
    expect(byKey.loaderVersion).toMatchObject({ flavours: ['fabric'], default: '' });
    expect(byKey.memoryMb).toMatchObject({ role: 'memory', min: 1024, default: '2048', step: 256 });
    expect(minecraftPanelAdapter.launch.warnings).toHaveProperty('paper-no-stable-build');
  });
});

describe('what the create form may pick, from the download services (UPD-02, UPD-05, Q13)', () => {
  let downloads: FakeDownloads;
  beforeAll(async () => {
    downloads = await startFakeDownloads({ fail: '' });
  });
  afterAll(() => downloads.close());
  const ctx = () => ({ fetch: (url: string) => fetch(url, { headers: { 'user-agent': 'gameserver-panel/test' } }), env: downloadEnv(downloads.url) });

  it('lists every Minecraft release from 1.16.5 up, newest first, for vanilla', async () => {
    const c = await minecraftChoices({ flavour: 'vanilla', version: null }, ctx());
    expect(c.version!.map((v) => v.value)).toEqual(['26.3', '26.2', '1.21.11', '1.20.6', '1.20.4', '1.17.1', '1.16.5']);
    expect(c.version![0]).toEqual({ value: '26.3', detail: '2026-09-15' });
    expect(Object.keys(c)).toEqual(['version']);
  });

  it('warns about Paper versions without a STABLE build and brings their channel along; channels without a build say so', async () => {
    const c = await minecraftChoices({ flavour: 'paper', version: '26.3' }, ctx());
    expect(c.version).toEqual([
      { value: '26.3', detail: '#41', channel: 'ALPHA', warning: 'paper-no-stable-build', implies: { channel: 'ALPHA' } },
      { value: '26.2', detail: '#129', channel: 'STABLE' },
      { value: '1.21.11', detail: '#132', channel: 'STABLE' },
    ]);
    expect(c.channel!.map((x) => [x.value, x.warning ?? null])).toEqual([
      ['STABLE', 'paper-channel-empty'],
      ['BETA', 'paper-channel-empty'],
      ['ALPHA', 'paper-unstable-channel'],
    ]);
    const stable = await minecraftChoices({ flavour: 'paper', version: '26.2' }, ctx());
    expect(stable.channel!.map((x) => [x.value, x.warning ?? null])).toEqual([
      ['STABLE', null],
      ['BETA', 'paper-unstable-channel'],
      ['ALPHA', 'paper-unstable-channel'],
    ]);
  });

  it("lists Fabric's releases, and the picked one's loaders with the newest stable first", async () => {
    const c = await minecraftChoices({ flavour: 'fabric', version: '26.3' }, ctx());
    expect(c.version!.map((v) => v.value)).toEqual(['26.3', '26.2', '1.21.11']);
    expect(c.loaderVersion).toEqual([
      { value: '', label: expect.objectContaining({ en: expect.any(String), es: expect.any(String) }), detail: '0.19.5' },
      { value: '0.19.5', channel: 'stable' },
      { value: '0.19.4' },
    ]);
    // A version Fabric doesn't have gets no loaders to pick.
    expect((await minecraftChoices({ flavour: 'fabric', version: '1.16.5' }, ctx())).loaderVersion).toBeUndefined();
  });

  it('asks only the services the environment names, with the fetch it is given', async () => {
    const before = downloads.requests.length;
    await minecraftChoices({ flavour: 'vanilla', version: null }, ctx());
    const asked = downloads.requests.slice(before);
    expect(asked.map((r) => r.path)).toEqual(['/mc/game/version_manifest_v2.json']);
    expect(asked[0]!.userAgent).toBe('gameserver-panel/test');
  });

  it('says why when a service refuses or cannot be reached', async () => {
    const limited = await startFakeDownloads({ fail: 'rate-limit' });
    try {
      await expect(minecraftChoices({ flavour: 'paper', version: null }, { ...ctx(), env: downloadEnv(limited.url) })).rejects.toThrow(/PaperMC's download service is limiting requests/);
    } finally {
      await limited.close();
    }
    await expect(minecraftChoices({ flavour: 'vanilla', version: null }, { fetch: () => Promise.reject(new Error('offline')), env: {} })).rejects.toThrow('offline');
    await expect(minecraftChoices({ flavour: 'forge', version: null }, ctx())).rejects.toThrow(/Unknown loader/);
    expect(() => sourceUrls({ GAME_MC_PAPER_URL: 'file:///etc' })).toThrow(/http/);
    expect(sourceUrls({})).toEqual({ mojang: 'https://piston-meta.mojang.com', paper: 'https://fill.papermc.io', fabric: 'https://meta.fabricmc.net' });
  });
});

// ------------------------------------------------------------ server.properties

describe('the server.properties form (CFG-01, CFG-04, CFG-10)', () => {
  const generated = Object.fromEntries(LOADERS.map((l) => [l, props(fixture(l, 'config', 'server.properties.generated'))]));
  const keys = PROPERTIES_SCHEMA.map((o) => o.key);

  it('covers every key the three loaders wrote, and only those', () => {
    const written = new Set(LOADERS.flatMap((l) => Object.keys(generated[l]!)));
    expect([...written].filter((k) => !keys.includes(k)).sort()).toEqual([]);
    expect(keys.filter((k) => !written.has(k))).toEqual([]);
    // 69 keys, 70 on Paper (the verification log's "71 keys (72 on Paper)" counts its two header lines).
    expect(keys.length).toBe(70);
  });

  it('defaults to what the game wrote; keys that differ by loader or version have none', () => {
    for (const o of PROPERTIES_SCHEMA) {
      if (o.default === undefined) continue;
      const own = LOADERS.map((l) => generated[l]![o.key]).filter((v) => v !== undefined);
      expect(new Set(own), o.key).toEqual(new Set([o.default]));
    }
    const without = PROPERTIES_SCHEMA.filter((o) => o.default === undefined).map((o) => o.key);
    expect(without.sort()).toEqual(['management-server-secret', 'pause-when-empty-seconds', 'white-list']);
  });

  it('names and explains every setting in English and Spanish, in a declared group', () => {
    const groups = PROPERTIES_GROUPS.map((g) => g.id);
    for (const o of [...PROPERTIES_SCHEMA, ...BSTATS_SCHEMA]) {
      for (const lang of ['en', 'es'] as const) {
        expect(o.label?.[lang]?.trim(), `${o.key} label ${lang}`).toBeTruthy();
        expect(o.description[lang]?.trim(), `${o.key} description ${lang}`).toBeTruthy();
      }
    }
    for (const o of PROPERTIES_SCHEMA) expect(groups, o.key).toContain(o.group);
    // The panel's own keys and the network behind "Advanced".
    const advanced = new Set(PROPERTIES_GROUPS.filter((g) => g.advanced).map((g) => g.id));
    for (const k of MANAGED_PROPERTIES) if (k !== 'level-name') expect(advanced.has(PROPERTIES_SCHEMA.find((o) => o.key === k)!.group!), k).toBe(true);
  });

  it('offers the difficulties the game’s help lists, as words', () => {
    const help = fixture('vanilla', 'logs', 'console-session.log');
    const listed = /difficulty \[([a-z|]+)\]/.exec(help)![1]!.split('|');
    expect(PROPERTIES_SCHEMA.find((o) => o.key === 'difficulty')!.options!.map((x) => x.value)).toEqual(listed);
    expect(PROPERTIES_SCHEMA.find((o) => o.key === 'gamemode')!.default).toBe('survival');
  });

  it('locks the keys the agent writes and masks the secrets (CFG-04)', () => {
    const decl = minecraftPanelAdapter.config.files(srv('vanilla')).find((f) => f.id === 'properties')!;
    expect(decl.managedKeys).toEqual([...MANAGED_PROPERTIES]);
    expect(decl.secretKeys).toEqual(PROPERTIES_SECRETS);
    expect(decl.restartKeys).toBe('*');
    // What the panel pins is what the agent writes before every start (the ports and the password are where it runs).
    const agent = managedProperties(testCtx());
    for (const [k, v] of Object.entries(minecraftManagedValues().properties!)) expect(agent[k as keyof typeof agent], k).toBe(v);
    expect(minecraftManagedValues().properties).not.toHaveProperty('rcon.password');
  });
});

// ------------------------------------------------------------------ config

describe('config files and editable folders (CFG-02, CFG-05, CFG-07, CFG-08, D6)', () => {
  it('declares the server’s files, Paper’s own for Paper; the operator and ban lists only while stopped', () => {
    const ids = (l: Loader) => minecraftPanelAdapter.config.files(srv(l)).map((f) => f.id);
    const base = ['properties', 'eula', 'whitelist', 'ops', 'banned-players', 'banned-ips'];
    expect(ids('vanilla')).toEqual(base);
    expect(ids('fabric')).toEqual(base);
    expect(ids('paper')).toEqual([...base, 'bukkit', 'spigot', 'commands', 'paper-global', 'paper-world-defaults', 'bstats']);
    const files = minecraftPanelAdapter.config.files(srv('paper'));
    expect(files.filter((f) => f.stoppedOnly).map((f) => f.id)).toEqual(['ops', 'banned-players', 'banned-ips']);
    expect(files.find((f) => f.id === 'eula')).toMatchObject({ rel: 'eula.txt', managedKeys: ['eula'] });
    expect(files.find((f) => f.id === 'whitelist')).toMatchObject({ restartKeys: [] });
    expect(files.find((f) => f.id === 'paper-global')!.secretKeys).toEqual(['proxies.velocity.secret']);
    expect(files.find((f) => f.id === 'bstats')).toMatchObject({ rel: BSTATS_FILE, schemaId: 'bstats' });
    expect(BSTATS_FILE).toBe(BSTATS_CONFIG);
  });

  it('opens text files only, never the user cache, and skips the world’s region folders', () => {
    for (const l of LOADERS) {
      const roots = minecraftPanelAdapter.config.roots(srv(l));
      for (const r of roots) for (const g of r.include) expect(g, `${l} ${r.id}`).not.toMatch(/\.(jar|so|dll|exe)$|\*$/);
      expect(roots.find((r) => r.id === 'server')!.exclude).toContain('usercache.json');
      expect(roots.map((r) => r.id)).toEqual(l === 'paper' ? ['server', 'config', 'plugins', 'world-config'] : ['server', 'config']);
    }
    const world = minecraftPanelAdapter.config.roots(srv('paper')).find((r) => r.id === 'world-config')!;
    expect(world).toMatchObject({ rel: `${LEVEL_NAME}/dimensions`, include: ['*/*/paper-world.yml'] });
    expect(world.exclude).toEqual(expect.arrayContaining(['*/*/region', '*/*/entities', '*/*/poi']));
  });

  it('has the whitelist re-read at once; everything else waits for the next start (CFG-05)', async () => {
    const c = ctxFor('vanilla', {}, (cmd) => (cmd === 'whitelist reload' ? 'Reloaded the whitelist' : ''));
    expect(await minecraftPanelAdapter.config.afterWrite!(c, 'whitelist', [])).toEqual({ applied: 'live', warnings: [] });
    expect(c.commands).toEqual(['whitelist reload']);
    for (const id of ['properties', 'ops', 'banned-players', 'bukkit']) expect(await minecraftPanelAdapter.config.afterWrite!(c, id, [])).toEqual({ applied: 'restart', warnings: [] });
    expect(c.commands).toEqual(['whitelist reload']);
  });

  it('has game-mode and difficulty presets the form accepts (CFG-06)', async () => {
    const p = minecraftPanelAdapter.config.presets!;
    expect(p.fileId).toBe('properties');
    const c = ctxFor('vanilla');
    expect(await p.list(c)).toEqual(Object.keys(MINECRAFT_PRESETS));
    for (const name of await p.list(c)) {
      for (const [k, v] of Object.entries(await p.load(c, name))) {
        const o = PROPERTIES_SCHEMA.find((x) => x.key === k)!;
        expect(o, k).toBeDefined();
        if (o.options) expect(o.options.map((x) => x.value), `${name}.${k}`).toContain(v);
      }
    }
    await expect(p.load(c, 'constructor')).rejects.toThrow(/Unknown preset/);
  });
});

// ------------------------------------------------------------------ players

describe('moderation over RCON and the game’s own lists (PLY-01, PLY-03)', () => {
  const players = minecraftPanelAdapter.players!;

  it('sends the measured commands and hands back the game’s replies', async () => {
    const c = ctxFor('vanilla', {}, (cmd) => `reply to ${cmd}`);
    expect(await players.kick!(c, 'gspffAlice', 'afk too long')).toBe('reply to kick gspffAlice afk too long');
    await players.kick!(c, 'gspffAlice');
    await players.ban!(c, { username: 'gspffBob' }, 'griefing');
    await players.ban!(c, { ip: '203.0.113.7' });
    await players.ban!(c, { ip: '2001:db8::1' }, 'spam');
    await players.unban!(c, { username: 'gspffBob' });
    await players.unban!(c, { ip: '203.0.113.7' });
    await players.setAccess!(c, 'gspffAlice', 'operator');
    await players.setAccess!(c, 'gspffAlice', 'player');
    await players.whitelistAdd!(c, 'gspffCarol');
    await players.whitelistRemove!(c, 'gspffCarol');
    expect(c.commands).toEqual([
      'kick gspffAlice afk too long',
      'kick gspffAlice',
      'ban gspffBob griefing',
      'ban-ip 203.0.113.7',
      'ban-ip 2001:db8::1 spam',
      'pardon gspffBob',
      'pardon-ip 203.0.113.7',
      'op gspffAlice',
      'deop gspffAlice',
      'whitelist add gspffCarol',
      'whitelist remove gspffCarol',
    ]);
    expect(players.accessLevels!.map((l) => l.id)).toEqual(['player', 'operator']);
    expect(players).toMatchObject({ banTargets: ['username', 'ip'], whitelistPassword: false });
  });

  it('refuses what isn’t a player name, an address or a plain reason, sending nothing', async () => {
    const c = ctxFor('vanilla');
    const refused = [
      players.kick!(c, 'two words'),
      players.kick!(c, 'a'.repeat(17)),
      players.ban!(c, { steamId: '76561198000000000' }),
      players.ban!(c, { ip: '203.0.113' }),
      players.ban!(c, { username: 'bob' }, 'x'.repeat(201)),
      players.kick!(c, 'bob', 'say "hi"'),
      players.setAccess!(c, 'bob', 'admin'),
    ];
    for (const r of refused) await expect(r).rejects.toBeInstanceOf(RconProtocolError);
    expect(c.commands).toEqual([]);
  });

  it('reads the whitelist, the operators and the bans from the files the game wrote', async () => {
    const files = {
      'data/whitelist.json': fixture('vanilla', 'files', 'whitelist.json'),
      'data/ops.json': fixture('vanilla', 'files', 'ops.json'),
      'data/banned-players.json': fixture('vanilla', 'files', 'banned-players.json'),
      'data/banned-ips.json': fixture('vanilla', 'files', 'banned-ips.json'),
      'data/server.properties': fixture('vanilla', 'config', 'server.properties.after'),
    };
    const c = ctxFor('vanilla', files);
    const wl = JSON.parse(files['data/whitelist.json']) as { name: string }[];
    expect(await players.whitelist!(c)).toEqual({ enabled: props(files['data/server.properties'])['white-list'] === 'true', usernames: wl.map((e) => e.name) });
    expect(await players.levelHolders!(c)).toEqual((JSON.parse(files['data/ops.json']) as { name: string }[]).map((e) => ({ username: e.name, level: 'operator' })));
    const bans = await players.bans!(c);
    const bannedPlayers = JSON.parse(files['data/banned-players.json']) as { name: string; uuid: string; reason: string }[];
    const bannedIps = JSON.parse(files['data/banned-ips.json']) as { ip: string; reason: string }[];
    expect(bans).toEqual({
      steamIds: [],
      usernames: bannedPlayers.map((b) => ({ username: b.name, id: b.uuid, reason: b.reason })),
      ips: bannedIps.map((b) => ({ ip: b.ip, username: null, reason: b.reason })),
    });
    expect(bans.usernames!.length + bans.ips.length).toBeGreaterThan(0);
    await expect(players.bans!(ctxFor('vanilla', { 'data/banned-ips.json': '{"not":"a list"}' }))).rejects.toThrow(/not a list/);
  });

  it('switches the whitelist and keeps the settings saved since the start, which the game rewrites from memory (CFG-09)', async () => {
    // The game started with motd A; the panel saved motd B since (it waits for a restart).
    const onDisk = 'motd=B\nwhite-list=false\nmax-players=20\n';
    const inMemory = { motd: 'A', 'white-list': 'false', 'max-players': '20' };
    const c = ctxFor('vanilla', { 'data/server.properties': onDisk }, (cmd, ctx) => {
      // Measured: `whitelist on` makes the game write the whole file from memory.
      inMemory['white-list'] = cmd === 'whitelist on' ? 'true' : 'false';
      void ctx.files.writeAtomic('data', 'server.properties', `#Minecraft server properties\n${Object.entries(inMemory).map(([k, v]) => `${k}=${v}`).sort().join('\n')}\n`);
      return 'Whitelist is now turned on';
    });
    expect(await players.setWhitelistEnabled!(c, true)).toBe('Whitelist is now turned on');
    expect(c.commands).toEqual(['whitelist on']);
    expect(c.sets).toEqual([['properties', { motd: 'B' }, expect.stringMatching(/whitelist/)]]);
    // Nothing was pending: nothing to put back.
    const clean = ctxFor('vanilla', { 'data/server.properties': 'white-list=true\n' }, (_cmd, ctx) => (void ctx.files.writeAtomic('data', 'server.properties', 'white-list=false\n'), 'Whitelist is now turned off'));
    await players.setWhitelistEnabled!(clean, false);
    expect(clean.sets).toEqual([]);
  });
});

// ------------------------------------------------------------------ messages

describe('countdown messages and broadcasts (CON-03, SRV-03)', () => {
  it('uses say, refusing messages longer than the game takes', () => {
    const { broadcast, announce } = minecraftPanelAdapter.messages;
    expect(broadcast!('Restart at 6')).toEqual({ command: 'say Restart at 6', via: 'rcon' });
    expect(broadcast!('x'.repeat(SAY_MAX)).command).toHaveLength(4 + SAY_MAX);
    expect(() => broadcast!('x'.repeat(SAY_MAX + 1))).toThrow(RconProtocolError);
    expect(() => broadcast!('two\nlines')).toThrow(RconProtocolError);
    expect(() => broadcast!('   ')).toThrow(RconProtocolError);
    expect(announce('restart', 300, 'es')).toBe('El servidor se reinicia en 5 minutos.');
    expect(announce('stop', 10, 'en')).toBe('Server shutting down in 10 seconds.');
    for (const lang of ['en', 'es'] as const) for (const kind of ['restart', 'stop', 'update', 'restore', 'reset', 'cancelled'] as const) expect(announce(kind, 900, lang)!.length).toBeLessThanOrEqual(SAY_MAX);
  });
});

// ------------------------------------------------------------ backups, resets

describe('backups and resets (BAK-01, BAK-03, BAK-04)', () => {
  const paths = (l: Loader) => Object.fromEntries(minecraftPanelAdapter.backups.parts.map((p) => [p.id, p.paths(srv(l))]));

  it('back up the world, the settings and lists, and Paper’s plugins or Fabric’s mods; never the EULA, caches or logs', () => {
    expect(paths('vanilla')).toEqual({ world: ['world'], config: ['server.properties', 'whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json'], plugins: [], mods: [] });
    expect(paths('paper')).toMatchObject({ plugins: ['plugins'], mods: [] });
    expect(paths('paper').config).toEqual(expect.arrayContaining(['bukkit.yml', 'spigot.yml', 'commands.yml', 'config']));
    expect(paths('fabric')).toMatchObject({ plugins: [], mods: ['mods'] });
    expect(paths('fabric').config).toContain('config');
    for (const l of LOADERS) {
      const all = Object.values(paths(l)).flat();
      for (const never of ['eula.txt', 'usercache.json', 'logs', 'crash-reports', '.paper', '.fabric']) expect(all, `${l} ${never}`).not.toContain(never);
    }
  });

  it('reset the world with a new random seed and a preset, or everything but the EULA', async () => {
    const [world, factory] = minecraftPanelAdapter.resets;
    expect(world).toMatchObject({ id: 'world', removeParts: ['world'], options: { newSeed: true, preset: true } });
    expect(factory).toMatchObject({ id: 'factory', removeParts: ['world', 'config', 'plugins', 'mods'] });
    const c = ctxFor('vanilla');
    await world!.after!(c, { newSeed: true, preset: 'hardcore' });
    expect(c.sets).toEqual([['properties', { 'level-seed': '' }, expect.any(String)]]);
    expect(c.presets).toEqual(['hardcore']);
    const keep = ctxFor('vanilla');
    await world!.after!(keep, { newSeed: false });
    expect(keep.sets).toEqual([]);
  });
});

// ------------------------------------------------------------------ updates

describe('update checks: newer builds of what is pinned, never another version (UPD-03, UPD-05)', () => {
  const check = (flavour: Loader, launch: Partial<MinecraftLaunchSettings>, v: VersionsResponse) => minecraftPanelAdapter.updates!.check(ctxFor(flavour, {}, () => '', v), settings(launch));
  const paper26_2 = { id: '26.2', build: '131', channel: 'STABLE', builds: [131, 130, 82, 58].map((id, i) => ({ id, channel: ['STABLE', 'STABLE', 'BETA', 'ALPHA'][i], timeUpdated: 0 })) };

  it('vanilla: only an install of another version needs one', async () => {
    const versions = [{ id: '26.3' }, { id: '26.2' }];
    expect(await check('vanilla', { version: '26.2' }, { installed: { version: '26.2', channel: 'vanilla' }, versions })).toEqual({ available: false, current: '26.2', latest: '26.2' });
    expect(await check('vanilla', { version: '26.2' }, { installed: { version: '26.3', channel: 'vanilla' }, versions })).toMatchObject({ available: true, latest: '26.2' });
    expect(await check('vanilla', { version: '1.20.1' }, { installed: null, versions })).toBeNull();
  });

  it('Paper: the newest build of the pinned channel or a more stable one', async () => {
    const r = await check('paper', { version: '26.2' }, { installed: { version: '26.2', channel: 'paper', build: '129' }, versions: [paper26_2] });
    expect(r).toEqual({ available: true, current: '26.2-129', latest: '26.2-131', channel: 'STABLE' });
    expect(await check('paper', { version: '26.2' }, { installed: { version: '26.2', channel: 'paper', build: '131' }, versions: [paper26_2] })).toMatchObject({ available: false });
    const alphaOnly = { id: '26.3', build: '41', channel: 'ALPHA', warning: 'paper-no-stable-build', builds: [41, 40].map((id) => ({ id, channel: 'ALPHA', timeUpdated: 0 })) };
    expect(await check('paper', { version: '26.3', channel: 'ALPHA' }, { installed: { version: '26.3', channel: 'paper', build: '40' }, versions: [alphaOnly] })).toEqual({ available: true, current: '26.3-40', latest: '26.3-41', channel: 'ALPHA' });
    // Pinned to STABLE and none yet: nothing to take.
    expect(await check('paper', { version: '26.3' }, { installed: null, versions: [alphaOnly] })).toMatchObject({ available: false });
  });

  it('Fabric: the newest stable loader, unless one is pinned', async () => {
    const v = { id: '26.3', build: '0.19.5', loaders: [{ version: '0.19.5', stable: true }, { version: '0.19.4', stable: false }] };
    expect(await check('fabric', { version: '26.3' }, { installed: { version: '26.3', channel: 'fabric', build: '0.19.4' }, versions: [v] })).toEqual({ available: true, current: '0.19.4', latest: '0.19.5' });
    expect(await check('fabric', { version: '26.3', loaderVersion: '0.19.4' }, { installed: { version: '26.3', channel: 'fabric', build: '0.19.4' }, versions: [v] })).toMatchObject({ available: false });
  });
});

describe('the console catalog (AST-04)', () => {
  it('names only commands the game’s help lists', () => {
    const help = fixture('vanilla', 'logs', 'console-session.log');
    for (const c of minecraftPanelAdapter.consoleCatalog!) expect(help, c.name).toContain(`System chat: /${c.name} `.trimEnd());
  });
});
