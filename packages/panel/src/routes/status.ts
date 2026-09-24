import type { FastifyInstance } from 'fastify';
import type { Deps } from '../http/deps';

export function statusRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/status', { config: { permission: 'dashboard.view' } }, async () => {
    let agent = deps.feed.status_;
    if (!agent) agent = await deps.agent.status().catch(() => null);
    const last = deps.backups.list()[0];
    return {
      panelVersion: deps.env.version,
      serverName: deps.env.serverName,
      agentConnected: deps.feed.connected,
      agent,
      launch: deps.settings.get('launch'),
      nextRestart: deps.scheduler.nextRuns().restart,
      lastBackup: last ? { at: last.manifest.createdAt, trigger: last.manifest.trigger, mode: last.manifest.mode } : null,
    };
  });
}
