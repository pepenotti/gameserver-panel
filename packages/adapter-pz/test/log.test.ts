import { describe, expect, it } from 'vitest';
import { parseLogLine, parsePlayers, PZ_PATTERNS } from '../src/shared/log';
import { fixture } from './fixtures';

const lines = (rel: string) => fixture(rel).split('\n').map(parseLogLine);
const find = (rel: string, re: RegExp) => lines(rel).find((l) => re.test(l.message));

describe('parseLogLine', () => {
  it('splits level, category and message', () => {
    expect(parseLogLine('LOG  : Network      f:0 st:34,907,676> *** SERVER STARTED ****')).toEqual({
      level: 'LOG',
      category: 'Network',
      message: '*** SERVER STARTED ****',
      raw: 'LOG  : Network      f:0 st:34,907,676> *** SERVER STARTED ****',
    });
    expect(parseLogLine('WARN : Script       f:0 st:34,865,802 at ModelScript.check                   > no such model "null" for Base.BareHands')).toMatchObject({
      level: 'WARN',
      category: 'Script',
      message: 'no such model "null" for Base.BareHands',
    });
    expect(parseLogLine('* additem : Give an item')).toMatchObject({ level: null, message: '* additem : Give an item' });
  });

  it('parses every header line of a real boot', () => {
    const all = lines('logs/first-boot.log').filter((l) => /^(LOG|WARN|ERROR) *:/.test(l.raw));
    expect(all.length).toBeGreaterThan(500);
    expect(all.every((l) => l.level !== null)).toBe(true);
  });
});

describe('PZ_PATTERNS against captured logs', () => {
  it('finds the version and the ready line', () => {
    expect(PZ_PATTERNS.version.exec(find('logs/first-boot.log', PZ_PATTERNS.version)!.message)!.slice(1)).toEqual(['42.20.4', 'b0bbce05d5']);
    expect(find('logs/first-boot.log', PZ_PATTERNS.ready)).toBeDefined();
    expect(find('logs/boot-with-rcon.log', PZ_PATTERNS.rconListening)!.message).toBe('RCON: listening on port 27015');
  });

  it('detects the blocking admin password prompt', () => {
    expect(find('logs/admin-prompt.log', PZ_PATTERNS.adminPrompt)).toBeDefined();
    expect(find('logs/first-boot.log', PZ_PATTERNS.adminPrompt)).toBeUndefined();
  });

  it('recognises console command results', () => {
    const f = 'logs/console-session.log';
    expect(PZ_PATTERNS.consoleCommand.exec(find(f, PZ_PATTERNS.consoleCommand)!.message)![1]).toBe('help');
    expect(find(f, PZ_PATTERNS.worldSaved)).toBeDefined();
    expect(find(f, PZ_PATTERNS.saveFinished)).toBeDefined();
    expect(PZ_PATTERNS.optionChanged.exec(find(f, PZ_PATTERNS.optionChanged)!.message)!.slice(1)).toEqual(['PublicName', 'Prueba Ñandú']);
    expect(PZ_PATTERNS.optionParseError.exec(find(f, PZ_PATTERNS.optionParseError)!.message)!.slice(1)).toEqual(['ChatMessageSlowModeTime', '3PanelTestKey']);
    expect(find(f, PZ_PATTERNS.optionsReloaded)).toBeDefined();
    expect(find(f, PZ_PATTERNS.shutdownFinished)).toBeDefined();
  });
});

describe('parsePlayers', () => {
  it('reads the empty reply captured from 42.20.4', () => {
    expect(parsePlayers('Players connected (0): \n')).toEqual({ count: 0, names: [] });
  });

  it('reads a dash-listed reply', () => {
    expect(parsePlayers('Players connected (2): \n-alice\n-Ñandú\n')).toEqual({ count: 2, names: ['alice', 'Ñandú'] });
    expect(parsePlayers('Unknown command players')).toBeNull();
  });
});
