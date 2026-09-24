import { existsSync } from 'node:fs';
import path from 'node:path';
import { AgentClient } from './agent/client';
import { buildApp } from './app';
import { Audit } from './audit';
import { bootstrapOwner } from './auth/bootstrap';
import { Sessions } from './auth/sessions';
import { GlobalBreaker } from './auth/throttle';
import { Users } from './auth/users';
import { openDb } from './db/db';
import { loadEnv } from './env';
import type { Deps } from './http/deps';
import { BackupFlows } from './backups/flows';
import { backupPanelDb } from './backups/panel-db';
import { BackupService } from './backups/service';
import { ConfigService } from './config/service';
import { Control } from './control/control';
import { PanelBus } from './ops/bus';
import { OpRunner } from './ops/runner';
import { ModsService } from './mods/service';
import { DiscordNotifier } from './notifier/discord';
import { wireNotifications } from './notifier/events';
import { Scheduler } from './scheduler/scheduler';
import { SteamWorkshop } from './mods/steam';
import { PlayersService } from './players/service';
import { Settings } from './settings';

const env = loadEnv();
const db = openDb(env.dataDir);
const audit = new Audit(db);
const users = new Users(db);
const agent = new AgentClient(env.agentUrl, env.agentToken);
const settings = new Settings(db);
const bus = new PanelBus();
const ops = new OpRunner(bus);
const notifier = new DiscordNotifier(settings);
const deps: Deps = {
  env,
  db,
  users,
  sessions: new Sessions(db),
  audit,
  settings,
  breaker: new GlobalBreaker((n) => {
    const detail = `${n} failed logins in a minute; logins paused for 60 s`;
    audit.log({ action: 'security.login-spike', detail, ok: false });
    notifier.notify('security', { detail });
  }),
  agent,
  feed: agent,
  bus,
  ops,
  control: new Control({ env, settings, agent, feed: agent, ops, audit }),
  config: new ConfigService({ env, db, agent, feed: agent, settings }),
  backups: new BackupService({ env, feed: agent }),
  flows: undefined as unknown as BackupFlows,
  players: new PlayersService({ env, db, agent, feed: agent }),
  mods: undefined as unknown as ModsService,
  notifier,
  scheduler: undefined as unknown as Scheduler,
};
deps.mods = new ModsService({ env, db, agent, feed: agent, ops, settings, config: deps.config, steam: new SteamWorkshop() });
deps.flows = new BackupFlows({ agent, feed: agent, ops, control: deps.control, backups: deps.backups, settings, config: deps.config, pzDataDir: env.pzDataDir });
deps.scheduler = new Scheduler({ settings, agent, feed: agent, ops, control: deps.control, flows: deps.flows, backups: deps.backups, mods: deps.mods, notifier, audit, backupPanelDb: () => backupPanelDb(db, deps.env.backupDir) });
deps.control.beforeUpdateInstall = async () => {
  // Only when there is a world to protect.
  if (deps.backups.partPaths('world').some((p) => existsSync(path.join(env.pzDataDir, p)))) await deps.backups.create({ trigger: 'pre-update', hot: false });
};
wireNotifications({ feed: agent, players: deps.players, bus, notifier });
agent.onEvent((e) => {
  if (e.event.type !== 'state' || e.event.status.state !== 'running') return;
  // The server downloads mod updates when it starts; re-read them once it's up.
  deps.mods.rescan();
  // A restored world that runs no longer needs the files it replaced (the
  // "before restore" backup still has them).
  deps.flows.purgeTrash();
});
deps.scheduler.reload();
deps.players.attach();
deps.control.onBeforeStart = () => deps.config.seedIniIfMissing();

await bootstrapOwner(deps);
agent.startStream();
setInterval(() => deps.sessions.purgeExpired(), 3_600_000).unref();

const app = await buildApp(deps, { logger: true });
await app.listen({ host: env.host, port: env.port });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    agent.stopStream();
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
