import type { PanelAdapter } from '@gsp/adapter-api';
import type { AgentStatus, SeqEvent } from '@gsp/shared';
import type { Audit } from '../audit';
import type { ServerGrants } from '../auth/grants';
import type { Sessions } from '../auth/sessions';
import type { GlobalBreaker } from '../auth/throttle';
import type { Users } from '../auth/users';
import type { Db } from '../db/db';
import type { PanelEnv } from '../env';
import type { HostAddress } from '../host/address';
import type { HostOverviewService } from '../host/overview';
import type { HostTraitsCache } from '../host/traits';
import type { DiscordNotifier } from '../notifier/discord';
import type { PanelBus } from '../ops/bus';
import type { HostJobs } from '../scheduler/host-jobs';
import type { LaunchChoicesService } from '../servers/choices';
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
  /** The one component with Docker access (D3); `NoOrchestrator` until M2-A's client is wired. */
  orchestrator: OrchestratorClient;
  /** The game adapters' panel halves servers can be created from (SRV-01). */
  adapters: readonly PanelAdapter[];
  /** The host's own jobs (the panel database's nightly copy). */
  hostJobs: HostJobs;
  /** What a game's version may be set to, from its download services (UPD-02). */
  choices: LaunchChoicesService;
  /** The host's public and home-network addresses (HST-08), for every server's connection info (SRV-08). */
  hostAddress: HostAddress;
  /** The host as the orchestrator describes it, kept a minute: its traits for the notes where they matter (HST-07). */
  hostTraits: HostTraitsCache;
  /** The host overview (HST-03, SRV-05, HST-07). */
  hostOverview: HostOverviewService;
}
