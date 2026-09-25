// The panel's composition root: every service, built in the one order they
// depend on each other. main.ts and the tests' harness both build the panel
// here, so the two can't drift apart. With main.ts, the only panel module
// that picks a game adapter (NFR-08).
import type { ModSource, PanelAdapter, ServerFiles } from '@gsp/adapter-api';
import { panelAdapter } from '@gsp/adapters/panel';
import type { AgentApi } from './agent/client';
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
import { LocalServerFiles } from './files/local';
import type { AgentFeed, Deps } from './http/deps';
import { ModsService } from './mods/service';
import { DiscordNotifier } from './notifier/discord';
import { wireNotifications } from './notifier/events';
import { PanelBus } from './ops/bus';
import { OpRunner } from './ops/runner';
import { PlayersService } from './players/service';
import { ConfigProposals } from './proposals/service';
import { HostJobs } from './scheduler/host-jobs';
import { Scheduler } from './scheduler/scheduler';
import { capabilitiesOf, ServerHandle } from './server/handle';
import type { ServerContext } from './servers/context';
import { NoOrchestrator, type OrchestratorClient } from './servers/orchestrator';
import { SingleServerRegistry } from './servers/registry';
import { DEFAULT_SERVER_ID, ensureDefaultServer, ServersStore, type ServerRow } from './servers/store';
import { ServerSettings, Settings } from './settings';

/** The game of the server an install's environment describes (today's single server). */
export const DEFAULT_ADAPTER = 'pz';

/** A game adapter's panel half, by id: the one place the panel picks adapters (NFR-08). */
export function adapterFor(id: string): PanelAdapter {
  return panelAdapter(id);
}

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
  /** Its files: `LocalServerFiles` for the server the environment describes, `AgentServerFiles` once M2-C lands (D11). */
  files: ServerFiles;
  /** The secrets the panel holds for it, by `LaunchSecretDecl.key`. */
  secrets: () => Readonly<Record<string, string>>;
  /** Mod sources in place of the adapter's (tests: sources that don't reach the network). */
  mods?: readonly ModSource[];
  /** Where its backups go. */
  backupDir: string;
  /** Its data root on the panel's disk, for backups, restores and resets until M2-C moves them behind the agent. */
  dataDir: string;
}

/**
 * One server's context: every service keyed to it, sharing one
 * `ServerHandle` (and so one `ServerRef`), with the listeners each server
 * needs wired (presence history, Discord, what the server coming up
 * triggers). Timers and the agent's stream start with `start()`.
 */
export function createServerContext(host: HostParts, row: ServerRow, parts: ServerParts): ServerContext {
  const { db, audit, bus, notifier } = host;
  const { adapter, agent, feed, files } = parts;
  const settings = new ServerSettings(db, row.id);
  const ops = new OpRunner(bus, row.id);

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
  });
  const config: ConfigService = new ConfigService({ db, settings, feed, adapter, server: handle, files });
  const players = new PlayersService({ db, feed, server: handle });
  const mods = new ModsService({ db, feed, ops, settings, config, server: handle, sources: parts.mods ?? adapter.mods ?? [] });
  const backups = new BackupService({ dir: parts.backupDir, dataDir: parts.dataDir, panelVersion: host.version, feed, server: handle, mods });
  const control = new Control({ agent, feed, ops, server: handle, backups });
  const flows = new BackupFlows({ agent, feed, ops, control, backups, settings, config, server: handle, dataDir: parts.dataDir });
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

export interface PanelDepsOptions {
  env: PanelEnv;
  db: Db;
  /** The agent of the server the environment describes and its live mirror: one `AgentClient` in production, fakes in tests. */
  agent: AgentApi;
  feed: AgentFeed;
  /** Starts and stops that agent's event stream (main.ts). */
  stream?: { start(): void; stop(): void };
  /** That server's game adapter (default: its row's). */
  adapter?: PanelAdapter;
  /** Mod sources in place of the adapter's (tests: sources that don't reach the network). */
  mods?: readonly ModSource[];
  /** How the Discord notifier reaches Discord (tests: not at all). */
  fetch?: typeof fetch;
  /** The orchestrator (default: none yet, M2-A). */
  orchestrator?: OrchestratorClient;
}

/**
 * Builds the host's services and the registry of servers. Today that is the
 * one server the environment describes (`default`, whose row is written on
 * first boot). Throws when its adapter needs a secret the environment
 * doesn't have.
 */
export function createPanelDeps(o: PanelDepsOptions): Deps {
  const { env, db } = o;
  const audit = new Audit(db);
  const settings = new Settings(db);
  const bus = new PanelBus();
  const notifier = new DiscordNotifier(settings, o.fetch);
  const serverRows = new ServersStore(db);

  ensureDefaultServer(serverRows, { env, adapter: o.adapter ?? adapterFor(DEFAULT_ADAPTER), settings: new ServerSettings(db, DEFAULT_SERVER_ID) });
  const row = serverRows.get(DEFAULT_SERVER_ID);
  if (!row) throw new Error(`No "${DEFAULT_SERVER_ID}" server: the environment must describe one (AGENT_URL, AGENT_TOKEN) until the server list lands`);
  const adapter = o.adapter ?? adapterFor(row.adapter);
  const host: HostParts = { db, audit, bus, notifier, version: env.version };
  // The server the environment describes: its files on the panel's own mounts, its secrets in the environment.
  const only = createServerContext(host, row, {
    adapter,
    agent: o.agent,
    feed: o.feed,
    stream: o.stream,
    files: new LocalServerFiles({ data: env.pzDataDir, install: env.pzInstallDir }),
    secrets: () => env.secrets,
    mods: o.mods,
    backupDir: env.backupDir,
    dataDir: env.pzDataDir,
  });
  const missing = only.handle.missingSecrets();
  if (missing.length) throw new Error(`${missing.map(secretEnvName).join(', ')} must be set (secrets the ${adapter.meta.id} adapter needs)`);

  return {
    env,
    db,
    users: new Users(db),
    grants: new ServerGrants(db),
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
    servers: new SingleServerRegistry(only),
    orchestrator: o.orchestrator ?? new NoOrchestrator(),
    hostJobs: new HostJobs({ audit, backupPanelDb: () => backupPanelDb(db, env.backupDir) }),
  };
}
