import type { FastifyInstance } from 'fastify';
import { permissionsOn, roleOn, type Permission, type Role } from '@gsp/shared';
import type { I18n } from '@gsp/adapter-api';
import { principal } from '../http/context';
import type { Deps } from '../http/deps';

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
  /** The signed-in user's role there, and what it lets them do. */
  role: Role;
  permissions: Permission[];
}

/**
 * The server list (SRV-02): every server the signed-in user has a role on,
 * and nothing about the others. Any signed-in user may ask; the answer is
 * filtered, never refused.
 */
export function serverListRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/servers', async (req): Promise<ServerSummary[]> => {
    const user = req.auth!.user;
    const who = principal(user);
    const grants = deps.grants.forUser(user.id);
    return deps.servers.list().flatMap((s) => {
      const role = roleOn(who, grants, s.id);
      if (role === null) return [];
      const st = s.feed.status_;
      return [
        {
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
          role,
          permissions: permissionsOn(who, grants, s.id),
        },
      ];
    });
  });
}
