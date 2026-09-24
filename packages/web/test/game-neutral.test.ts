/// <reference types="node" />
// The web is game-neutral (M1, NFR-08): what one game calls things comes from
// its adapter through GET /api/meta, never from the web's own code or strings.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, capabilityKey, hasCapability, MOD_CAPABILITIES, NEED_MODS, NEED_RESETS, supports, type Meta } from '../src/api/meta';
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
 * Steam app ids, branch and build. Case-insensitive (`b42` counts), except
 * `servermsg`: `ServerMsg` is a generic name (the panel's websocket messages).
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
