import type { CommandDoc } from '@gsp/adapter-api';
import { RconProtocolError, type OptionMeta } from '@gsp/formats';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { COUNTDOWNS, type GameLang } from '../control/control';
import { by, HttpError, srvOf } from '../http/context';
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

/**
 * What is wrong with a launch settings body for the adapter's form: every
 * key, typed and in range, nothing else. Null when it is fine. (Each server
 * has its own adapter, so this can't be a route schema.)
 */
export function launchBodyProblem(options: OptionMeta[], body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object';
  const b = body as Record<string, unknown>;
  const keys = new Set(options.map((o) => o.key));
  const extra = Object.keys(b).find((k) => !keys.has(k));
  if (extra !== undefined) return `unknown setting ${extra}`;
  for (const o of options) {
    const v = b[o.key];
    if (v === undefined) return `${o.key} is required`;
    const range = (n: number) => (o.min !== undefined && n < o.min) || (o.max !== undefined && n > o.max);
    switch (o.type) {
      case 'boolean':
        if (typeof v !== 'boolean') return `${o.key} must be true or false`;
        break;
      case 'integer':
        if (typeof v !== 'number' || !Number.isInteger(v) || range(v)) return `${o.key} must be a whole number in range`;
        break;
      case 'decimal':
        if (typeof v !== 'number' || !Number.isFinite(v) || range(v)) return `${o.key} must be a number in range`;
        break;
      case 'enum':
        if (!(o.options ?? []).some((x) => x.value === v)) return `${o.key} is not one of the choices`;
        break;
      case 'string':
        if (typeof v !== 'string' || v.length > 200 || /[\r\n\0]/.test(v)) return `${o.key} must be one line of at most 200 characters`;
        break;
    }
  }
  return null;
}

export function serverRoutes(app: FastifyInstance, deps: Deps): void {
  const { audit } = deps;
  const lang = (req: FastifyRequest): GameLang => (req.auth?.user.lang === 'en' ? 'en' : 'es');
  const who = (req: FastifyRequest) => req.auth?.user.username ?? null;

  app.get('/ops/current', { config: { permission: 'server.view' } }, async (req) => {
    const { ops } = srvOf(req);
    return ops.busy ?? ops.last();
  });

  app.post<{ Params: { id: string } }>('/ops/:id/cancel', { config: { permission: 'server.control' } }, async (req) => {
    if (!srvOf(req).ops.cancel(req.params.id)) throw new HttpError(409, 'not-cancellable');
    audit.log({ ...by(req), action: 'server.cancel' });
    return { ok: true };
  });

  app.post('/server/start', { config: { permission: 'server.control' } }, async (req) => {
    const op = srvOf(req).control.start(who(req));
    audit.log({ ...by(req), action: 'server.start' });
    return op;
  });

  app.post<{ Body: { countdownSec?: number } }>('/server/stop', { config: { permission: 'server.control' }, schema: { body: countdownBody } }, async (req) => {
    const op = srvOf(req).control.stop(who(req), req.body?.countdownSec ?? 0, lang(req));
    audit.log({ ...by(req), action: 'server.stop', detail: { countdownSec: req.body?.countdownSec ?? 0 } });
    return op;
  });

  app.post<{ Body: { countdownSec?: number } }>('/server/restart', { config: { permission: 'server.control' }, schema: { body: countdownBody } }, async (req) => {
    const op = srvOf(req).control.restart(who(req), req.body?.countdownSec ?? 0, lang(req));
    audit.log({ ...by(req), action: 'server.restart', detail: { countdownSec: req.body?.countdownSec ?? 0 } });
    return op;
  });

  // Emergency stop without saving: admins only.
  app.post('/server/kill', { config: { permission: 'server.update' } }, async (req) => {
    const s = await srvOf(req).agent.kill();
    audit.log({ ...by(req), action: 'server.kill' });
    return s;
  });

  app.post('/server/save', { config: { permission: 'server.control', capability: 'save' } }, async (req) => {
    const r = await srvOf(req).agent.save();
    audit.log({ ...by(req), action: 'server.save', ok: r.ok });
    if (!r.ok) throw new HttpError(502, 'save-failed', r.error);
    return { ok: true };
  });

  app.post<{ Body: { message: string } }>(
    '/server/broadcast',
    {
      config: { permission: 'server.broadcast', capability: 'broadcast' },
      schema: { body: { type: 'object', required: ['message'], additionalProperties: false, properties: { message: { type: 'string', minLength: 1, maxLength: 300 } } } },
    },
    async (req) => {
      try {
        await srvOf(req).control.broadcast(req.body.message.trim());
      } catch (e) {
        if (e instanceof RconProtocolError) throw new HttpError(400, 'invalid-message');
        throw e;
      }
      audit.log({ ...by(req), action: 'server.broadcast', detail: req.body.message.slice(0, 300) });
      return { ok: true };
    },
  );

  app.post<{ Body: { command: string } }>(
    '/server/command',
    {
      config: { permission: 'console.raw' },
      schema: { body: { type: 'object', required: ['command'], additionalProperties: false, properties: { command: { type: 'string', minLength: 1, maxLength: 1000, pattern: '^[^\\r\\n\\u0000]+$' } } } },
    },
    async (req) => {
      const s = srvOf(req);
      const cmd = req.body.command.trim().replace(/^\//, '');
      const r = await s.agent.command(cmd);
      audit.log({ ...by(req), action: 'server.command', detail: auditableCommand(cmd, s.adapter.consoleCatalog ?? []) });
      return r;
    },
  );

  app.get('/server/launch', { config: { permission: 'server.view' } }, async (req) => srvOf(req).handle.launchSettings());

  app.put<{ Body: Record<string, unknown> }>(
    '/server/launch',
    { config: { permission: 'server.update' }, schema: { body: { type: 'object', maxProperties: 100 } } },
    async (req) => {
      const { handle } = srvOf(req);
      const problem = launchBodyProblem(handle.adapter.launch.schema, req.body);
      if (problem) throw new HttpError(400, 'validation', problem, { message: problem });
      // The adapter refuses settings it can't turn into launch params (ranges and formats the form can't express).
      try {
        handle.launchEnvelope({}, req.body);
      } catch (e) {
        throw new HttpError(400, 'validation', (e as Error).message);
      }
      const before = handle.launchSettings();
      handle.setLaunchSettings(req.body);
      audit.log({ ...by(req), action: 'server.launch-settings', detail: { before, after: req.body } });
      return handle.launchSettings();
    },
  );

  // The shape predates adapters (Steam branches); versions map onto it.
  app.get('/server/updates', { config: { permission: 'server.update', capability: 'updateCheck' } }, async (req) => {
    const { handle } = srvOf(req);
    const ctx = handle.ctx();
    const check = await handle.adapter.updates?.check(ctx, handle.launchSettings());
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
    '/server/update',
    {
      config: { permission: 'server.update' },
      schema: { body: { type: 'object', additionalProperties: false, properties: { countdownSec: { enum: [...COUNTDOWNS] }, validate: { type: 'boolean' } } } },
    },
    async (req) => {
      const op = srvOf(req).control.update(who(req), { countdownSec: req.body?.countdownSec ?? 0, validate: req.body?.validate ?? false }, lang(req));
      audit.log({ ...by(req), action: req.body?.validate ? 'server.validate' : 'server.update', detail: { countdownSec: req.body?.countdownSec ?? 0 } });
      return op;
    },
  );
}
