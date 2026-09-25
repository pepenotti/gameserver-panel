import { describe, expect, it } from 'vitest';
import { memoryServerFiles, panelAdapterConfigSuite } from '@gsp/adapter-api/testing/panel-suite-config';
import type { ServerCtx } from '@gsp/adapter-api';
import { pzPanelAdapter } from '../src/panel';
import { pzPanelConfig } from '../src/panel/config';
import { fixture } from './fixtures';

const server = () => ({ id: 'test', gameName: 'zomboid', flavour: null });
const sandbox = fixture('config/SandboxVars.en.lua');
// A preset is the same table in the `return { … }` form (media/lua/shared/Sandbox/<name>.lua).
const preset = sandbox.replace(/^SandboxVars = /, 'return ');

const captured = () => ({
  'data/Server/zomboid.ini': fixture('config/server.en.ini'),
  'data/Server/zomboid_SandboxVars.lua': sandbox,
  'data/Server/zomboid_spawnregions.lua': fixture('config/spawnregions.lua'),
  'data/Server/zomboid_spawnpoints.lua': fixture('config/spawnpoints.lua'),
  'install/media/lua/shared/Sandbox/Apocalypse.lua': preset,
  'install/media/lua/shared/Sandbox/Survivor.lua': preset.replace('Zombies = 3,', 'Zombies = 5,'),
  'install/media/lua/shared/Sandbox/SandboxVars.lua': sandbox,
  'install/media/lua/shared/Sandbox/notes.txt': 'not a preset',
});

panelAdapterConfigSuite(pzPanelAdapter, { server, files: captured });

function ctx(over: Partial<ServerCtx> = {}): ServerCtx {
  const no = async (): Promise<never> => {
    throw new Error('not used by config files');
  };
  return {
    srv: server(),
    files: memoryServerFiles(captured()),
    actor: null,
    status: () => null,
    command: async () => ({ via: 'rcon', output: '' }),
    action: async () => null,
    versions: no,
    launchSettings: () => pzPanelAdapter.launch.defaults(),
    config: { set: no, seedIfMissing: no, applyPreset: no },
    onLog: () => () => undefined,
    ...over,
  };
}

describe('Project Zomboid config files', () => {
  it('declares the ini, SandboxVars and spawn files under Server/<name>', () => {
    const files = pzPanelConfig.files({ id: 'x', gameName: 'pz2', flavour: null });
    expect(files.every((f) => f.label?.en && f.label.es)).toBe(true);
    expect(pzPanelConfig.presets?.fileId).toBe('sandbox');
    expect(files.map((f) => [f.id, f.rel, f.format])).toEqual([
      ['ini', 'Server/pz2.ini', 'ini'],
      ['sandbox', 'Server/pz2_SandboxVars.lua', 'lua-data'],
      ['spawnregions', 'Server/pz2_spawnregions.lua', 'lua-data'],
      ['spawnpoints', 'Server/pz2_spawnpoints.lua', 'lua-data'],
    ]);
    const ini = files[0]!;
    expect(ini.managedKeys).toEqual(expect.arrayContaining(['RCONPassword', 'DefaultPort', 'UDPPort', 'UPnP', 'Mods', 'WorkshopItems', 'Map']));
    expect(ini.secretKeys).toEqual(['RCONPassword', 'Password', 'DiscordToken']);
    expect(ini.restartKeys).toContain('PublicName');
    expect(ini.seed).toEqual({ SaveWorldEveryMinutes: '10' });
  });

  it('locks the sandbox file’s VERSION, the file format’s and not a setting (CFG-04, CFG-01)', () => {
    const sandbox = pzPanelConfig.files(server()).find((f) => f.id === 'sandbox')!;
    expect(sandbox.managedKeys).toEqual(['VERSION']);
    // The game writes it: nothing the panel sets, so a raw save keeps what is on disk.
    expect(pzPanelConfig.managedValues(server()).sandbox).toBeUndefined();
    // The form shows it locked, behind Advanced, described as what it is in both languages.
    const meta = pzPanelConfig.schemas.sandbox!.find((o) => o.key === 'VERSION')!;
    expect(meta).toMatchObject({ type: 'integer', advanced: true, group: 'general' });
    expect(meta.label?.en && meta.label.es && meta.description.en && meta.description.es).toBeTruthy();
    // Only VERSION changed: every other sandbox option is as the game's files describe it.
    expect(pzPanelConfig.schemas.sandbox!.filter((o) => o.key !== 'VERSION').every((o) => o.advanced === undefined && o.label === undefined)).toBe(true);
  });

  it('lets the editor browse only this server’s files and mod settings', () => {
    const [serverFolder, mods] = pzPanelConfig.roots(server());
    expect(serverFolder).toMatchObject({ root: 'data', rel: 'Server', include: ['zomboid.ini', 'zomboid_*'] });
    expect(mods).toMatchObject({ root: 'data', rel: 'Lua' });
  });

  it('pins UPnP off and leaves the agent’s ports and RCON password as they are on disk', () => {
    expect(pzPanelConfig.managedValues(server())).toEqual({ ini: { UPnP: 'false' } });
  });

  it('reloads a running server’s ini and reports what the game rejected', async () => {
    const commands: string[] = [];
    let listener: ((line: string) => void) | null = null;
    const c = ctx({
      command: async (cmd) => {
        commands.push(cmd.command);
        // What 42.20.4 logs for values it can't take.
        listener?.('LOG  : General      f:0 st:1> ERROR IntegerConfigOption.parse() "ChatMessageSlowModeTime" string="abc"');
        listener?.('LOG  : General      f:0 st:1> ERROR: DoubleConfigOption.setValue() "VoiceMaxDistance" value 900 is out of range');
        listener?.('LOG  : General      f:0 st:1> Options reloaded');
        return { via: 'rcon', output: '' };
      },
      onLog: (l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    });
    const r = await pzPanelConfig.afterWrite!(c, 'ini', ['PVP']);
    expect(commands).toEqual(['reloadoptions']);
    expect(r).toEqual({ applied: 'live', warnings: ['ChatMessageSlowModeTime: abc', 'VoiceMaxDistance: value 900 is out of range'] });
    expect(listener).toBeNull();
    expect(await pzPanelConfig.afterWrite!(c, 'sandbox', ['Zombies'])).toEqual({ applied: 'restart', warnings: [] });
    expect(commands).toEqual(['reloadoptions']);
  });

  it('lists the install’s sandbox presets and loads one without its VERSION', async () => {
    expect(await pzPanelConfig.presets!.list(ctx())).toEqual(['Apocalypse', 'Survivor']);
    const values = await pzPanelConfig.presets!.load(ctx(), 'Survivor');
    expect(values).toMatchObject({ Zombies: 5, 'ZombieLore.Speed': 4 });
    expect(values).not.toHaveProperty('VERSION');
    await expect(pzPanelConfig.presets!.load(ctx(), 'SandboxVars')).rejects.toThrow(/Unknown preset/);
  });
});
