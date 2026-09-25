import type { FastifyInstance, FastifyRequest } from 'fastify';
import { permissionsOn, roleOn, SERVER_ID_PATTERN, type CpuArch, type Permission, type PortProto, type Role } from '@gsp/shared';
import type { I18n, LaunchOption, OptionMeta, PortDecl } from '@gsp/adapter-api';
import type { UserRow } from '../auth/users';
import { actor, HttpError, principal, srvOf } from '../http/context';
import type { Deps } from '../http/deps';
import type { ServerContext } from '../servers/context';

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
  /** Whether the orchestrator runs it; false: the server the install's environment describes (`default`), which only the stack itself can remove. */
  managed: boolean;
  /** The signed-in user's role there, and what it lets them do. */
  role: Role;
  permissions: Permission[];
}

/** A game servers can be created from (`GET /api/adapters`). */
export interface AdapterSummary {
  id: string;
  name: I18n;
  runtime: string;
  arch: CpuArch[];
  /** Whether this host runs it natively (HST-05); null when the host can't be asked. */
  supported: boolean | null;
  flavours: { id: string; name: I18n }[];
  /** Every port it uses; only `publish` ones get a host port. */
  ports: PortDecl[];
  memory: { minMb: number; defaultMb: number; overheadMb: number };
  capabilities: string[];
  /** The license must be accepted when creating a server (D6). */
  eula: boolean;
  /** Its launch settings form; the secrets it needs are generated, never asked for. */
  launch: { schema: (LaunchOption | OptionMeta)[]; secrets: { key: string; label: I18n }[] };
}

function summary(s: ServerContext, user: UserRow, deps: Pick<Deps, 'grants'>): ServerSummary | null {
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
    managed: s.row.spec !== null,
    role,
    permissions: permissionsOn(who, grants, s.id),
  };
}

const ports = { type: 'object', maxProperties: 16, additionalProperties: { type: 'integer' } } as const;

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

  /** The games a server can be created from, and whether this host runs each (HST-05). */
  app.get('/api/adapters', { config: { permission: 'servers.create' } }, async (): Promise<{ host: { arch: CpuArch; cpus: number; memBytes: number } | null; adapters: AdapterSummary[] }> => {
    const host = await deps.orchestrator.host().catch(() => null);
    return {
      host: host && { arch: host.arch, cpus: host.cpus, memBytes: host.memBytes },
      adapters: deps.adapters.map((a) => ({
        id: a.meta.id,
        name: a.meta.name,
        runtime: a.meta.runtime,
        arch: a.meta.arch,
        supported: host ? a.meta.arch.includes(host.arch) : null,
        flavours: a.meta.flavours.map((f) => ({ id: f.id, name: f.name })),
        ports: a.meta.ports,
        memory: a.meta.memory,
        capabilities: a.meta.capabilities,
        eula: a.meta.capabilities.includes('eula'),
        launch: { schema: a.launch.schema, secrets: (a.launch.secrets ?? []).map((x) => ({ key: x.key, label: x.label })) },
      })),
    };
  });

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
      const ctx = await deps.servers.create({ ...req.body, by: actor(req), ip: req.ip });
      return summary(ctx, req.auth!.user, deps)!;
    },
  );
}

/**
 * Changing and removing one server (under `/api/servers/:sid`, so the guard
 * resolves it and checks the permission there): rename or reorder with
 * `server.update`; remove (SRV-04) with `server.delete`, after typing its
 * name. Deleting its backups too, or skipping the final backup, is the
 * owner's choice alone.
 */
export function serverAdminRoutes(app: FastifyInstance, deps: Deps): void {
  app.patch<{ Body: { name?: string; sort?: number } }>(
    '',
    {
      config: { permission: 'server.update' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { name: { type: 'string', minLength: 1, maxLength: 64 }, sort: { type: 'integer', minimum: 0, maximum: 1_000_000 } },
        },
      },
    },
    async (req): Promise<ServerSummary> => {
      const ctx = await deps.servers.update(srvOf(req).id, req.body, actor(req), req.ip);
      return summary(ctx, req.auth!.user, deps)!;
    },
  );

  app.delete<{ Body: { confirm: string; keepBackups?: boolean; finalBackup?: boolean } }>(
    '',
    {
      config: { permission: 'server.delete' },
      schema: {
        body: {
          type: 'object',
          required: ['confirm'],
          additionalProperties: false,
          properties: { confirm: { type: 'string', maxLength: 64 }, keepBackups: { type: 'boolean' }, finalBackup: { type: 'boolean' } },
        },
      },
    },
    async (req: FastifyRequest<{ Body: { confirm: string; keepBackups?: boolean; finalBackup?: boolean } }>) => {
      const { confirm, keepBackups = true, finalBackup = true } = req.body;
      if ((!keepBackups || !finalBackup) && req.auth!.user.role !== 'owner') throw new HttpError(403, 'forbidden');
      const r = await deps.servers.remove(srvOf(req).id, { confirm, keepBackups, finalBackup, by: actor(req), ip: req.ip });
      return { ok: true, finalBackup: r.finalBackup };
    },
  );
}
