// The Terraria adapter passes the contract suites (D4, NFR-07): the runtime
// half (M5 phase 2) with the boots captured from each flavour (D5); the
// panel half is still the skeleton phase 3 fills in. The live runs against
// the fake server, through the agent's own plumbing, are in
// packages/agent/test/runtime-contract.test.ts.
import { describe, expect, it } from 'vitest';
import { panelAdapterConfigSuite } from '@gsp/adapter-api/testing/panel-suite-config';
import { panelAdapterCoreSuite } from '@gsp/adapter-api/testing/panel-suite-core';
import { runtimeAdapterSuite } from '@gsp/adapter-api/testing/runtime-suite';
import { terrariaPanelAdapter } from '../src/panel';
import { terrariaRuntimeAdapter } from '../src/runtime';
import { TERRARIA_META } from '../src/shared';
import { fixtureLines } from './helpers';

const server = () => ({ id: 'tr', gameName: 'tr', flavour: 'vanilla' });

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

panelAdapterCoreSuite(terrariaPanelAdapter, { server, secrets: () => ({}) });
// No config files are declared yet (phase 3), so the checks that need one are left out.
panelAdapterConfigSuite(terrariaPanelAdapter);

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

  it("declares what the runtime half implements; the panel half's come with phase 3", () => {
    expect(TERRARIA_META.capabilities).toEqual(['stdinConsole', 'save', 'hotBackup', 'players', 'playerHistory', 'versionPin', 'worldCreate']);
    expect(terrariaRuntimeAdapter.channel(undefined as never, undefined as never)).toEqual({ kind: 'stdin' });
    expect(Object.keys(terrariaRuntimeAdapter.actions ?? {})).toEqual(['tshock-players', 'tshock-kick', 'tshock-ban', 'tshock-unban', 'tshock-bans', 'tshock-broadcast']);
  });
});
