// Java properties (CFG-02, CFG-07, CFG-09), the syntax Minecraft's
// server.properties uses. The texts are written for these tests: the real
// file's keys and values come with the fact-finding captures (fixtures/).
import { describe, expect, it } from 'vitest';
import { buildProperties, editProperties, escapeValue, parseProperties, propertiesToRecord } from '../src/properties';
import { propertiesFormat } from '../src/registry';

const SAMPLE = [
  '#Server properties',
  '#Thu Jan 01 00:00:00 UTC 2026',
  'motd=A Test Server',
  'resource-pack=https\\://example.com/pack.zip',
  'level-seed=',
  'server-port=25570',
  '! a comment in the other style',
  '   # an indented comment',
  'spaced\\ key\\ here = value with spaces  ',
  'stops at the blank',
  'colon.sep:yes',
  'blank.sep   spaced out',
  'unicode=caf\\u00e9 \\t tab',
  'continued=first, \\',
  '    second, \\',
  '    third',
  'unknown-future-key=kept',
  '',
].join('\n');

function flat(text: string) {
  const r = propertiesFormat.parse(text);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return propertiesFormat.flatten(r.doc);
}

describe('properties format (CFG-02)', () => {
  it('reads keys, separators, escapes, comments and continuations as Java does', () => {
    expect(flat(SAMPLE)).toEqual({
      motd: 'A Test Server',
      'resource-pack': 'https://example.com/pack.zip',
      'level-seed': '',
      'server-port': '25570',
      'spaced key here': 'value with spaces  ',
      // An unescaped blank ends a key.
      stops: 'at the blank',
      'colon.sep': 'yes',
      'blank.sep': 'spaced out',
      unicode: 'café \t tab',
      continued: 'first, second, third',
      'unknown-future-key': 'kept',
    });
  });

  it('lets the last of repeated keys win, and reads a lone key as empty', () => {
    expect(propertiesToRecord(parseProperties('a=1\na=2\nlonely\n'))).toEqual({ a: '2', lonely: '' });
    expect(propertiesToRecord(parseProperties('\ufeffa=1'))).toEqual({ a: '1' });
    expect(propertiesToRecord(parseProperties('a=1\r\nb=2\r\n'))).toEqual({ a: '1', b: '2' });
  });

  it('refuses a malformed \\u escape with its line and column', () => {
    const r = propertiesFormat.parse('ok=1\nbad=D:\\units\\x\n');
    expect(r).toEqual({ ok: false, issues: [{ line: 2, col: 7, message: expect.stringMatching(/\\uXXXX/) }] });
    // On a continuation line, the position is that line's.
    const r2 = propertiesFormat.parse('k=a\\\n  b\\uzz\n');
    expect(r2.ok ? [] : r2.issues).toEqual([{ line: 2, col: 4, message: expect.any(String) }]);
  });

  it('locates a key by its value', () => {
    const r = propertiesFormat.parse(SAMPLE);
    if (!r.ok) throw new Error('parse');
    expect(propertiesFormat.locate!(r.doc, 'server-port')).toEqual({ line: 6, col: 13 });
    expect(propertiesFormat.locate!(r.doc, 'continued')).toEqual({ line: 14, col: 11 });
    expect(propertiesFormat.locate!(r.doc, 'nope')).toBeNull();
  });
});

describe('properties edits (CFG-09)', () => {
  it('changes only the value, keeping every comment, unknown key and the layout byte for byte', () => {
    const out = propertiesFormat.edit(SAMPLE, { 'server-port': 25571, motd: 'New: name = #1!' });
    expect(out).toBe(SAMPLE.replace('server-port=25570', 'server-port=25571').replace('motd=A Test Server', 'motd=New\\: name \\= \\#1\\!'));
    expect(flat(out)).toMatchObject({ 'server-port': '25571', motd: 'New: name = #1!', 'unknown-future-key': 'kept' });
  });

  it('keeps a key written with other separators as it was, and collapses a continued value', () => {
    const out = propertiesFormat.edit(SAMPLE, { 'colon.sep': 'no', 'blank.sep': 'x y', continued: 'one line', 'spaced key here': ' lead' });
    expect(out.split('\n')).toEqual(
      expect.arrayContaining(['colon.sep:no', 'blank.sep   x y', 'continued=one line', 'spaced\\ key\\ here = \\ lead']),
    );
    expect(out).not.toContain('third');
    expect(flat(out)).toMatchObject({ 'colon.sep': 'no', 'blank.sep': 'x y', continued: 'one line', 'spaced key here': ' lead', 'unknown-future-key': 'kept' });
  });

  it('writes what Java writes: \\u escapes outside ASCII, escaped blanks and line breaks', () => {
    expect(escapeValue(' two  spaces')).toBe('\\ two  spaces');
    expect(escapeValue('a\\b\nc\td')).toBe('a\\\\b\\nc\\td');
    expect(escapeValue('ñandú ☃')).toBe('\\u00F1and\\u00FA \\u2603');
    const out = propertiesFormat.edit('k=v\n', { k: 'línea\nnueva' });
    expect(out).toBe('k=l\\u00EDnea\\nnueva\n');
    expect(flat(out)).toEqual({ k: 'línea\nnueva' });
  });

  it('adds new keys at the end, removes keys without touching the comments above, and edits every duplicate', () => {
    expect(propertiesFormat.edit('#head\na=1\nb=2', { c: true, a: null })).toBe('#head\nb=2\nc=true');
    expect(propertiesFormat.edit('a=1\na=2\n', { a: '3' })).toBe('a=3\na=3\n');
    expect(propertiesFormat.edit('a=1\r\n', { 'new key': 'x' })).toBe('a=1\r\nnew\\ key=x\r\n');
    expect(propertiesFormat.edit('', { a: 'b' })).toBe('a=b\n');
    expect(propertiesFormat.edit(SAMPLE, { missing: null })).toBe(SAMPLE);
    expect(propertiesFormat.edit('lonely\n', { lonely: 'now' })).toBe('lonely=now\n');
    expect(() => editProperties('a=1', { '': 'x' })).toThrow(/empty/);
  });

  it('round-trips a whole file through create and parse', () => {
    const values = { motd: 'Hi: there', 'max-players': 10, pvp: false, 'resource-pack': 'https://x.example/p.zip' };
    const text = propertiesFormat.create!(values);
    expect(text).toBe('motd=Hi\\: there\nmax-players=10\npvp=false\nresource-pack=https\\://x.example/p.zip\n');
    expect(flat(text)).toEqual({ motd: 'Hi: there', 'max-players': '10', pvp: 'false', 'resource-pack': 'https://x.example/p.zip' });
    expect(buildProperties({ a: '1' }, '\r\n')).toBe('a=1\r\n');
  });
});
