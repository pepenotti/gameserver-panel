// The panel's composition root: every service, built in the one order they
// depend on each other. main.ts and the tests' harness both build the panel
// here, so the two can't drift apart. With main.ts, the only panel module
// that picks a game adapter (NFR-08).
import type { ModSource, PanelAdapter } from '@gsp/adapter-api';
import { panelAdapter } from '@gsp/adapters/panel';
import type { AgentApi } from './agent/client';
import { Audit, SYSTEM } from './audit';
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
import { Scheduler } from './scheduler/scheduler';
import { ServerHandle } from './server/handle';
import { ServerSettings, Settings } from './settings';
import { DEFAULT_SERVER_ID, ensureDefaultServer, ServersStore } from './servers/store';

/** The game of the panel's one server until M2 lets each server pick its adapter. */
export const DEFAULT_ADAPTER = 'pz';

export interface PanelDepsOptions {
  env: PanelEnv;
  db: Db;
  /** The agent's API and its live mirror: one `AgentClient` in production, fakes in tests. */
  agent: AgentApi;
  feed: AgentFeed;
  /** The server's game adapter (default: `DEFAULT_ADAPTER`'s). */
  adapter?: PanelAdapter;
  /** Mod sources in place of the adapter's (tests: sources that don't reach the network). */
  mods?: readonly ModSource[];
  /** How the Discord notifier reaches Discord (tests: not at all). */
  fetch?: typeof fetch;
}

/**
 * Builds every service the routes use, sharing one `ServerHandle` (and so
 * one `ServerRef`), and wires the listeners every panel needs: the players'
 * presence history, Discord, and what a server coming up triggers. Timers
 * and the agent's event stream are the caller's (main.ts starts them).
 * Throws when the adapter needs a secret the environment doesn't have.
 */
export function createPanelDeps(o: PanelDepsOptions): Deps {
  const { env, db, agent, feed } = o;
  const adapter = o.adapter ?? panelAdapter(DEFAULT_ADAPTER);
  const audit = new Audit(db);
  const settings = new Settings(db);
  // The one server until the registry serves several (M2-B): the environment describes it.
  const serverSettings = new ServerSettings(db, DEFAULT_SERVER_ID);
  ensureDefaultServer(new ServersStore(db), { env, adapter, settings: serverSettings });
  const bus = new PanelBus();
  const ops = new OpRunner(bus);
  const notifier = new DiscordNotifier(settings, o.fetch);
  const files = new LocalServerFiles({ data: env.pzDataDir, install: env.pzInstallDir });

  // The server's contexts give adapter code the config store, and the store
  // runs adapter code (afterWrite, presets) with those contexts: late-bound.
  const server: ServerHandle = new ServerHandle({ env, agent, feed, files, settings: serverSettings, adapter, config: (): ConfigStore => config });
  const missing = server.missingSecrets();
  if (missing.length) throw new Error(`${missing.map(secretEnvName).join(', ')} must be set (secrets the ${adapter.meta.id} adapter needs)`);
  const config: ConfigService = new ConfigService({ db, settings: serverSettings, feed, adapter, server, files });

  const players = new PlayersService({ db, feed, server });
  const mods = new ModsService({ db, feed, ops, settings: serverSettings, config, server, sources: o.mods ?? adapter.mods ?? [] });
  const backups = new BackupService({ env, feed, server, mods });
  const control = new Control({ agent, feed, ops, server, backups });
  const flows = new BackupFlows({ agent, feed, ops, control, backups, settings: serverSettings, config, server, dataDir: env.pzDataDir });
  const scheduler = new Scheduler({ settings: serverSettings, agent, feed, ops, control, flows, backups, mods, notifier, audit, backupPanelDb: () => backupPanelDb(db, env.backupDir) });

  const deps: Deps = {
    env,
    db,
    users: new Users(db),
    sessions: new Sessions(db),
    audit,
    settings,
    breaker: new GlobalBreaker((n) => {
      const detail = `${n} failed logins in a minute; logins paused for 60 s`;
      audit.log({ actor: SYSTEM, action: 'security.login-spike', detail, ok: false });
      notifier.notify('security', { detail });
    }),
    agent,
    feed,
    bus,
    ops,
    server,
    control,
    config,
    backups,
    flows,
    players,
    mods,
    notifier,
    scheduler,
    files,
    changes: new ConfigProposals({ db, config: () => deps.config, serverId: server.ref.id }),
    adapter,
  };

  wireNotifications({ feed, players, bus, notifier });
  players.attach();
  feed.onEvent((e) => {
    if (e.event.type !== 'state' || e.event.status.state !== 'running') return;
    // The server downloads mod updates when it starts; re-read them once it's up.
    void mods.rescan().catch(() => undefined);
    // A restored world that runs no longer needs the files it replaced (the
    // "before restore" backup still has them).
    flows.purgeTrash();
  });
  return deps;
}
