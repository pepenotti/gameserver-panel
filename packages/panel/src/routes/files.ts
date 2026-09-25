import type { FastifyInstance } from 'fastify';
import { srvOf } from '../http/context';
import type { Deps } from '../http/deps';
import { FILE_ID } from './config';

/**
 * The text editor's files (CFG-07, CFG-08): the declared config files and a
 * tree of the adapter's editable folders, each entry editable or not with a
 * reason, and one file's text (secrets masked). Saving goes through
 * proposals (routes/proposals.ts).
 */
export function fileRoutes(app: FastifyInstance, _deps: Deps): void {
  const perm = { permission: 'config.edit' as const };

  app.get('/config/files', { config: perm }, async (req) => srvOf(req).config.listFiles());

  app.get<{ Querystring: { id: string } }>(
    '/config/files/content',
    { config: perm, schema: { querystring: { type: 'object', required: ['id'], properties: { id: FILE_ID } } } },
    async (req) => srvOf(req).config.content(req.query.id),
  );
}
