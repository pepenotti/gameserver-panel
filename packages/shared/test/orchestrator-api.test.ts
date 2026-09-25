import { describe, expect, it } from 'vitest';
import { isServerId, SPEC_ENV_DENIED, SPEC_ENV_KEY } from '../src/orchestrator-api';

describe('orchestrator contract', () => {
  it('takes server ids the panel database takes: a-z first, then a-z 0-9 -, 2-24 long', () => {
    for (const ok of ['default', 'pz', 'pz-2', 'mc-paper-121', 'a'.repeat(24)]) expect(isServerId(ok), ok).toBe(true);
    for (const bad of ['a', 'a'.repeat(25), '2pz', '-pz', 'Pz', 'pz_2', 'pz 2', 'pz.2', '', 'pz/..', 42, null]) expect(isServerId(bad), String(bad)).toBe(false);
  });

  it('lets a spec set only GAME_* and GSP_* keys, minus the ones the image owns', () => {
    for (const ok of ['GAME_PORT_RCON', 'GAME_FLAVOUR', 'GSP_SERVER_NAME']) expect(SPEC_ENV_KEY.test(ok), ok).toBe(true);
    for (const bad of ['AGENT_PORT', 'PATH', 'LD_PRELOAD', 'GAME_', 'game_port', 'GAME_PORT__X', 'GSP-X']) expect(SPEC_ENV_KEY.test(bad), bad).toBe(false);
    for (const k of SPEC_ENV_DENIED) expect(SPEC_ENV_KEY.test(k), k).toBe(true);
  });
});
