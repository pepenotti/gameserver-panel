import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { AgentCommand, ConfigAccess, DirEntry, RootId, ServerCtx, ServerFiles, ServerRef, VersionsResponse } from '@gsp/adapter-api';
import { RconProtocolError } from '@gsp/formats';
import { pzPanelAdapter } from '../src/panel';
import { parseAccounts, parseBans, PZ_LAUNCH_DEFAULTS, PZ_LAUNCH_SECRETS } from '../src/panel/core';
import { PZ_BACKUP_PARTS, PZ_RESETS, pzBeforeStart } from '../src/panel/core/backups';
import { PZ_CONSOLE_CATALOG } from '../src/panel/core/console';
import { pzToAgent } from '../src/panel/core/launch';
import { pzAnnounce, pzBroadcast } from '../src/panel/core/messages';
import { pzPlayers } from '../src/panel/core/players';
import { pzCheckUpdate } from '../src/panel/core/updates';
import { createWorkshopSource, type PzMod } from '../src/panel/core/workshop';
import { ACCOUNTS, BANS, WORKSHOP_DOWNLOAD } from '../src/shared/actions';

const SRV: ServerRef = { id: 'test', gameName: 'zomboid', flavour: null };
const SECRETS = { adminPassword: 'Admin-pw-123456' };
const fixtures = fileURLToPath(new URL('../../../fixtures/pz/b42/workshop/', import.meta.url));

/** `ServerFiles` over plain folders, read-only: enough for scanning. */
function folderFiles(roots: Record<string, string>): ServerFiles {
  const abs = (root: RootId, rel: string) => path.join(roots[root]!, ...rel.split('/'));
  const nope = async (): Promise<never> => {
    throw new Error('read-only');
  };
  return {
    stat: async (root, rel) => {
      try {
        const st = statSync(abs(root, rel));
        return { kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    },
    list: async (root, rel) => {
      try {
        return readdirSync(abs(root, rel), { withFileTypes: true })
          .map((e): DirEntry => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file', size: 0, mtimeMs: 0 }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        return [];
      }
    },
    read: async (root, rel) => {
      try {
        return readFileSync(abs(root, rel));
      } catch {
        return null;
      }
    },
    writeAtomic: nope,
    remove: nope,
    pack: nope,
    stage: nope,
    swap: nope,
    undo: nope,
    purgeTrash: nope,
  };
}

interface FakeCtx extends ServerCtx {
  commands: AgentCommand[];
  actions: { name: string; input: unknown }[];
}

function ctx(o: { files?: ServerFiles; reply?: (cmd: string) => string; action?: (name: string, input: unknown) => unknown; extras?: Partial<ServerCtx> } = {}): FakeCtx {
  const commands: AgentCommand[] = [];
  const actions: { name: string; input: unknown }[] = [];
  const no = async (): Promise<never> => {
    throw new Error('not in this test');
  };
  return {
    srv: SRV,
    files: o.files ?? folderFiles({}),
    actor: null,
    status: () => null,
    command: async (c) => {
      commands.push(c);
      return { via: 'rcon', output: o.reply?.(c.command) ?? 'ok' };
    },
    action: async (name, input) => {
      actions.push({ name, input });
      return o.action?.(name, input);
    },
    versions: no,
    launchSettings: () => ({ ...PZ_LAUNCH_DEFAULTS }),
    config: { set: no, seedIfMissing: no, applyPreset: no },
    onLog: () => () => undefined,
    commands,
    actions,
    ...o.extras,
  };
}

function configSpy(): ConfigAccess & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    seedIfMissing: async () => (calls.push(['seed']), true),
    set: async (fileId, values, note) => void calls.push(['set', fileId, values, note]),
    applyPreset: async (name) => void calls.push(['preset', name]),
  };
}

describe('launch', () => {
  it('turns the stored settings and the admin password into the agent params', () => {
    expect(pzToAgent(SRV, { ...PZ_LAUNCH_DEFAULTS }, SECRETS)).toEqual({ serverName: 'zomboid', adminUsername: 'admin', adminPassword: 'Admin-pw-123456', memoryMb: 8192, branch: 'public', updateOnStart: true });
    // Right after an install the start doesn't update again.
    expect(pzToAgent(SRV, { ...PZ_LAUNCH_DEFAULTS }, SECRETS, { afterInstall: true })).toMatchObject({ updateOnStart: false });
    // Settings stored by an older version get the new defaults.
    expect(pzToAgent(SRV, { memoryMb: 4096 } as never, SECRETS)).toMatchObject({ memoryMb: 4096, branch: 'public' });
  });

  it('refuses settings the server cannot run with', () => {
    for (const bad of [{ memoryMb: 1000 }, { memoryMb: 4100 }, { memoryMb: 65536 }, { branch: 'x; rm -rf' }, { branch: '' }, { updateOnStart: 'yes' }]) {
      expect(() => pzToAgent(SRV, { ...PZ_LAUNCH_DEFAULTS, ...bad } as never, SECRETS), JSON.stringify(bad)).toThrow();
    }
    expect(() => pzToAgent(SRV, { ...PZ_LAUNCH_DEFAULTS }, {})).toThrow(/admin password/);
  });
});

describe('in-game messages', () => {
  it('reads naturally in both languages', () => {
    expect(pzAnnounce('restart', 300, 'es')).toBe('El servidor se reinicia en 5 minutos. Busquen un lugar seguro.');
    expect(pzAnnounce('stop', 60, 'es')).toBe('El servidor se apaga en 1 minuto. Busquen un lugar seguro.');
    expect(pzAnnounce('update', 30, 'en')).toBe('Server updating in 30 seconds. Find somewhere safe.');
    expect(pzAnnounce('cancelled', 0, 'es')).toBe('Se canceló el reinicio del servidor.');
  });

  it('broadcasts with servermsg over RCON and refuses quote injection', () => {
    expect(pzBroadcast('Reinicio a las 6')).toEqual({ command: 'servermsg "Reinicio a las 6"', via: 'rcon' });
    expect(() => pzBroadcast('x" ; quit "')).toThrow(RconProtocolError);
  });
});

describe('players', () => {
  it('sends the B42 moderation commands with quoted arguments', async () => {
    const c = ctx();
    await pzPlayers.kick!(c, 'rick', 'afk');
    await pzPlayers.ban!(c, { steamId: '76561198000000001' });
    await pzPlayers.ban!(c, { username: 'rick' }, 'duping');
    await pzPlayers.unban!(c, { username: 'rick' });
    await pzPlayers.unban!(c, { steamId: '76561198000000001' });
    await pzPlayers.setAccess!(c, 'rick', 'moderator');
    await pzPlayers.whitelistAdd!(c, 'glenn', 'pizza-delivery');
    await pzPlayers.whitelistRemove!(c, 'glenn');
    expect(c.commands).toEqual(
      [
        'kickuser "rick" -r "afk"',
        'banid 76561198000000001',
        'banuser "rick" -r "duping"',
        'unbanuser "rick"',
        'unbanid 76561198000000001',
        'setaccesslevel "rick" moderator',
        'adduser "glenn" "pizza-delivery"',
        'removeuserfromwhitelist "glenn"',
      ].map((command) => ({ command, via: 'rcon' })),
    );
  });

  it('falls back to "kick" when "kickuser" is unknown', async () => {
    const c = ctx({ reply: (cmd) => (cmd.startsWith('kickuser') ? 'Unknown command kickuser' : 'User rick kicked.') });
    expect(await pzPlayers.kick!(c, 'rick')).toBe('User rick kicked.');
    expect(c.commands.map((x) => x.command)).toEqual(['kickuser "rick"', 'kick "rick"']);
  });

  it('refuses bad SteamIDs, levels and missing passwords', async () => {
    const c = ctx();
    await expect(pzPlayers.ban!(c, { steamId: '123' })).rejects.toThrow(RconProtocolError);
    await expect(pzPlayers.setAccess!(c, 'rick', 'god')).rejects.toThrow(RconProtocolError);
    await expect(pzPlayers.whitelistAdd!(c, 'glenn')).rejects.toThrow(RconProtocolError);
    expect(c.commands).toEqual([]);
  });

  it("reads accounts and bans through the agent's actions and checks the replies", async () => {
    const rows = [{ username: 'rick', displayName: null, role: 'user', lastConnection: '2026-09-23 10:00:00', steamId: '76561198000000001' }];
    const c = ctx({ action: (name) => (name === ACCOUNTS ? [...rows, { nope: 1 }, 'x', null] : { steamIds: [{ steamId: '76561198000000009', reason: 'griefing' }, { reason: 'no id' }], ips: [] }) });
    expect(await pzPlayers.accounts!(c)).toEqual(rows);
    expect(await pzPlayers.bans!(c)).toEqual({ steamIds: [{ steamId: '76561198000000009', reason: 'griefing' }], ips: [] });
    expect(c.actions).toEqual([
      { name: ACCOUNTS, input: { serverName: 'zomboid' } },
      { name: BANS, input: { serverName: 'zomboid' } },
    ]);
  });

  it('refuses replies of the wrong shape and cuts long strings', () => {
    expect(() => parseAccounts({ username: 'x' })).toThrow();
    expect(() => parseBans([])).toThrow();
    expect(parseAccounts([{ username: 'x'.repeat(500), role: 7 }])).toEqual([{ username: 'x'.repeat(64), displayName: null, role: '', lastConnection: null, steamId: null }]);
  });
});

describe('backup parts and resets', () => {
  it('names the world, accounts and settings files of the server', () => {
    expect(Object.fromEntries(PZ_BACKUP_PARTS.map((p) => [p.id, p.paths(SRV)]))).toEqual({
      world: ['Saves/Multiplayer/zomboid', 'Saves/Multiplayer/zomboid_player'],
      accounts: ['db/zomboid.db'],
      configs: ['Server/zomboid.ini', 'Server/zomboid_SandboxVars.lua', 'Server/zomboid_spawnregions.lua', 'Server/zomboid_spawnpoints.lua'],
    });
  });

  it('gives a new world a new ResetID, maybe a seed and a preset, through the settings service', async () => {
    const config = configSpy();
    const world = PZ_RESETS.find((r) => r.id === 'world')!;
    await world.after!(ctx({ extras: { config, actor: 'alice' } }), { newSeed: true, preset: 'Apocalypse' });
    const [ini, preset] = config.calls as [[string, string, Record<string, string>, string], unknown[]];
    expect(ini.slice(0, 2)).toEqual(['set', 'ini']);
    expect(ini[2].ResetID).toMatch(/^[1-9]\d{8}$/);
    expect(ini[2].Seed).toMatch(/^[A-Za-z]{16}$/);
    // The panel records ctx.actor ('alice') in the history.
    expect(ini[3]).toBe('reset (world)');
    expect(preset).toEqual(['preset', 'Apocalypse']);

    const again = configSpy();
    await PZ_RESETS.find((r) => r.id === 'full')!.after!(ctx({ extras: { config: again, actor: 'alice' } }), { newSeed: false });
    expect(again.calls).toHaveLength(1);
    expect(Object.keys(again.calls[0]![2] as object)).toEqual(['ResetID']);
  });

  it('writes the first-run settings after a factory reset and before a first start', async () => {
    const config = configSpy();
    await PZ_RESETS.find((r) => r.id === 'factory')!.after!(ctx({ extras: { config } }), { newSeed: false });
    await pzBeforeStart(ctx({ extras: { config } }));
    expect(config.calls).toEqual([['seed'], ['seed']]);
  });
});

describe('launch secrets and the console catalog', () => {
  it('declares the admin password the agent params need', () => {
    expect(PZ_LAUNCH_SECRETS.map((s) => s.key)).toEqual(['adminPassword']);
    expect(pzPanelAdapter.launch.secrets).toBe(PZ_LAUNCH_SECRETS);
  });

  it('marks the commands whose arguments hold passwords', () => {
    expect(PZ_CONSOLE_CATALOG.filter((c) => c.secretArgs).map((c) => c.name)).toEqual(['adduser', 'setpassword', 'changeoption']);
  });
});

describe('update check', () => {
  const versions = (installed: VersionsResponse['installed']): VersionsResponse => ({ installed, versions: [{ id: 'public', build: '200' }, { id: 'legacy41', build: '50' }] });
  const check = (s: object, v: VersionsResponse) => pzCheckUpdate(ctx({ extras: { versions: async () => v } }), { ...PZ_LAUNCH_DEFAULTS, ...s });

  it('compares the installed build with the pinned branch', async () => {
    expect(await check({ branch: 'public' }, versions({ version: null, channel: 'public', build: '100' }))).toEqual({ available: true, current: '100', latest: '200', channel: 'public' });
    expect(await check({ branch: 'public' }, versions({ version: null, channel: 'public', build: '200' }))).toMatchObject({ available: false });
    // Another branch pinned: installing it is the update.
    expect(await check({ branch: 'legacy41' }, versions({ version: null, channel: 'public', build: '200' }))).toMatchObject({ available: true, latest: '50', channel: 'legacy41' });
    expect(await check({ branch: 'public' }, versions(null))).toMatchObject({ available: true, current: null });
  });

  it('says nothing for an unknown branch', async () => {
    expect(await check({ branch: 'nope' }, versions(null))).toBeNull();
  });
});

describe('Steam Workshop source', () => {
  function fakeSteam() {
    const calls: string[] = [];
    const doFetch = (async (url: string, init: { body: URLSearchParams }) => {
      const ids = [...init.body.entries()].filter(([k]) => k.startsWith('publishedfileids')).map(([, v]) => v);
      calls.push(`${url.split('/').at(-3)}:${ids.join(',')}`);
      if (url.includes('GetCollectionDetails')) {
        return new Response(JSON.stringify({ response: { collectiondetails: [ids[0] === '9999999999' ? { result: 1, children: [{ publishedfileid: '2544353492', filetype: 0 }] } : { result: 9 }] } }));
      }
      return new Response(
        JSON.stringify({
          response: {
            publishedfiledetails: ids.map((id) =>
              id === '5555555555'
                ? { publishedfileid: id, result: 1, title: 'Skyrim mod', consumer_app_id: 72850, time_updated: 1, file_size: 10 }
                : { publishedfileid: id, result: 1, title: `Item ${id}`, consumer_app_id: 108600, time_updated: 1000, file_size: 10, hcontent_file: 'x', preview_url: 'http://insecure.example/x.jpg' },
            ),
          },
        }),
      );
    }) as unknown as typeof fetch;
    return { source: createWorkshopSource({ fetch: doFetch }), calls };
  }

  it('asks Steam for details and collections; other games are not ok', async () => {
    const { source, calls } = fakeSteam();
    expect(source.parseRef('https://steamcommunity.com/sharedfiles/filedetails/?id=2544353492')).toBe('2544353492');
    expect(source.parseRef('https://evil.example/?id=1')).toBeNull();
    expect(await source.expand!('9999999999')).toEqual(['2544353492']);
    expect(await source.expand!('2544353492')).toEqual([]);
    const d = await source.details(['2544353492', '5555555555']);
    expect(d.map((x) => [x.id, x.ok])).toEqual([
      ['2544353492', true],
      ['5555555555', false],
    ]);
    // Only https thumbnails (the panel's CSP allows Steam's image hosts).
    expect(d[0]!.previewUrl).toBeNull();
    expect(calls[0]).toBe('GetCollectionDetails:9999999999');
  });

  it("downloads through the agent's steamcmd action, 100 items at a time", async () => {
    const { source } = fakeSteam();
    const c = ctx({ action: () => ({ ok: true }) });
    const ids = Array.from({ length: 230 }, (_, i) => String(1_000_000 + i));
    expect(await source.download(c, ids)).toEqual({ ok: true });
    expect(c.actions.map((a) => [a.name, (a.input as { ids: string[] }).ids.length])).toEqual([
      [WORKSHOP_DOWNLOAD, 100],
      [WORKSHOP_DOWNLOAD, 100],
      [WORKSHOP_DOWNLOAD, 30],
    ]);
    expect(await source.download(ctx({ action: () => ({ ok: false, error: 'steamcmd failed' }) }), ['1234567'])).toEqual({ ok: false, error: 'steamcmd failed' });
    expect(await source.download(ctx({ action: () => 'garbage' }), ['1234567'])).toMatchObject({ ok: false });
    expect(await source.download(c, ['12;34'])).toMatchObject({ ok: false });
  });

  it('scans the real B42 mod folders wherever the item was downloaded', async () => {
    const { source } = fakeSteam();
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'gsp-pz-scan-'));
    onTestFinished(() => rmSync(tmp, { recursive: true, force: true }));
    const cache = path.join(tmp, 'data', '.workshop', 'steamapps', 'workshop', 'content', '108600');
    const serverDownloads = path.join(tmp, 'install', 'steamapps', 'workshop', 'content', '108600');
    mkdirSync(cache, { recursive: true });
    mkdirSync(serverDownloads, { recursive: true });
    cpSync(path.join(fixtures, '2503622437'), path.join(cache, '2503622437'), { recursive: true });
    cpSync(path.join(fixtures, '2725378876'), path.join(serverDownloads, '2725378876'), { recursive: true });
    const c = ctx({ files: folderFiles({ data: path.join(tmp, 'data'), install: path.join(tmp, 'install') }) });

    const srj = (await source.scan(c, '2503622437', '42.20.4'))!;
    expect(srj).toEqual([
      expect.objectContaining({
        modId: 'SkillRecoveryJournal',
        folder: 'Skill Recovery Journal',
        versionFolder: '42.20.1',
        require: ['ChuckleberryFinnAlertSystem', 'errorMagnifier'],
        compatible: true,
        maps: [],
      }),
    ]);
    // On an older build the game loads an older folder.
    expect(await source.scan(c, '2503622437', '42.19.2')).toEqual([expect.objectContaining({ versionFolder: '42.19' })]);
    // Found in the server's own downloads; B41-only.
    expect(await source.scan(c, '2725378876', '')).toEqual([expect.objectContaining({ modId: 'TheyKnew', compatible: false, reason: 'no-matching-folder' })]);
    expect(await source.scan(c, '2946364542', '42.20.4')).toBeNull();
    expect(await source.scan(c, '../../etc', '42.20.4')).toBeNull();
  });

  it('writes the enabled list as the B42 ini lines, map mods before the vanilla map, and reads them back', () => {
    const { source } = fakeSteam();
    const mod = (modId: string, maps: string[] = []): PzMod => ({ modId, name: modId, require: [], incompatible: [], compatible: true, reason: null, folder: modId, versionFolder: '42', versionMin: null, maps });
    const entries = new Map([
      ['SearchContainers', mod('SearchContainers', ['Raven Creek'])],
      ['P4HasBeenRead', mod('P4HasBeenRead')],
    ]);
    const out = source.toConfig(
      [
        { modId: 'SearchContainers', itemId: '2946364542' },
        { modId: 'P4HasBeenRead', itemId: '2544353492' },
      ],
      entries,
    );
    expect(out).toEqual({ fileId: 'ini', values: { Mods: '\\SearchContainers;\\P4HasBeenRead', WorkshopItems: '2946364542;2544353492', Map: 'Raven Creek;Muldraugh, KY' } });
    expect(source.fromConfig!(out.values)).toEqual({ items: ['2946364542', '2544353492'], enabled: ['SearchContainers', 'P4HasBeenRead'] });
  });

  it("is the adapter's only mod source", () => {
    expect(pzPanelAdapter.mods?.map((m) => m.id)).toEqual(['steam-workshop']);
  });
});

describe('the install a launch wants (HST-09, D12)', () => {
  it('names the Steam branch; the build is the newest an install job finds', () => {
    const wanted = pzPanelAdapter.install!.wanted;
    expect(wanted({ ...PZ_LAUNCH_DEFAULTS }, SRV)).toEqual({ flavour: null, version: null, build: null, branch: 'public', channel: null });
    expect(wanted({ ...PZ_LAUNCH_DEFAULTS, branch: 'unstable', memoryMb: 4096, updateOnStart: false }, SRV)).toEqual({ flavour: null, version: null, build: null, branch: 'unstable', channel: null });
    // Settings the server can't run with want nothing.
    expect(() => wanted({ ...PZ_LAUNCH_DEFAULTS, branch: 'no spaces' }, SRV)).toThrow(/branch/);
  });
});
