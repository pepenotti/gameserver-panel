import type { AgentStatus, SeqEvent } from '@gsp/shared';
import type { Audit } from '../audit';
import type { ServerGrants } from '../auth/grants';
import type { Sessions } from '../auth/sessions';
import type { GlobalBreaker } from '../auth/throttle';
import type { Users } from '../auth/users';
import type { Db } from '../db/db';
import type { PanelEnv } from '../env';
import type { DiscordNotifier } from '../notifier/discord';
import type { PanelBus } from '../ops/bus';
import type { HostJobs } from '../scheduler/host-jobs';
import type { OrchestratorClient } from '../servers/orchestrator';
import type { ServerRegistry } from '../servers/registry';
import type { ServersStore } from '../servers/store';
import type { Settings } from '../settings';

/** The live agent mirror the websocket hub fans out. */
export interface AgentFeed {
  readonly connected: boolean;
  readonly status_: AgentStatus | null;
  recentLogs(): SeqEvent[];
  onEvent(l: (e: SeqEvent) => void): () => void;
}

/**
 * What the host has, once, for every server: accounts, grants, sessions,
 * the audit log, host settings, Discord, the event bus, and the registry of
 * servers (each a `ServerContext` with its own services). Built only by
 * `createPanelDeps` (wiring.ts).
 */
export interface Deps {
  env: PanelEnv;
  db: Db;
  users: Users;
  /** Per-server roles (ACC-02). */
  grants: ServerGrants;
  sessions: Sessions;
  audit: Audit;
  /** The host's settings (the Discord webhook…); each server has its own in its context. */
  settings: Settings;
  breaker: GlobalBreaker;
  /** Panel events of every server (operations, notices), for the websocket. */
  bus: PanelBus;
  notifier: DiscordNotifier;
  /** The `servers` table. */
  serverRows: ServersStore;
  /** The servers the panel runs (M2). */
  servers: ServerRegistry;
  /** The one component with Docker access (D3); a stub until M2-A. */
  orchestrator: OrchestratorClient;
  /** The host's own jobs (the panel database's nightly copy). */
  hostJobs: HostJobs;
}
