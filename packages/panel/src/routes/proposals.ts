import type { FastifyInstance } from 'fastify';
import { HttpError } from '../http/context';
import type { Deps } from '../http/deps';

/**
 * Change proposals: submit, preview as a diff, approve or reject (AST-03).
 * Reserved until they land (M1-C): every call answers 501.
 */
export function proposalRoutes(app: FastifyInstance, _deps: Deps): void {
  for (const url of ['/api/proposals', '/api/proposals/*']) {
    app.route({
      method: ['GET', 'POST', 'PUT', 'DELETE'],
      url,
      config: { permission: 'config.edit' },
      handler: async () => {
        throw new HttpError(501, 'not-implemented');
      },
    });
  }
}
