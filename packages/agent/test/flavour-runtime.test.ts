// PRD §10, HST-05: a flavour may run in another image family than its
// adapter. The agent learns the flavour from GAME_FLAVOUR (the server's
// spec) and gives installs that family's tools: the steamcmd driver only
// where the steam image runs.
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeAdapter } from '@gsp/adapter-api';
import { loadConfig } from '../src/config';
import { envelope, makeHarness, type Harness } from './helpers';

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

/** The PZ adapter as a game of the native family whose `modded` flavour runs in the steam image; installs record whether they got steamcmd. */
function twoImages(seen: boolean[]) {
  return (a: RuntimeAdapter): RuntimeAdapter => ({
    ...a,
    meta: {
      ...a.meta,
      runtime: 'native',
      flavours: [
        { id: 'plain', name: { en: 'Plain', es: 'Simple' } },
        { id: 'modded', name: { en: 'Modded', es: 'Con mods' }, runtime: 'steam' },
      ],
    },
    install: async (ctx) => {
      seen.push(ctx.steam !== undefined);
      return { ok: true };
    },
  });
}

describe("a flavour's own image family (PRD §10, HST-05)", () => {
  it('reads the flavour from GAME_FLAVOUR, and refuses one that is not an id', () => {
    const token = { AGENT_TOKEN: 't'.repeat(40) };
    expect(loadConfig(token).flavour).toBeNull();
    expect(loadConfig({ ...token, GAME_FLAVOUR: 'tmodloader' }).flavour).toBe('tmodloader');
    expect(() => loadConfig({ ...token, GAME_FLAVOUR: '../x' })).toThrow(/GAME_FLAVOUR/);
  });

  it("gives installs the steamcmd driver only when the server's flavour runs in the steam image", async () => {
    const seen: boolean[] = [];
    for (const flavour of [null, 'plain', 'modded', 'unknown']) {
      h = await makeHarness({ flavour }, { adapter: twoImages(seen) });
      expect(h.agent.runtimeFamily()).toBe(flavour === 'modded' ? 'steam' : 'native');
      h.agent.setLaunch(envelope());
      expect(await h.agent.install({ validate: false }, undefined)).toEqual({ ok: true });
      await h.cleanup();
      h = null;
    }
    expect(seen).toEqual([false, false, true, false]);
  });

  it("keeps the adapter's family for adapters whose flavours name none", async () => {
    h = await makeHarness({ flavour: null });
    expect(h.agent.runtimeFamily()).toBe('steam');
  });
});
