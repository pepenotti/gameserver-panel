import type { CommandDoc } from '@gsp/adapter-api';
import { RconProtocolError, type OptionMeta } from '@gsp/formats';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { COUNTDOWNS, type GameLang } from '../control/control';
import { actor, HttpError } from '../http/context';
import type { Deps } from '../http/deps';

const countdownBody = {
  type: 'object',
  additionalProperties: false,
  properties: { countdownSec: { enum: [...COUNTDOWNS] } },
} as const;

/** A console command for the audit log: only the name when the adapter's catalog says its arguments hold secrets. */
export function auditableCommand(cmd: string, catalog: readonly CommandDoc[]): string {
  const [name = '', ...rest] = cmd.trim().split(/\s+/);
  const secret = catalog.some((c) => c.secretArgs && c.name.toLowerCase() === name.toLowerCase());
  if (secret && rest.length) return `${name} <arguments hidden>`;
  return cmd.slice(0, 300);
}

/** A JSON schema for the adapter's launch settings form: every key, typed, nothing else. */
export function launchBodySchema(options: OptionMeta[]): Record<string, unknown> {
  const prop = (o: OptionMeta): Record<string, unknown> => {
    const range = { ...(o.min !== undefined ? { minimum: o.min } : {}), ...(o.max !== undefined ? { maximum: o.max } : {}) };
    switch (o.type) {
      case 'boolean':
        return { type: 'boolean' };
      case 'integer':
        return { type: 'integer', ...range };
      case 'decimal':
        return { type: 'number', ...range };
      case 'enum':
        return { enum: (o.options ?? []).map((x) => x.value) };
      case 'string':
        return { type: 'string', maxLength: 200, pattern: '^[^\\r\\n\\u0000]*$' };
    }
  };
  return {
    type: 'object',
    required: options.map((o) => o.key),
    additionalProperties: false,
    properties: Object.fromEntries(options.map((o) => [o.key, prop(o)])),
  };
}

export function serverRoutes(app: FastifyInstance, deps: Deps): void {
  const { control, ops, agent, audit, server } = deps;
  const lang = (req: FastifyRequest): GameLang => (req.auth?.user.lang === 'en' ? 'en' : 'es');
  const who = (req: FastifyRequest) => req.auth?.user.username ?? null;

  app.get('/api/ops/current', { config: { permission: 'server.view' } }, async () => ops.busy ?? deps.bus.currentOp());

  app.post<{ Params: { id: string } }>('/api/ops/:id/cancel', { config: { permission: 'server.control' } }, async (req) => {
    if (!ops.cancel(req.params.id)) throw new HttpError(409, 'not-cancellable');
    audit.log({ user: actor(req), action: 'server.cancel', ip: req.ip });
    return { ok: true };
  });

  app.post('/api/server/start', { config: { permission: 'server.control' } }, async (req) => {
    const op = control.start(who(req));
    audit.log({ user: actor(req), action: 'server.start', ip: req.ip });
    return op;
  });

  app.post<{ Body: { countdownSec?: number } }>('/api/server/stop', { config: { permission: 'server.control' }, schema: { body: countdownBody } }, async (req) => {
    const op = control.stop(who(req), req.body?.countdownSec ?? 0, lang(req));
    audit.log({ user: actor(req), action: 'server.stop', detail: { countdownSec: req.body?.countdownSec ?? 0 }, ip: req.ip });
    return op;
  });

  app.post<{ Body: { countdownSec?: number } }>('/api/server/restart', { config: { permission: 'server.control' }, schema: { body: countdownBody } }, async (req) => {
    const op = control.restart(who(req), req.body?.countdownSec ?? 0, lang(req));
    audit.log({ user: actor(req), action: 'server.restart', detail: { countdownSec: req.body?.countdownSec ?? 0 }, ip: req.ip });
    return op;
  });

  // Emergency stop without saving: admins only.
  app.post('/api/server/kill', { config: { permission: 'server.update' } }, async (req) => {
    const s = await agent.kill();
    audit.log({ user: actor(req), action: 'server.kill', ip: req.ip });
    return s;
  });

  app.post('/api/server/save', { config: { permission: 'server.control', capability: 'save' } }, async (req) => {
    const r = await agent.save();
    audit.log({ user: actor(req), action: 'server.save', ok: r.ok, ip: req.ip });
    if (!r.ok) throw new HttpError(502, 'save-failed', r.error);
    return { ok: true };
  });

  app.post<{ Body: { message: string } }>(
    '/api/server/broadcast',
    {
      config: { permission: 'server.broadcast', capability: 'broadcast' },
      schema: { body: { type: 'object', required: ['message'], additionalProperties: false, properties: { message: { type: 'string', minLength: 1, maxLength: 300 } } } },
    },
    async (req) => {
      try {
        await control.broadcast(req.body.message.trim());
      } catch (e) {
        if (e instanceof RconProtocolError) throw new HttpError(400, 'invalid-message');
        throw e;
      }
      audit.log({ user: actor(req), action: 'server.broadcast', detail: req.body.message.slice(0, 300), ip: req.ip });
      return { ok: true };
    },
  );

  app.post<{ Body: { command: string } }>(
    '/api/server/command',
    {
      config: { permission: 'console.raw' },
      schema: { body: { type: 'object', required: ['command'], additionalProperties: false, properties: { command: { type: 'string', minLength: 1, maxLength: 1000, pattern: '^[^\\r\\n\\u0000]+$' } } } },
    },
    async (req) => {
      const cmd = req.body.command.trim().replace(/^\//, '');
      const r = await agent.command(cmd);
      audit.log({ user: actor(req), action: 'server.command', detail: auditableCommand(cmd, server.adapter.consoleCatalog ?? []), ip: req.ip });
      return r;
    },
  );

  app.get('/api/server/launch', { config: { permission: 'server.view' } }, async () => server.launchSettings());

  app.put<{ Body: Record<string, unknown> }>(
    '/api/server/launch',
    { config: { permission: 'server.update' }, schema: { body: launchBodySchema(server.adapter.launch.schema) } },
    async (req) => {
      // The adapter refuses settings it can't turn into launch params (ranges and formats the form can't express).
      try {
        server.launchEnvelope({}, req.body);
      } catch (e) {
        throw new HttpError(400, 'validation', (e as Error).message);
      }
      const before = server.launchSettings();
      server.setLaunchSettings(req.body);
      audit.log({ user: actor(req), action: 'server.launch-settings', detail: { before, after: req.body }, ip: req.ip });
      return server.launchSettings();
    },
  );

  // The shape predates adapters (Steam branches); versions map onto it.
  app.get('/api/server/updates', { config: { permission: 'server.update', capability: 'updateCheck' } }, async () => {
    const ctx = server.ctx();
    const check = await server.adapter.updates?.check(ctx, server.launchSettings());
    const info = await ctx.versions();
    const channel = check?.channel ?? null;
    const latest = info.versions.find((v) => v.id === channel) ?? null;
    return {
      installed: info.installed ? { buildId: info.installed.build ?? null, branch: info.installed.channel ?? null } : null,
      branch: channel,
      latest: latest ? { name: latest.id, buildId: latest.build ?? null, timeUpdated: latest.timeUpdated, description: latest.description, passwordRequired: latest.passwordRequired ?? false } : null,
      branches: info.versions.filter((v) => !v.passwordRequired).map((v) => ({ name: v.id, buildId: v.build ?? null, timeUpdated: v.timeUpdated ?? null })),
      updateAvailable: check?.available ?? false,
    };
  });

  app.post<{ Body: { countdownSec?: number; validate?: boolean } }>(
    '/api/server/update',
    {
      config: { permission: 'server.update' },
      schema: { body: { type: 'object', additionalProperties: false, properties: { countdownSec: { enum: [...COUNTDOWNS] }, validate: { type: 'boolean' } } } },
    },
    async (req) => {
      const op = control.update(who(req), { countdownSec: req.body?.countdownSec ?? 0, validate: req.body?.validate ?? false }, lang(req));
      audit.log({ user: actor(req), action: req.body?.validate ? 'server.validate' : 'server.update', detail: { countdownSec: req.body?.countdownSec ?? 0 }, ip: req.ip });
      return op;
    },
  );
}
