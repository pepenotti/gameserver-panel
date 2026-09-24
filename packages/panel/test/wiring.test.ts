import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import type { Deps } from '../src/http/deps';
import { createPanelDeps } from '../src/wiring';
import { FakeFeed, fakeAgent, makePanel, noNetwork } from './harness';

/** Every field of `Deps`: the compiler refuses this list when one is missing or unknown. */
const FIELDS = {
  env: true,
  db: true,
  users: true,
  sessions: true,
  audit: true,
  settings: true,
  breaker: true,
  agent: true,
  feed: true,
  bus: true,
  ops: true,
  server: true,
  control: true,
  config: true,
  backups: true,
  flows: true,
  players: true,
  mods: true,
  notifier: true,
  scheduler: true,
  files: true,
  changes: true,
  adapter: true,
} as const satisfies Record<keyof Deps, true>;

describe('createPanelDeps (the one composition root)', () => {
  it('builds every field of Deps, no placeholders left', async () => {
    const { deps } = await makePanel();
    for (const key of Object.keys(FIELDS) as (keyof Deps)[]) {
      expect(deps[key], key).toBeDefined();
      expect(deps[key], key).not.toBeNull();
    }
    expect(Object.keys(deps).sort()).toEqual(Object.keys(FIELDS).sort());
  });

  it('hands every service the same instances Deps holds, and one server', async () => {
    const { deps } = await makePanel();
    // A service keeps what it was built with in its fields (or in `d`); any
    // one named like a Deps field must be that very instance. A second Control
    // or BackupService is how scheduled backups once went wrong.
    const data = new Set<keyof Deps>(['env', 'db', 'adapter']);
    let checked = 0;
    const same = (where: string, fields: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(fields)) {
        if (!(key in FIELDS) || typeof value !== 'object' || value === null) continue;
        expect(value, `${where}.${key}`).toBe(deps[key as keyof Deps]);
        checked++;
      }
    };
    for (const [name, svc] of Object.entries(deps) as [keyof Deps, object][]) {
      if (data.has(name)) continue;
      same(name, svc as Record<string, unknown>);
      if ('d' in svc) same(`${name}.d`, (svc as { d: Record<string, unknown> }).d);
    }
    expect(checked).toBeGreaterThan(30);
    expect(deps.control.server).toBe(deps.server);
    expect(deps.server.ref).toEqual({ id: 'default', gameName: 'zomboid', flavour: null });
    expect(deps.server.adapter).toBe(deps.adapter);
  });

  it("refuses to start without a secret the adapter declares, naming the variable", async () => {
    const { deps } = await makePanel();
    const feed = new FakeFeed();
    const build = () => createPanelDeps({ env: { ...deps.env, secrets: {} }, db: openDb(':memory:'), agent: fakeAgent(feed), feed, fetch: noNetwork });
    expect(build).toThrow(/GAME_SECRET_ADMIN_PASSWORD must be set/);
  });
});
