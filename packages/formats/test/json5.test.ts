// JSON5 (CFG-02, CFG-07, CFG-09): checked by the `json5` package, edited in
// place like JSON. The texts are written for these tests.
import { describe, expect, it } from 'vitest';
import { json5Format } from '../src/registry';

const CONFIG = [
  '// A mod config',
  '{',
  '  /* block comment */',
  '  name: \'single\', // trailing',
  '  "quoted": "double",',
  '  hex: 0x1F,',
  '  half: .5,',
  '  far: Infinity,',
  '  nested: {',
  '    inner: true,',
  '  },',
  '  list: [1, 2,],',
  '  unknownModKey: "kept",',
  '}',
  '',
].join('\n');

function flat(text: string) {
  const r = json5Format.parse(text);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return json5Format.flatten(r.doc);
}

/** Every comment of a text, without the code on its line. */
const comments = (t: string) => t.match(/\/\/.*|\/\*[\s\S]*?\*\//g) ?? [];

describe('json5 format (CFG-02)', () => {
  it('reads comments, bare keys, single quotes, hex, trailing commas; flattens like JSON', () => {
    expect(flat(CONFIG)).toEqual({ name: 'single', quoted: 'double', hex: 31, half: 0.5, 'nested.inner': true, unknownModKey: 'kept' });
    expect(flat("{'a\\\nb': 'x\\u0041', $id: 1, \\u0062c: 2}")).toEqual({ ab: 'xA', $id: 1, bc: 2 });
  });

  it('reports syntax errors with line and column', () => {
    expect(json5Format.parse('{a: 1,,}')).toEqual({ ok: false, issues: [{ line: 1, col: 7, message: "Invalid character ','" }] });
    expect(json5Format.parse('{\n  a: 1\n  b: 2\n}')).toEqual({ ok: false, issues: [{ line: 3, col: 3, message: "Invalid character 'b'" }] });
    const r = json5Format.parse(CONFIG);
    if (!r.ok) throw new Error('parse');
    expect(json5Format.locate!(r.doc, 'nested.inner')).toEqual({ line: 10, col: 12 });
  });
});

describe('json5 edits (CFG-09)', () => {
  it('replaces values in place, keeping every comment and the layout', () => {
    const out = json5Format.edit(CONFIG, { name: 'new', hex: 32, 'nested.inner': 'false', unknownModKey: 'still' });
    expect(out).toBe(CONFIG.replace("'single'", '"new"').replace('0x1F', '32').replace('inner: true', 'inner: false').replace('"kept"', '"still"'));
    expect(comments(out)).toEqual(comments(CONFIG));
    expect(() => json5Format.edit(CONFIG, { half: 'x' })).toThrow(/expects a number/);
  });

  it('adds and removes keys, trailing commas and all', () => {
    const out = json5Format.edit(CONFIG, { added: 1, 'nested.more': 'm', half: null });
    expect(flat(out)).toEqual({ name: 'single', quoted: 'double', hex: 31, 'nested.inner': true, 'nested.more': 'm', unknownModKey: 'kept', added: 1 });
    expect(comments(out)).toEqual(comments(CONFIG));
    expect(json5Format.edit('{a: 1,}', { a: null })).toBe('{}');
    expect(json5Format.edit('{a: 1, b: 2,}', { b: null })).toBe('{a: 1,}');
    expect(json5Format.edit('{a: 1,}', { b: 2 })).toBe('{a: 1, "b": 2,}');
  });

  it('creates a file other JSON5 readers read', () => {
    const text = json5Format.create!({ a: 1, 'b.c': 'x' });
    expect(flat(text)).toEqual({ a: 1, 'b.c': 'x' });
  });
});
