// The Terraria adapter passes the contract suites (D4, NFR-07): the runtime
// half (M5 phase 2) with the boots captured from each flavour (D5); the
// panel half (phase 3) for each flavour, with the files the real servers
// wrote. The live runs against the fake server, through the agent's own
// plumbing, are in packages/agent/test/runtime-contract.test.ts.
import { describe, expect, it } from 'vitest';
import { panelAdapterConfigSuite } from '@gsp/adapter-api/testing/panel-suite-config';
import { panelAdapterCoreSuite } from '@gsp/adapter-api/testing/panel-suite-core';
import { runtimeAdapterSuite } from '@gsp/adapter-api/testing/runtime-suite';
import { terrariaPanelAdapter } from '../src/panel';
import { terrariaRuntimeAdapter } from '../src/runtime';
import { TERRARIA_META } from '../src/shared';
import { fixture, fixtureLines } from './helpers';

for (const [flavour, boot, version, prompt] of [
  ['vanilla', 'vanilla/logs/boot-savedirectory.log', '1.4.5.8', 'vanilla/logs/no-args-world-menu.log'],
  ['tshock', 'tshock/logs/first-boot.log', '1.4.5.8', undefined],
  ['tmodloader', 'tmodloader/logs/first-boot.log', '1.4.4.9', 'tmodloader/logs/no-world-menu.log'],
] as const) {
  describe(`captured ${flavour}`, () => {
    runtimeAdapterSuite(terrariaRuntimeAdapter, {
      validLaunch: () => ({ flavour, world: 'world', worldSize: 1, maxPlayers: 8, memoryMb: 2048 }),
      captured: {
        boot: fixtureLines(...boot.split('/')),
        bootVersion: version,
        ...(prompt ? { prompt: fixtureLines(...prompt.split('/')) } : {}),
        fatal: ['Load failed!  No backup found.', '[ERROR] FATAL UNHANDLED EXCEPTION: System.ObjectDisposedException: Cannot access a disposed object.', 'You must install .NET to run this application.'],
      },
    });
  });
}

/** What each flavour's first runs wrote (fixtures/terraria/1.4.5.8), by `<root>/<rel>`. */
const FILES: Record<string, () => Record<string, string>> = {
  vanilla: () => ({ 'data/serverconfig.txt': fixture('vanilla', 'files', 'serverconfig.txt'), 'data/banlist.txt': fixture('vanilla', 'files', 'banlist.txt') }),
  tshock: () => ({
    'data/tshock/config.json': fixture('tshock', 'config', 'config.json.generated'),
    'data/tshock/sscconfig.json': fixture('tshock', 'config', 'sscconfig.json.generated'),
    'data/tshock/motd.txt': fixture('tshock', 'config', 'motd.txt.generated'),
    'data/tshock/rules.txt': fixture('tshock', 'config', 'rules.txt.generated'),
    'data/tshock/whitelist.txt': fixture('tshock', 'config', 'whitelist.txt.generated'),
  }),
  tmodloader: () => ({ 'data/Mods/enabled.json': fixture('tmodloader', 'files', 'enabled.json') }),
};

for (const flavour of ['vanilla', 'tshock', 'tmodloader'] as const) {
  describe(`panel half, ${flavour}`, () => {
    const server = () => ({ id: 'tr', gameName: 'tr', flavour });
    panelAdapterCoreSuite(terrariaPanelAdapter, { server, secrets: () => ({}) });
    panelAdapterConfigSuite(terrariaPanelAdapter, { server, files: FILES[flavour] });
  });
}

describe('the Terraria adapter (D4, D5, PRD §7, §10)', () => {
  it('shares one meta: the native image, tModLoader in the steam one, x86-64, the game port published and the REST port not', () => {
    expect(terrariaRuntimeAdapter.meta).toBe(TERRARIA_META);
    expect(terrariaPanelAdapter.meta).toBe(TERRARIA_META);
    expect(TERRARIA_META).toMatchObject({ id: 'terraria', runtime: 'native', arch: ['amd64'], memory: { minMb: 1024, defaultMb: 2048, overheadMb: 256 }, stopBudgetMs: 60_000 });
    expect(TERRARIA_META.flavours.map((f) => [f.id, f.runtime ?? TERRARIA_META.runtime])).toEqual([
      ['vanilla', 'native'],
      ['tshock', 'native'],
      ['tmodloader', 'steam'],
    ]);
    expect(TERRARIA_META.ports.map((p) => [p.id, p.proto, p.default, p.publish])).toEqual([
      ['game', 'tcp', 7777, true],
      ['rest', 'tcp', 7878, false],
    ]);
    // No Terraria flavour has a license to accept (PRD §7).
    expect(TERRARIA_META.eula).toBeUndefined();
  });

  it('declares what both halves implement: the same for each flavour, plus TShock’s plugins and tModLoader’s Workshop mods (MOD-03, MOD-06)', () => {
    const caps = ['stdinConsole', 'broadcast', 'save', 'hotBackup', 'players', 'playerHistory', 'kick', 'ban', 'settingsForms', 'versionPin', 'updateCheck', 'worldCreate'];
    expect(TERRARIA_META.capabilities).toEqual(caps);
    expect(Object.fromEntries(TERRARIA_META.flavours.map((f) => [f.id, f.capabilities]))).toEqual({ vanilla: caps, tshock: [...caps, 'mods:tshock'], tmodloader: [...caps, 'mods:workshop'] });
    // One source each: the Workshop (the game's app id on it, not a dedicated server's) and TShock's plugin files.
    expect(terrariaPanelAdapter.mods?.map((m) => [m.id, m.capability, m.serverFetches])).toEqual([['steam-workshop', 'mods:workshop', false]]);
    expect(terrariaPanelAdapter.plugins?.map((m) => [m.id, m.capability, m.extensions])).toEqual([['tshock-plugins', 'mods:tshock', ['.dll']]]);
    // TShock's REST API is reached through the runtime's actions, not as a control channel.
    expect(TERRARIA_META.flavours.flatMap((f) => f.capabilities ?? [])).not.toContain('restApi');
    expect(terrariaRuntimeAdapter.channel(undefined as never, undefined as never)).toEqual({ kind: 'stdin' });
    expect(Object.keys(terrariaRuntimeAdapter.actions ?? {})).toEqual([
      'tshock-players',
      'tshock-kick',
      'tshock-ban',
      'tshock-unban',
      'tshock-bans',
      'tshock-broadcast',
      'tshock-plugins',
      'tshock-plugin-add',
      'tshock-plugin-set',
      'tshock-plugin-remove',
      'workshop-download',
    ]);
  });
});
