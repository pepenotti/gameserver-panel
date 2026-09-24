import { describe, expect, it } from 'vitest';
import { flattenScalars, getPath, LuaDataError, luaNumber, luaString, parseLuaData, setLuaValues, validateLuaData } from '../src/lua-data';
import { fixture } from './fixtures';

const sandboxEn = fixture('config/SandboxVars.en.lua');
const sandboxEs = fixture('config/SandboxVars.es.lua');

describe('parseLuaData on real files', () => {
  it('reads SandboxVars with nested tables and comments', () => {
    const f = parseLuaData(sandboxEn);
    expect(f.form).toBe('assign');
    expect(f.name).toBe('SandboxVars');
    const zombies = getPath(f.table, 'Zombies')!;
    expect(zombies.value).toEqual({ type: 'number', value: 3, raw: '3' });
    expect(zombies.comments[0]).toBe('Changing this also sets the "Population Multiplier" in Advanced Zombie Options. Default = Normal');
    expect(zombies.comments).toContain('1 = Insane');
    expect(getPath(f.table, 'ZombieLore.Speed')!.value.type).toBe('number');
    expect(getPath(f.table, 'Map.AllowMiniMap')!.value).toEqual({ type: 'boolean', value: false });
    expect(getPath(f.table, 'WorldItemRemovalList')!.value).toMatchObject({ type: 'string', value: expect.stringContaining('Base.Hat') });
    expect(getPath(f.table, 'Nope.Nope')).toBeUndefined();
  });

  it('finds the same option paths in English and Spanish', () => {
    const en = flattenScalars(parseLuaData(sandboxEn).table).map((s) => s.path);
    const es = flattenScalars(parseLuaData(sandboxEs).table).map((s) => s.path);
    expect(en.length).toBe(270);
    expect(es).toEqual(en);
  });

  it('reads spawnregions and spawnpoints (function form, positional entries)', () => {
    const regions = parseLuaData(fixture('config/spawnregions.lua'));
    expect(regions).toMatchObject({ form: 'function', name: 'SpawnRegions' });
    expect(regions.table.fields).toHaveLength(4);
    const first = regions.table.fields[0]!;
    expect(first.key).toBeNull();
    expect(first.value.type === 'table' && getPath(first.value, 'name')!.value).toEqual({ type: 'string', value: 'Muldraugh, KY' });

    const points = parseLuaData(fixture('config/spawnpoints.lua'));
    expect(points.name).toBe('SpawnPoints');
    expect(getPath(points.table, 'unemployed')!.value.type).toBe('table');
  });

  it('reads the preset form', () => {
    const f = parseLuaData('return {\n    Version = 6,\n    Zombies = 4,\n    Basement = { SpawnFrequency = 4, },\n}\n');
    expect(f.form).toBe('return');
    expect(flattenScalars(f.table).map((s) => s.path)).toEqual(['Version', 'Zombies', 'Basement.SpawnFrequency']);
  });

  it('handles negative numbers, decimals, escapes and bracket keys', () => {
    const f = parseLuaData('T = { a = -1, b = 0.5, c = "q\\"x\\\\y\\n", ["d e"] = true, e = nil, f = 1e3, g = \'s\' }');
    const get = (k: string) => getPath(f.table, k)!.value;
    expect(get('a')).toEqual({ type: 'number', value: -1, raw: '-1' });
    expect(get('b')).toEqual({ type: 'number', value: 0.5, raw: '0.5' });
    expect(get('c')).toEqual({ type: 'string', value: 'q"x\\y\n' });
    expect(get('d e')).toEqual({ type: 'boolean', value: true });
    expect(get('e')).toEqual({ type: 'nil' });
    expect(get('f')).toMatchObject({ value: 1000 });
    expect(get('g')).toEqual({ type: 'string', value: 's' });
  });

  it('does not attach trailing comments to the next field', () => {
    const f = parseLuaData('T = {\n  a = 1, -- about a\n  b = 2,\n  -- about c\n  c = 3,\n}');
    expect(getPath(f.table, 'b')!.comments).toEqual([]);
    expect(getPath(f.table, 'c')!.comments).toEqual(['about c']);
  });
});

describe('the data-only guarantee', () => {
  const rejects = {
    'a function call value': 'SandboxVars = { a = os.execute("rm -rf /") }',
    'require': 'SandboxVars = require "Sandbox/Apocalypse"',
    'code after the table': 'SandboxVars = { a = 1 }\ngetSandboxOptions():initSandboxVars()',
    'an identifier value': 'SandboxVars = { a = someGlobal }',
    'concatenation': 'SandboxVars = { a = "x" .. "y" }',
    'a method call statement': 'getSandboxOptions():initSandboxVars()',
    'a function with a body': 'function SpawnRegions() os.exit() return {} end',
    'two tables': 'return {} return {}',
    'a multi-line short string': 'T = { a = "x\ny" }',
    'an arithmetic value': 'T = { a = 1 + 2 }',
  };
  for (const [what, src] of Object.entries(rejects)) {
    it(`rejects ${what}`, () => {
      expect(() => validateLuaData(src)).toThrow(LuaDataError);
    });
  }

  it('reports the line of the problem', () => {
    try {
      validateLuaData('T = {\n  a = 1,\n  b = os.time(),\n}');
      expect.unreachable();
    } catch (e) {
      expect((e as LuaDataError).lineNumber).toBe(3);
    }
  });
});

describe('setLuaValues', () => {
  it('replaces only the edited values in the real file', () => {
    const out = setLuaValues(sandboxEn, { Zombies: 2, 'ZombieLore.Speed': 1, 'Map.AllowMiniMap': true, 'MultiplierConfig.Global': 2 });
    const f = parseLuaData(out);
    expect(getPath(f.table, 'Zombies')!.value).toMatchObject({ value: 2 });
    expect(getPath(f.table, 'ZombieLore.Speed')!.value).toMatchObject({ value: 1 });
    expect(getPath(f.table, 'Map.AllowMiniMap')!.value).toMatchObject({ value: true });
    // A decimal option keeps its decimal point so the file still reads as PZ writes it.
    expect(getPath(f.table, 'MultiplierConfig.Global')!.value).toMatchObject({ raw: '2.0' });
    const changed = out.split('\r\n').filter((l, i) => l !== sandboxEn.split('\r\n')[i]);
    expect(changed.map((l) => l.trim())).toEqual(['Zombies = 2,', 'AllowMiniMap = true,', 'Speed = 1,', 'Global = 2.0,']);
  });

  it('escapes strings so they cannot break out', () => {
    const out = setLuaValues('T = { s = "a" }', { s: 'x", evil = os.exit(), y = "' });
    expect(getPath(parseLuaData(out).table, 's')!.value).toEqual({ type: 'string', value: 'x", evil = os.exit(), y = "' });
    expect(parseLuaData(out).table.fields).toHaveLength(1);
  });

  it('refuses unknown paths and type changes', () => {
    expect(() => setLuaValues(sandboxEn, { NotAnOption: 1 })).toThrow(/Unknown option/);
    expect(() => setLuaValues(sandboxEn, { Zombies: 'lots' })).toThrow(/number/);
    expect(() => setLuaValues(sandboxEn, { 'Map.AllowMiniMap': 'yes' })).toThrow(/true or false/);
    expect(() => setLuaValues(sandboxEn, { Zombies: Infinity })).toThrow(/number/);
  });

  it('formats scalars the way PZ does', () => {
    expect(luaNumber(3)).toBe('3');
    expect(luaNumber(3, '1.0')).toBe('3.0');
    expect(luaNumber(0.25, '1.0')).toBe('0.25');
    expect(luaString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });
});
