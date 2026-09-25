import type { PanelAdapter } from '@gsp/adapter-api';
import { isServerId, type ServerSpec } from '@gsp/shared';
import { nowIso, tx, type Db } from '../db/db';
import type { PanelEnv } from '../env';
import type { KeyValueSettings } from '../settings';

/** The server every install from before M2 had; its data became this id's in migration 6. */
export const DEFAULT_SERVER_ID = 'default';

/** A server as the panel stores it (`servers`), without its secrets. */
export interface ServerRow {
  /** `SERVER_ID_PATTERN`; names its container, volumes, network and backup folder. */
  id: string;
  /** What people call it. */
  name: string;
  /** Adapter id (`AdapterMeta.id`). */
  adapter: string;
  /** Flavour id, or null for adapters without flavours. */
  flavour: string | null;
  /** The name the game uses for the server's files (`ServerRef.gameName`); fixed once created. */
  gameName: string;
  /** What the server is pinned to, in the adapter's terms (UPD-02); null: its launch settings decide. */
  versionPin: unknown;
  /** Host port numbers by `PortDecl.id` (the published ones). */
  ports: Record<string, number>;
  /** Container memory limit, MiB (SRV-05). */
  memLimitMb: number;
  /** CPU limit in cores; null: none. */
  cpus: number | null;
  /** The last spec sent to the orchestrator; null: a server the orchestrator doesn't manage (an install's `default` until it is adopted). */
  spec: ServerSpec | null;
  eulaAcceptedAt: string | null;
  eulaAcceptedBy: number | null;
  createdAt: string;
  createdBy: number | null;
  /** Order in lists. */
  sort: number;
}

export type NewServer = Omit<ServerRow, 'createdAt' | 'spec' | 'eulaAcceptedAt' | 'eulaAcceptedBy' | 'sort'> & Partial<Pick<ServerRow, 'spec' | 'sort' | 'eulaAcceptedAt' | 'eulaAcceptedBy'>>;

/** What can change about a server after it was created without recreating its container. */
export interface ServerPatch {
  name?: string;
  sort?: number;
}

/**
 * Every table that keys rows by server (migration 6). They have no foreign
 * key to `servers` (the audit log must outlive a server), so removing one
 * deletes from each explicitly; `audit` is deliberately not here.
 */
const SERVER_TABLES = ['server_grants', 'server_settings', 'server_mods', 'config_versions', 'player_sessions', 'proposals'] as const;

interface DbRow {
  id: string;
  name: string;
  adapter: string;
  flavour: string | null;
  game_name: string;
  version_pin: string | null;
  ports: string;
  mem_limit_mb: number;
  cpus: number | null;
  spec: string | null;
  eula_accepted_at: string | null;
  eula_accepted_by: number | null;
  created_at: string;
  created_by: number | null;
  sort: number;
}

const COLUMNS = 'id, name, adapter, flavour, game_name, version_pin, ports, mem_limit_mb, cpus, spec, eula_accepted_at, eula_accepted_by, created_at, created_by, sort';

function toRow(r: DbRow): ServerRow {
  return {
    id: r.id,
    name: r.name,
    adapter: r.adapter,
    flavour: r.flavour,
    gameName: r.game_name,
    versionPin: r.version_pin === null ? null : (JSON.parse(r.version_pin) as unknown),
    ports: JSON.parse(r.ports) as Record<string, number>,
    memLimitMb: r.mem_limit_mb,
    cpus: r.cpus,
    spec: r.spec === null ? null : (JSON.parse(r.spec) as ServerSpec),
    eulaAcceptedAt: r.eula_accepted_at,
    eulaAcceptedBy: r.eula_accepted_by,
    createdAt: r.created_at,
    createdBy: r.created_by,
    sort: r.sort,
  };
}

/**
 * The `servers` table. Secrets (the agent token, the adapter's declared
 * secrets) are kept apart from `ServerRow` so no listing can carry them.
 */
export class ServersStore {
  constructor(private readonly db: Db) {}

  list(): ServerRow[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM servers ORDER BY sort, created_at, id`).all() as unknown as DbRow[]).map(toRow);
  }

  get(id: string): ServerRow | null {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM servers WHERE id = ?`).get(id) as DbRow | undefined;
    return r ? toRow(r) : null;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM servers').get() as { n: number }).n;
  }

  /** Adds a server; the database refuses an id outside `SERVER_ID_PATTERN` or one that exists. */
  insert(s: NewServer, secrets: Record<string, string> = {}): ServerRow {
    if (!isServerId(s.id)) throw new Error(`Invalid server id ${JSON.stringify(s.id)}`);
    this.db
      .prepare(
        'INSERT INTO servers (id, name, adapter, flavour, game_name, version_pin, ports, mem_limit_mb, cpus, secrets, spec, created_at, created_by, sort, eula_accepted_at, eula_accepted_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        s.id,
        s.name,
        s.adapter,
        s.flavour,
        s.gameName,
        s.versionPin === null || s.versionPin === undefined ? null : JSON.stringify(s.versionPin),
        JSON.stringify(s.ports),
        s.memLimitMb,
        s.cpus,
        JSON.stringify(secrets),
        s.spec ? JSON.stringify(s.spec) : null,
        nowIso(),
        s.createdBy,
        s.sort ?? 0,
        s.eulaAcceptedAt ?? null,
        s.eulaAcceptedBy ?? null,
      );
    return this.get(s.id)!;
  }

  /** Changes what `ServerPatch` allows; the row as it is now, or null when there is none. */
  update(id: string, patch: ServerPatch): ServerRow | null {
    if (patch.name !== undefined) this.db.prepare('UPDATE servers SET name = ? WHERE id = ?').run(patch.name, id);
    if (patch.sort !== undefined) this.db.prepare('UPDATE servers SET sort = ? WHERE id = ?').run(patch.sort, id);
    return this.get(id);
  }

  /** Removes the row (grants go with it); the caller removes the server's settings, mods and history. */
  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM servers WHERE id = ?').run(id).changes) > 0;
  }

  /**
   * SRV-04: the server's row and every row keyed to it (grants, settings,
   * mods, settings history, player history, proposals), in one transaction.
   * Its audit entries stay (ACC-03).
   */
  purge(id: string): void {
    tx(this.db, () => {
      for (const t of SERVER_TABLES) this.db.prepare(`DELETE FROM ${t} WHERE server_id = ?`).run(id);
      this.db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    });
  }

  /** The server's secrets by name (never returned by the API). */
  secrets(id: string): Record<string, string> {
    const r = this.db.prepare('SELECT secrets FROM servers WHERE id = ?').get(id) as { secrets: string } | undefined;
    return r ? (JSON.parse(r.secrets) as Record<string, string>) : {};
  }

  setSecrets(id: string, secrets: Record<string, string>): void {
    this.db.prepare('UPDATE servers SET secrets = ? WHERE id = ?').run(JSON.stringify(secrets), id);
  }

  setSpec(id: string, spec: ServerSpec | null): void {
    this.db.prepare('UPDATE servers SET spec = ? WHERE id = ?').run(spec ? JSON.stringify(spec) : null, id);
  }
}

/**
 * Boot: an install whose environment describes its one server (the agent's
 * address and token) gets that server as `default`, so everything migration
 * 6 kept as `default`'s has a row. Ports come from `GAME_PORT_<ID>` (else the
 * adapter's defaults) and the memory limit from the launch settings'
 * memory option plus the adapter's overhead. Its secrets stay in the
 * environment and it has no orchestrator spec: M2 adopts it later.
 * Returns the row when it was created.
 */
export function ensureDefaultServer(store: ServersStore, o: { env: PanelEnv; adapter: PanelAdapter; settings: KeyValueSettings }): ServerRow | null {
  const { env, adapter } = o;
  if (store.count() > 0 || !env.agentUrl || !env.agentToken) return null;
  const ports = Object.fromEntries(adapter.meta.ports.filter((p) => p.publish).map((p) => [p.id, env.ports[p.id] ?? p.default]));
  const launch = { ...(adapter.launch.defaults() as Record<string, unknown>), ...(o.settings.getRaw<Record<string, unknown>>('launch') ?? {}) };
  const memoryKey = adapter.launch.schema.find((x) => x.role === 'memory')?.key;
  const memory = memoryKey !== undefined && typeof launch[memoryKey] === 'number' ? (launch[memoryKey] as number) : adapter.meta.memory.defaultMb;
  return store.insert({
    id: DEFAULT_SERVER_ID,
    name: env.serverName,
    adapter: adapter.meta.id,
    flavour: null,
    gameName: env.serverName,
    versionPin: null,
    ports,
    memLimitMb: memory + adapter.meta.memory.overheadMb,
    cpus: null,
    createdBy: null,
  });
}
