import { describe, expect, it } from 'vitest';
import { isFatal, isRetryableSteamcmdError, makeRedactor, parseLogLine, parsePlayers, parseSteamcmdLine, PZ_PATTERNS, stripAnsi } from '../src/log';
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

  it('knows fatal lines', () => {
    expect(isFatal('Exception in thread "main" java.lang.OutOfMemoryError: Java heap space')).toBe(true);
    expect(isFatal('ERROR: General      f:0 st:1> DebugFileWatcher.registerDir> Exception thrown')).toBe(false);
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

describe('makeRedactor', () => {
  it('hides secrets and password flags', () => {
    const r = makeRedactor(['s3cretpw', 'rconrconrcon', undefined, 'abc']);
    expect(r('args -adminusername admin -adminpassword s3cretpw')).toBe('args -adminusername admin -adminpassword <redacted>');
    expect(r('RCONPassword=rconrconrcon')).toBe('RCONPassword=<redacted>');
    expect(r('-adminpassword other')).toBe('-adminpassword <redacted>');
    expect(r('abc is too short to be a secret')).toBe('abc is too short to be a secret');
  });
});

describe('parseSteamcmdLine', () => {
  it('reads progress, success and errors', () => {
    expect(parseSteamcmdLine(' Update state (0x61) downloading, progress: 12.34 (123 / 456)')).toMatchObject({ kind: 'progress', state: 'downloading', percent: 12.34 });
    expect(parseSteamcmdLine("Success! App '380870' fully installed.")).toMatchObject({ kind: 'success' });
    expect(parseSteamcmdLine("Success! App '380870' already up to date.")).toMatchObject({ kind: 'success' });
    expect(parseSteamcmdLine("Error! App '380870' state is 0x202 after update job.")).toMatchObject({ kind: 'error', state: '0x202' });
    expect(parseSteamcmdLine('random noise')).toBeNull();
  });

  it('reads a real first install: colour codes stripped, "Missing configuration" retried', () => {
    const parsed = fixture('logs/steamcmd-first-install.log').split('\n').map(parseSteamcmdLine);
    const errors = parsed.filter((p) => p?.kind === 'error');
    expect(errors).toEqual([{ kind: 'error', message: "ERROR! Failed to install app '380870' (Missing configuration)" }]);
    expect(isRetryableSteamcmdError(undefined, errors[0]!.message)).toBe(true);
    expect(parsed.find((p) => p?.message.startsWith('Connecting anonymously'))).toMatchObject({ kind: 'status' });
    expect(stripAnsi('\x1b[0mWaiting for user info...\x1b[0mOK')).toBe('Waiting for user info...OK');
  });

  it('never retries a disk-space failure', () => {
    expect(isRetryableSteamcmdError('0x202', '')).toBe(false);
    expect(isRetryableSteamcmdError('0x602', '')).toBe(true);
    expect(isRetryableSteamcmdError(undefined, 'Timed out waiting')).toBe(true);
  });
});
