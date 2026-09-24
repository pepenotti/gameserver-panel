import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const token = { AGENT_TOKEN: 't'.repeat(40) };

describe('loadConfig', () => {
  it('defaults to the pz adapter and its own roots and stop budget', () => {
    const c = loadConfig({ ...token });
    expect(c).toMatchObject({ adapter: 'pz', installDir: null, dataDir: null, launcher: null, ports: {}, stopTimeoutMs: null });
    expect(c.stateDir.replace(/\\/g, '/')).toBe('/data/.agent');
  });

  it('reads the GAME_* names', () => {
    const c = loadConfig({
      ...token,
      GAME_ADAPTER: 'pz',
      GAME_INSTALL_DIR: '/srv/game',
      GAME_DATA_DIR: '/srv/data',
      GAME_START_COMMAND: '["node","fake.mjs"]',
      GAME_PORT_RCON: '27100',
      GAME_PORT_GAME: '16300',
      GAME_STOP_TIMEOUT_MS: '60000',
    });
    expect(c).toMatchObject({ installDir: '/srv/game', dataDir: '/srv/data', launcher: ['node', 'fake.mjs'], ports: { rcon: 27100, game: 16300 }, stopTimeoutMs: 60_000 });
    expect(c.stateDir.replace(/\\/g, '/')).toBe('/srv/data/.agent');
  });

  it('falls back to the old PZ_* names, the GAME_* ones winning', () => {
    const old = { ...token, PZ_INSTALL_DIR: '/opt/pz', PZ_DATA_DIR: '/data', PZ_START_COMMAND: '["old"]', PZ_STOP_TIMEOUT_MS: '9000', PZ_RESTART_DELAY_MS: '5' };
    expect(loadConfig(old)).toMatchObject({ installDir: '/opt/pz', dataDir: '/data', launcher: ['old'], stopTimeoutMs: 9000, restartDelayMs: 5 });
    expect(loadConfig({ ...old, GAME_DATA_DIR: '/new', GAME_START_COMMAND: '["new"]' })).toMatchObject({ dataDir: '/new', launcher: ['new'] });
  });

  it('refuses bad values', () => {
    expect(() => loadConfig({})).toThrow(/AGENT_TOKEN/);
    expect(() => loadConfig({ ...token, GAME_PORT_RCON: '99999' })).toThrow(/GAME_PORT_RCON/);
    expect(() => loadConfig({ ...token, GAME_START_COMMAND: 'node fake.mjs' })).toThrow(/GAME_START_COMMAND/);
    expect(() => loadConfig({ ...token, PZ_READY_TIMEOUT_MS: 'soon' })).toThrow(/PZ_READY_TIMEOUT_MS/);
  });
});
