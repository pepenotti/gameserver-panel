import type { FastifyInstance } from 'fastify';
import { HttpError } from '../http/context';
import type { Deps } from '../http/deps';

/**
 * The config-folder browser and text editor (CFG-07, CFG-08). Reserved
 * until it lands (M1-C): every call answers 501.
 */
export function fileRoutes(app: FastifyInstance, _deps: Deps): void {
  for (const url of ['/api/files', '/api/files/*']) {
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
