import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyContextConfig, type FastifyInstance, type FastifySchema } from 'fastify';
import { AgentCallError } from './agent/client';
import { UserError } from './auth/users';
import { HttpError, installGuards } from './http/context';
import { trustProxyFor } from './listen';
import type { Deps } from './http/deps';
import { authRoutes } from './routes/auth';
import { statusRoutes } from './routes/status';
import { backupRoutes } from './routes/backups';
import { configRoutes } from './routes/config';
import { connectionRoutes, hostAddressRoutes } from './routes/connection';
import { fileRoutes } from './routes/files';
import { metaRoutes } from './routes/meta';
import { modRoutes } from './routes/mods';
import { pluginRoutes } from './routes/plugins';
import { playerRoutes } from './routes/players';
import { proposalRoutes } from './routes/proposals';
import { resetRoutes } from './routes/reset';
import { notificationRoutes, scheduleRoutes } from './routes/schedules';
import { serverScope } from './routes/scope';
import { serverRoutes } from './routes/server';
import { serverAdminRoutes, serverListRoutes } from './routes/servers';
import { meRoutes, userRoutes } from './routes/users';
import { wsRoutes } from './routes/ws';

/** A route as registered: what the API-first test (AST-01) checks the web's calls and every route's guard against. */
export interface RouteInfo {
  method: string;
  url: string;
  readonly config: FastifyContextConfig;
  /** Its JSON schemas (body, querystring, params), as declared; the API docs summarise them. */
  readonly schema: FastifySchema | undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route of the app, as registered (HEAD twins included). */
    routeTable: readonly RouteInfo[];
  }
}

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-gsp-csrf"]'] } : false,
    trustProxy: trustProxyFor(deps.env),
    bodyLimit: 256 * 1024,
  });
  const routes: RouteInfo[] = [];
  app.decorate('routeTable', routes);
  app.addHook('onRoute', (r) => {
    // `config` is read later: plugins' own onRoute hooks (serverScope) still add to it.
    for (const method of [r.method].flat())
      routes.push({
        method,
        url: r.url,
        get config() {
          return r.config ?? {};
        },
        get schema() {
          return r.schema;
        },
      });
  });
  // Only JSON bodies: a text/plain "simple request" from another site must not reach a route.
  app.removeContentTypeParser('text/plain');

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  // Only the upload routes read multipart bodies, each size-capped there: backups (owner only) and plugins (admins, MOD-06).
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

  // The host's routes: accounts, sessions, users, audit, host settings, the server list, the websocket.
  authRoutes(app, deps);
  meRoutes(app, deps);
  userRoutes(app, deps);
  notificationRoutes(app, deps);
  hostAddressRoutes(app, deps);
  serverListRoutes(app, deps);
  wsRoutes(app, deps);

  // Each server's routes, under /api/servers/:sid (ACC-02: resolved and checked per server).
  await serverScope(app, (s) => {
    serverAdminRoutes(s, deps);
    statusRoutes(s, deps);
    metaRoutes(s, deps);
    connectionRoutes(s, deps);
    serverRoutes(s, deps);
    configRoutes(s, deps);
    fileRoutes(s, deps);
    proposalRoutes(s, deps);
    backupRoutes(s, deps);
    resetRoutes(s, deps);
    playerRoutes(s, deps);
    modRoutes(s, deps);
    pluginRoutes(s, deps);
    scheduleRoutes(s, deps);
  });

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
