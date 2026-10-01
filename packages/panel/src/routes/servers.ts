import type { FastifyInstance, FastifyRequest } from 'fastify';
import { can, permissionsOn, roleOn, SERVER_ID_PATTERN, type CpuArch, type Permission, type PortProto, type PortRangeInfo, type Role } from '@gsp/shared';
import type { AdapterNote, Agreement, I18n, LaunchChoices, LaunchOption, OptionMeta, PortDecl, RuntimeFamily } from '@gsp/adapter-api';
import type { UserRow } from '../auth/users';
import { actor, HttpError, principal, srvOf } from '../http/context';
import type { Deps } from '../http/deps';
import type { ServerContext } from '../servers/context';
import type { ContainerPendingReason } from '../servers/registry';

/** A server in `GET /api/servers` (SRV-02). */
export interface ServerSummary {
  id: string;
  name: string;
  adapter: string;
  adapterName: I18n;
  flavour: string | null;
  /** Null while its agent hasn't answered. */
  state: string | null;
  agentConnected: boolean;
  /** Online players; null unless it runs. */
  players: number | null;
  version: string | null;
  nextRestart: string | null;
  /** Its published host ports. */
  ports: { id: string; port: number; proto: PortProto }[];
  /** Container memory limit, MiB. */
  memLimitMb: number;
  /** CPU limit in cores; null: none. */
  cpus: number | null;
  /** Its container waits to be recreated with changed settings (new limits) at the game's next start. */
  containerPending: boolean;
  /** Why: `settings` changed, and/or a newer runtime `image` (a product upgrade); empty when nothing waits. */
  containerPendingReasons: ContainerPendingReason[];
  /** Whether the orchestrator runs it; false: the server the install's environment describes (`default`), which only the stack itself can remove. */
  managed: boolean;
  /** The signed-in user's role there, and what it lets them do. */
  role: Role;
  permissions: Permission[];
  /**
   * For a game whose license the owner must accept (D6): the agreement, and
   * when and by whom it was accepted (null while it waits: the server can't
   * start). Null for games without one.
   */
  eula: EulaSummary | null;
}

/** A game's agreement on a server (D6). */
export interface EulaSummary {
  name: I18n;
  url: string;
  acceptedAt: string | null;
  /** The username of whoever accepted it, while that account exists. */
  acceptedBy: string | null;
}

/** The host in `GET /api/adapters`. */
export interface HostSummary {
  arch: CpuArch;
  cpus: number;
  memBytes: number;
  /** Where servers may publish (`ORCH_HOST_PORTS`); new servers get free ports inside. */
  hostPorts: PortRangeInfo[] | null;
  /** The most memory one server may be given, MiB (`ORCH_MAX_MEM_MB`). */
  maxMemMb: number | null;
}

/**
 * `GET /api/servers/:sid/limits` (SRV-05): the most this host lets one
 * server's container have, for whoever may change that server's limits.
 * Each is null when the orchestrator doesn't say (or can't be asked); then
 * only its refusal tells.
 */
export interface ServerLimits {
  /** The most memory one server may be given, MiB (`ORCH_MAX_MEM_MB`). */
  maxMemMb: number | null;
  /** The host's CPUs: the most a server's CPU limit may be. */
  cpus: number | null;
}

/** A game servers can be created from (`GET /api/adapters`). */
export interface AdapterSummary {
  id: string;
  name: I18n;
  runtime: string;
  arch: CpuArch[];
  /** Whether this host runs it natively (HST-05); null when the host can't be asked. */
  supported: boolean | null;
  /** `runtime`: the image family servers of that flavour run in, when it isn't the adapter's (PRD §10). */
  flavours: { id: string; name: I18n; runtime?: RuntimeFamily }[];
  /** Every port it uses; only `publish` ones get a host port. */
  ports: PortDecl[];
  memory: { minMb: number; defaultMb: number; overheadMb: number };
  capabilities: string[];
  /** The license must be accepted when creating a server (D6). */
  eula: boolean;
  /** That license: what it is called and where to read it; null without one. */
  agreement: Agreement | null;
  /** What people should know about the game before relying on a feature (UX-04), each with its docs/limitations.md entry. */
  notes: AdapterNote[];
  /**
   * Its launch settings form; the secrets it needs are generated, never asked
   * for. `choices`: its versions can be listed (`GET /api/adapters/:id/choices`);
   * `warnings`: what their warning codes mean.
   */
  launch: { schema: (LaunchOption | OptionMeta)[]; secrets: { key: string; label: I18n }[]; choices: boolean; warnings: Record<string, I18n> };
}

/** The server's agreement and its acceptance, read live (an acceptance doesn't rebuild the server's context). */
function eulaOf(s: ServerContext, deps: Pick<Deps, 'users'>): EulaSummary | null {
  const e = s.handle.eula();
  const agreement = s.adapter.meta.eula;
  if (!e || !agreement) return null;
  return { name: agreement.name, url: agreement.url, acceptedAt: e.at, acceptedBy: e.by === null ? null : (deps.users.byId(e.by)?.username ?? null) };
}

function summary(s: ServerContext, user: UserRow, deps: Pick<Deps, 'grants' | 'servers' | 'users'>): ServerSummary | null {
  const who = principal(user);
  const grants = deps.grants.forUser(user.id);
  const role = roleOn(who, grants, s.id);
  if (role === null) return null;
  const st = s.feed.status_;
  return {
    id: s.id,
    name: s.row.name,
    adapter: s.row.adapter,
    adapterName: s.adapter.meta.name,
    flavour: s.row.flavour,
    state: st?.state ?? null,
    agentConnected: s.feed.connected,
    players: st?.state === 'running' ? (st.players?.count ?? 0) : null,
    version: st?.installedInfo?.version ?? null,
    nextRestart: s.scheduler.nextRuns().restart,
    ports: s.adapter.meta.ports.filter((p) => s.row.ports[p.id] !== undefined).map((p) => ({ id: p.id, port: s.row.ports[p.id]!, proto: p.proto })),
    memLimitMb: s.row.memLimitMb,
    cpus: s.row.cpus,
    containerPending: deps.servers.containerPending(s.id),
    containerPendingReasons: deps.servers.containerPendingReasons(s.id),
    managed: s.row.spec !== null,
    role,
    permissions: permissionsOn(who, grants, s.id),
    eula: eulaOf(s, deps),
  };
}

const ports = { type: 'object', maxProperties: 16, additionalProperties: { type: 'integer' } } as const;

/** `DELETE /api/servers/:sid` (SRV-04). */
interface DeleteBody {
  /** The server's name, typed. */
  confirm: string;
  keepBackups?: boolean;
  finalBackup?: boolean;
  /** Owner only: remove a server that won't stop or whose container won't run (see `RemoveServerOptions.force`). */
  force?: boolean;
}

/**
 * The server list (SRV-02): every server the signed-in user has a role on,
 * and nothing about the others. Any signed-in user may ask; the answer is
 * filtered, never refused. Creating servers (SRV-01) needs `servers.create`
 * (an admin on every server).
 */
export function serverListRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/servers', { config: { auth: 'session' } }, async (req): Promise<ServerSummary[]> => {
    const user = req.auth!.user;
    return deps.servers.list().flatMap((s) => summary(s, user, deps) ?? []);
  });

  /**
   * The games a server can be created from, whether this host runs each
   * (HST-05), and what this install lets a server have: the host ports it
   * may publish (SRV-01) and the most memory (SRV-05); null when the
   * orchestrator doesn't say.
   */
  app.get('/api/adapters', { config: { permission: 'servers.create' } }, async (): Promise<{ host: HostSummary | null; adapters: AdapterSummary[] }> => {
    const host = await deps.orchestrator.host().catch(() => null);
    return {
      host: host && { arch: host.arch, cpus: host.cpus, memBytes: host.memBytes, hostPorts: host.hostPorts ?? null, maxMemMb: host.maxMemMb ?? null },
      adapters: deps.adapters.map((a) => ({
        id: a.meta.id,
        name: a.meta.name,
        runtime: a.meta.runtime,
        arch: a.meta.arch,
        supported: host ? a.meta.arch.includes(host.arch) : null,
        flavours: a.meta.flavours.map((f) => ({ id: f.id, name: f.name, ...(f.runtime ? { runtime: f.runtime } : {}) })),
        ports: a.meta.ports,
        memory: a.meta.memory,
        capabilities: a.meta.capabilities,
        eula: a.meta.capabilities.includes('eula'),
        agreement: a.meta.eula ?? null,
        notes: a.meta.notes ?? [],
        launch: { schema: a.launch.schema, secrets: (a.launch.secrets ?? []).map((x) => ({ key: x.key, label: x.label })), choices: !!a.launch.choices, warnings: a.launch.warnings ?? {} },
      })),
    };
  });

  /**
   * What a new server of a game may be set to (UPD-02): the versions of a
   * flavour, and for the version picked so far the settings that depend on
   * it, from the game's download services (kept a few minutes). Asked before
   * the server, and so its agent, exists.
   */
  app.get<{ Params: { id: string }; Querystring: { flavour?: string; version?: string } }>(
    '/api/adapters/:id/choices',
    {
      config: { permission: 'servers.create' },
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' } } },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { flavour: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' }, version: { type: 'string', pattern: '^[0-9A-Za-z.+-]{1,32}$' } },
        },
      },
    },
    async (req): Promise<LaunchChoices> => {
      const adapter = deps.adapters.find((a) => a.meta.id === req.params.id);
      if (!adapter) throw new HttpError(404, 'unknown-adapter');
      return deps.choices.get(adapter, req.query.flavour ?? null, req.query.version ?? null);
    },
  );

  app.post<{
    Body: { id: string; name: string; adapter: string; flavour?: string | null; launch?: Record<string, unknown>; ports?: Record<string, number>; memLimitMb?: number; cpus?: number | null; eulaAccepted?: boolean };
  }>(
    '/api/servers',
    {
      config: { permission: 'servers.create' },
      schema: {
        body: {
          type: 'object',
          required: ['id', 'name', 'adapter'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', pattern: SERVER_ID_PATTERN.source },
            name: { type: 'string', minLength: 1, maxLength: 64 },
            adapter: { type: 'string', minLength: 1, maxLength: 64 },
            flavour: { type: 'string', maxLength: 64, nullable: true },
            // Checked against the adapter's launch form (each server has its own adapter).
            launch: { type: 'object', maxProperties: 100 },
            ports,
            memLimitMb: { type: 'integer', minimum: 256, maximum: 1_048_576 },
            cpus: { type: 'number', exclusiveMinimum: 0, maximum: 256, nullable: true },
            eulaAccepted: { type: 'boolean' },
          },
        },
      },
    },
    async (req): Promise<ServerSummary> => {
      // D6: only the owner accepts a game's EULA; anyone else creates the server with it waiting for them.
      const mayAcceptEula = can(req.auth!.user.role, 'server.eula');
      const ctx = await deps.servers.create({ ...req.body, mayAcceptEula, by: actor(req), ip: req.ip });
      return summary(ctx, req.auth!.user, deps)!;
    },
  );
}

/**
 * Changing and removing one server (under `/api/servers/:sid`, so the guard
 * resolves it and checks the permission there): rename, reorder or change
 * its memory and CPU limits (SRV-05) with `server.update`, which also reads
 * the most the host allows; remove (SRV-04) with `server.delete`, after
 * typing its name. Deleting its backups too, skipping the final backup, or
 * forcing out a server that won't stop or run, is the owner's choice alone.
 */
export function serverAdminRoutes(app: FastifyInstance, deps: Deps): void {
  // What `GET /api/adapters` tells those who create servers, for an admin of this server alone too.
  app.get('/limits', { config: { permission: 'server.update' } }, async (): Promise<ServerLimits> => {
    const host = await deps.orchestrator.host().catch(() => null);
    return { maxMemMb: host?.maxMemMb ?? null, cpus: host?.cpus ?? null };
  });

  app.patch<{ Body: { name?: string; sort?: number; memLimitMb?: number; cpus?: number | null } }>(
    '',
    {
      config: { permission: 'server.update' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 64 },
            sort: { type: 'integer', minimum: 0, maximum: 1_000_000 },
            // SRV-05: its container is recreated with them now if the game is stopped, else at its next start.
            memLimitMb: { type: 'integer', minimum: 256, maximum: 1_048_576 },
            cpus: { type: 'number', exclusiveMinimum: 0, maximum: 256, nullable: true },
          },
        },
      },
    },
    async (req): Promise<ServerSummary> => {
      const ctx = await deps.servers.update(srvOf(req).id, req.body, actor(req), req.ip);
      return summary(ctx, req.auth!.user, deps)!;
    },
  );

  // D6: the owner accepts the game's license (EULA) for this server, having read it; recorded and audited.
  app.post<{ Body: { accept: true } }>(
    '/eula',
    {
      config: { permission: 'server.eula' },
      schema: { body: { type: 'object', required: ['accept'], additionalProperties: false, properties: { accept: { type: 'boolean', enum: [true] } } } },
    },
    async (req): Promise<ServerSummary> => {
      const ctx = deps.servers.acceptEula(srvOf(req).id, actor(req), req.ip);
      return summary(ctx, req.auth!.user, deps)!;
    },
  );

  app.delete<{ Body: DeleteBody }>(
    '',
    {
      config: { permission: 'server.delete' },
      schema: {
        body: {
          type: 'object',
          required: ['confirm'],
          additionalProperties: false,
          properties: { confirm: { type: 'string', maxLength: 64 }, keepBackups: { type: 'boolean' }, finalBackup: { type: 'boolean' }, force: { type: 'boolean' } },
        },
      },
    },
    async (req: FastifyRequest<{ Body: DeleteBody }>) => {
      const { confirm, keepBackups = true, finalBackup = true, force = false } = req.body;
      // Dropping the backups, skipping the final one, or forcing a server out: the owner's call alone.
      if ((!keepBackups || !finalBackup || force) && req.auth!.user.role !== 'owner') throw new HttpError(403, 'forbidden');
      const r = await deps.servers.remove(srvOf(req).id, { confirm, keepBackups, finalBackup, force, by: actor(req), ip: req.ip });
      return { ok: true, finalBackup: r.finalBackup, forced: r.forced, finalBackupError: r.finalBackupError };
    },
  );
}
