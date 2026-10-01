// Avorion, from its manifest alone, passes the adapter contract suites (D4,
// NFR-07, M6): the runtime half with the boots captured from Avorion 2.5.13
// (D5), the panel half with the files the real server wrote. The live runs
// against tools/fake-avorion, through the agent's own plumbing, are in
// packages/agent/test/runtime-contract.test.ts; the whole path through the
// panel and the fake orchestrator in packages/panel/test/avorion-e2e.test.ts.
import { describe, expect, it } from 'vitest';
import { panelAdapterConfigSuite } from '@gsp/adapter-api/testing/panel-suite-config';
import { panelAdapterCoreSuite } from '@gsp/adapter-api/testing/panel-suite-core';
import { runtimeAdapterSuite } from '@gsp/adapter-api/testing/runtime-suite';
import { manifestAdapter } from '../src';
import { AVORION, manifestMeta } from '../src/shared';
import { avorionLaunch, fixture, fixtureLines } from './helpers';

const { runtime, panel } = manifestAdapter(AVORION);

runtimeAdapterSuite(runtime, {
  validLaunch: avorionLaunch,
  captured: {
    boot: fixtureLines('logs', 'first-boot-console-then-stop.log'),
    bootVersion: '2.5.13',
    fatal: [fixtureLines('logs', 'fail-ports-in-use.log').find((l) => l.startsWith('Server startup FAILED'))!, fixtureLines('logs', 'fail-wrong-working-directory.log').find((l) => l.startsWith('An exception occurred'))!],
  },
});

const server = () => ({ id: 'gal', gameName: 'gal', flavour: null });
panelAdapterCoreSuite(panel, { server, secrets: () => ({}) });
panelAdapterConfigSuite(panel, {
  server,
  // What the real server wrote in its galaxy folder (fixtures/avorion/2.5.13/config).
  files: () => ({
    'data/gal/server.ini': fixture('config', 'server.ini.after-later-runs'),
    'data/gal/admin.xml': fixture('config', 'admin.xml.after-first-boot'),
    'data/gal/blacklist.txt': '',
    'data/gal/ipblacklist.txt': '',
    'data/gal/whitelist.txt': '',
    'data/gal/group-whitelist.txt': '',
  }),
});

describe('Avorion from its manifest (M6, D4, PRD §7)', () => {
  it('is one adapter, avorion, of the steam image on x86-64, sharing one meta (HST-05)', () => {
    expect(runtime.meta).toBe(panel.meta);
    expect(runtime.meta).toBe(manifestMeta(AVORION));
    expect(runtime.meta).toMatchObject({ id: 'avorion', name: { en: 'Avorion', es: 'Avorion' }, runtime: 'steam', arch: ['amd64'], flavours: [], memory: { minMb: 512, defaultMb: 2048, overheadMb: 256 }, stopBudgetMs: 30_000 });
    expect(runtime.meta.eula).toBeUndefined();
  });

  it('publishes the game port on UDP and TCP and both query ports, the same numbers inside and out', () => {
    expect(runtime.meta.ports.map((p) => [p.id, p.proto, p.default, p.publish, p.sameInsideOut, p.follows ?? null])).toEqual([
      ['game', 'udp', 27000, true, true, null],
      ['gametcp', 'tcp', 27000, true, true, { id: 'game', offset: 0 }],
      ['query', 'udp', 27003, true, true, null],
      ['steamquery', 'udp', 27020, true, true, null],
      ['steammaster', 'udp', 27021, false, false, null],
    ]);
  });

  it('supports what Avorion measured: a slash console, saves, running backups, players, kicks, bans, broadcasts, branches (PLY-01, PLY-03, BAK-02, UPD-02)', () => {
    expect(runtime.meta.capabilities).toEqual(['stdinConsole', 'broadcast', 'save', 'hotBackup', 'players', 'playerHistory', 'kick', 'ban', 'branches', 'updateCheck']);
  });

  it('says what people should know, each in docs/limitations.md (UX-04)', () => {
    expect(runtime.meta.notes!.map((n) => [n.id, n.doc])).toEqual([
      ['settings-stopped-only', 'limitations.md#avorion-a-steam-game-run-from-a-manifest'],
      ['players-unverified', 'limitations.md#avorion-a-steam-game-run-from-a-manifest'],
      ['ports-expected', 'limitations.md#avorion-a-steam-game-run-from-a-manifest'],
    ]);
  });
});
