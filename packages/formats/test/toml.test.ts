// TOML (CFG-02, CFG-07, CFG-09): read by `smol-toml`, edited in place. The
// texts are written for these tests, in the shapes mod configs take.
import { describe, expect, it } from 'vitest';
import { tomlFormat } from '../src/registry';

const CONFIG = [
  '# Mod config',
  'title = "x" # trailing',
  'count = 3',
  '',
  '[server]',
  '# the port',
  'port = 25565',
  'ratio = 1.5',
  "path = 'C:\\no\\escapes'",
  'big = 9007199254740993',
  'when = 1979-05-27 07:32:00Z',
  'flag = true',
  '"quoted key" = "q"',
  'dotted.inner = 2',
  'inline = { x = 1 }',
  'arr = [',
  '  1, # one',
  '  2,',
  ']',
  'text = """',
  'a = not a key',
  '"""',
  'unknown-mod-key = "kept"',
  '',
  '[server.sub]',
  'deep = "d"',
  '',
  '[[bans]]',
  'name = "a"',
  '',
].join('\n');

function flat(text: string) {
  const r = tomlFormat.parse(text);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return tomlFormat.flatten(r.doc);
}

const comments = (t: string) => t.split('\n').filter((l) => l.includes('#'));

describe('toml format (CFG-02)', () => {
  it('flattens tables to dotted keys and leaves lists and arrays of tables to the text editor', () => {
    expect(flat(CONFIG)).toEqual({
      title: 'x',
      count: 3,
      'server.port': 25565,
      'server.ratio': 1.5,
      'server.path': 'C:\\no\\escapes',
      'server.big': '9007199254740993',
      'server.when': '1979-05-27T07:32:00.000Z',
      'server.flag': true,
      'server.quoted key': 'q',
      'server.dotted.inner': 2,
      'server.inline.x': 1,
      'server.text': 'a = not a key\n',
      'server.unknown-mod-key': 'kept',
      'server.sub.deep': 'd',
    });
  });

  it('reports syntax errors with line and column', () => {
    expect(tomlFormat.parse('a = 1\nb = \n')).toEqual({ ok: false, issues: [{ line: 2, col: 5, message: 'Invalid value' }] });
    const dup = tomlFormat.parse('a = 1\na = 2\n');
    expect(dup.ok ? [] : dup.issues).toEqual([{ line: 2, col: 1, message: expect.stringMatching(/redefine/) }]);
  });

  it('locates a value', () => {
    const r = tomlFormat.parse(CONFIG);
    if (!r.ok) throw new Error('parse');
    expect(tomlFormat.locate!(r.doc, 'server.port')).toEqual({ line: 7, col: 8 });
    expect(tomlFormat.locate!(r.doc, 'server.dotted.inner')).toEqual({ line: 14, col: 16 });
    expect(tomlFormat.locate!(r.doc, 'server.inline.x')).toBeNull();
  });
});

describe('toml edits (CFG-09)', () => {
  it('replaces values in place, keeping each type and quoting: the rest stays byte for byte', () => {
    const out = tomlFormat.edit(CONFIG, {
      title: 'y "z"',
      count: '4',
      'server.port': 25570,
      'server.ratio': 2,
      'server.path': 'D:\\other',
      'server.big': 12,
      'server.when': '2026-01-02T03:04:05Z',
      'server.flag': 'false',
      'server.dotted.inner': 7,
      'server.text': 'short',
    });
    expect(out).toBe(
      CONFIG.replace('title = "x"', 'title = "y \\"z\\""')
        .replace('count = 3', 'count = 4')
        .replace('port = 25565', 'port = 25570')
        .replace('ratio = 1.5', 'ratio = 2.0')
        .replace("'C:\\no\\escapes'", "'D:\\other'")
        .replace('9007199254740993', '12')
        .replace('1979-05-27 07:32:00Z', '2026-01-02T03:04:05Z')
        .replace('flag = true', 'flag = false')
        .replace('dotted.inner = 2', 'dotted.inner = 7')
        .replace('"""\na = not a key\n"""', '"short"'),
    );
    expect(flat(out)).toMatchObject({ 'server.port': 25570, 'server.ratio': 2, 'server.unknown-mod-key': 'kept' });
  });

  it('refuses a wrong type, and values it could only reach by rewriting the file', () => {
    expect(() => tomlFormat.edit(CONFIG, { 'server.port': 'many' })).toThrow(/expects a number/);
    expect(() => tomlFormat.edit(CONFIG, { count: 1.5 })).toThrow(/whole number/);
    expect(() => tomlFormat.edit(CONFIG, { 'server.flag': 'maybe' })).toThrow(/true or false/);
    expect(() => tomlFormat.edit(CONFIG, { 'server.when': 'yesterday' })).toThrow(/date or time/);
    expect(() => tomlFormat.edit(CONFIG, { 'server.inline.x': 2 })).toThrow(/inline table or a list/);
    expect(() => tomlFormat.edit(CONFIG, { 'server.arr': 2 })).toThrow(/a list/);
    expect(() => tomlFormat.edit(CONFIG, { server: 2 })).toThrow(/a table/);
    expect(() => tomlFormat.edit(CONFIG, { 'title.x': 2 })).toThrow(/not a table/);
    expect(() => tomlFormat.edit(CONFIG, { 'server.inline.x': null })).toThrow(/text editor/);
  });

  it('adds keys to their table, under the nearest one, or in a new table at the end', () => {
    const out = tomlFormat.edit(CONFIG, { 'server.motd': 'hi', 'server.sub.more': true, 'server.sub2.k': 1, root: 0.5, 'fresh.table.key': 'v' });
    expect(out).toContain('unknown-mod-key = "kept"\nmotd = "hi"\n');
    expect(out).toContain('deep = "d"\nmore = true\n');
    expect(out).toContain('count = 3\nroot = 0.5\n');
    expect(out).toContain('unknown-mod-key = "kept"\nmotd = "hi"\nsub2.k = 1\n');
    expect(out.endsWith('\n[fresh.table]\nkey = "v"\n')).toBe(true);
    expect(comments(out)).toEqual(comments(CONFIG));
    expect(flat(out)).toMatchObject({ 'server.motd': 'hi', 'server.sub.more': true, 'server.sub2.k': 1, root: 0.5, 'fresh.table.key': 'v', 'server.unknown-mod-key': 'kept' });
    expect(tomlFormat.edit('', { a: 1 })).toBe('a = 1\n');
    expect(tomlFormat.edit('# c\n[t]\nx = 1', { y: 2 })).toBe('# c\ny = 2\n[t]\nx = 1');
  });

  it('removes a key with its line, keeping the comments above it', () => {
    const out = tomlFormat.edit(CONFIG, { 'server.port': null, 'server.arr': null, 'server.text': null, missing: null });
    expect(out).toBe(CONFIG.replace('port = 25565\n', '').replace('arr = [\n  1, # one\n  2,\n]\n', '').replace('text = """\na = not a key\n"""\n', ''));
    expect(out).toContain('# the port\nratio');
  });

  it('creates a file from dotted values', () => {
    const text = tomlFormat.create!({ a: 1, 'b.c': 'x', 'b.d': true, e: 'q"' });
    expect(text).toBe('a = 1\ne = "q\\""\n\n[b]\nc = "x"\nd = true\n');
    expect(flat(text)).toEqual({ a: 1, e: 'q"', 'b.c': 'x', 'b.d': true });
  });
});
