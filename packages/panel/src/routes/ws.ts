import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { can, canHost, roleOn, type AgentStatus, type Permission, type Role, type SeqEvent } from '@gsp/shared';
import type { UserRow } from '../auth/users';
import { principal } from '../http/context';
import type { Deps } from '../http/deps';
import type { OpState } from '../ops/bus';
import type { ServerContext } from '../servers/context';

/** Which permission each agent event needs, on its server, before a browser may see it. */
const TOPIC: Record<SeqEvent['event']['type'], Permission> = {
  state: 'server.view',
  job: 'server.view',
  alert: 'server.view',
  players: 'players.view',
  log: 'log.view',
};

const SOFT_LIMIT = 1_000_000;
const HARD_LIMIT = 8_000_000;

/** One server as a browser first sees it. */
export interface WsServerSnapshot {
  serverId: string;
  agentConnected: boolean;
  status: AgentStatus | null;
  /** Recent log lines, when the user may read the log there. */
  logs: SeqEvent[];
  /** The running operation, else the last one. */
  op: OpState | null;
}

/**
 * What `/api/ws` sends: one socket per browser tab, for every server the
 * user may see; everything about a server names it.
 */
export type WsMessage =
  /** On connect (every visible server), and later for servers that become visible. */
  | { type: 'hello'; servers: WsServerSnapshot[] }
  /** A server that is no longer visible (removed, or the grant taken away). */
  | { type: 'gone'; serverId: string }
  /** The servers this user sees, their names or the user's roles on them changed: fetch `GET /api/servers` again. */
  | { type: 'servers' }
  | ({ type: 'event'; serverId: string } & SeqEvent)
  | { type: 'op'; serverId: string; op: OpState }
  /** `serverId` null: about the host. */
  | { type: 'notice'; serverId: string | null; kind: string; message: string }
  | { type: 'pong' };

export function wsRoutes(app: FastifyInstance, deps: Deps): void {
  // Any signed-in user: what flows is filtered per server and topic (ACC-02).
  app.get('/api/ws', { websocket: true, config: { auth: 'session' } }, (socket: WebSocket, req) => {
    let user: UserRow = req.auth!.user;
    const sessionHash = req.auth!.session.id_hash;

    const send = (msg: WsMessage, droppable = false) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > HARD_LIMIT) {
        socket.close(1013, 'too slow');
        return;
      }
      if (droppable && socket.bufferedAmount > SOFT_LIMIT) return;
      socket.send(JSON.stringify(msg));
    };

    /** The servers this user sees now: the context followed, their role there, and the feed subscription. */
    const subs = new Map<string, { srv: ServerContext; role: Role; off: () => void }>();
    const may = (serverId: string, p: Permission) => {
      const s = subs.get(serverId);
      return !!s && can(s.role, p);
    };
    const snapshot = (srv: ServerContext, role: Role): WsServerSnapshot => ({
      serverId: srv.id,
      agentConnected: srv.feed.connected,
      status: srv.feed.status_,
      logs: can(role, 'log.view') ? srv.feed.recentLogs() : [],
      op: srv.ops.last(),
    });

    /**
     * Follow the servers the user may see: subscribe to new ones (and to a
     * server's new context once it was rebuilt, e.g. renamed), drop the others.
     */
    const sync = (first: boolean) => {
      const who = principal(user);
      const grants = deps.grants.forUser(user.id);
      const added: WsServerSnapshot[] = [];
      const visible = new Set<string>();
      for (const srv of deps.servers.list()) {
        const role = roleOn(who, grants, srv.id);
        if (role === null) continue;
        visible.add(srv.id);
        const cur = subs.get(srv.id);
        if (cur?.srv === srv) {
          cur.role = role;
          continue;
        }
        cur?.off();
        const off = srv.feed.onEvent((e) => {
          if (may(srv.id, TOPIC[e.event.type])) send({ type: 'event', serverId: srv.id, ...e }, e.event.type === 'log');
        });
        subs.set(srv.id, { srv, role, off });
        added.push(snapshot(srv, role));
      }
      for (const [id, s] of subs) {
        if (visible.has(id)) continue;
        s.off();
        subs.delete(id);
        send({ type: 'gone', serverId: id });
      }
      if (first || added.length) send({ type: 'hello', servers: added });
    };
    sync(true);

    /**
     * Sessions can be revoked, and roles, grants and servers change, while
     * the socket is open: checked when the panel says something changed
     * (`access` events), and every 30 s for what it can't announce (expiry).
     */
    const recheck = (): boolean => {
      const row = deps.db.prepare('SELECT user_id, expires_at FROM sessions WHERE id_hash = ?').get(sessionHash) as { user_id: number; expires_at: number } | undefined;
      const fresh = row ? deps.users.byId(row.user_id) : null;
      if (!row || row.expires_at <= Date.now() || !fresh || fresh.disabled) {
        socket.close(4001, 'session ended');
        return false;
      }
      user = fresh;
      sync(false);
      return true;
    };
    const timer = setInterval(recheck, 30_000);

    const offBus = deps.bus.on((e) => {
      if (e.type === 'access') {
        if ((e.userId === null || e.userId === user.id) && recheck()) send({ type: 'servers' });
      } else if (e.type === 'op') {
        if (subs.has(e.serverId)) send({ type: 'op', serverId: e.serverId, op: e.op });
      } else if (e.serverId === null ? canHost(principal(user), e.permission) : may(e.serverId, e.permission)) {
        send({ type: 'notice', serverId: e.serverId, kind: e.kind, message: e.message });
      }
    });

    socket.on('message', (raw) => {
      if (raw.toString() === 'ping') send({ type: 'pong' });
    });
    socket.on('close', () => {
      for (const s of subs.values()) s.off();
      subs.clear();
      offBus();
      clearInterval(timer);
    });
  });
}
