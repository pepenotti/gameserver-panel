import type { FastifyInstance } from 'fastify';
import type { I18n } from '@gsp/adapter-api';
import { INSTALL_ID_PATTERN, SERVER_ID_PATTERN, type InstallKey, type InstallWanted } from '@gsp/shared';
import { actor, by, HttpError, srvOf } from '../http/context';
import type { Deps } from '../http/deps';
import type { OpState } from '../ops/bus';
import type { ServerContext } from '../servers/context';
import type { InstallProgress, InstallRow, InstallState } from '../servers/installs';
import { launchBodyProblem } from './server';

/** What a server runs from (HST-09), as its pages show it. */
export interface ServerInstallView {
  /** `shared`: a shared install, mounted read-only; `own`: an install volume of its own (a server from before shared installs, or a game whose installs aren't shared). */
  mode: 'shared' | 'own';
  /** The install it runs from (or, while it has no container yet, waits for); null on its own install. */
  id: string | null;
  state: InstallState | null;
  /** What that install holds, once ready. */
  key: InstallKey | null;
  bytes: number | null;
  files: number | null;
  /** How many other servers run from it or wait for it. */
  sharedWith: number;
  /** Where its job is, while one runs. */
  job: InstallProgress | null;
  /** Why its job failed (its next start runs it again). */
  error: string | null;
  /** It has no container yet: its install is being made (a server just created). */
  waiting: boolean;
  /**
   * It moves to another install at its next start (at once when its game is
   * stopped): `id` the one it moves to (null: a shared one in place of its
   * own install, adopted then), with what it holds and its job.
   */
  next: { id: string | null; key: InstallKey | null; state: InstallState | null; job: InstallProgress | null } | null;
}

/** An install as the host page lists it (HST-09). */
export interface InstallView {
  id: string;
  adapter: string;
  /** The game's name, from its adapter (the web is game-neutral). */
  adapterName: I18n | null;
  flavour: string | null;
  flavourName: I18n | null;
  state: InstallState;
  /** What it holds, once ready. */
  key: InstallKey | null;
  /** What it was made for (and what else wanted the same files). */
  wanted: InstallWanted[];
  error: string | null;
  bytes: number | null;
  files: number | null;
  /** How it was filled: downloaded, made by an update from a copy of another install, or adopted from a server's own install. */
  origin: 'download' | 'update' | 'adopted';
  /** An update replaced it: new servers get the newer one. */
  superseded: boolean;
  /** The servers that run from it, wait for it or still mount it. */
  servers: { id: string; name: string }[];
  job: InstallProgress | null;
  createdAt: string;
  readyAt: string | null;
  /** Nobody uses it and no job runs: the owner may remove it. */
  removable: boolean;
}

/** A server's own install volume, left over after it moved to a shared install, until the owner removes it. */
export interface OwnInstallView {
  serverId: string;
  serverName: string | null;
  /** Its size, as measured when it was adopted. */
  bytes: number | null;
  files: number | null;
  since: string;
}

/** `GET /api/host/installs`. */
export interface InstallsResponse {
  installs: InstallView[];
  leftovers: OwnInstallView[];
  /** Bytes of every install and left-over whose size is known. */
  totalBytes: number;
}

/**
 * What creating a server would do about its game's files (the create
 * form's "will download about N" or "uses the existing install"):
 * `existing`: a ready install holds them (`servers` already use it);
 * `installing`: one being installed now will; `download`: a new install,
 * of about `bytes` when another install of the game and flavour says (null:
 * no idea yet); `own`: this game keeps an install per server.
 */
export interface InstallPlan {
  mode: 'existing' | 'installing' | 'download' | 'own';
  bytes: number | null;
  servers: number;
}

/** The view of a server's install, from its row and the installs. */
export function serverInstallView(deps: Pick<Deps, 'servers' | 'serverRows'>, s: Pick<ServerContext, 'id'>): ServerInstallView | null {
  const row = deps.serverRows.get(s.id);
  if (!row?.spec) return null;
  const m = deps.servers.installs;
  const waiting = deps.servers.awaitingInstall(s.id);
  const target = row.installId;
  const current = waiting ? target : (row.spec.install ?? null);
  const shownId = current ?? target;
  const shown = shownId ? m.get(shownId) : null;
  const moves = !waiting && deps.servers.containerPendingReasons(s.id).includes('install');
  const next = target ? m.get(target) : null;
  return {
    mode: shownId ? 'shared' : 'own',
    id: shownId,
    state: shown?.state ?? null,
    key: shown?.key ?? null,
    bytes: shown?.bytes ?? null,
    files: shown?.files ?? null,
    sharedWith: shownId ? deps.servers.installUsers(shownId).filter((x) => x !== s.id).length : 0,
    job: shownId ? m.progress(shownId) : null,
    error: shown?.state === 'failed' ? shown.error : null,
    waiting,
    next: moves ? (target && target !== current ? { id: target, key: next?.key ?? null, state: next?.state ?? null, job: m.progress(target) } : { id: null, key: null, state: null, job: null }) : null,
  };
}

const origin = (r: InstallRow): InstallView['origin'] => (r.source === null ? 'download' : r.source.startsWith('server:') ? 'adopted' : 'update');

/**
 * Shared installs (HST-09, D12): the host page lists every install with its
 * size, what it holds, the servers using it and its job's progress (for
 * those who see the host overview, `host.view`), and the left-over own
 * installs of servers that moved to a shared one; only the owner removes
 * an install nobody uses, or a left-over, after confirming (`host.settings`,
 * audited). The create form asks what a new server would do about its
 * game's files. A server's page shows its install, and an admin of it puts
 * it on its shared install now (a move off its own install, a failed
 * install run again, a waiting move) while its game is stopped.
 */
export function installRoutes(app: FastifyInstance, deps: Deps): void {
  const nameOf = (id: string) => deps.serverRows.get(id)?.name ?? null;
  const adapterOf = (id: string) => deps.adapters.find((a) => a.meta.id === id) ?? null;

  app.get('/api/host/installs', { config: { permission: 'host.view' } }, async (): Promise<InstallsResponse> => {
    const m = deps.servers.installs;
    const installs = m.list().map((r): InstallView => {
      const a = adapterOf(r.adapter);
      const users = deps.servers.installUsers(r.id);
      return {
        id: r.id,
        adapter: r.adapter,
        adapterName: a?.meta.name ?? null,
        flavour: r.flavour,
        flavourName: (r.flavour !== null ? a?.meta.flavours.find((f) => f.id === r.flavour)?.name : null) ?? null,
        state: r.state,
        key: r.key,
        wanted: r.wanted,
        error: r.error,
        bytes: r.bytes,
        files: r.files,
        origin: origin(r),
        superseded: r.supersededBy !== null,
        servers: users.map((id) => ({ id, name: nameOf(id) ?? id })),
        job: m.progress(r.id),
        createdAt: r.createdAt,
        readyAt: r.readyAt,
        removable: users.length === 0 && (r.state === 'ready' || r.state === 'failed') && !m.busy(r.id),
      };
    });
    const leftovers = m.store.leftovers().map((l): OwnInstallView => ({ serverId: l.serverId, serverName: nameOf(l.serverId), bytes: l.bytes, files: l.files, since: l.since }));
    const totalBytes = [...installs, ...leftovers].reduce((n, x) => n + (x.bytes ?? 0), 0);
    return { installs, leftovers, totalBytes };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/host/installs/:id',
    { config: { permission: 'host.settings' }, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: INSTALL_ID_PATTERN.source } } } } },
    async (req) => {
      await deps.servers.removeInstall(req.params.id, actor(req), req.ip);
      return { ok: true };
    },
  );

  app.delete<{ Params: { sid: string } }>(
    '/api/host/own-installs/:sid',
    { config: { permission: 'host.settings' }, schema: { params: { type: 'object', required: ['sid'], properties: { sid: { type: 'string', pattern: SERVER_ID_PATTERN.source } } } } },
    async (req) => {
      await deps.servers.removeLeftover(req.params.sid, actor(req), req.ip);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { flavour?: string | null; launch?: Record<string, unknown> } }>(
    '/api/adapters/:id/install-plan',
    {
      config: { permission: 'servers.create' },
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' } } },
        body: { type: 'object', additionalProperties: false, properties: { flavour: { type: 'string', maxLength: 64, nullable: true }, launch: { type: 'object', maxProperties: 100 } } },
      },
    },
    async (req): Promise<InstallPlan> => {
      const adapter = adapterOf(req.params.id);
      if (!adapter) throw new HttpError(404, 'unknown-adapter');
      const flavour = req.body?.flavour ?? null;
      const flavours = adapter.meta.flavours;
      if (flavours.length ? !flavours.some((f) => f.id === flavour) : flavour !== null) throw new HttpError(400, 'unknown-flavour');
      const launch = { ...(adapter.launch.defaults() as Record<string, unknown>), ...(req.body?.launch ?? {}) };
      const problem = launchBodyProblem(adapter.launch.schema, launch);
      if (problem) throw new HttpError(400, 'invalid-options', problem, { message: problem });
      return deps.servers.installPlan(adapter, flavour, launch);
    },
  );
}

/** A server's install (under `/api/servers/:sid`). */
export function serverInstallRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/install', { config: { permission: 'server.view' } }, async (req): Promise<ServerInstallView | null> => serverInstallView(deps, srvOf(req)));

  app.post('/install', { config: { permission: 'server.update' } }, async (req): Promise<OpState> => {
    const s = srvOf(req);
    if (s.row.spec === null) throw new HttpError(409, 'server-unmanaged');
    const op = s.ops.start('update', req.auth?.user.username ?? null, async (ctx) => {
      ctx.step('moving');
      await deps.servers.moveInstall(s.id, { step: (step, progress) => ctx.step(step, { progress }) });
    });
    deps.audit.log({ ...by(req), action: 'server.install.move', detail: { asked: true } });
    return op;
  });
}
