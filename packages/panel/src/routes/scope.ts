import type { FastifyInstance } from 'fastify';

/** Where one server's routes live: `:sid` is the server's id. */
export const SERVER_PREFIX = '';

/**
 * Registers the routes of one server (`register` adds them to `s`). Each is
 * marked `serverScoped`, so the guard (http/context.ts) resolves its server
 * into `req.srv`, answers 404 `server-not-found` to anyone without a role on
 * it, and checks the route's permission and capability on that server
 * (ACC-02).
 */
export async function serverScope(app: FastifyInstance, register: (s: FastifyInstance) => void): Promise<void> {
  await app.register(
    async (s) => {
      s.addHook('onRoute', (r) => {
        r.config = { ...r.config, serverScoped: true };
      });
      register(s);
    },
    { prefix: SERVER_PREFIX },
  );
}
