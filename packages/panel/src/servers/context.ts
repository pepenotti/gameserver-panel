import type { Capability, PanelAdapter, ServerFiles } from '@gsp/adapter-api';
import type { AgentApi } from '../agent/client';
import type { BackupFlows } from '../backups/flows';
import type { BackupService } from '../backups/service';
import type { ConfigStore } from '../config/store';
import type { Control } from '../control/control';
import type { AgentFeed } from '../http/deps';
import type { ModsService } from '../mods/service';
import type { Notify } from '../notifier/discord';
import type { OpRunner } from '../ops/runner';
import type { PlayersService } from '../players/service';
import type { PluginsService } from '../plugins/service';
import type { ProposalService } from '../proposals/service';
import type { Scheduler } from '../scheduler/scheduler';
import type { ServerHandle } from '../server/handle';
import type { ServerSettings } from '../settings';
import type { ServerRow } from './store';

/**
 * One game server as the panel runs it (M2, G1): its stored row, its game
 * adapter, the agent that runs it, and every service keyed to it. The
 * registry holds one per server; routes under `/api/servers/:sid` get theirs
 * on the request (`req.srv`). Nothing in one context reaches another
 * server's data.
 */
export interface ServerContext {
  readonly id: string;
  /** As stored (without secrets). */
  readonly row: ServerRow;
  /** The game adapter's panel half. */
  adapter: PanelAdapter;
  /** The server's agent: its API… */
  readonly agent: AgentApi;
  /** …and the live mirror of its event stream. */
  readonly feed: AgentFeed;
  /** One heavy operation at a time on this server (restart, backup, restore…); other servers aren't held up. */
  readonly ops: OpRunner;
  /** The server's own settings (`server_settings`). */
  readonly settings: ServerSettings;
  /** The server's files (D11: through its agent once M2-C lands `AgentServerFiles`). */
  readonly files: ServerFiles;
  /** Its ref, launch settings, secrets, and the `ServerCtx` adapter code runs with. */
  readonly handle: ServerHandle;
  readonly control: Control;
  readonly config: ConfigStore;
  readonly backups: BackupService;
  readonly flows: BackupFlows;
  readonly players: PlayersService;
  readonly mods: ModsService;
  /** Plugin files people bring (MOD-06), for a flavour that takes them. */
  readonly plugins: PluginsService;
  readonly scheduler: Scheduler;
  /** Its Discord messages: the host's webhook or its own override (SCH-03), each naming the server. */
  readonly notifier: Notify;
  /** Change proposals for its files (AST-03). */
  readonly changes: ProposalService;
  /** What its game supports: its flavour's capabilities, or the adapter's. */
  capabilities(): Set<Capability>;
  /** Timers and the agent's event stream (a running panel; tests leave them off). */
  start(): void;
  /** Stops them again; for removal and shutdown. */
  stop(): void;
}
