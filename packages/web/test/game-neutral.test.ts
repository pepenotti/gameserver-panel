/// <reference types="node" />
// The web is game-neutral (M1, NFR-08): what one game calls things comes from
// its adapter through GET /api/meta, never from the web's own code or strings.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS without type declarations (its JSDoc types it); the core's own check (scripts/core-agnostic.test.ts) uses it too.
import { findGameTokens } from '../../../scripts/lib/core-agnostic.mjs';
import { CAPABILITIES, capabilityKey, forFlavour, hasCapability, impliedBy, MOD_CAPABILITIES, NEED_MODS, NEED_RESETS, preferredChoice, supports, type LaunchOption, type Meta } from '../src/api/meta';
import { en } from '../src/i18n/en';

const web = path.resolve(import.meta.dirname, '..');
const packages = path.resolve(web, '..');

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(f) ? [p] : [];
  });
}

/**
 * Project Zomboid words and numbers: its name, files, console command, map,
 * Steam app ids, branch and build, and what its settings forms used to be
 * grouped by here (zombie options, safehouses, spawn files, ini keys) before
 * the adapter declared its own groups. Case-insensitive (`b42` counts),
 * except `servermsg`: `ServerMsg` is a generic name (the panel's websocket
 * messages).
 */
const PZ_ONLY: [string, RegExp][] = [
  ['Zomboid', /zomboid/i],
  ['SandboxVars', /sandboxvars/i],
  ['servermsg', /servermsg/],
  ['Muldraugh', /muldraugh/i],
  ['380870', /380870/],
  ['108600', /108600/],
  ['checkModsNeedUpdate', /checkmodsneedupdate/i],
  ['legacy41', /legacy41/i],
  ['B42', /b42/i],
  ['zombie', /zombi/i],
  ['safehouse', /safehouse/i],
  ['spawn files', /spawn(regions|points)/i],
  ['MultiplierConfig', /multiplierconfig/i],
  ['PublicName', /publicname/i],
];

function hits(text: string): string[] {
  return PZ_ONLY.filter(([, re]) => re.test(text)).map(([token]) => token);
}

describe('game-neutral web', () => {
  it('finds the tokens it looks for', () => {
    expect(hits('Welcome to Muldraugh')).toEqual(['Muldraugh']);
    expect(hits('Build 42 (b42)')).toEqual(['B42']);
    expect(hits("{ 'not-b42': 'x' }")).toEqual(['B42']);
    expect(hits('type ServerMsg = …; send `servermsg "hi"`')).toEqual(['servermsg']);
    expect(hits('server name zomboid')).toEqual(['Zomboid']);
    expect(hits("{ ZombieLore: 'Población zombi' }")).toEqual(['zombie']);
    expect(hits("['safehouses', (k) => /^(PlayerSafehouse)/]")).toEqual(['safehouse']);
  });

  it('names options, groups, files and access levels from the adapter, not from its own strings', () => {
    // What M1 translated here until the contract carried it (M2): gone for good.
    const config = en.config as Record<string, unknown>;
    for (const fallback of ['groups', 'sandboxGroups', 'files', 'worldHelp', 'managedHelp']) expect(config[fallback], `config.${fallback}`).toBeUndefined();
    expect(Object.keys(en.config.tabs).sort()).toEqual(['files', 'history']);
    expect((en.server as Record<string, unknown>).fields).toBeUndefined();
    expect((en.players as Record<string, unknown>).levels).toBeUndefined();
    // No page keys a translation by an adapter's option, file or schema id.
    const dynamic: string[] = [];
    for (const f of files(path.join(web, 'src'), /\.tsx?$/)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\bt\(\s*`(config\.(tabs|files|groups)|server\.fields|players\.levels)\./g)) dynamic.push(`${path.relative(web, f)}: ${m[1]}`);
    }
    expect(dynamic).toEqual([]);
  });

  it('has no Project Zomboid words or values in its code, strings or page', () => {
    const found: string[] = [];
    for (const f of [...files(path.join(web, 'src'), /\.(tsx?|css|json)$/), path.join(web, 'index.html')]) {
      for (const [i, line] of readFileSync(f, 'utf8').split('\n').entries()) {
        for (const token of hits(line)) found.push(`${path.relative(web, f)}:${i + 1}: ${token}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('has no Minecraft words or values either: loaders, channels, files, commands and links come from its adapter (M3)', () => {
    // `Paper` alone is also a layout component here, so PaperMC's own names stand for it.
    const MC_ONLY: [string, RegExp][] = [
      ['Minecraft', /minecraft/i],
      ['Mojang', /mojang/i],
      ['PaperMC', /papermc|paperclip/i],
      ['Fabric', /\bfabric/i],
      ['bStats', /bstats/i],
      ['server.properties', /server\.properties/],
      ['its lists', /(whitelist|ops|banned-players|banned-ips|usercache)\.json/],
      ['a console command', /\b(save-all|save-off|save-on|deop|pardon-ip|ban-ip)\b/],
      ['a build channel', /\b(STABLE|BETA|ALPHA)\b/],
      ['its EULA link', /aka\.ms/],
    ];
    const found: string[] = [];
    for (const f of [...files(path.join(web, 'src'), /\.(tsx?|css|json)$/), path.join(web, 'index.html')]) {
      const text = readFileSync(f, 'utf8');
      for (const [i, line] of text.split('\n').entries()) for (const [token, re] of MC_ONLY) if (re.test(line)) found.push(`${path.relative(web, f)}:${i + 1}: ${token}`);
      // Every game's tokens the core is held to (scripts/lib/core-agnostic.mjs).
      for (const h of findGameTokens(text)) found.push(`${path.relative(web, f)}:${h.line}: ${h.token}`);
    }
    expect(found).toEqual([]);
  });

  it('names the product, not a game', () => {
    expect(en.app.title).toBe('Game Server Panel');
    expect(readFileSync(path.join(web, 'index.html'), 'utf8')).toContain('<title>Game Server Panel</title>');
  });
});

describe('capabilities', () => {
  it('mirror the adapter contract', () => {
    const src = readFileSync(path.join(packages, 'adapter-api', 'src', 'index.ts'), 'utf8');
    const union = /export type Capability =([^;]+);/.exec(src)?.[1] ?? '';
    const contract = [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(contract.length).toBeGreaterThan(10);
    expect([...CAPABILITIES]).toEqual(contract);
  });

  it('each has a name for "X does not support …"', () => {
    const names = en.capabilities as Record<string, string>;
    for (const c of CAPABILITIES) expect(names[capabilityKey(c).slice('capabilities.'.length)], c).toBeTruthy();
    expect(capabilityKey('mods:workshop')).toBe('capabilities.modsWorkshop');
  });

  const meta = (over: Partial<Meta> = {}): Meta => ({
    adapter: { id: 'x', name: { en: 'X', es: 'X' }, runtime: 'native', memory: { minMb: 1, defaultMb: 1, overheadMb: 0 }, capabilities: [] },
    server: { gameName: 'x', flavour: null },
    capabilities: ['players', 'kick'],
    launch: { schema: [] },
    backupParts: [],
    resets: [],
    accessLevels: [],
    modSources: [],
    consoleCatalog: [],
    ...over,
  });

  it('decide what a page needs', () => {
    const m = meta();
    expect(hasCapability(m, 'kick')).toBe(true);
    expect(hasCapability(m, 'ban')).toBe(false);
    expect(hasCapability(m, ['ban', 'players'])).toBe(true);
    expect(supports(m, {})).toBe(true);
    expect(supports(m, NEED_MODS)).toBe(false);
    expect(supports(m, NEED_RESETS)).toBe(false);
    const modded = meta({ capabilities: ['mods:modrinth'], modSources: [{ id: 'm', capability: 'mods:modrinth', label: { en: 'M', es: 'M' } }] });
    expect(supports(modded, NEED_MODS)).toBe(true);
    expect(MOD_CAPABILITIES).toEqual(['mods:workshop', 'mods:modrinth', 'mods:tshock']);
    expect(supports(meta({ resets: [{ id: 'w', label: { en: 'W', es: 'W' }, permission: 'reset.world', removeParts: [] }] }), NEED_RESETS)).toBe(true);
  });
});

describe('launch choices from an adapter (UPD-02, Q13)', () => {
  const schema: LaunchOption[] = [
    { key: 'version', type: 'string', role: 'version', description: {} },
    { key: 'channel', type: 'enum', flavours: ['b'], default: 'SAFE', options: [{ value: 'SAFE', label: {} }, { value: 'EARLY', label: {} }], description: {} },
  ];
  const versions = [
    { value: '3', warning: 'early-only', implies: { channel: 'EARLY' } },
    { value: '2' },
    { value: '1' },
  ];

  it('shows a flavour its own settings only', () => {
    expect(forFlavour(schema[0]!, 'a')).toBe(true);
    expect(forFlavour(schema[1]!, 'a')).toBe(false);
    expect(forFlavour(schema[1]!, 'b')).toBe(true);
    expect(forFlavour(schema[1]!, null)).toBe(false);
  });

  it('starts on the newest version that needs no warning, else the newest', () => {
    expect(preferredChoice(versions)?.value).toBe('2');
    expect(preferredChoice([versions[0]!])?.value).toBe('3');
    expect(preferredChoice([])).toBeUndefined();
    expect(preferredChoice(undefined)).toBeUndefined();
  });

  it('brings along what a pick implies, and puts back what another pick needed', () => {
    expect(impliedBy(versions[0]!, versions, schema)).toEqual({ channel: 'EARLY' });
    expect(impliedBy(versions[1]!, versions, schema)).toEqual({ channel: 'SAFE' });
    // A list whose picks imply nothing changes nothing.
    expect(impliedBy({ value: 'x' }, [{ value: 'x' }], schema)).toEqual({});
  });
});

describe('alerts', () => {
  it('every agent alert kind has a title', () => {
    // Without comments: they may hold a `;` or a quoted word.
    const src = readFileSync(path.join(packages, 'shared', 'src', 'agent-api.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const kinds = [...(/export type AlertKind =([^;]+);/.exec(src)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(kinds).toContain('crash');
    expect(kinds).toContain('blocking-prompt');
    const titles = en.alerts as Record<string, string>;
    for (const k of kinds) expect(titles[k], k).toBeTruthy();
  });
});
