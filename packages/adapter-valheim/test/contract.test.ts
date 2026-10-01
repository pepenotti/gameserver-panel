// Valheim, a Steam manifest plus hooks (M6, D4), passes the adapter
// contract suites: the runtime half with the boots captured from the
// dedicated server 1.0.16 (D5), the panel half with the list files the real
// server wrote. The live runs against tools/fake-valheim, through the
// agent's own plumbing, are in packages/agent/test/runtime-contract.test.ts;
// the whole path through the panel and the fake orchestrator in
// packages/panel/test/valheim-e2e.test.ts.
import { describe, expect, it } from 'vitest';
import { panelAdapterConfigSuite } from '@gsp/adapter-api/testing/panel-suite-config';
import { panelAdapterCoreSuite } from '@gsp/adapter-api/testing/panel-suite-core';
import { runtimeAdapterSuite } from '@gsp/adapter-api/testing/runtime-suite';
import { manifestMeta } from '@gsp/adapter-manifest/shared';
import { valheimPanelAdapter } from '../src/panel';
import { valheimRuntimeAdapter } from '../src/runtime';
import { VALHEIM, VALHEIM_META } from '../src/shared';
import { fixture, fixtureLines, valheimLaunch } from './helpers';

const fatalLine = (file: string, re: RegExp) => fixtureLines('logs', file).find((l) => re.test(l))!;

runtimeAdapterSuite(valheimRuntimeAdapter, {
  validLaunch: valheimLaunch,
  captured: {
    boot: fixtureLines('logs', 'first-boot-then-sigterm.log'),
    bootVersion: '1.0.16',
    fatal: [
      fatalLine('fail-password-too-short-public.log', /Error bad password/),
      fatalLine('fail-password-in-name.log', /Error bad password/),
      fatalLine('fail-query-port-in-use.log', /GameServer\.Init\(\) failed/),
      fatalLine('fail-corrupt-world.log', /World load failed/),
      fatalLine('never-ready-readonly-savedir.log', /^IOException: Read-only file system$/),
    ],
  },
});

const server = () => ({ id: 'vh', gameName: 'vh', flavour: null });
// A list of SteamIDs: moderation names players by SteamID (the anonymous one the scrubber uses).
panelAdapterCoreSuite(valheimPanelAdapter, { server, secrets: () => ({}), player: '76561198000000001' });
panelAdapterConfigSuite(valheimPanelAdapter, {
  server,
  // The three lists exactly as the real server's first boot wrote them (fixtures/valheim/1.0.16/files).
  files: () => ({
    'data/adminlist.txt': fixture('files', 'adminlist.txt'),
    'data/bannedlist.txt': fixture('files', 'bannedlist.txt'),
    'data/permittedlist.txt': fixture('files', 'permittedlist.txt'),
  }),
});

describe('Valheim, a manifest plus hooks (M6, D4, PRD §7)', () => {
  it('is one adapter, valheim, of the steam image on x86-64, sharing one meta (HST-05)', () => {
    expect(valheimRuntimeAdapter.meta).toBe(valheimPanelAdapter.meta);
    expect(valheimRuntimeAdapter.meta).toBe(VALHEIM_META);
    expect(VALHEIM_META).toBe(manifestMeta(VALHEIM));
    expect(VALHEIM_META).toMatchObject({ id: 'valheim', name: { en: 'Valheim', es: 'Valheim' }, runtime: 'steam', arch: ['amd64'], flavours: [], memory: { minMb: 2048, defaultMb: 3072, overheadMb: 256 }, stopBudgetMs: 60_000 });
    expect(VALHEIM_META.eula).toBeUndefined();
  });

  it('publishes UDP 2456 and the Steam query port that follows it at +1, the same numbers inside and out (SRV-01)', () => {
    expect(VALHEIM_META.ports.map((p) => [p.id, p.proto, p.default, p.publish, p.sameInsideOut, p.follows ?? null])).toEqual([
      ['game', 'udp', 2456, true, true, null],
      ['query', 'udp', 2457, true, true, { id: 'game', offset: 1 }],
    ]);
  });

  it('supports what Valheim measured: no console, running backups, players, bans, allowed players and admins by list, branches (PLY-01, PLY-03, BAK-02, UPD-02)', () => {
    expect(VALHEIM_META.capabilities).toEqual(['hotBackup', 'players', 'playerHistory', 'ban', 'whitelist', 'accessLevels', 'branches', 'updateCheck']);
    expect(valheimRuntimeAdapter.save).toBeUndefined();
    expect(valheimPanelAdapter.messages.broadcast).toBeUndefined();
    expect(valheimPanelAdapter.consoleCatalog).toBeUndefined();
  });

  it('says what people should know, each in docs/limitations.md (UX-04)', () => {
    expect(VALHEIM_META.notes!.map((n) => [n.id, n.doc])).toEqual(
      ['no-console', 'running-backups', 'lists', 'public-list', 'crossplay', 'players-count', 'resources'].map((id) => [id, 'limitations.md#valheim']),
    );
    const text = (id: string) => VALHEIM_META.notes!.find((n) => n.id === id)!.text;
    // Q14: crossplay says what it shares; Q15: what a listed server needs.
    expect(text('crossplay').en).toMatch(/public address with Microsoft's PlayFab.*log/);
    expect(text('crossplay').es).toMatch(/dirección pública .* PlayFab de Microsoft/);
    expect(text('public-list').en).toMatch(/at least 5 characters that isn't part of its name/);
    // Docker Desktop hides players' addresses; bans by SteamID don't care.
    expect(text('lists').en).toMatch(/SteamID.*Docker Desktop/);
  });
});
