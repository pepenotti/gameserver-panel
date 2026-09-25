import { describe, expect, it } from 'vitest';
import { setIniValues } from '../src/ini';
import { getPath, parseLuaData } from '../src/lua-data';
import { CONFIG_FORMATS, FORMAT_HIGHLIGHT, formatFor, formatIdForName, iniFormat, jsonFormat, luaDataFormat, textFormat, type ConfigFormat, type FormatId } from '../src/registry';
import { fixture } from './fixtures';

const en = fixture('config/server.en.ini');
const sandbox = fixture('config/SandboxVars.en.lua');

function issues(f: ConfigFormat, text: string) {
  const r = f.parse(text);
  return r.ok ? [] : r.issues;
}

describe('format registry', () => {
  it('holds every format id, each with its highlighting (CFG-02, CFG-07)', () => {
    expect(Object.keys(CONFIG_FORMATS).sort()).toEqual(['ini', 'json', 'json5', 'lines', 'lua-data', 'properties', 'text', 'toml', 'yaml']);
    for (const [id, f] of Object.entries(CONFIG_FORMATS)) {
      expect(f.id).toBe(id);
      expect(f.highlight).toBe(FORMAT_HIGHLIGHT[id as FormatId]);
      // Every format says whether its edits keep comments (CFG-09); all of these do.
      expect(f.preservesComments, id).toBe(true);
    }
  });

  it('picks a format for a declaration or a file name', () => {
    expect(formatFor({ format: 'ini' })).toBe(iniFormat);
    expect(formatFor({ format: 'lua-data' })).toBe(luaDataFormat);
    expect(formatFor('Server/zomboid.ini')).toBe(iniFormat);
    expect(formatFor('config/plugin.JSON')).toBe(jsonFormat);
    expect(formatFor('notes.txt')).toBe(textFormat);
    expect(formatFor('README')).toBe(textFormat);
    expect(formatIdForName('ops.yml')).toBe('yaml');
    for (const [name, id] of [
      ['server.properties', 'properties'],
      ['plugins/x/config.yml', 'yaml'],
      ['config/mod.toml', 'toml'],
      ['config/mod.json5', 'json5'],
    ] as const) {
      expect(formatIdForName(name), name).toBe(id);
      expect(formatFor(name)).toBe(CONFIG_FORMATS[id]);
    }
    expect(formatFor({ format: 'yaml' })).toBe(formatFor('x.yaml'));
    // Only a declaration makes a file a line list.
    expect(formatFor({ format: 'lines' }).id).toBe('lines');
  });

  it('edits names that suggest no format as text, highlighted when the name suggests one (CFG-07)', () => {
    for (const name of ['server.cfg', 'bukkit.conf']) {
      const f = formatFor(name);
      expect(formatIdForName(name)).toBe('text');
      expect(f.id).toBe('text');
      expect(f.highlight).toBe('properties');
      // Anything goes: these files are all kinds of things.
      expect(f.parse('exec x.cfg\n[Section]\nkey: \\u12')).toEqual({ ok: true, doc: 'exec x.cfg\n[Section]\nkey: \\u12' });
    }
    expect(formatFor('server.cfg')).toBe(formatFor('other.conf'));
  });
});

describe('ini format', () => {
  it('parses and flattens the real 42.20.4 file', () => {
    const r = iniFormat.parse(en);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flat = iniFormat.flatten(r.doc);
    expect(Object.keys(flat)).toHaveLength(144);
    expect(flat.PVP).toBe('true');
    expect(iniFormat.locate!(r.doc, 'PVP')).toEqual({ line: 2, col: 5 });
    expect(iniFormat.locate!(r.doc, 'Nope')).toBeNull();
  });

  it('reports lines that are not settings, comments or sections, with their line', () => {
    expect(issues(iniFormat, '# ok\nPVP=true\n\n[Section]\n; also ok\nMaxPlayers 16\nA=1\n')).toEqual([{ line: 6, col: 1, message: expect.stringMatching(/Key=Value/) }]);
  });

  it('edits like setIniValues, turning scalars into text', () => {
    expect(iniFormat.edit(en, { MaxPlayers: 8, PVP: false })).toBe(setIniValues(en, { MaxPlayers: '8', PVP: 'false' }));
  });

  it('removes a key with the comment above it and keeps everything else', () => {
    const text = '# first\nA=1\n\n# second\nB=2\n';
    expect(iniFormat.edit(text, { A: null })).toBe('\n# second\nB=2\n');
    expect(iniFormat.edit(text, { B: null, C: 'x' })).toBe('# first\nA=1\n\nC=x\n');
    expect(iniFormat.edit(text, { Missing: null })).toBe(text);
  });

  it('keeps the comments of the real file when a value changes (CFG-09)', () => {
    const out = iniFormat.edit(en, { PVP: false });
    const comments = (t: string) => t.split('\r\n').filter((l) => l.startsWith('#'));
    expect(comments(out)).toEqual(comments(en));
    expect(comments(out).length).toBeGreaterThan(100);
  });

  it('creates a minimal file', () => {
    expect(iniFormat.create!({ PublicName: 'Partial Test', MaxPlayers: 8 })).toBe('PublicName=Partial Test\nMaxPlayers=8\n');
  });
});

describe('lua-data format', () => {
  it('parses and flattens the real SandboxVars file', () => {
    const r = luaDataFormat.parse(sandbox);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flat = luaDataFormat.flatten(r.doc);
    expect(Object.keys(flat)).toHaveLength(270);
    expect(flat['ZombieLore.Speed']).toBe(4);
    expect(luaDataFormat.locate!(r.doc, 'ZombieLore.Speed')!.line).toBeGreaterThan(1);
    expect(luaDataFormat.checkShape!(r.doc, { form: 'assign', name: 'SandboxVars' })).toBeNull();
    expect(luaDataFormat.checkShape!(r.doc, { form: 'function', name: 'SpawnRegions' })!.message).toMatch(/function SpawnRegions\(\) return/);
  });

  it('refuses code with the line and column of the problem (CFG-02)', () => {
    expect(issues(luaDataFormat, 'SandboxVars = {\n  Zombies = 3,\n  Speed = getWorld(),\n}')).toEqual([{ line: 3, col: 11, message: expect.stringMatching(/not a plain value/) }]);
    expect(issues(luaDataFormat, 'SandboxVars = { a = 1 }\nrequire "evil"')[0]).toMatchObject({ line: 2, message: expect.stringMatching(/Only one table/) });
  });

  it('edits values in place, keeping every comment of the real file (CFG-09)', () => {
    const out = luaDataFormat.edit(sandbox, { Zombies: 2, 'ZombieLore.Speed': 1 });
    const comments = (t: string) => t.split('\r\n').filter((l) => l.trim().startsWith('--'));
    expect(comments(out)).toEqual(comments(sandbox));
    const flat = luaDataFormat.flatten(parseLuaData(out));
    expect(flat).toMatchObject({ Zombies: 2, 'ZombieLore.Speed': 1 });
  });

  it('adds new keys inside their table, following its layout', () => {
    const src = 'T = {\r\n    a = 1, -- about a\r\n    Sub = {\r\n        x = true\r\n    },\r\n}\r\n';
    const out = luaDataFormat.edit(src, { b: 'two', 'Sub.y': 3, 'New.z': false });
    expect(out).toBe('T = {\r\n    a = 1, -- about a\r\n    Sub = {\r\n        x = true,\r\n        y = 3,\r\n    },\r\n    b = "two",\r\n    New = { z = false },\r\n}\r\n');
    expect(luaDataFormat.edit('return {}', { a: 1 })).toBe('return {\n    a = 1,\n}');
    expect(luaDataFormat.edit('T = { a = 1 }', { ['end']: 2 })).toBe('T = { a = 1, ["end"] = 2, }');
    expect(() => luaDataFormat.edit(src, { 'a.b': 1 })).toThrow(/a is not a table/);
  });

  it('removes a key with its comments and keeps the rest', () => {
    const src = 'T = {\n    -- about a\n    -- more\n    a = 1,\n    b = 2, -- about b\n    c = { d = 1, e = 2 },\n}\n';
    expect(luaDataFormat.edit(src, { a: null })).toBe('T = {\n    b = 2, -- about b\n    c = { d = 1, e = 2 },\n}\n');
    expect(luaDataFormat.edit(src, { b: null, 'c.d': null })).toBe('T = {\n    -- about a\n    -- more\n    a = 1,\n    c = { e = 2 },\n}\n');
    expect(luaDataFormat.edit(src, { missing: null })).toBe(src);
    expect(getPath(parseLuaData(luaDataFormat.edit(src, { c: null })).table, 'c')).toBeUndefined();
  });

  it('escapes new string values so they stay data', () => {
    const out = luaDataFormat.edit('T = {}', { s: '"; os.exit() --' });
    expect(luaDataFormat.flatten(parseLuaData(out))).toEqual({ s: '"; os.exit() --' });
  });
});

describe('json format', () => {
  const text = '{\n  "motd": "Hello",\n  "port": 7777,\n  "pvp": false,\n  "limits": {\n    "players": 8\n  },\n  "list": [1, 2]\n}\n';

  it('flattens nested objects to dotted keys and leaves lists to the text editor', () => {
    const r = jsonFormat.parse(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(jsonFormat.flatten(r.doc)).toEqual({ motd: 'Hello', port: 7777, pvp: false, 'limits.players': 8 });
    expect(jsonFormat.locate!(r.doc, 'limits.players')).toEqual({ line: 6, col: 16 });
  });

  it('reports syntax errors with line and column', () => {
    expect(issues(jsonFormat, '{\n  "a": 1,\n}')).toEqual([{ line: 3, col: 1, message: 'Trailing comma before "}"' }]);
    expect(issues(jsonFormat, '{\n  "a": 1\n  "b": 2\n}')).toEqual([{ line: 3, col: 3, message: 'Expected "," or "}"' }]);
    expect(issues(jsonFormat, '{"a": "x\ny"}')[0]).toMatchObject({ line: 1, col: 9 });
    expect(issues(jsonFormat, '// comment\n{}')[0]).toMatchObject({ line: 1, col: 1 });
    expect(issues(jsonFormat, '{} {}')[0]!.message).toMatch(/after the JSON value/);
    expect(issues(jsonFormat, '')[0]!.message).toMatch(/empty/);
  });

  it('parses what JSON.parse parses', () => {
    for (const s of ['0', '-1.5e3', '"\\u00f1\\n"', '[true, false, null]', '{"a": {"b": []}}', `${String.fromCharCode(0xfeff)}{"bom": 1}`]) {
      const r = jsonFormat.parse(s);
      expect(r.ok, s).toBe(true);
    }
  });

  it('edits values in place, keeping each value type and the layout', () => {
    const out = jsonFormat.edit(text, { port: '7778', pvp: 'true', motd: 'Hi "all"', 'limits.players': 16 });
    expect(out).toBe(text.replace('7777', '7778').replace('false', 'true').replace('"Hello"', '"Hi \\"all\\""').replace('8\n', '16\n'));
    expect(() => jsonFormat.edit(text, { port: 'many' })).toThrow(/expects a number/);
    expect(() => jsonFormat.edit(text, { limits: 1 })).toThrow(/an object/);
  });

  it('adds and removes keys', () => {
    const added = jsonFormat.edit(text, { 'limits.admins': 2, 'new.deep': 'x' });
    expect(added).toBe('{\n  "motd": "Hello",\n  "port": 7777,\n  "pvp": false,\n  "limits": {\n    "players": 8,\n    "admins": 2\n  },\n  "list": [1, 2],\n  "new": { "deep": "x" }\n}\n');
    expect(jsonFormat.edit(text, { motd: null })).toBe(text.replace('  "motd": "Hello",\n', ''));
    expect(jsonFormat.edit(text, { list: null })).toBe(text.replace(',\n  "list": [1, 2]', ''));
    expect(jsonFormat.edit('{"a": 1}', { a: null, b: true })).toBe('{ "b": true }');
    expect(jsonFormat.edit('{"a": 1}', { missing: null })).toBe('{"a": 1}');
  });

  it('creates a file from dotted values', () => {
    expect(jsonFormat.create!({ a: 1, 'b.c': 'x' })).toBe('{\n  "a": 1,\n  "b": {\n    "c": "x"\n  }\n}\n');
  });
});

describe('text format', () => {
  it('keeps the text as it is and has no keys', () => {
    const r = textFormat.parse('anything\r\ngoes');
    expect(r).toEqual({ ok: true, doc: 'anything\r\ngoes' });
    expect(textFormat.flatten('x')).toEqual({});
    expect(textFormat.edit('x', {})).toBe('x');
    expect(() => textFormat.edit('x', { a: 1 })).toThrow(/no keys/);
  });
});
