// YAML (CFG-02, CFG-07, CFG-09) through the `yaml` package. The texts are
// written for these tests, in the shapes plugin configs take.
import { describe, expect, it } from 'vitest';
import { editYaml } from '../src/yaml';
import { yamlFormat } from '../src/registry';

const CONFIG = [
  '# Top comment',
  '# second line',
  'settings:',
  '  # about the spawn',
  '  spawn-limits:',
  '    monsters: 70   # trailing comment',
  '    animals: 10',
  '',
  '  motd: "Hello: world"',
  "  quote: 'single'",
  '  plain: hello world',
  '  enabled: true',
  '  ratio: 0.5',
  '  empty:',
  '  list:',
  '  - a',
  '  - b',
  '  block: |',
  '    line one',
  '    line two',
  '  flow: {a: 1, b: x}',
  '  unknown-plugin-key: kept',
  '# between',
  'top: 1',
  '',
].join('\n');

function flat(text: string) {
  const r = yamlFormat.parse(text);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return yamlFormat.flatten(r.doc);
}

const comments = (t: string) => t.split('\n').filter((l) => l.includes('#'));

describe('yaml format (CFG-02)', () => {
  it('flattens nested maps to dotted keys and leaves lists and nulls to the text editor', () => {
    expect(flat(CONFIG)).toEqual({
      'settings.spawn-limits.monsters': 70,
      'settings.spawn-limits.animals': 10,
      'settings.motd': 'Hello: world',
      'settings.quote': 'single',
      'settings.plain': 'hello world',
      'settings.enabled': true,
      'settings.ratio': 0.5,
      'settings.block': 'line one\nline two\n',
      'settings.flow.a': 1,
      'settings.flow.b': 'x',
      'settings.unknown-plugin-key': 'kept',
      top: 1,
    });
    expect(flat('a: &x 5\nb: *x\n')).toEqual({ a: 5, b: 5 });
    expect(flat('')).toEqual({});
  });

  it('reports syntax errors with line and column', () => {
    const r = yamlFormat.parse('a: 1\n b: 2\nc: [1,\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0]).toMatchObject({ line: expect.any(Number), col: expect.any(Number) });
    for (const i of r.issues) expect(i.message).not.toMatch(/\n| at line \d+/);
    const dup = yamlFormat.parse('a: 1\na: 2\n');
    expect(dup.ok ? [] : dup.issues).toEqual([expect.objectContaining({ line: 2, message: expect.stringMatching(/unique/i) })]);
  });

  it('locates a value', () => {
    const r = yamlFormat.parse(CONFIG);
    if (!r.ok) throw new Error('parse');
    expect(yamlFormat.locate!(r.doc, 'settings.spawn-limits.monsters')).toEqual({ line: 6, col: 15 });
    expect(yamlFormat.locate!(r.doc, 'settings.nope')).toBeNull();
  });
});

describe('yaml edits (CFG-09)', () => {
  it('replaces values in place: the rest of the file stays byte for byte', () => {
    const out = yamlFormat.edit(CONFIG, { 'settings.spawn-limits.monsters': '50', 'settings.motd': 'Bye', 'settings.quote': "it's", 'settings.plain': 'true', 'settings.enabled': 'false', 'settings.ratio': 2 });
    expect(out).toBe(
      CONFIG.replace('monsters: 70 ', 'monsters: 50 ')
        .replace('"Hello: world"', '"Bye"')
        .replace("'single'", "'it''s'")
        .replace('plain: hello world', 'plain: "true"')
        .replace('enabled: true', 'enabled: false')
        .replace('ratio: 0.5', 'ratio: 2'),
    );
    expect(flat(out)).toMatchObject({ 'settings.spawn-limits.monsters': 50, 'settings.plain': 'true', 'settings.enabled': false, 'settings.unknown-plugin-key': 'kept' });
  });

  it('keeps each value its type', () => {
    expect(() => yamlFormat.edit(CONFIG, { 'settings.spawn-limits.monsters': 'many' })).toThrow(/expects a number/);
    expect(() => yamlFormat.edit(CONFIG, { 'settings.enabled': 'maybe' })).toThrow(/true or false/);
    expect(() => yamlFormat.edit(CONFIG, { 'settings.list': 1 })).toThrow(/a list/);
    expect(() => yamlFormat.edit(CONFIG, { settings: 1 })).toThrow(/a map/);
    expect(flat(yamlFormat.edit(CONFIG, { 'settings.empty': 3 }))).toMatchObject({ 'settings.empty': 3 });
    expect(yamlFormat.edit(CONFIG, { 'settings.empty': 3 })).toContain('  empty: 3\n');
  });

  it('adds keys to their map at its indentation, creating maps on the way', () => {
    const out = yamlFormat.edit(CONFIG, { 'settings.new-key': 'x', 'settings.spawn-limits.water': 5, 'brand.new.deep': true, fresh: 'a: b' });
    expect(out).toContain('  unknown-plugin-key: kept\n  new-key: x\n# between');
    expect(out).toContain('    animals: 10\n    water: 5\n');
    expect(out).toContain('top: 1\nbrand:\n  new:\n    deep: true\nfresh: "a: b"\n');
    expect(comments(out)).toEqual(comments(CONFIG));
    expect(flat(out)).toMatchObject({ 'settings.new-key': 'x', 'settings.spawn-limits.water': 5, 'brand.new.deep': true, fresh: 'a: b', top: 1 });
    expect(yamlFormat.edit('', { a: 1 })).toBe('a: 1\n');
    expect(() => yamlFormat.edit('- a\n', { k: 1 })).toThrow(/not a map/);
    expect(() => yamlFormat.edit(CONFIG, { 'top.x': 1 })).toThrow(/top is not a map/);
    expect(yamlFormat.edit('# only a comment', { a: 1 })).toBe('# only a comment\na: 1\n');
  });

  it('removes a key with its lines only, comments above it stay', () => {
    const out = yamlFormat.edit(CONFIG, { 'settings.motd': null, 'settings.spawn-limits': null, 'settings.list': null, missing: null });
    expect(out).toBe(CONFIG.replace('  motd: "Hello: world"\n', '').replace('  spawn-limits:\n    monsters: 70   # trailing comment\n    animals: 10\n', '').replace('  list:\n  - a\n  - b\n', ''));
    expect(flat(out)).not.toHaveProperty('settings.motd');
  });

  it('falls back to the Document API where text surgery would not do, still keeping every comment', () => {
    const out = yamlFormat.edit(CONFIG, { 'settings.block': 'one line', 'settings.flow.c': 2, 'settings.flow.a': 9 });
    expect(flat(out)).toMatchObject({ 'settings.block': 'one line', 'settings.flow.c': 2, 'settings.flow.a': 9, 'settings.unknown-plugin-key': 'kept' });
    expect(comments(out).map((l) => l.trim().replace(/\s+/g, ' '))).toEqual(comments(CONFIG).map((l) => l.trim().replace(/\s+/g, ' ')));
    // A map's only key: removing it leaves an empty map, not a null.
    expect(flat(editYaml('a:\n  b: 1\nc: 2\n', { 'a.b': null }))).toEqual({ c: 2 });
    expect(editYaml('a:\n  b: 1\nc: 2\n', { 'a.b': null })).toMatch(/^a: \{\}/);
  });

  it('creates a file from dotted values', () => {
    const text = yamlFormat.create!({ a: 1, 'b.c': 'x', 'b.d': true });
    expect(text).toBe('a: 1\nb:\n  c: x\n  d: true\n');
    expect(flat(text)).toEqual({ a: 1, 'b.c': 'x', 'b.d': true });
  });
});
