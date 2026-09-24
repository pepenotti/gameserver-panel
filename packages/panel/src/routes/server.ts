import { RconProtocolError } from '@pz/formats';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { COUNTDOWNS, type GameLang } from '../control/control';
import { actor, HttpError } from '../http/context';
import type { Deps } from '../http/deps';

const countdownBody = {
  type: 'object',
  additionalProperties: false,
  properties: { countdownSec: { enum: [...COUNTDOWNS] } },
} as const;

/** Commands whose arguments are secrets: the audit log keeps only the command name. */
const SENSITIVE = new Set(['setpassword', 'adduser', 'changeoption']);

export function auditableCommand(cmd: string): string {
  const [name = '', ...rest] = cmd.trim().split(/\s+/);
  if (SENSITIVE.has(name.toLowerCase()) && rest.length) return `${name} <arguments hidden>`;
  return cmd.slice(0, 300);
}

export function serverRoutes(app: FastifyInstance, deps: Deps): void {
  const { control, ops, agent, audit, settings } = deps;
  const lang = (req: FastifyRequest): GameLang => (req.auth?.user.lang === 'en' ? 'en' : 'es');
  const who = (req: FastifyRequest) => req.auth?.user.username ?? null;

  app.get('/api/ops/current', { config: { permission: 'dashboard.view' } }, async () => ops.busy ?? deps.bus.currentOp());

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

  app.post('/api/server/save', { config: { permission: 'server.control' } }, async (req) => {
    const r = await agent.command('save');
    audit.log({ user: actor(req), action: 'server.save', ip: req.ip });
    return r;
  });

  app.post<{ Body: { message: string } }>(
    '/api/server/broadcast',
    {
      config: { permission: 'server.broadcast' },
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
      audit.log({ user: actor(req), action: 'server.command', detail: auditableCommand(cmd), ip: req.ip });
      return r;
    },
  );

  app.get('/api/server/launch', { config: { permission: 'dashboard.view' } }, async () => settings.get('launch'));

  app.put<{ Body: { memoryMb: number; branch: string; updateOnStart: boolean } }>(
    '/api/server/launch',
    {
      config: { permission: 'server.update' },
      schema: {
        body: {
          type: 'object',
          required: ['memoryMb', 'branch', 'updateOnStart'],
          additionalProperties: false,
          properties: {
            memoryMb: { type: 'integer', minimum: 2048, maximum: 32768, multipleOf: 512 },
            branch: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' },
            updateOnStart: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => {
      const before = settings.get('launch');
      settings.set('launch', req.body);
      audit.log({ user: actor(req), action: 'server.launch-settings', detail: { before, after: req.body }, ip: req.ip });
      return settings.get('launch');
    },
  );

  app.get('/api/server/updates', { config: { permission: 'server.update' } }, async () => {
    const info = await agent.appInfo();
    const branch = settings.get('launch').branch;
    const latest = info.branches.find((b) => b.name === branch) ?? null;
    return {
      installed: info.installed,
      branch,
      latest,
      branches: info.branches.filter((b) => !b.passwordRequired).map((b) => ({ name: b.name, buildId: b.buildId, timeUpdated: b.timeUpdated ?? null })),
      updateAvailable: !!latest && (!info.installed || info.installed.branch !== branch || info.installed.buildId !== latest.buildId),
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
