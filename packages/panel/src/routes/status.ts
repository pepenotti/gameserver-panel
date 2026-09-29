import type { FastifyInstance } from 'fastify';
import { srvOf } from '../http/context';
import type { Deps } from '../http/deps';

export function statusRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/status', { config: { permission: 'server.view' } }, async (req) => {
    const s = srvOf(req);
    let agent = s.feed.status_;
    if (!agent) agent = await s.agent.status().catch(() => null);
    const last = s.backups.list()[0];
    return {
      panelVersion: deps.env.version,
      serverId: s.id,
      name: s.row.name,
      serverName: s.handle.ref.gameName,
      agentConnected: s.feed.connected,
      agent,
      // Secret launch settings (a server password) masked.
      launch: s.handle.publicLaunchSettings(),
      nextRestart: s.scheduler.nextRuns().restart,
      lastBackup: last ? { at: last.manifest.createdAt, trigger: last.manifest.trigger, mode: last.manifest.mode } : null,
    };
  });
}
