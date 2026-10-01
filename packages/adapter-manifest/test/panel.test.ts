// The panel half the engine makes from a manifest (D4, M6): the launch
// settings form and its EN/ES refusals (CFG-01, UPD-02), config files and
// editable folders (CFG-04, CFG-07…09), backups and resets (BAK-01, BAK-04),
// messages (CON-03), moderation from console templates or list files
// (PLY-03), update checks (UPD-03) and the hooks a game adds.
import { describe, expect, it } from 'vitest';
import type { AgentCommand, LaunchSettingRefusal, PlayerOps, ServerCtx, VersionsResponse } from '@gsp/adapter-api';
import { memoryServerFiles } from '@gsp/adapter-api/testing/panel-suite-config';
import { panelAdapterConfigSuite } from '@gsp/adapter-api/testing/panel-suite-config';
import { panelAdapterCoreSuite } from '@gsp/adapter-api/testing/panel-suite-core';
import { RconProtocolError } from '@gsp/formats';
import { manifestPanelAdapter, REPLY_MS } from '../src/panel';
import { AVORION } from '../src/shared';
import { TIDEWATER } from './tidewater';

const gal = { id: 'gal', gameName: 'gal', flavour: null };
const avorion = () => manifestPanelAdapter(AVORION);
const tide = () => manifestPanelAdapter(TIDEWATER);

/** A server for panel-side code: files in memory, commands recorded, a game that answers with `reply` in its log. */
function serverCtx(o: { running?: boolean; reply?: (cmd: string) => string[]; files?: Record<string, string>; versions?: VersionsResponse } = {}) {
  const commands: AgentCommand[] = [];
  const configCalls: unknown[][] = [];
  const listeners = new Set<(line: string) => void>();
  const files = memoryServerFiles(o.files ?? {});
  const ctx: ServerCtx = {
    srv: gal,
    files,
    actor: 'alice',
    status: () => (o.running ? ({ state: 'running' } as ReturnType<ServerCtx['status']>) : null),
    command: async (c) => {
      commands.push(c);
      // The reply shows in the log a moment later, as a console's does.
      setTimeout(() => (o.reply?.(c.command) ?? []).forEach((l) => listeners.forEach((x) => x(l))), 5);
      return { via: 'stdin', output: null };
    },
    action: async () => null,
    versions: async () => o.versions ?? { installed: null, versions: [] },
    launchSettings: () => ({}),
    config: {
      set: async (...args) => void configCalls.push(['set', ...args]),
      seedIfMissing: async () => (configCalls.push(['seedIfMissing']), false),
      applyPreset: async () => undefined,
    },
    onLog: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return { ctx, commands, configCalls, files };
}

describe('launch settings (CFG-01, UPD-02, SRV-05)', () => {
  it("form the branch, updates, the game's memory, then the manifest's settings, typed and labelled", () => {
    const a = avorion();
    expect(a.launch.schema.map((o) => [o.key, o.type, o.role ?? null, o.default])).toEqual([
      ['branch', 'string', 'version', 'public'],
      ['updateOnStart', 'boolean', null, 'true'],
      ['memoryMb', 'integer', 'memory', '2048'],
      ['serverName', 'string', null, 'Avorion'],
      ['maxPlayers', 'integer', null, '10'],
      ['listed', 'boolean', null, 'false'],
      ['saveInterval', 'integer', null, '300'],
    ]);
    expect(a.launch.schema.find((o) => o.key === 'memoryMb')).toMatchObject({ min: 512, max: 65_536, step: 256, unit: 'MiB' });
    expect(a.launch.schema.find((o) => o.key === 'saveInterval')).toMatchObject({ min: 60, max: 3600, step: 60, unit: 's', advanced: true, label: { en: 'Autosave every' } });
    expect(a.launch.defaults()).toEqual({ branch: 'public', updateOnStart: true, memoryMb: 2048, serverName: 'Avorion', maxPlayers: 10, listed: false, saveInterval: 300 });
    // A secret people choose is a hidden text; a fixed list of branches is a choice; generated secrets are the panel's.
    const t = tide();
    expect(t.launch.schema.find((o) => o.key === 'password')).toMatchObject({ type: 'string', secret: true, default: '' });
    expect(t.launch.schema.find((o) => o.key === 'branch')).toMatchObject({ type: 'enum', options: [{ value: 'public' }, { value: 'beta' }] });
    expect(t.launch.schema.find((o) => o.key === 'mode')).toMatchObject({ type: 'enum', options: [{ value: '' }, { value: 'hard' }] });
    expect(t.launch.secrets).toEqual([{ key: 'adminKey', label: { en: 'Admin key', es: 'Clave de administración' } }]);
  });

  it('turn into the agent params, refusing what the game would refuse in both languages', () => {
    const a = avorion();
    expect(a.launch.toAgent(gal, a.launch.defaults(), {})).toEqual({ name: 'gal', branch: 'public', updateOnStart: true, memoryMb: 2048, serverName: 'Avorion', maxPlayers: 10, listed: false, saveInterval: 300 });
    // Right after an install the panel ran, no update before the start.
    expect(a.launch.toAgent(gal, a.launch.defaults(), {}, { afterInstall: true })).toMatchObject({ updateOnStart: false });
    const refusal = (s: Record<string, string | number | boolean>, secrets: Record<string, string> = { adminKey: 'k' }) => {
      try {
        tide().launch.toAgent(gal, { ...tide().launch.defaults(), ...s }, secrets);
      } catch (e) {
        return e as Error & LaunchSettingRefusal;
      }
      throw new Error('expected a refusal');
    };
    expect(refusal({ public: true, password: 'abc' })).toMatchObject({ field: 'password', text: { es: 'Un servidor público necesita una contraseña de al menos 5 caracteres.' } });
    expect(refusal({ serverName: '' })).toMatchObject({ field: 'serverName', text: { en: "Server name can't be empty.", es: 'Nombre del servidor no puede quedar vacío.' } });
    expect(refusal({}, {}).message).toMatch(/secret adminKey is not set/);
    expect(tide().launch.toAgent(gal, tide().launch.defaults(), { adminKey: 'k-1' })).toMatchObject({ adminKey: 'k-1', name: 'gal' });
  });
});

describe('config files and folders (CFG-04, CFG-07…09)', () => {
  it("declares Avorion's galaxy files: server.ini with the agent's keys locked and passwords hidden, everything edited only while stopped", () => {
    const files = avorion().config.files(gal);
    expect(files.map((f) => [f.id, f.rel, f.format, f.stoppedOnly ?? false])).toEqual([
      ['server', 'gal/server.ini', 'ini', true],
      ['admins', 'gal/admin.xml', 'text', true],
      ['blacklist', 'gal/blacklist.txt', 'lines', true],
      ['ipblacklist', 'gal/ipblacklist.txt', 'lines', true],
      ['whitelist', 'gal/whitelist.txt', 'lines', true],
      ['group-whitelist', 'gal/group-whitelist.txt', 'lines', true],
    ]);
    expect(files[0]).toMatchObject({ managedKeys: ['port', 'name', 'maxPlayers', 'isListed', 'saveInterval', 'sendCrashReports', 'backupsPath'], secretKeys: ['password', 'rconPassword'], restartKeys: '*', note: { en: expect.stringMatching(/^Avorion writes this file back from memory/) } });
    // The panel sets what it knows itself; the ports, folders and settings are the agent's at every start.
    expect(avorion().config.managedValues(gal)).toEqual({ server: { sendCrashReports: 'false' } });
    expect(tide().config.managedValues(gal)).toEqual({ 'world-settings': { world: 'gal', telemetry: 'off' } });
    expect(avorion().config.roots(gal)).toEqual([{ id: 'galaxy', root: 'data', rel: 'gal', include: ['server.ini', 'admin.xml', '*.txt'], exclude: ['serverlog *.txt', 'server.ini - readme.txt'], label: { en: "The galaxy's settings", es: 'Ajustes de la galaxia' } }]);
    expect(avorion().config.schemas).toEqual({});
  });
});

describe('backups and resets (BAK-01, BAK-04)', () => {
  it("back up Avorion's galaxy folder, its own backups left out; a reset makes a new galaxy", () => {
    const a = avorion();
    expect(a.backups.parts.map((p) => [p.id, p.paths(gal)])).toEqual([['galaxy', ['gal']]]);
    expect(a.resets).toEqual([{ id: 'factory', label: expect.objectContaining({ en: expect.stringMatching(/^New galaxy/) }), permission: 'reset.factory', removeParts: ['galaxy'] }]);
    expect(tide().backups.parts.map((p) => p.paths(gal))).toEqual([['worlds/gal'], ['banned.txt', 'allowed.txt', 'admins.txt']]);
  });
});

describe('messages (CON-03)', () => {
  it('broadcast with /say and announce countdowns where there is a console; a game without one shows nothing', () => {
    const a = avorion();
    expect(a.messages.broadcast!('  Hola a todos ')).toEqual({ command: '/say Hola a todos', via: 'stdin' });
    expect(() => a.messages.broadcast!('two\nlines')).toThrow(RconProtocolError);
    expect(() => a.messages.broadcast!('x'.repeat(301))).toThrow(RconProtocolError);
    expect(a.messages.announce('restart', 300, 'es')).toBe('El servidor se reinicia en 5 minutos.');
    expect(a.messages.announce('stop', 30, 'en')).toBe('Server shutting down in 30 seconds.');
    expect(tide().messages.announce('restart', 300, 'en')).toBeNull();
    expect(tide().messages.broadcast).toBeUndefined();
  });
});

describe('moderation on the console (PLY-03)', () => {
  it("kicks and bans with Avorion's commands, answering with the game's reply and telling its refusals", async () => {
    const p = avorion().players!;
    const replies: Record<string, string> = { '/kick Bob': 'Player Bob is not online.', '/ban Ghost': 'Player Ghost not found.', '/ban Carol': 'Player logged off: Carol', '/unban Carol': 'Removed Carol from blacklist' };
    const { ctx, commands } = serverCtx({ running: true, reply: (c) => (replies[c] ? [replies[c]] : []) });
    expect(await p.kick!(ctx, 'Bob', 'afk')).toBe('Player Bob is not online.');
    expect(p.refused!('kick', 'Player Bob is not online.')).toBe('player-not-online');
    expect(await p.ban!(ctx, { username: 'Ghost' })).toBe('Player Ghost not found.');
    expect(p.refused!('ban', 'Player Ghost not found.')).toBe('player-not-found');
    expect(await p.ban!(ctx, { username: 'Carol' }, 'griefing')).toBe('Player logged off: Carol');
    expect(p.refused!('ban', 'Player logged off: Carol')).toBeNull();
    expect(await p.unban!(ctx, { username: 'Carol' })).toBe('Removed Carol from blacklist');
    expect(commands).toEqual(['/kick Bob', '/ban Ghost', '/ban Carol', '/unban Carol'].map((command) => ({ command, via: 'stdin' })));
    expect(p.banTargets).toEqual(['username']);
    // Nothing that could be a second command, or a command of its own.
    for (const bad of ['/stop', 'a"b', 'two\nlines', ' padded ']) await expect(p.kick!(ctx, bad)).rejects.toBeInstanceOf(RconProtocolError);
    await expect(p.ban!(ctx, { steamId: '76561198000000001' })).rejects.toBeInstanceOf(RconProtocolError);
  });

  it('says nothing came back when the game answers nothing in time', async () => {
    const { ctx } = serverCtx({ running: true });
    const t0 = Date.now();
    expect(await avorion().players!.kick!(ctx, 'Bob')).toBe('');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(REPLY_MS - 50);
  });
});

describe('moderation through list files (PLY-03)', () => {
  const steamId = '76561198000000001';
  it('bans, allows and makes admins by editing the lists through the panel, which keeps their history', async () => {
    const p: PlayerOps = tide().players!;
    expect([p.banTargets, p.whitelistPassword, p.accessLevels?.map((l) => l.id), p.stoppedOnly]).toEqual([['steamId'], false, ['player', 'admin'], undefined]);
    const { ctx, configCalls, commands } = serverCtx();
    await p.ban!(ctx, { steamId }, 'griefing');
    await p.unban!(ctx, { steamId });
    await p.whitelistAdd!(ctx, steamId);
    await p.whitelistRemove!(ctx, steamId);
    await p.setAccess!(ctx, steamId, 'admin');
    await p.setAccess!(ctx, steamId, 'player');
    const sets = configCalls.filter((c) => c[0] === 'set').map((c) => c.slice(1, 3));
    expect(sets).toEqual([
      ['banned', { [steamId]: true }],
      ['banned', { [steamId]: false }],
      ['allowed', { [steamId]: true }],
      ['allowed', { [steamId]: false }],
      ['admins', { [steamId]: true }],
      ['admins', { [steamId]: false }],
    ]);
    // A list the game hasn't written yet starts empty first; nothing goes to a console.
    expect(configCalls.filter((c) => c[0] === 'seedIfMissing')).toHaveLength(6);
    expect(commands).toEqual([]);
    expect(tide().config.files(gal).filter((f) => f.seed).map((f) => [f.id, f.seed])).toEqual([
      ['banned', {}],
      ['allowed', {}],
      ['admins', {}],
    ]);
    // Only SteamIDs: a name is refused before anything changes.
    await expect(p.ban!(ctx, { username: 'bob' })).rejects.toBeInstanceOf(RconProtocolError);
    await expect(p.whitelistAdd!(ctx, 'bob')).rejects.toBeInstanceOf(RconProtocolError);
  });

  it('reads the bans, the allowed players and the admins from the lists', async () => {
    const p = tide().players!;
    // A game's own heading that isn't a `#` comment is no entry of a list of SteamIDs.
    const { ctx } = serverCtx({ files: { 'data/banned.txt': `# banned SteamIDs\n${steamId}\n`, 'data/allowed.txt': '', 'data/admins.txt': '// List admin players ID  ONE per line\n76561198000000002\n' } });
    expect(await p.bans!(ctx)).toEqual({ steamIds: [{ steamId, reason: null }], ips: [] });
    expect(await p.whitelist!(ctx)).toEqual({ enabled: false, usernames: [] });
    expect(await p.levelHolders!(ctx)).toEqual([{ username: '76561198000000002', level: 'admin' }]);
  });
});

describe('update checks (UPD-03)', () => {
  it('compare the installed build with the newest of the pinned branch', async () => {
    const versions: VersionsResponse = { installed: { version: '2.5.13', channel: 'public', build: '100' }, versions: [{ id: 'public', build: '101' }, { id: 'beta', build: '102' }] };
    const a = avorion();
    expect(await a.updates!.check(serverCtx({ versions }).ctx, a.launch.defaults())).toEqual({ available: true, current: '100', latest: '101', channel: 'public' });
    expect(await a.updates!.check(serverCtx({ versions }).ctx, { ...a.launch.defaults(), branch: 'nope' })).toBeNull();
  });
});

describe('hooks', () => {
  it('may change the panel adapter the manifest made', () => {
    const a = manifestPanelAdapter(AVORION, { panel: (x) => ({ ...x, consoleCatalog: [] }) });
    expect(a.consoleCatalog).toEqual([]);
    expect(avorion().consoleCatalog!.map((c) => c.name)).toEqual(['help', 'players', 'save', 'stop', 'say', 'kick', 'ban', 'unban', 'version', 'seed']);
  });
});

describe('a game moderated through list files passes the panel contract (D4)', () => {
  const server = () => ({ id: 'tide', gameName: 'tide', flavour: null });
  panelAdapterCoreSuite(tide(), { server, secrets: () => ({ adminKey: 'k-123456789' }), player: '76561198000000001' });
  panelAdapterConfigSuite(tide(), { server, files: () => ({ 'data/banned.txt': '# banned SteamIDs\n', 'data/worlds/tide/settings.ini': 'port=3000\nmotd=hi\nadminpass=x\n' }) });
});
