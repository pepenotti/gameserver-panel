import { describe, expect, it } from 'vitest';
import { setIniValues } from '../src/ini';
import { CONFIG_FORMATS, iniFormat, textFormat } from '../src/registry';
import { fixture } from './fixtures';

const en = fixture('config/server.en.ini');

describe('format registry', () => {
  it('holds the formats implemented so far', () => {
    expect(Object.keys(CONFIG_FORMATS).sort()).toEqual(['ini', 'text']);
    for (const [id, f] of Object.entries(CONFIG_FORMATS)) expect(f!.id).toBe(id);
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

  it('creates a minimal file', () => {
    expect(iniFormat.create!({ PublicName: 'Partial Test', MaxPlayers: 8 })).toBe('PublicName=Partial Test\nMaxPlayers=8\n');
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
