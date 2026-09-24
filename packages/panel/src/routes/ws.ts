import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { can, type Permission, type SeqEvent } from '@pz/shared';
import type { Deps } from '../http/deps';

/** Which permission each agent event needs before a browser may see it. */
const TOPIC: Record<SeqEvent['event']['type'], Permission> = {
  state: 'dashboard.view',
  job: 'dashboard.view',
  alert: 'dashboard.view',
  players: 'players.view',
  log: 'log.view',
};

const SOFT_LIMIT = 1_000_000;
const HARD_LIMIT = 8_000_000;

export function wsRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/ws', { websocket: true, config: { permission: 'dashboard.view' } }, (socket: WebSocket, req) => {
    const a = req.auth!;
    let role = a.user.role;
    const sessionHash = a.session.id_hash;

    const send = (msg: unknown, droppable = false) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > HARD_LIMIT) {
        socket.close(1013, 'too slow');
        return;
      }
      if (droppable && socket.bufferedAmount > SOFT_LIMIT) return;
      socket.send(JSON.stringify(msg));
    };

    send({
      type: 'hello',
      agentConnected: deps.feed.connected,
      status: deps.feed.status_,
      logs: can(role, 'log.view') ? deps.feed.recentLogs() : [],
      op: deps.bus.currentOp(),
    });

    const off = deps.feed.onEvent((e) => {
      if (!can(role, TOPIC[e.event.type])) return;
      send({ type: 'event', ...e }, e.event.type === 'log');
    });

    const offBus = deps.bus.on((e) => {
      if (e.type === 'op') send({ type: 'op', op: e.op });
      else if (can(role, e.permission)) send({ type: 'notice', kind: e.kind, message: e.message });
    });

    // Sessions can be revoked or roles changed while the socket is open.
    const recheck = setInterval(() => {
      const row = deps.db.prepare('SELECT user_id, expires_at FROM sessions WHERE id_hash = ?').get(sessionHash) as { user_id: number; expires_at: number } | undefined;
      const user = row ? deps.users.byId(row.user_id) : null;
      if (!row || row.expires_at <= Date.now() || !user || user.disabled) {
        socket.close(4001, 'session ended');
        return;
      }
      role = user.role;
    }, 30_000);

    socket.on('message', (raw) => {
      if (raw.toString() === 'ping') send({ type: 'pong' });
    });
    socket.on('close', () => {
      off();
      offBus();
      clearInterval(recheck);
    });
  });
}
