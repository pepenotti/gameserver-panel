import type { FastifyInstance } from 'fastify';
import { srvOf } from '../http/context';
import type { Deps } from '../http/deps';

/**
 * What the server's game adapter supports, for the UI to show only that and
 * for AST-04 (machine-readable context). Anyone with a role on the server
 * may read it.
 */
export function metaRoutes(app: FastifyInstance, _deps: Deps): void {
  app.get('/api/meta', { config: { permission: 'server.view' } }, async (req) => {
    const s = srvOf(req);
    const a = s.adapter;
    const srv = s.handle.ref;
    return {
      adapter: a.meta,
      server: { id: srv.id, name: s.row.name, gameName: srv.gameName, flavour: srv.flavour },
      capabilities: [...s.capabilities()],
      // Which secrets the server needs, never their values.
      launch: { schema: a.launch.schema, secrets: (a.launch.secrets ?? []).map((x) => ({ key: x.key, label: x.label })) },
      backupParts: a.backups.parts.map((p) => ({ id: p.id, label: p.label })),
      resets: a.resets.map((r) => ({ id: r.id, label: r.label, permission: r.permission, removeParts: r.removeParts, options: r.options ?? {} })),
      accessLevels: a.players?.accessLevels ?? [],
      banTargets: a.players?.banTargets ?? [],
      modSources: (a.mods ?? []).map((m) => ({ id: m.id, capability: m.capability, label: m.label })),
      consoleCatalog: a.consoleCatalog ?? [],
    };
  });
}
