import type { FastifyInstance } from 'fastify';
import type { Deps } from '../http/deps';
import { capabilitiesOf } from '../server/handle';

/**
 * What the server's game adapter supports, for the UI to show only that and
 * for AST-04 (machine-readable context). Any signed-in user may read it.
 */
export function metaRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/meta', async () => {
    const a = deps.adapter;
    const srv = deps.control.server.ref;
    return {
      adapter: a.meta,
      server: { gameName: srv.gameName, flavour: srv.flavour },
      capabilities: [...capabilitiesOf(a, srv.flavour)],
      launch: { schema: a.launch.schema },
      backupParts: a.backups.parts.map((p) => ({ id: p.id, label: p.label })),
      resets: a.resets.map((r) => ({ id: r.id, label: r.label, permission: r.permission, removeParts: r.removeParts })),
      accessLevels: a.players?.accessLevels ?? [],
      modSources: (a.mods ?? []).map((m) => ({ id: m.id, capability: m.capability, label: m.label })),
      consoleCatalog: a.consoleCatalog ?? [],
    };
  });
}
