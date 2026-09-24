import { describe, expect, it } from 'vitest';
import { buildIni, getIniValue, iniToRecord, parseIni, parseOptionComment, serializeIni, setIniValues } from '../src/ini';
import { fixture } from './fixtures';

const en = fixture('config/server.en.ini');
const es = fixture('config/server.es.ini');

describe('parseIni on the real 42.20.4 file', () => {
  it('reads every key with its comment, CRLF and no final newline', () => {
    const doc = parseIni(en);
    expect(doc.eol).toBe('\r\n');
    expect(doc.finalNewline).toBe(false);
    expect(doc.entries).toHaveLength(144);
    const pvp = doc.entries.find((e) => e.key === 'PVP')!;
    expect(pvp.value).toBe('true');
    expect(pvp.comments).toEqual(['Players can hurt and kill other players']);
    expect(doc.entries.find((e) => e.key === 'ChatStreams')!.comments).toEqual([]);
    expect(getIniValue(doc, 'Map')).toBe('Muldraugh, KY');
    expect(iniToRecord(doc).RCONPassword).toBe('<RCON_PASSWORD>');
  });

  it('keeps values that contain "=" and markup intact', () => {
    const doc = parseIni(en);
    expect(getIniValue(doc, 'ServerWelcomeMessage')).toMatch(/^Welcome to Project Zomboid Multiplayer! <LINE>/);
    expect(getIniValue(doc, 'ClientCommandFilter')).toBe('-vehicle.*;+vehicle.damageWindow;+vehicle.fixPart;+vehicle.installPart;+vehicle.uninstallPart');
  });

  it('round-trips byte-for-byte', () => {
    for (const text of [en, es, fixture('config/partial.output.ini'), 'A=1\nB=2\n', '', 'A=1']) {
      expect(serializeIni(parseIni(text))).toBe(text);
    }
  });

  it('has the same keys in both languages', () => {
    expect(parseIni(es).entries.map((e) => e.key)).toEqual(parseIni(en).entries.map((e) => e.key));
  });
});

describe('setIniValues', () => {
  it('edits one line in place and leaves the rest byte-identical', () => {
    const out = setIniValues(en, { MaxPlayers: '8', PublicName: 'Zombies Jatisheados — ñ' });
    const before = en.split('\r\n');
    const after = out.split('\r\n');
    expect(after).toHaveLength(before.length);
    const changed = after.map((l, i) => (l === before[i] ? null : l)).filter(Boolean);
    expect(changed).toEqual(['PublicName=Zombies Jatisheados — ñ', 'MaxPlayers=8']);
    expect(out.endsWith('\r\n')).toBe(false);
  });

  it('appends unknown keys after a blank line, keeping the EOL style', () => {
    expect(setIniValues('A=1\n', { B: '2' })).toBe('A=1\n\nB=2\n');
    expect(setIniValues('A=1', { B: '2' })).toBe('A=1\n\nB=2');
    expect(setIniValues('', { B: '2' })).toBe('B=2');
  });

  it('refuses values or keys that would inject extra lines', () => {
    expect(() => setIniValues(en, { PublicName: 'x\r\nRCONPassword=pwned' })).toThrow(/line break/);
    expect(() => setIniValues(en, { 'Bad Key': '1' })).toThrow(/Invalid ini key/);
  });

  it('edits every duplicate so a stale copy cannot win', () => {
    expect(setIniValues('A=1\nA=2\n', { A: '3' })).toBe('A=3\nA=3\n');
  });
});

describe('buildIni', () => {
  it('writes a minimal ini that PZ will complete with defaults', () => {
    expect(buildIni({ PublicName: 'Partial Test', MaxPlayers: '8' })).toBe('PublicName=Partial Test\nMaxPlayers=8\n');
  });
});

describe('parseOptionComment', () => {
  it('reads the English range format', () => {
    expect(parseOptionComment('The time it takes for a player to enter and leave PVP mode Min: 0 Max: 1000 Default: 2')).toEqual({
      description: 'The time it takes for a player to enter and leave PVP mode',
      min: 0,
      max: 1000,
      default: '2',
    });
    expect(parseOptionComment('Min: 0 Max: 60 Default: 60')).toEqual({ min: 0, max: 60, default: '60' });
  });

  it('reads the Spanish range format', () => {
    expect(parseOptionComment('El tiempo que tarda un jugador en entrar y salir del modo PVP. Mínimo=0 Máximo=1000 Por defecto=2')).toEqual({
      description: 'El tiempo que tarda un jugador en entrar y salir del modo PVP.',
      min: 0,
      max: 1000,
      default: '2',
    });
  });

  it('reads enum-style defaults and decimals', () => {
    expect(parseOptionComment('How fast zombies move. Default = Random')).toEqual({ description: 'How fast zombies move.', default: 'Random' });
    expect(parseOptionComment('Default = 1 Hour, 30 Minutes')).toEqual({ default: '1 Hour, 30 Minutes' });
    expect(parseOptionComment('Mínimo=0.00 Máximo=1000.00 Por defecto=1.00')).toEqual({ min: 0, max: 1000, default: '1.00' });
    expect(parseOptionComment('Plain text')).toEqual({ description: 'Plain text' });
  });
});
