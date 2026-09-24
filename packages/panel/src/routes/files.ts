import type { FastifyInstance } from 'fastify';
import type { Deps } from '../http/deps';
import { FILE_ID } from './config';

/**
 * The text editor's files (CFG-07, CFG-08): the declared config files and a
 * tree of the adapter's editable folders, each entry editable or not with a
 * reason, and one file's text (secrets masked). Saving goes through
 * proposals (routes/proposals.ts).
 */
export function fileRoutes(app: FastifyInstance, deps: Deps): void {
  const perm = { permission: 'config.edit' as const };

  app.get('/api/config/files', { config: perm }, async () => deps.config.listFiles());

  app.get<{ Querystring: { id: string } }>(
    '/api/config/files/content',
    { config: perm, schema: { querystring: { type: 'object', required: ['id'], properties: { id: FILE_ID } } } },
    async (req) => deps.config.content(req.query.id),
  );
}
