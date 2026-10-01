import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { Capability, PanelAdapter } from '@gsp/adapter-api';
import type { AgentApi } from '../agent/client';
import { changedDerivation, isServerId, newerImage, type HostInfo, type ServerContainer, type ServerSpec } from '@gsp/shared';
import { SYSTEM, type Actor, type Audit } from '../audit';
import { syncRoleWithGrants, type ServerGrants } from '../auth/grants';
import type { Users } from '../auth/users';
import type { Db } from '../db/db';
import type { PanelEnv } from '../env';
import { HttpError } from '../http/context';
import type { AgentFeed } from '../http/deps';
import type { PanelBus } from '../ops/bus';
import { launchBodyProblem, launchRefusal } from '../routes/server';
import { capabilitiesOf } from '../server/handle';
import { ServerSettings } from '../settings';
import type { ServerContext } from './context';
import { OrchestratorCallError, type OrchestratorClient } from './orchestrator';
import { AGENT_TOKEN_SECRET, buildSpec, planPorts, redactSpec, takenPorts } from './spec';
import { DEFAULT_SERVER_ID, type ServerPatch, type ServerRow, type ServersStore } from './store';

/** What SRV-01 asks for when a server is created. */
export interface CreateServerInput {
  /** `SERVER_ID_PATTERN`. */
  id: string;
  name: string;
  /** Adapter id; must run on the host's architecture (HST-05). */
  adapter: string;
  flavour?: string | null;
  /** The adapter's launch settings over its defaults (version, memory…). */
  launch?: Record<string, unknown>;
  /** Host ports by `PortDecl.id`; missing ones get free ports near the adapter's defaults. */
  ports?: Record<string, number>;
  /** Container memory limit; default: the launch settings' memory plus the adapter's overhead. */
  memLimitMb?: number;
  cpus?: number | null;
  /** The owner accepted the game's EULA (D6), for adapters with the `eula` capability. */
  eulaAccepted?: boolean;
  /**
   * Whether `by` may accept a game's EULA (`server.eula`: the owner); default
   * true. One who may must accept it to create the server; one who may not
   * creates it with the EULA pending, and it can't start until the owner
   * accepts (`acceptEula`).
   */
  mayAcceptEula?: boolean;
  by: Actor;
  /** Where the request came from, for the audit log. */
  ip?: string | null;
}

export interface RemoveServerOptions {
  /** What the person typed: must be the server's name (SRV-04). */
  confirm: string;
  /** Keep the server's backups (SRV-04: kept unless the owner chooses otherwise). */
  keepBackups: boolean;
  /** Take the final backup first (default); only the owner may skip it, for a server whose data can't be reached. */
  finalBackup?: boolean;
  /**
   * The owner's way out for a server that can't be stopped normally, whose
   * container won't run or whose agent can't be reached (without it, 409
   * `server-unreachable`): removed even while its game runs or an operation
   * holds it, without waiting for the game to stop. The final backup is
   * still taken when it can be; when it can't, the removal goes on without
   * it and says why (`finalBackupError`).
   */
  force?: boolean;
  by: Actor;
  ip?: string | null;
}

export interface RemoveReport {
  /** The final backup's archive name; null when none was taken. */
  finalBackup: string | null;
  /** Whether the removal was forced. */
  forced: boolean;
  /** Forced only: why the final backup couldn't be taken (null: it was, or none was asked for). */
  finalBackupError: string | null;
}

/** Seconds a forced removal gives the game to stop before Docker kills it. */
const FORCED_STOP_SEC = 10;

/**
 * Why a server's container waits for its game's next start (SRV-05):
 * `settings` changed (new memory or CPU limits, and the like), its runtime
 * `image` was rebuilt since it was created, or the orchestrator now builds
 * containers another way (`derivation`); the last two come with a product
 * upgrade.
 */
export type ContainerPendingReason = 'settings' | 'image' | 'derivation';

/** What `reconcile` changed to bring containers in line with the servers table (SRV-06). */
export interface ReconcileReport {
  /** Containers created or recreated from their row's spec. */
  applied: string[];
  /** Containers started again (they were created, stopped or exited). */
  started: string[];
  /** Containers of this stack with no row (left alone, reported). */
  orphans: string[];
  /** Servers the orchestrator couldn't bring up, with why. */
  failed: { id: string; error: string }[];
}

/**
 * The servers the panel runs (PRD §10 "a server registry"): one
 * `ServerContext` each, built from the `servers` table. Creating and
 * removing servers goes through the orchestrator (D3); `reconcile` brings
 * containers back in line with the table after a panel, Docker or host
 * restart (SRV-06).
 */
export interface ServerRegistry {
  /** Every server, in the table's order. */
  list(): ServerContext[];
  get(id: string): ServerContext | null;
  /** SRV-01: validate, write the row, ask the orchestrator for the container, build the context. */
  create(input: CreateServerInput): Promise<ServerContext>;
  /**
   * Rename, reorder, or new memory and CPU limits (SRV-05); the server's
   * context is rebuilt around its new row. New limits recreate its container
   * at once when its game isn't running, else at the game's next start.
   */
  update(id: string, patch: ServerPatch, by: Actor, ip?: string | null): Promise<ServerContext>;
  /**
   * SRV-05: the game's launch settings are about to become `launch`. When
   * that changes the memory the game takes, the container's limit moves with
   * it (keeping the room it had above the game's), as `update` does.
   */
  followLaunch(id: string, launch: Record<string, unknown>, by: Actor, ip?: string | null): Promise<void>;
  /**
   * Before a server's game starts: a container whose settings changed,
   * whose runtime image was rebuilt since, or that the orchestrator now
   * builds another way, is recreated first, and its agent waited for.
   */
  prepareStart(id: string): Promise<void>;
  /** Whether a server's container waits to be recreated (`ContainerPendingReason`) at its game's next start. */
  containerPending(id: string): boolean;
  /** Why it waits; none when it doesn't. */
  containerPendingReasons(id: string): ContainerPendingReason[];
  /**
   * D6: the owner accepts the game's agreement (the route checks
   * `server.eula`); recorded with who and when, and audited. The server may
   * start from then on. 409 `eula-not-needed` for a game without one; a
   * second acceptance changes nothing.
   */
  acceptEula(id: string, by: Actor, ip?: string | null): ServerContext;
  /** SRV-04: final backup, container and volumes removed, then the row and everything keyed to it. */
  remove(id: string, o: RemoveServerOptions): Promise<RemoveReport>;
  reconcile(): Promise<ReconcileReport>;
  /** A running panel: reconcile, then start every server's timers and agent stream (retrying what failed). */
  start(): Promise<ReconcileReport>;
  /** Stops them again (shutdown). */
  stop(): void;
}

/** 501 while a piece the operation needs isn't in this build. */
export function notImplemented(what: string): HttpError {
  return new HttpError(501, 'not-implemented', `${what} is not implemented yet`);
}

/** Where a server's agent answers and its token (`files/agent.ts`'s `AgentFilesTarget`); `baseUrl` may change. */
export interface AgentTarget {
  readonly baseUrl: string;
  readonly token: string;
}

/** A server's agent API, its live mirror, and its event stream. */
export interface AgentParts {
  agent: AgentApi;
  feed: AgentFeed;
  stream?: { start(): void; stop(): void };
}

export interface RegistryDeps {
  env: PanelEnv;
  db: Db;
  rows: ServersStore;
  orchestrator: OrchestratorClient;
  audit: Audit;
  bus: PanelBus;
  users: Users;
  grants: ServerGrants;
  /** tz database name the servers' containers run in. */
  tz: string;
  /** A game adapter's panel half by id; throws for an unknown one. */
  adapterFor(id: string): PanelAdapter;
  /** A server's agent client, where its agent answers (made once per server). */
  agentFor(row: ServerRow, target: AgentTarget): AgentParts;
  /** One server's context, from its row, where its agent answers, its agent client, and the registry's hooks (wiring.ts). */
  build(row: ServerRow, target: AgentTarget, agent: AgentParts, hooks: ServerHooks): ServerContext;
}

/** What a server's context calls back into the registry for. */
export interface ServerHooks {
  /** Before its game starts (`Control.startAgent`): a container waiting for changed settings is recreated first (SRV-05). */
  beforeStart(): Promise<void>;
}

/** Game states in which recreating the container would stop someone's game (or an install). */
const GAME_ACTIVE: ReadonlySet<string> = new Set(['installing', 'starting', 'running', 'stopping']);

/** How long a recreated container's agent gets to answer before the game is started (a real boot takes a few seconds). */
const AGENT_BACK_MS = 120_000;

/** How the audit log says what a container was recreated with. */
const RECREATED_WITH: Record<ContainerPendingReason, string> = {
  settings: 'with its changed settings',
  image: 'on a newer runtime image',
  derivation: 'the way this panel version builds containers',
};

/** The audit log's word for a container recreated at once because it was built before a security fix (NFR-02). */
const SECURITY_RECREATED = 'container recreated at once for a security fix in how containers are built, without waiting for its game to stop (a running game starts again in it)';

/** Whether a spec is the one stored (`servers.spec`, without the agent token). */
function sameSpec(spec: ServerSpec, stored: ServerSpec | null): boolean {
  return JSON.stringify(redactSpec(spec)) === JSON.stringify(stored);
}

/**
 * Ids nobody may create: `default` is the server an install's environment
 * describes, and `panel` is the folder the panel database's copies go to
 * next to each server's backup folder (`BACKUP_DIR/<id>/`).
 */
export const RESERVED_SERVER_IDS = [DEFAULT_SERVER_ID, 'panel'] as const;

const NAME_MAX = 64;

/** A server name as stored: trimmed, one line, 1–64 characters. */
function cleanName(name: string): string {
  const n = name.trim();
  if (n.length === 0 || n.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(n)) throw new HttpError(400, 'invalid-server-name');
  return n;
}

/** An orchestrator failure as the API answers it. */
export function orchestratorError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (!(e instanceof OrchestratorCallError)) return new HttpError(502, 'orchestrator-error', (e as Error).message, { message: (e as Error).message });
  const extra = { message: e.message, ...(e.field ? { field: e.field } : {}) };
  switch (e.code) {
    case 'not-implemented':
      return notImplemented('Running servers through the orchestrator');
    case 'unreachable':
    case 'unavailable':
      return new HttpError(503, 'orchestrator-unavailable', e.message, extra);
    case 'refused':
      return new HttpError(409, 'orchestrator-refused', e.message, extra);
    case 'conflict':
      // A host port another program has, or the server is being changed by another request.
      return new HttpError(409, e.field?.startsWith('ports') ? 'port-conflict' : 'orchestrator-conflict', e.message, extra);
    default:
      return new HttpError(502, 'orchestrator-error', e.message, extra);
  }
}

/**
 * A memory limit above what this install gives one server (`ORCH_MAX_MEM_MB`,
 * SRV-05): refused before the orchestrator is asked, with the limit it has.
 */
export function memoryAboveHost(memLimitMb: number, maxMb: number): HttpError {
  const message = `A memory limit of ${memLimitMb} MiB is above this host's limit of ${maxMb} MiB per server (ORCH_MAX_MEM_MB)`;
  return new HttpError(409, 'orchestrator-refused', message, { field: 'memLimitMb', maxMb, message });
}

/** The TCP ports people reach the panel on (its origins) and the one it listens on: never a game's. */
function panelPorts(env: PanelEnv): number[] {
  const out = env.origins.map((o) => {
    const u = new URL(o);
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  });
  if (env.listen.kind === 'tcp' && env.listen.port > 0) out.push(env.listen.port);
  return [...new Set(out)];
}

/** The memory the adapter's launch settings give the game, MiB (its `memory` option), else its default. */
function gameMemoryMb(adapter: PanelAdapter, launch: Record<string, unknown>): number {
  const key = adapter.launch.schema.find((o) => o.role === 'memory')?.key;
  const v = key === undefined ? undefined : launch[key];
  return typeof v === 'number' ? v : adapter.meta.memory.defaultMb;
}

/** The smallest container memory limit for these launch settings (SRV-05): the game's memory, at least the adapter's minimum, plus its overhead. */
export function memoryNeedMb(adapter: PanelAdapter, launch: Record<string, unknown>): number {
  return Math.max(adapter.meta.memory.minMb, gameMemoryMb(adapter, launch)) + adapter.meta.memory.overheadMb;
}

/**
 * The registry over the `servers` table (M2, G1). `default` (a row without
 * a spec) is the server the environment describes: Compose runs its
 * container, the panel reaches it at `AGENT_URL`, and this registry never
 * applies, starts or removes it. Every other server is the orchestrator's.
 * Changes to the set of servers run one at a time.
 */
export class DbServerRegistry implements ServerRegistry {
  private readonly contexts = new Map<string, ServerContext>();
  /** Where each orchestrator-run server's agent answers, from its container. */
  private readonly agentUrls = new Map<string, string>();
  private readonly agents = new Map<string, AgentParts>();
  /** Servers whose container runs an older runtime image than its tag names now, as the orchestrator last said (HST-01). */
  private readonly olderImage = new Set<string>();
  /** Servers whose container the orchestrator would build another way now, as it last said (SRV-06). */
  private readonly olderDerivation = new Set<string>();
  private readonly running = new Set<ServerContext>();
  private order: string[] = [];
  private live = false;
  private retry: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: RegistryDeps) {
    for (const row of d.rows.list()) this.contexts.set(row.id, this.build(row));
    this.order = d.rows.list().map((r) => r.id);
  }

  list(): ServerContext[] {
    return this.order.map((id) => this.contexts.get(id)).filter((c): c is ServerContext => c !== undefined);
  }

  get(id: string): ServerContext | null {
    return this.contexts.get(id) ?? null;
  }

  // ---------------------------------------------------------------- building

  private target(row: ServerRow): AgentTarget {
    if (row.spec === null) return { baseUrl: this.d.env.agentUrl, token: this.d.env.agentToken };
    const urls = this.agentUrls;
    return {
      get baseUrl() {
        return urls.get(row.id) ?? '';
      },
      token: this.d.rows.secrets(row.id)[AGENT_TOKEN_SECRET] ?? '',
    };
  }

  /**
   * A server's context. Its agent client is made once and kept across
   * rebuilds (a rename), so the live status, the log backlog and the event
   * stream carry over; it goes with the server.
   */
  private build(row: ServerRow): ServerContext {
    const target = this.target(row);
    let agent = this.agents.get(row.id);
    if (!agent) {
      agent = this.d.agentFor(row, target);
      this.agents.set(row.id, agent);
    }
    return this.d.build(row, target, agent, { beforeStart: () => this.prepareStart(row.id) });
  }

  /** The spec a row asks for, with its agent token (from its secrets). */
  private specOf(row: ServerRow): ServerSpec {
    const token = this.d.rows.secrets(row.id)[AGENT_TOKEN_SECRET];
    if (!token) throw new Error('no agent token stored');
    return buildSpec(row, this.d.adapterFor(row.adapter), { agentToken: token, tz: this.d.tz, variant: this.d.env.serverImageVariant });
  }

  private async host(): Promise<HostInfo> {
    try {
      return await this.d.orchestrator.host();
    } catch (e) {
      throw orchestratorError(e);
    }
  }

  /** Whether a server's game is up or on its way, as its agent says; an agent that doesn't answer runs nothing. */
  private async gameActive(id: string): Promise<boolean> {
    const status = await this.agents
      .get(id)
      ?.agent.status()
      .catch(() => null);
    return !!status && GAME_ACTIVE.has(status.state);
  }

  /** What the orchestrator said about a server's container; notes whether a newer runtime image or derivation waits for it. */
  private seen(c: ServerContainer): ServerContainer {
    if (newerImage(c)) this.olderImage.add(c.id);
    else this.olderImage.delete(c.id);
    // A missing container, or an orchestrator that doesn't say: what it said last stands.
    if (c.derivation !== undefined) {
      if (changedDerivation(c)) this.olderDerivation.add(c.id);
      else this.olderDerivation.delete(c.id);
    }
    return c;
  }

  /** Whether a newer runtime image or derivation waits for any server, as the orchestrator says now; when it can't say, what it said last stands. */
  private async refreshContainers(): Promise<void> {
    try {
      for (const c of await this.d.orchestrator.list()) this.seen(c);
    } catch {
      // Unreachable or not in this build: nothing new to learn.
    }
  }

  /**
   * The row's container, created or recreated from it (volumes kept, on the
   * runtime image its tag names now) and running; the spec is stored once
   * both worked. Failures are the API's.
   */
  private async applySpec(row: ServerRow): Promise<ServerContainer> {
    const spec = this.specOf(row);
    try {
      let c = this.seen(await this.d.orchestrator.apply(spec));
      if (c.state !== 'running') c = this.seen(await this.d.orchestrator.start(row.id));
      this.agentUrls.set(row.id, c.agentUrl);
      this.d.rows.setSpec(row.id, redactSpec(spec));
      return c;
    } catch (e) {
      throw orchestratorError(e);
    }
  }

  /** After its container was recreated: until the server's agent answers again. */
  private async agentBack(id: string): Promise<void> {
    const agent = this.agents.get(id)?.agent;
    if (!agent) return;
    const end = Date.now() + AGENT_BACK_MS;
    for (;;) {
      try {
        await agent.status();
        return;
      } catch {
        if (Date.now() > end) throw new Error(`The server's agent did not answer within ${AGENT_BACK_MS / 1000} s of its container being recreated`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  containerPending(id: string): boolean {
    return this.containerPendingReasons(id).length > 0;
  }

  containerPendingReasons(id: string): ContainerPendingReason[] {
    const row = this.d.rows.get(id);
    if (!row?.spec) return [];
    let wanted: ServerSpec;
    try {
      wanted = this.specOf(row);
    } catch {
      // Nothing to recreate it from.
      return [];
    }
    const out: ContainerPendingReason[] = [];
    if (!sameSpec(wanted, row.spec)) out.push('settings');
    if (this.olderImage.has(id)) out.push('image');
    if (this.olderDerivation.has(id)) out.push('derivation');
    return out;
  }

  async prepareStart(id: string): Promise<void> {
    if (!this.d.rows.get(id)?.spec) return;
    // A runtime image rebuilt, or an orchestrator upgraded, since the orchestrator last said (without a panel restart)
    // waits too. Not queued: with nothing waiting (the usual case) the start isn't held up behind another server's
    // creation or removal.
    await this.refreshContainers();
    if (!this.containerPending(id)) return;
    const applied = await this.exclusive(async () => {
      const row = this.d.rows.get(id);
      const reasons = this.containerPendingReasons(id);
      if (!row?.spec || reasons.length === 0) return false;
      // Pressed while it runs: the agent says so; the change keeps waiting.
      if (await this.gameActive(id)) return false;
      await this.applySpec(row);
      this.d.audit.log({ actor: SYSTEM, serverId: id, action: 'server.reconcile', detail: `container recreated ${reasons.map((r) => RECREATED_WITH[r]).join(' and ')} before the game started` });
      return true;
    });
    if (applied) await this.agentBack(id);
  }

  private activate(ctx: ServerContext): void {
    if (!this.live || this.running.has(ctx)) return;
    ctx.start();
    this.running.add(ctx);
  }

  /** Timers, stream and listeners off, whether or not it was started. */
  private retire(ctx: ServerContext): void {
    ctx.stop();
    this.running.delete(ctx);
  }

  private changed(): void {
    this.order = this.d.rows.list().map((r) => r.id);
    this.d.bus.emit({ type: 'access', userId: null });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // ------------------------------------------------------------------ create

  create(input: CreateServerInput): Promise<ServerContext> {
    return this.exclusive(() => this.doCreate(input));
  }

  private async doCreate(input: CreateServerInput): Promise<ServerContext> {
    const { rows, orchestrator, audit } = this.d;
    const id = input.id;
    if (!isServerId(id)) throw new HttpError(400, 'invalid-server-id');
    if ((RESERVED_SERVER_IDS as readonly string[]).includes(id)) throw new HttpError(409, 'reserved-server-id');
    if (rows.get(id)) throw new HttpError(409, 'server-exists');
    const name = cleanName(input.name);
    if (rows.list().some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'server-name-taken');

    let adapter: PanelAdapter;
    try {
      adapter = this.d.adapterFor(input.adapter);
    } catch {
      throw new HttpError(400, 'unknown-adapter');
    }
    const flavours = adapter.meta.flavours;
    const flavour = input.flavour ?? null;
    // An adapter with flavours needs one of them; one without takes none.
    if (flavours.length ? !flavours.some((f) => f.id === flavour) : flavour !== null) throw new HttpError(400, 'unknown-flavour', undefined, { flavours: flavours.map((f) => f.id) });
    const caps: Set<Capability> = capabilitiesOf(adapter, flavour);
    // D6: only the owner accepts a game's EULA. The owner accepts it here; anyone else leaves it to them.
    const mayAccept = input.mayAcceptEula !== false;
    if (caps.has('eula') && mayAccept && input.eulaAccepted !== true) throw new HttpError(400, 'eula-required');
    if (caps.has('eula') && !mayAccept && input.eulaAccepted === true) throw new HttpError(403, 'eula-owner-only');
    const eulaAccepted = caps.has('eula') && mayAccept;

    // Secrets: the agent's token and every secret the adapter declares, generated here and kept only in `servers.secrets`.
    const secrets: Record<string, string> = { [AGENT_TOKEN_SECRET]: randomBytes(32).toString('base64url') };
    for (const s of adapter.launch.secrets ?? []) {
      if (s.key === AGENT_TOKEN_SECRET) throw new Error(`Adapter ${adapter.meta.id} declares a secret named ${AGENT_TOKEN_SECRET}`);
      secrets[s.key] = randomBytes(18).toString('base64url');
    }

    const launch = { ...(adapter.launch.defaults() as Record<string, unknown>), ...(input.launch ?? {}) };
    const problem = launchBodyProblem(adapter.launch.schema, launch);
    if (problem) throw new HttpError(400, 'invalid-options', problem, { message: problem });
    try {
      adapter.launch.toAgent({ id, gameName: id, flavour }, launch, secrets);
    } catch (e) {
      // A refusal the adapter worded names its setting, in both languages (CFG-01, UX-01).
      throw new HttpError(400, 'invalid-options', (e as Error).message, { message: (e as Error).message, ...(launchRefusal(e) ?? {}) });
    }
    const needMb = memoryNeedMb(adapter, launch);
    const memLimitMb = input.memLimitMb ?? needMb;
    if (memLimitMb < needMb) throw new HttpError(400, 'memory-too-low', undefined, { minMb: needMb });

    // What the host is and allows, and what the orchestrator already runs (HST-05; a container without a row keeps its volumes).
    let host: HostInfo;
    let containers: ServerContainer[];
    try {
      host = await orchestrator.host();
      containers = await orchestrator.list();
    } catch (e) {
      throw orchestratorError(e);
    }
    if (!adapter.meta.arch.includes(host.arch)) throw new HttpError(409, 'arch-unsupported', undefined, { arch: host.arch, supported: adapter.meta.arch });
    if (input.cpus !== undefined && input.cpus !== null && input.cpus > host.cpus) throw new HttpError(400, 'invalid-cpus', undefined, { max: host.cpus });
    if (host.maxMemMb !== undefined && memLimitMb > host.maxMemMb) throw memoryAboveHost(memLimitMb, host.maxMemMb);
    if (containers.some((c) => c.id === id)) throw new HttpError(409, 'server-exists');

    // Free ports where this install lets servers publish (SRV-01), next to every other server's.
    const ports = planPorts(adapter, input.ports, takenPorts(rows.list(), (a) => this.adapterOrNull(a), panelPorts(this.d.env)), host.hostPorts);

    const userId = input.by.user?.id ?? null;
    const draft: ServerRow = {
      id,
      name,
      adapter: adapter.meta.id,
      flavour,
      gameName: id,
      versionPin: null,
      ports,
      memLimitMb,
      cpus: input.cpus ?? null,
      spec: null,
      eulaAcceptedAt: eulaAccepted ? new Date().toISOString() : null,
      eulaAcceptedBy: eulaAccepted ? userId : null,
      createdAt: '',
      createdBy: userId,
      sort: Math.max(0, ...rows.list().map((r) => r.sort)) + 1,
    };
    const spec = buildSpec(draft, adapter, { agentToken: secrets[AGENT_TOKEN_SECRET]!, tz: this.d.tz, variant: this.d.env.serverImageVariant });
    // The row is the wanted state: written first, so a crash before the container exists is repaired by reconcile.
    const row = rows.insert({ ...draft, spec: redactSpec(spec) }, secrets);
    if (input.launch) new ServerSettings(this.d.db, id).setRaw('launch', launch);

    let applied = false;
    try {
      let c = this.seen(await orchestrator.apply(spec));
      applied = true;
      if (c.state !== 'running') c = this.seen(await orchestrator.start(id));
      this.agentUrls.set(id, c.agentUrl);
    } catch (e) {
      if (applied) await orchestrator.remove(id, { removeVolumes: true }).catch(() => undefined);
      rows.purge(id);
      const err = orchestratorError(e);
      audit.log({ actor: input.by, ip: input.ip ?? null, serverId: id, action: 'server.create', detail: { adapter: adapter.meta.id, error: err.code }, ok: false });
      throw err;
    }

    const ctx = this.build(row);
    this.contexts.set(id, ctx);
    this.activate(ctx);
    audit.log({ actor: input.by, ip: input.ip ?? null, serverId: id, action: 'server.create', target: name, detail: { adapter: adapter.meta.id, flavour, ports, memLimitMb, cpus: row.cpus } });
    if (eulaAccepted) this.auditEula(input.by, input.ip ?? null, row);
    this.changed();
    return ctx;
  }

  // -------------------------------------------------------------------- EULA

  private auditEula(by: Actor, ip: string | null, row: ServerRow): void {
    const agreement = this.d.adapterFor(row.adapter).meta.eula;
    this.d.audit.log({ actor: by, ip, serverId: row.id, action: 'server.eula', target: row.name, detail: { agreement: agreement?.url ?? null } });
  }

  acceptEula(id: string, by: Actor, ip: string | null = null): ServerContext {
    const ctx = this.contexts.get(id);
    if (!ctx) throw new HttpError(404, 'server-not-found');
    if (!ctx.handle.has('eula')) throw new HttpError(409, 'eula-not-needed');
    // Accepted once is accepted: the first acceptance (who, when) stays on record.
    if (!ctx.handle.eulaPending()) return ctx;
    const row = this.d.rows.get(id)!;
    this.d.rows.setEula(id, new Date().toISOString(), by.user?.id ?? null);
    this.auditEula(by, ip, row);
    this.changed();
    return ctx;
  }

  private adapterOrNull(id: string): PanelAdapter | null {
    try {
      return this.d.adapterFor(id);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ update

  update(id: string, patch: ServerPatch, by: Actor, ip: string | null = null): Promise<ServerContext> {
    return this.exclusive(() => this.doUpdate(id, patch, by, ip));
  }

  /**
   * New limits are checked against the game's launch settings (`launch`:
   * the ones about to be stored, else the current ones) and against what
   * the host gives one server. When the game isn't running, the container
   * is recreated with them first (if that fails, nothing changed); while it
   * runs, they wait for its next start: a limit never stops someone's game.
   */
  private async doUpdate(id: string, patch: ServerPatch, by: Actor, ip: string | null, launch?: Record<string, unknown>): Promise<ServerContext> {
    const old = this.contexts.get(id);
    if (!old) throw new HttpError(404, 'server-not-found');
    const current = this.d.rows.get(id)!;
    const next: ServerPatch = {};
    if (patch.name !== undefined) {
      next.name = cleanName(patch.name);
      if (this.d.rows.list().some((r) => r.id !== id && r.name.toLowerCase() === next.name!.toLowerCase())) throw new HttpError(409, 'server-name-taken');
    }
    if (patch.sort !== undefined) next.sort = patch.sort;
    const limits = patch.memLimitMb !== undefined || patch.cpus !== undefined;
    if (limits) {
      // The container of the server the environment describes is the stack's, not the orchestrator's.
      if (current.spec === null) throw new HttpError(409, 'server-unmanaged');
      if (patch.memLimitMb !== undefined) {
        const need = memoryNeedMb(old.adapter, launch ?? (old.handle.launchSettings() as Record<string, unknown>));
        if (patch.memLimitMb < need) throw new HttpError(400, 'memory-too-low', undefined, { minMb: need });
        next.memLimitMb = patch.memLimitMb;
      }
      if (patch.cpus !== undefined) next.cpus = patch.cpus;
      const host = await this.host();
      if (next.memLimitMb !== undefined && host.maxMemMb !== undefined && next.memLimitMb > host.maxMemMb) throw memoryAboveHost(next.memLimitMb, host.maxMemMb);
      if (typeof next.cpus === 'number' && next.cpus > host.cpus) throw new HttpError(400, 'invalid-cpus', undefined, { max: host.cpus });
    }
    // The context is rebuilt around the new row: not while an operation of the old one runs.
    if (old.ops.busy) throw new HttpError(409, 'busy', undefined, { op: old.ops.busy });

    const draft: ServerRow = { ...current, ...next };
    let container: 'recreated' | 'at-next-start' | null = null;
    if (limits && (draft.memLimitMb !== current.memLimitMb || draft.cpus !== current.cpus)) {
      container = 'at-next-start';
      if (!(await this.gameActive(id))) {
        await this.applySpec(draft);
        container = 'recreated';
      }
    }
    const row = this.d.rows.update(id, next)!;
    const wasRunning = this.running.has(old);
    this.retire(old);
    const ctx = this.build(row);
    this.contexts.set(id, ctx);
    if (wasRunning) this.activate(ctx);
    const before: Record<string, unknown> = { name: current.name, sort: current.sort };
    if (limits) Object.assign(before, { memLimitMb: current.memLimitMb, cpus: current.cpus });
    this.d.audit.log({ actor: by, ip, serverId: id, action: 'server.update', target: row.name, detail: { before, after: next, ...(container ? { container } : {}) } });
    this.changed();
    return ctx;
  }

  followLaunch(id: string, launch: Record<string, unknown>, by: Actor, ip: string | null = null): Promise<void> {
    return this.exclusive(async () => {
      const ctx = this.contexts.get(id);
      if (!ctx) throw new HttpError(404, 'server-not-found');
      const row = this.d.rows.get(id)!;
      // The stack's own container (`default`): its limit is Compose's.
      if (row.spec === null) return;
      const before = memoryNeedMb(ctx.adapter, ctx.handle.launchSettings() as Record<string, unknown>);
      const after = memoryNeedMb(ctx.adapter, launch);
      if (after === before) return;
      const host = await this.host();
      if (host.maxMemMb !== undefined && after > host.maxMemMb) throw memoryAboveHost(after, host.maxMemMb);
      // The room it had above the game's memory stays, as far as the host allows.
      let limit = after + Math.max(0, row.memLimitMb - before);
      if (host.maxMemMb !== undefined) limit = Math.min(limit, host.maxMemMb);
      if (limit !== row.memLimitMb) await this.doUpdate(id, { memLimitMb: limit }, by, ip, launch);
    });
  }

  // ------------------------------------------------------------------ remove

  remove(id: string, o: RemoveServerOptions): Promise<RemoveReport> {
    return this.exclusive(() => this.doRemove(id, o));
  }

  private async doRemove(id: string, o: RemoveServerOptions): Promise<RemoveReport> {
    const { rows, orchestrator, audit, env } = this.d;
    const ctx = this.contexts.get(id);
    if (!ctx) throw new HttpError(404, 'server-not-found');
    const managed = ctx.row.spec !== null;
    // While the environment describes `default`, something else (Compose, the dev loop) runs it:
    // removing it is that one's business. Once it no longer does, the row is all that's left.
    if (!managed && env.agentUrl) throw new HttpError(409, 'server-unmanaged');
    if (o.confirm !== ctx.row.name) throw new HttpError(400, 'confirm-mismatch');
    // Forced (the owner, for a server that won't stop or whose container won't run): neither holds it back.
    const busy = ctx.ops.busy;
    if (busy && !o.force) throw new HttpError(409, 'busy', undefined, { op: busy });
    let state = ctx.feed.status_?.state;
    if (managed && !o.force) {
      // What its game is doing now, from its agent. An agent that can't be reached can't say (nor
      // take the final backup): only the owner's forced removal goes on without it.
      const live = await ctx.agent.status().catch(() => null);
      if (!live) throw new HttpError(409, 'server-unreachable', "The server's agent can't be reached; the owner can force the removal", { force: true });
      state = live.state;
    }
    if (!o.force && (state === 'running' || state === 'starting' || state === 'stopping')) throw new HttpError(409, 'server-running');

    // SRV-04: a final backup first, into the server's own folder, unless nothing is to be kept
    // (or nothing can be reached: an unmanaged row the environment no longer describes). Forced,
    // it is still taken whenever it can be (hot, if the game runs); only a backup that can't be
    // taken is skipped, and the answer and the audit log say why.
    let finalBackup: string | null = null;
    let finalBackupError: string | null = null;
    if (managed && o.keepBackups && o.finalBackup !== false) {
      try {
        if (busy) throw new Error(`Another operation (${busy.kind}) is still running on this server`);
        const b = await ctx.ops.run('backup', o.by.user?.username ?? null, (op) => ctx.flows.backupNow(op, 'final'));
        finalBackup = b.name;
      } catch (e) {
        const message = (e as Error).message;
        if (!o.force) {
          audit.log({ actor: o.by, ip: o.ip ?? null, serverId: id, action: 'server.delete', detail: { step: 'final-backup', error: message }, ok: false });
          throw new HttpError(409, 'final-backup-failed', message, { message });
        }
        finalBackupError = message;
      }
    }

    // Forced: a game that won't stop isn't waited for (its volumes go with it; the backup is taken).
    if (managed && o.force) await orchestrator.stop(id, { timeoutSec: FORCED_STOP_SEC }).catch(() => undefined);
    try {
      if (managed) await orchestrator.remove(id, { removeVolumes: true });
    } catch (e) {
      // Already gone is what we wanted.
      if (!(e instanceof OrchestratorCallError && e.code === 'not-found')) {
        const err = orchestratorError(e);
        audit.log({ actor: o.by, ip: o.ip ?? null, serverId: id, action: 'server.delete', detail: { step: 'container', error: err.code, finalBackup }, ok: false });
        throw err;
      }
    }

    this.retire(ctx);
    this.contexts.delete(id);
    this.agentUrls.delete(id);
    this.agents.delete(id);
    this.olderImage.delete(id);
    this.olderDerivation.delete(id);
    const holders = this.d.grants.forServer(id).map((g) => g.userId);
    rows.purge(id);
    // Accounts that lose a grant may lose their highest role with it.
    for (const userId of holders) {
      syncRoleWithGrants(this.d.users, this.d.grants, userId);
      this.d.bus.emit({ type: 'access', userId });
    }
    if (!o.keepBackups) {
      const own = path.resolve(env.backupDir, id);
      // Only ever the server's own folder, never the backups root (which holds `default`'s).
      if (path.resolve(ctx.backups.dir) === own) rmSync(own, { recursive: true, force: true });
    }
    const forced = o.force === true;
    audit.log({
      actor: o.by,
      ip: o.ip ?? null,
      serverId: id,
      action: 'server.delete',
      target: ctx.row.name,
      detail: { keepBackups: o.keepBackups, finalBackup, ...(forced ? { forced, finalBackupError } : {}) },
    });
    this.changed();
    return { finalBackup, forced, finalBackupError };
  }

  // --------------------------------------------------------------- reconcile

  reconcile(): Promise<ReconcileReport> {
    return this.exclusive(() => this.doReconcile());
  }

  private async doReconcile(): Promise<ReconcileReport> {
    const { rows, orchestrator, audit } = this.d;
    const report: ReconcileReport = { applied: [], started: [], orphans: [], failed: [] };
    const managed = rows.list().filter((r) => r.spec !== null);
    let containers: ServerContainer[];
    try {
      containers = await orchestrator.list();
    } catch (e) {
      // Without servers of its own, an install doesn't need an orchestrator.
      const error = orchestratorError(e).message;
      for (const row of managed) report.failed.push({ id: row.id, error });
      return this.reported(report);
    }
    /** Why a container was recreated, when the audit log can say more than "created or recreated". */
    const why = new Map<string, string>();
    for (const row of managed) {
      try {
        // Rebuilt from the row, so new limits, a changed time zone or a newer panel's spec reach the container,
        // and so do a runtime image rebuilt since it was created (a product upgrade, HST-01) and an orchestrator
        // that now builds containers another way (SRV-06)…
        const wanted = this.specOf(row);
        const asItWas: ServerSpec = { ...row.spec!, env: { ...row.spec!.env, AGENT_TOKEN: wanted.env.AGENT_TOKEN } };
        const before = containers.find((c) => c.id === row.id);
        if (before) {
          this.agentUrls.set(row.id, before.agentUrl);
          this.seen(before);
        }
        const changed = !sameSpec(wanted, row.spec);
        const newer = before !== undefined && newerImage(before);
        const rederived = before !== undefined && changedDerivation(before);
        // …but a container built before a security fix never waits (NFR-02): the orchestrator recreates it at the
        // next apply whatever is asked, so it takes everything else that waited with it.
        const urgent = before?.derivation === 'security-fix';
        // …and otherwise, while its game runs (SRV-05), all of it waits for the game's next start. Its agent is
        // asked once the container it has was applied again as it was, on its own image and derivation: that joins
        // a new panel container (a product upgrade just made one) to its network, so the agent can be reached to say.
        const kept = !urgent && before?.state === 'running' && (changed || newer || rederived) ? this.seen(await orchestrator.apply(asItWas, { keepImage: true, keepDerivation: true })) : null;
        const waits = kept !== null && (await this.gameActive(row.id));
        const spec = waits ? asItWas : wanted;
        // A newer image or derivation is taken only when it was seen and nothing waits; otherwise a container keeps
        // what it has, even when it changed a moment ago (the next start through the panel takes it).
        let c = kept && waits ? kept : this.seen(await orchestrator.apply(spec, { keepImage: before !== undefined && !newer && !urgent, keepDerivation: before !== undefined && !rederived }));
        const recreated = !before || before.specHash !== c.specHash || (before.imageId ?? '') !== (c.imageId ?? '') || (rederived && !changedDerivation(c));
        if (recreated) report.applied.push(row.id);
        if (recreated && urgent) why.set(row.id, SECURITY_RECREATED);
        else if (recreated && !changed && (newer || rederived)) {
          const reasons: ContainerPendingReason[] = [...(newer ? (['image'] as const) : []), ...(rederived ? (['derivation'] as const) : [])];
          why.set(row.id, `container recreated ${reasons.map((r) => RECREATED_WITH[r]).join(' and ')}`);
        }
        if (!waits && !sameSpec(spec, row.spec)) rows.setSpec(row.id, redactSpec(spec));
        if (c.state !== 'running') {
          c = this.seen(await orchestrator.start(row.id));
          report.started.push(row.id);
        }
        this.agentUrls.set(row.id, c.agentUrl);
        if (!this.contexts.has(row.id)) this.contexts.set(row.id, this.build(rows.get(row.id)!));
      } catch (e) {
        report.failed.push({ id: row.id, error: orchestratorError(e).message });
      }
    }
    report.orphans = containers.filter((c) => !rows.get(c.id)).map((c) => c.id);
    for (const id of report.applied) audit.log({ actor: SYSTEM, serverId: id, action: 'server.reconcile', detail: why.get(id) ?? 'container created or recreated' });
    for (const id of report.started.filter((x) => !report.applied.includes(x))) audit.log({ actor: SYSTEM, serverId: id, action: 'server.reconcile', detail: 'container started' });
    return this.reported(report);
  }

  private reported(report: ReconcileReport): ReconcileReport {
    for (const f of report.failed) this.d.audit.log({ actor: SYSTEM, serverId: f.id, action: 'server.reconcile', detail: f.error, ok: false });
    this.order = this.d.rows.list().map((r) => r.id);
    return report;
  }

  // --------------------------------------------------------------- lifecycle

  async start(): Promise<ReconcileReport> {
    this.live = true;
    // `default` doesn't wait for the orchestrator.
    for (const ctx of this.list()) if (ctx.row.spec === null) this.activate(ctx);
    const report = await this.reconcile();
    for (const ctx of this.list()) this.activate(ctx);
    this.retryFailed(report, 15_000);
    return report;
  }

  /** Servers the orchestrator couldn't bring up are tried again, less and less often. */
  private retryFailed(report: ReconcileReport, delayMs: number): void {
    if (!this.live || report.failed.length === 0) return;
    const failed = report.failed.map((f) => f.id);
    this.retry = setTimeout(() => {
      void this.reconcile().then((r) => {
        for (const ctx of this.list()) this.activate(ctx);
        // The audit log's last word on a server that failed is that it's fine now (a retry that changed nothing is otherwise silent).
        const quiet = (id: string) => !r.failed.some((f) => f.id === id) && !r.applied.includes(id) && !r.started.includes(id);
        for (const id of failed.filter((x) => this.d.rows.get(x) && quiet(x))) {
          this.d.audit.log({ actor: SYSTEM, serverId: id, action: 'server.reconcile', detail: 'in line with its settings again on retry' });
        }
        this.retryFailed(r, Math.min(delayMs * 2, 300_000));
      });
    }, delayMs);
    this.retry.unref();
  }

  stop(): void {
    this.live = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    for (const ctx of [...this.running]) this.retire(ctx);
  }
}
