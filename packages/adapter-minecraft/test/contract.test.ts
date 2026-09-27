// The Minecraft adapter passes the contract suites (D4, NFR-07): the runtime
// half with each loader's captured boot and failures (the agent's tests run
// it live against the fake), the panel half for each loader with the files
// the real servers wrote (fixtures/minecraft/26.3).
import { describe, expect, it } from 'vitest';
import { panelAdapterConfigSuite } from '@gsp/adapter-api/testing/panel-suite-config';
import { panelAdapterCoreSuite } from '@gsp/adapter-api/testing/panel-suite-core';
import { runtimeAdapterSuite } from '@gsp/adapter-api/testing/runtime-suite';
import { minecraftPanelAdapter } from '../src/panel';
import { minecraftRuntimeAdapter } from '../src/runtime';
import { MINECRAFT_META } from '../src/shared';
import { fixture, fixtureLines } from './helpers';

for (const loader of ['vanilla', 'paper', 'fabric'] as const) {
  describe(`captured ${loader} 26.3`, () => {
    runtimeAdapterSuite(minecraftRuntimeAdapter, {
      validLaunch: () => ({ version: '26.3', loader, memoryMb: 2048, ...(loader === 'paper' ? { channel: 'ALPHA' } : {}) }),
      captured: {
        boot: fixtureLines(loader, 'logs', 'first-boot.log'),
        bootVersion: '26.3',
        fatal: [
          ...fixtureLines(loader, 'logs', 'no-eula.log').filter((l) => /You need to agree to the EULA/.test(l)),
          ...(loader === 'vanilla' ? ['[19:40:18] [Server thread/WARN]: **** FAILED TO BIND TO PORT!', '[19:40:18] [Server thread/ERROR]: Encountered an unexpected exception', ...fixtureLines('vanilla', 'logs', 'bad-jar.log').filter(Boolean)] : []),
          ...(loader === 'fabric' ? fixtureLines('fabric', 'logs', 'installed-missing-game-jar.log').filter((l) => /^The Minecraft server \.JAR is missing/.test(l)) : []),
        ],
      },
    });
  });
}

/** A server's files as the loader's real server left them. */
function capturedFiles(loader: 'vanilla' | 'paper' | 'fabric'): Record<string, string> {
  const files: Record<string, string> = {
    'data/server.properties': fixture(loader, 'config', 'server.properties.after'),
    'data/eula.txt': fixture(loader, 'config', 'eula.txt.generated'),
  };
  for (const f of ['whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json', 'usercache.json']) files[`data/${f}`] = fixture(loader, 'files', f);
  if (loader === 'paper') {
    for (const f of ['bukkit.yml', 'spigot.yml', 'commands.yml', 'config/paper-global.yml', 'config/paper-world-defaults.yml', 'plugins/bStats/config.yml', 'world/dimensions/minecraft/overworld/paper-world.yml']) {
      files[`data/${f}`] = fixture('paper', 'data', ...f.split('/'));
    }
  }
  return files;
}

for (const loader of ['vanilla', 'paper', 'fabric'] as const) {
  describe(`panel half, ${loader}`, () => {
    const server = () => ({ id: 'mc', gameName: 'mc', flavour: loader });
    panelAdapterCoreSuite(minecraftPanelAdapter, { server, secrets: () => ({}) });
    panelAdapterConfigSuite(minecraftPanelAdapter, { server, files: () => capturedFiles(loader) });
  });
}

describe('the Minecraft adapter (D4, D6, UPD-06)', () => {
  it('shares one meta: the java runtime, x86-64 and ARM64, the loaders, the ports, and the EULA with its agreement', () => {
    expect(minecraftRuntimeAdapter.meta).toBe(MINECRAFT_META);
    expect(minecraftPanelAdapter.meta).toBe(MINECRAFT_META);
    expect(MINECRAFT_META).toMatchObject({ id: 'minecraft', runtime: 'java', arch: ['amd64', 'arm64'], memory: { minMb: 1024, defaultMb: 2048, overheadMb: 1024 }, stopBudgetMs: 120_000 });
    expect(MINECRAFT_META.flavours.map((f) => f.id)).toEqual(['vanilla', 'paper', 'fabric']);
    expect(MINECRAFT_META.ports).toEqual([
      expect.objectContaining({ id: 'game', proto: 'tcp', default: 25565, publish: true, sameInsideOut: false }),
      expect.objectContaining({ id: 'rcon', proto: 'tcp', default: 25575, publish: false, sameInsideOut: false }),
    ]);
    expect(MINECRAFT_META.eula?.url).toBe('https://aka.ms/MinecraftEULA');
  });

  it('declares what both halves implement: the runtime (phase 2) and the panel (phase 3); not liveReload', () => {
    expect(MINECRAFT_META.capabilities).toEqual([
      'rcon',
      'stdinConsole',
      'broadcast',
      'save',
      'hotBackup',
      'players',
      'playerHistory',
      'kick',
      'ban',
      'whitelist',
      'accessLevels',
      'settingsForms',
      'presets',
      'versionPin',
      'loaders',
      'updateCheck',
      'eula',
    ]);
  });
});
