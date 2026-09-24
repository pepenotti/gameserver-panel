import { describe, expect, it } from 'vitest';
import { isFatal, isRetryableSteamcmdError, makeRedactor, parseSteamcmdLine, stripAnsi } from '../src/log';
import { fixture } from './fixtures';

describe('isFatal', () => {
  it('knows fatal lines', () => {
    expect(isFatal('Exception in thread "main" java.lang.OutOfMemoryError: Java heap space')).toBe(true);
    expect(isFatal('ERROR: General      f:0 st:1> DebugFileWatcher.registerDir> Exception thrown')).toBe(false);
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
