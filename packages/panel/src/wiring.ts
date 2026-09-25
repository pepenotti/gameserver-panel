// The panel's composition root: every service, built in the one order they
// depend on each other. main.ts and the tests' harness both build the panel
// here, so the two can't drift apart. With main.ts, the only panel module
// that picks game adapters (NFR-08): `panelAdapters`, the ones servers are
// created from and run with.
import path from 'node:path';
import type { ModSource, PanelAdapter, ServerFiles } from '@gsp/adapter-api';
import { panelAdapters } from '@gsp/adapters/panel';
import { AgentClient, type AgentApi } from './agent/client';
import { Audit, SYSTEM } from './audit';
import { ServerGrants } from './auth/grants';
import { Sessions } from './auth/sessions';
import { GlobalBreaker } from './auth/throttle';
import { Users } from './auth/users';
import { BackupFlows } from './backups/flows';
import { backupPanelDb } from './backups/panel-db';
import { BackupService } from './backups/service';
import { ConfigService } from './config/service';
import type { ConfigStore } from './config/store';
import { Control } from './control/control';
import type { Db } from './db/db';
import { secretEnvName, type PanelEnv } from './env';
import { AgentServerFiles } from './files/agent';
import type { AgentFeed, Deps } from './http/deps';
import { ModsService } from './mods/service';
import { DISCORD_OVERRIDE_KEY, DiscordNotifier, type DiscordOverride } from './notifier/discord';
import { wireNotifications } from './notifier/events';
import { PanelBus } from './ops/bus';
import { OpRunner } from './ops/runner';
import { PlayersService } from './players/service';
import { ConfigProposals } from './proposals/service';
import { HostJobs } from './scheduler/host-jobs';
import { Scheduler } from './scheduler/scheduler';
import { capabilitiesOf, ServerHandle, type EulaAcceptance } from './server/handle';
import type { ServerContext } from './servers/context';
import { NoOrchestrator, type OrchestratorClient } from './servers/orchestrator';
import { OrchestratorHttp } from './servers/orchestrator-http';
import { DbServerRegistry, type AgentParts, type AgentTarget } from './servers/registry';
import { DEFAULT_SERVER_ID, ensureDefaultServer, ServersStore, type ServerRow } from './servers/store';
import { ServerSettings, Settings } from './settings';

/** The game of the server an install's environment describes (`default`). */
export const DEFAULT_ADAPTER = 'pz';

/** What every server's services share from the host. */
export interface HostParts {
  db: Db;
  audit: Audit;
  bus: PanelBus;
  notifier: DiscordNotifier;
  /** The panel's version (recorded in backup manifests). */
  version: string;
}

/** What one server's context is built from besides its row. */
export interface ServerParts {
  adapter: PanelAdapter;
  /** Its agent's API and live mirror: an `AgentClient` in production, fakes in tests. */
  agent: AgentApi;
  feed: AgentFeed;
  /** Starts and stops the agent's event stream (main.ts; tests leave it out). */
  stream?: { start(): void; stop(): void };
  /** Its files: `AgentServerFiles` in production (D11), `LocalServerFiles` in tests. */
  files: ServerFiles;
  /** The secrets the panel holds for it, by `LaunchSecretDecl.key`. */
  secrets: () => Readonly<Record<string, string>>;
  /** Mod sources in place of the adapter's (tests: sources that don't reach the network). */
  mods?: readonly ModSource[];
  /** Where its backups go. */
  backupDir: string;
  /** Before its game starts (the registry's `ServerHooks`). */
  beforeStart?: () => Promise<void>;
  /** Its game's agreement, as accepted now (D6): read live, so an acceptance needs no rebuild. */
  eula?: () => EulaAcceptance;
}

/**
 * One server's context: every service keyed to it, sharing one
 * `ServerHandle` (and so one `ServerRef`), with the listeners each server
 * needs wired (presence history, Discord, what the server coming up
 * triggers). Timers and the agent's stream start with `start()`.
 */
export function createServerContext(host: HostParts, row: ServerRow, parts: ServerParts): ServerContext {
  const { db, audit, bus } = host;
  const { adapter, agent, feed, files } = parts;
  const settings = new ServerSettings(db, row.id);
  const ops = new OpRunner(bus, row.id);
  // Its Discord messages name it, and follow its override of the host's webhook (SCH-03).
  const notifier = host.notifier.forServer({ name: () => row.name, override: () => settings.getRaw<DiscordOverride>(DISCORD_OVERRIDE_KEY) });

  // The server's contexts give adapter code the config store, and the store
  // runs adapter code (afterWrite, presets) with those contexts: late-bound.
  const handle: ServerHandle = new ServerHandle({
    ref: { id: row.id, gameName: row.gameName, flavour: row.flavour },
    secrets: parts.secrets,
    agent,
    feed,
    files,
    settings,
    adapter,
    config: (): ConfigStore => config,
    eula: parts.eula,
  });
  const config: ConfigService = new ConfigService({ db, settings, feed, adapter, server: handle, files });
  const players = new PlayersService({ db, feed, server: handle });
  const mods = new ModsService({ db, feed, ops, settings, config, server: handle, sources: parts.mods ?? adapter.mods ?? [] });
  const backups = new BackupService({ dir: parts.backupDir, panelVersion: host.version, feed, server: handle, mods });
  const control = new Control({ agent, feed, ops, server: handle, backups, beforeStart: parts.beforeStart });
  const flows = new BackupFlows({ agent, feed, ops, control, backups, settings, config, server: handle });
  const scheduler = new Scheduler({ settings, agent, feed, ops, control, flows, backups, mods, notifier, audit });
  const changes = new ConfigProposals({ db, config: () => config, serverId: row.id });

  const unwire = [
    wireNotifications({ serverId: row.id, feed, players, bus, notifier }),
    players.attach(),
    feed.onEvent((e) => {
      if (e.event.type !== 'state' || e.event.status.state !== 'running') return;
      // The server downloads mod updates when it starts; re-read them once it's up.
      void mods.rescan().catch(() => undefined);
      // A restored world that runs no longer needs the files it replaced (the
      // "before restore" backup still has them).
      flows.purgeTrash();
    }),
  ];

  const ctx: ServerContext = {
    id: row.id,
    row,
    adapter,
    agent,
    feed,
    ops,
    settings,
    files,
    handle,
    control,
    config,
    backups,
    flows,
    players,
    mods,
    scheduler,
    notifier,
    changes,
    capabilities: () => capabilitiesOf(ctx.adapter, row.flavour),
    start: () => {
      scheduler.reload();
      parts.stream?.start();
    },
    stop: () => {
      scheduler.stop();
      parts.stream?.stop();
      for (const off of unwire) off();
    },
  };
  return ctx;
}

/**
 * What the panel is built from that differs between builds and tests, each
 * swappable on its own (`PanelDepsOptions.factories`). Production:
 * `FACTORIES`.
 */
export interface PanelFactories {
  /** The orchestrator (D3), from `ORCH_SOCKET`/`ORCH_TOKEN`. */
  orchestrator(env: PanelEnv): OrchestratorClient;
  /** A server's agent: an `AgentClient` at `target` (its address may change: see `AgentTarget`). */
  agent(row: ServerRow, target: AgentTarget): AgentParts;
  /** A server's files (D11: through its agent; tests: on their own disk). */
  files(row: ServerRow, target: AgentTarget, env: PanelEnv): ServerFiles;
}

/** Whether the orchestrator runs this server (it has a spec), rather than Compose (`default`, until adopted). */
export const isManaged = (row: ServerRow): boolean => row.spec !== null;

export const FACTORIES: PanelFactories = {
  // The orchestrator's unix socket (D3); without one, creating servers answers 501 and there is nothing to reconcile.
  orchestrator: (env) => (env.orchestrator ? new OrchestratorHttp(env.orchestrator) : new NoOrchestrator()),
  agent: (_row, target) => {
    const client = new AgentClient(() => target.baseUrl, target.token);
    return { agent: client, feed: client, stream: { start: () => client.startStream(), stop: () => client.stopStream() } };
  },
  // Every server's files, `default`'s included, through its own agent: the panel mounts no game volume (D11).
  files: (_row, target) => new AgentServerFiles(target),
};

/**
 * Where a server's backups go (BAK-01): `BACKUP_DIR/<id>/`, so servers of
 * one adapter never list each other's archives; `default` keeps the folder
 * it always had, the root.
 */
export function backupDirOf(env: PanelEnv, row: ServerRow): string {
  return isManaged(row) ? path.join(env.backupDir, row.id) : env.backupDir;
}

export interface PanelDepsOptions {
  env: PanelEnv;
  db: Db;
  /** The agent of the server the environment describes (`default`) and its live mirror (tests: fakes; else `factories.agent`). */
  agent?: AgentApi;
  feed?: AgentFeed;
  /** Starts and stops that agent's event stream. */
  stream?: { start(): void; stop(): void };
  /** `default`'s game adapter (default: its row's). */
  adapter?: PanelAdapter;
  /** The adapters servers are created from and run with (default: every adapter in `@gsp/adapters`). */
  adapters?: readonly PanelAdapter[];
  /** Mod sources in place of the adapters' (tests: sources that don't reach the network). */
  mods?: readonly ModSource[];
  /** How the Discord notifier reaches Discord (tests: not at all). */
  fetch?: typeof fetch;
  /** The orchestrator (default: `factories.orchestrator(env)`). */
  orchestrator?: OrchestratorClient;
  /** Any of `FACTORIES` replaced (tests: fake agents and local files for orchestrator-run servers). */
  factories?: Partial<PanelFactories>;
}

/**
 * Builds the host's services and the registry of servers: one context per
 * row of `servers`. The environment may describe `default` (its row is
 * written on first boot); throws when that row exists but the environment
 * doesn't say where its agent is, or lacks a secret its adapter needs.
 */
export function createPanelDeps(o: PanelDepsOptions): Deps {
  const { env, db } = o;
  const f: PanelFactories = { ...FACTORIES, ...o.factories };
  const adapters = o.adapters ?? panelAdapters;
  const adapterOf = (id: string): PanelAdapter => {
    const a = adapters.find((x) => x.meta.id === id);
    if (!a) throw new Error(`No panel adapter "${id}"`);
    return a;
  };
  const audit = new Audit(db);
  const settings = new Settings(db);
  const bus = new PanelBus();
  const notifier = new DiscordNotifier(settings, o.fetch);
  const serverRows = new ServersStore(db);
  const users = new Users(db);
  const grants = new ServerGrants(db);
  const host: HostParts = { db, audit, bus, notifier, version: env.version };

  // A `default` row whose environment no longer says where its agent is (a stack
  // without the old game service) is still listed, unreachable, and its owner may remove it.
  ensureDefaultServer(serverRows, { env, adapter: o.adapter ?? adapterOf(DEFAULT_ADAPTER), settings: new ServerSettings(db, DEFAULT_SERVER_ID) });

  const orchestrator = o.orchestrator ?? f.orchestrator(env);
  const servers = new DbServerRegistry({
    env,
    db,
    rows: serverRows,
    orchestrator,
    audit,
    bus,
    users,
    grants,
    tz: process.env.TZ || 'UTC',
    adapterFor: adapterOf,
    agentFor: (row, target) => (!isManaged(row) && o.agent && o.feed ? { agent: o.agent, feed: o.feed, stream: o.stream } : f.agent(row, target)),
    build: (row, target, agent, hooks) => {
      const managed = isManaged(row);
      return createServerContext(host, row, {
        adapter: !managed && o.adapter ? o.adapter : adapterOf(row.adapter),
        ...agent,
        files: f.files(row, target, env),
        // `default`'s secrets are in the environment; every other server's in its row.
        secrets: managed ? () => serverRows.secrets(row.id) : () => env.secrets,
        mods: o.mods,
        backupDir: backupDirOf(env, row),
        beforeStart: managed ? hooks.beforeStart : undefined,
        eula: () => {
          const r = serverRows.get(row.id);
          return { at: r?.eulaAcceptedAt ?? null, by: r?.eulaAcceptedBy ?? null };
        },
      });
    },
  });
  for (const s of servers.list()) {
    const missing = s.handle.missingSecrets();
    if (missing.length && !isManaged(s.row) && env.agentUrl) throw new Error(`${missing.map(secretEnvName).join(', ')} must be set (secrets the ${s.adapter.meta.id} adapter needs)`);
  }

  return {
    env,
    db,
    users,
    grants,
    sessions: new Sessions(db),
    audit,
    settings,
    breaker: new GlobalBreaker((n) => {
      const detail = `${n} failed logins in a minute; logins paused for 60 s`;
      audit.log({ actor: SYSTEM, action: 'security.login-spike', detail, ok: false });
      notifier.notify('security', { detail });
    }),
    bus,
    notifier,
    serverRows,
    servers,
    orchestrator,
    adapters,
    hostJobs: new HostJobs({ audit, backupPanelDb: () => backupPanelDb(db, env.backupDir) }),
  };
}
