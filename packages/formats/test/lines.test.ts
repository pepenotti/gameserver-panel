// Line lists (CFG-02, CFG-07, CFG-09): one entry per line, `#` comments.
import { describe, expect, it } from 'vitest';
import { assertLineEntry, buildLines } from '../src/lines';
import { linesFormat } from '../src/registry';

const LIST = '# Admins, one per line\n\n76561198000000001\n  Player One  \n# Player2 left\nPlayer3\n';

function flat(text: string) {
  const r = linesFormat.parse(text);
  if (!r.ok) throw new Error('parse');
  return linesFormat.flatten(r.doc);
}

describe('lines format (CFG-02)', () => {
  it('reads one entry per line, without blanks, empty lines or comments', () => {
    expect(flat(LIST)).toEqual({ '76561198000000001': true, 'Player One': true, Player3: true });
    expect(flat('')).toEqual({});
    expect(flat('﻿a\r\nb')).toEqual({ a: true, b: true });
    const r = linesFormat.parse(LIST);
    if (!r.ok) throw new Error('parse');
    expect(linesFormat.locate!(r.doc, 'Player3')).toEqual({ line: 6 });
    expect(linesFormat.locate!(r.doc, 'Player2')).toBeNull();
  });
});

describe('lines edits (CFG-09)', () => {
  it('adds entries at the end and removes them, keeping comments and every other line', () => {
    const out = linesFormat.edit(LIST, { Player4: true, 'Player One': null, Player3: false });
    expect(out).toBe('# Admins, one per line\n\n76561198000000001\n# Player2 left\nPlayer4\n');
    expect(linesFormat.edit(LIST, { Player3: true })).toBe(LIST);
    expect(linesFormat.edit('a\r\nb', { c: true })).toBe('a\r\nb\r\nc');
    expect(linesFormat.edit('', { a: true })).toBe('a\n');
    expect(linesFormat.edit('dup\ndup\nx\n', { dup: null })).toBe('x\n');
  });

  it('refuses what one line cannot hold', () => {
    for (const bad of ['two\nlines', '', ' padded', '# comment']) expect(() => linesFormat.edit('', { [bad]: true }), bad).toThrow();
    expect(() => linesFormat.edit('', { a: 'yes' })).toThrow(/true.*null/);
    expect(() => assertLineEntry('ok entry')).not.toThrow();
  });

  it('creates a list from the entries set to true', () => {
    expect(linesFormat.create!({ a: true, b: false, c: true })).toBe('a\nc\n');
    expect(buildLines(['x'], '\r\n')).toBe('x\r\n');
  });
});
