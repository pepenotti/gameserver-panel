import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../src/state-store';
import { launch } from './helpers';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-state-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const onDisk = () => JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')) as Record<string, unknown>;
const writeOld = (s: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
};

describe('StateStore', () => {
  it('starts with a generated control secret in the secrets map', () => {
    const store = new StateStore(dir, { adapter: 'pz' });
    expect(store.controlSecret).toMatch(/^[0-9a-f]{48}$/);
    expect(onDisk()).toEqual({ desired: 'stopped', launch: null, secrets: { control: store.controlSecret }, gameVersion: null });
    expect(new StateStore(dir, { adapter: 'pz' }).controlSecret).toBe(store.controlSecret);
  });

  it('migrates the pre-adapter file: rconPassword and bare launch params', () => {
    const rconPassword = 'a1'.repeat(24);
    writeOld({ desired: 'running', launch, rconPassword, gameVersion: '42.20.4' });
    const store = new StateStore(dir, { adapter: 'pz' });
    // The game's ini keeps working: the RCON password is the same secret.
    expect(store.controlSecret).toBe(rconPassword);
    expect(store.get()).toEqual({ desired: 'running', launch: { adapter: 'pz', params: launch }, secrets: { control: rconPassword }, gameVersion: '42.20.4' });
    const file = onDisk();
    expect(file).not.toHaveProperty('rconPassword');
    expect(file.secrets).toEqual({ control: rconPassword });
    expect(file.launch).toEqual({ adapter: 'pz', params: launch });
  });

  it('replaces a secret too short to keep, and keeps other secrets', () => {
    writeOld({ desired: 'stopped', launch: null, rconPassword: 'short', secrets: { rest: 'b'.repeat(40) } });
    const store = new StateStore(dir, { adapter: 'pz' });
    expect(store.controlSecret).toMatch(/^[0-9a-f]{48}$/);
    expect(store.get().secrets.rest).toBe('b'.repeat(40));
  });

  it('keeps an envelope as it is, and survives a corrupt file', () => {
    writeOld({ desired: 'stopped', launch: { adapter: 'other', params: { x: 1 } }, secrets: { control: 'c'.repeat(48) }, gameVersion: null });
    const before = readFileSync(path.join(dir, 'state.json'), 'utf8');
    expect(new StateStore(dir, { adapter: 'pz' }).get().launch).toEqual({ adapter: 'other', params: { x: 1 } });
    // Nothing to migrate: the file is left alone.
    expect(readFileSync(path.join(dir, 'state.json'), 'utf8')).toBe(before);

    writeFileSync(path.join(dir, 'state.json'), '{ not json');
    const fresh = new StateStore(dir, { adapter: 'pz' });
    expect(fresh.get().launch).toBeNull();
    expect(fresh.controlSecret).toHaveLength(48);
  });
});
