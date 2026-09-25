import type { FastifyInstance, FastifyRequest } from 'fastify';
import { by, srvOf } from '../http/context';
import type { Deps } from '../http/deps';

const perm = { permission: 'config.edit' as const };
/** A declared file id (`ini`) or `path:<root>/<rel>`. */
export const FILE_ID = { type: 'string', minLength: 1, maxLength: 1100 } as const;
const idParam = { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } } as const;

/**
 * Settings forms, the pending-restart badge and the history (CFG-01,
 * CFG-03, CFG-05). Changes go through proposals (routes/proposals.ts); the
 * text editor's files through routes/files.ts.
 */
export function configRoutes(app: FastifyInstance, deps: Deps): void {
  const { audit } = deps;
  const who = (req: FastifyRequest) => req.auth?.user.username ?? null;

  /** Schemas, declared files and presets: what the forms are built from (AST-04 reads it too). */
  app.get('/api/config/meta', { config: perm }, async (req) => srvOf(req).config.meta());

  app.get('/api/config/pending', { config: { permission: 'server.view' } }, async (req) => srvOf(req).config.pendingRestart());

  /** A form's values, secrets masked. */
  app.get<{ Querystring: { id: string } }>(
    '/api/config/values',
    { config: perm, schema: { querystring: { type: 'object', required: ['id'], properties: { id: FILE_ID } } } },
    async (req) => srvOf(req).config.values(req.query.id),
  );

  // --------------------------------------------------------------- history
  app.get<{ Querystring: { file: string } }>(
    '/api/config/history',
    { config: perm, schema: { querystring: { type: 'object', required: ['file'], properties: { file: FILE_ID } } } },
    async (req) => srvOf(req).config.historyOf(req.query.file),
  );

  app.get<{ Params: { id: number } }>('/api/config/history/:id', { config: perm, schema: { params: idParam } }, async (req) => srvOf(req).config.version(req.params.id));

  /** One-click revert (CFG-03). The web previews it first as a proposal (`revert`). */
  app.post<{ Params: { id: number } }>('/api/config/history/:id/revert', { config: perm, schema: { params: idParam } }, async (req) => {
    const r = await srvOf(req).config.revert(req.params.id, who(req));
    audit.log({ ...by(req), action: 'config.revert', target: String(req.params.id) });
    return r;
  });
}
