import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import type { Deps } from '../src/http/deps';
import type { ServerContext } from '../src/servers/context';
import { ServerSettings } from '../src/settings';
import { NoOrchestrator } from '../src/servers/orchestrator';
import { createPanelDeps } from '../src/wiring';
import { FakeFeed, fakeAgent, makePanel, noNetwork } from './harness';

/** Every field of `Deps`: the compiler refuses this list when one is missing or unknown. */
const FIELDS = {
  env: true,
  db: true,
  users: true,
  grants: true,
  sessions: true,
  audit: true,
  settings: true,
  breaker: true,
  bus: true,
  notifier: true,
  serverRows: true,
  servers: true,
  orchestrator: true,
  adapters: true,
  hostJobs: true,
} as const satisfies Record<keyof Deps, true>;

/** Every service field of a `ServerContext`, likewise. */
const SERVER_FIELDS = {
  id: false,
  row: false,
  adapter: false,
  agent: true,
  feed: true,
  ops: true,
  settings: true,
  files: true,
  handle: true,
  control: true,
  config: true,
  backups: true,
  flows: true,
  players: true,
  mods: true,
  scheduler: true,
  changes: true,
  capabilities: false,
  start: false,
  stop: false,
} as const satisfies Record<keyof ServerContext, boolean>;

/** How a service names the fields it keeps (`server` is the handle). */
const ALIAS: Record<string, keyof ServerContext> = { server: 'handle' };

describe('createPanelDeps (the one composition root)', () => {
  it('builds every field of Deps, no placeholders left', async () => {
    const { deps } = await makePanel();
    for (const key of Object.keys(FIELDS) as (keyof Deps)[]) {
      expect(deps[key], key).toBeDefined();
      expect(deps[key], key).not.toBeNull();
    }
    expect(Object.keys(deps).sort()).toEqual(Object.keys(FIELDS).sort());
  });

  it('serves default, the server the environment describes, outside the orchestrator', async () => {
    const { deps, srv } = await makePanel();
    expect(deps.servers.list().map((s) => s.id)).toEqual(['default']);
    expect(deps.servers.get('nope')).toBeNull();
    expect(srv.handle.ref).toEqual({ id: 'default', gameName: 'zomboid', flavour: null });
    expect(srv.row).toMatchObject({ id: 'default', adapter: 'pz', gameName: 'zomboid', spec: null });
    expect(srv.handle.adapter).toBe(srv.adapter);
    expect(srv.ops.serverId).toBe('default');
    expect(srv.settings).toBeInstanceOf(ServerSettings);
    // Its backups stay where they always were; its secrets in the environment.
    expect(srv.backups.dir).toBe(deps.env.backupDir);
    expect(srv.handle.secrets()).toEqual({ adminPassword: 'AdminPw-123456' });
    expect(deps.adapters.map((a) => a.meta.id)).toEqual(['pz']);
  });

  it('answers 501 for what needs the orchestrator while this build has none (FACTORIES)', async () => {
    const { deps } = await makePanel();
    const feed = new FakeFeed();
    const bare = createPanelDeps({ env: deps.env, db: openDb(':memory:'), agent: fakeAgent(feed), feed, fetch: noNetwork });
    expect(bare.orchestrator).toBeInstanceOf(NoOrchestrator);
    await expect(bare.servers.create({ id: 'pz-2', name: 'x', adapter: 'pz', by: { type: 'system' } })).rejects.toMatchObject({ statusCode: 501, code: 'not-implemented' });
    // Nothing of its own for the orchestrator to run: nothing to reconcile, and nothing fails.
    await expect(bare.servers.reconcile()).resolves.toEqual({ applied: [], started: [], orphans: [], failed: [] });
  });

  it('boots without a default server when the environment describes none', async () => {
    const { deps } = await makePanel();
    const bare = createPanelDeps({ env: { ...deps.env, agentUrl: '', agentToken: '' }, db: openDb(':memory:'), fetch: noNetwork });
    expect(bare.servers.list()).toEqual([]);
    // A database that has default, with an environment that no longer says where it is: refused loudly.
    const db = openDb(':memory:');
    createPanelDeps({ env: deps.env, db, agent: fakeAgent(new FakeFeed()), feed: new FakeFeed(), fetch: noNetwork });
    expect(() => createPanelDeps({ env: { ...deps.env, agentUrl: '', agentToken: '' }, db, fetch: noNetwork })).toThrow(/AGENT_URL, AGENT_TOKEN/);
  });

  it("hands every service of a server that server's instances, and the host's shared ones", async () => {
    const { deps, srv } = await makePanel();
    // A service keeps what it was built with in `d`; any field named like a
    // context or Deps field must be that very instance. A second Control or
    // BackupService is how scheduled backups once went wrong.
    let checked = 0;
    const same = (where: string, fields: Record<string, unknown>) => {
      for (const [raw, value] of Object.entries(fields)) {
        if (typeof value !== 'object' || value === null) continue;
        const key = ALIAS[raw] ?? raw;
        if (key in SERVER_FIELDS && SERVER_FIELDS[key as keyof ServerContext]) {
          expect(value, `${where}.${raw}`).toBe(srv[key as keyof ServerContext]);
          checked++;
        } else if (key in FIELDS && key !== 'env' && key !== 'db') {
          expect(value, `${where}.${raw}`).toBe(deps[key as keyof Deps]);
          checked++;
        }
      }
    };
    for (const [name, svc] of Object.entries(srv) as [keyof ServerContext, unknown][]) {
      if (!SERVER_FIELDS[name] || typeof svc !== 'object' || svc === null) continue;
      if ('d' in svc) same(`${name}.d`, (svc as { d: Record<string, unknown> }).d);
    }
    expect(checked).toBeGreaterThan(30);
    expect(srv.control.server).toBe(srv.handle);
  });

  it('refuses to start without a secret the adapter declares, naming the variable', async () => {
    const { deps } = await makePanel();
    const feed = new FakeFeed();
    const build = () => createPanelDeps({ env: { ...deps.env, secrets: {} }, db: openDb(':memory:'), agent: fakeAgent(feed), feed, fetch: noNetwork });
    expect(build).toThrow(/GAME_SECRET_ADMIN_PASSWORD must be set/);
  });
});
