import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { AgentCallError } from './agent/client';
import { UserError } from './auth/users';
import { HttpError, installGuards } from './http/context';
import type { Deps } from './http/deps';
import { authRoutes } from './routes/auth';
import { statusRoutes } from './routes/status';
import { backupRoutes } from './routes/backups';
import { configRoutes } from './routes/config';
import { modRoutes } from './routes/mods';
import { playerRoutes } from './routes/players';
import { resetRoutes } from './routes/reset';
import { scheduleRoutes } from './routes/schedules';
import { serverRoutes } from './routes/server';
import { meRoutes, userRoutes } from './routes/users';
import { wsRoutes } from './routes/ws';

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-pz-csrf"]'] } : false,
    trustProxy: deps.env.trustProxy,
    bodyLimit: 256 * 1024,
  });
  // Only JSON bodies: a text/plain "simple request" from another site must not reach a route.
  app.removeContentTypeParser('text/plain');

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  // Only the backup upload route reads multipart bodies (owner-only, size-capped there).
  await app.register(multipart, { limits: { files: 1, fields: 0, parts: 1 } });
  installGuards(app, deps);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.code, ...err.extra });
    if (err instanceof UserError) return reply.status(400).send({ error: err.code });
    if (err instanceof AgentCallError) return reply.status(err.status === 423 ? 423 : err.status >= 500 ? 502 : err.status).send({ error: `agent-${err.code}`, message: err.message });
    const e = err as { validation?: unknown; statusCode?: number; code?: string; message: string };
    if (e.validation) return reply.status(400).send({ error: 'validation', message: e.message });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.code ?? 'bad-request', message: e.message });
    req.log.error(err);
    return reply.status(500).send({ error: 'internal' });
  });

  app.get('/api/health', { config: { auth: 'public' } }, async () => ({ ok: true, version: deps.env.version }));

  authRoutes(app, deps);
  meRoutes(app, deps);
  userRoutes(app, deps);
  statusRoutes(app, deps);
  serverRoutes(app, deps);
  configRoutes(app, deps);
  backupRoutes(app, deps);
  resetRoutes(app, deps);
  playerRoutes(app, deps);
  modRoutes(app, deps);
  scheduleRoutes(app, deps);
  wsRoutes(app, deps);

  app.setNotFoundHandler({ preHandler: undefined }, (req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not-found' });
    // Single-page app: unknown paths get index.html.
    if (deps.env.publicDir && existsSync(deps.env.publicDir)) return reply.sendFile('index.html');
    return reply.status(404).send({ error: 'not-found' });
  });

  if (deps.env.publicDir && existsSync(deps.env.publicDir)) {
    await app.register(fastifyStatic, {
      root: deps.env.publicDir,
      wildcard: false,
      index: ['index.html'],
      setHeaders: (res, filePath) => {
        // Hashed assets are immutable; index.html must always revalidate.
        res.header('cache-control', /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  return app;
}
