import type { PanelAdapter, ServerFiles } from '@gsp/adapter-api';
import type { AgentStatus, SeqEvent } from '@gsp/shared';
import type { AgentApi } from '../agent/client';
import type { Audit } from '../audit';
import type { Sessions } from '../auth/sessions';
import type { GlobalBreaker } from '../auth/throttle';
import type { Users } from '../auth/users';
import type { Db } from '../db/db';
import type { PanelEnv } from '../env';
import type { BackupFlows } from '../backups/flows';
import type { BackupService } from '../backups/service';
import type { ConfigStore } from '../config/store';
import type { Control } from '../control/control';
import type { PanelBus } from '../ops/bus';
import type { OpRunner } from '../ops/runner';
import type { ModsService } from '../mods/service';
import type { DiscordNotifier } from '../notifier/discord';
import type { Scheduler } from '../scheduler/scheduler';
import type { PlayersService } from '../players/service';
import type { ProposalService } from '../proposals/service';
import type { ServerHandle } from '../server/handle';
import type { Settings } from '../settings';

/** The live agent mirror the websocket hub fans out. */
export interface AgentFeed {
  readonly connected: boolean;
  readonly status_: AgentStatus | null;
  recentLogs(): SeqEvent[];
  onEvent(l: (e: SeqEvent) => void): () => void;
}

/** Everything routes use; built only by `createPanelDeps` (wiring.ts). */
export interface Deps {
  env: PanelEnv;
  db: Db;
  users: Users;
  sessions: Sessions;
  audit: Audit;
  settings: Settings;
  breaker: GlobalBreaker;
  agent: AgentApi;
  feed: AgentFeed;
  bus: PanelBus;
  ops: OpRunner;
  /** The server (one until M2): its ref, adapter, launch settings, secrets and contexts; every service shares it. */
  server: ServerHandle;
  control: Control;
  config: ConfigStore;
  backups: BackupService;
  flows: BackupFlows;
  players: PlayersService;
  mods: ModsService;
  notifier: DiscordNotifier;
  scheduler: Scheduler;
  /** The server's files (CFG-07; through its agent from M2, D11). */
  files: ServerFiles;
  /** Change proposals (AST-03). */
  changes: ProposalService;
  /** The game adapter's panel half (the one server's, until M2). */
  adapter: PanelAdapter;
}
