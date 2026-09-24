import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CONFIG_FILES, MANAGED_INI, RESTART_ONLY_INI, SECRET_INI, type ConfigFile } from '../config/service';
import { actor, HttpError } from '../http/context';
import type { Deps } from '../http/deps';

const perm = { permission: 'config.edit' as const };
const rawBody = { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', maxLength: 524288 } } } as const;

export function configRoutes(app: FastifyInstance, deps: Deps): void {
  const { config, audit } = deps;
  const who = (req: FastifyRequest) => req.auth?.user.username ?? null;

  app.get('/api/config/meta', { config: perm }, async () => ({
    ini: config.iniMeta(),
    sandbox: config.sandboxMeta(),
    managed: MANAGED_INI,
    secret: SECRET_INI,
    restartOnly: [...RESTART_ONLY_INI],
    presets: config.presets(),
  }));

  app.get('/api/config/pending', { config: { permission: 'dashboard.view' } }, async () => config.pendingRestart());

  // ------------------------------------------------------------ server ini
  app.get('/api/config/server', { config: perm }, async () => config.getIni());

  app.put<{ Body: { changes: Record<string, string> } }>(
    '/api/config/server',
    {
      config: perm,
      schema: {
        body: {
          type: 'object',
          required: ['changes'],
          additionalProperties: false,
          properties: { changes: { type: 'object', maxProperties: 200, additionalProperties: { type: 'string', maxLength: 4000 } } },
        },
      },
    },
    async (req) => {
      const r = await config.applyIni(req.body.changes, who(req));
      if (r.applied !== 'unchanged') audit.log({ user: actor(req), action: 'config.server', detail: redactChanges(req.body.changes), ip: req.ip });
      return r;
    },
  );

  app.get('/api/config/server/raw', { config: perm }, async () => ({ text: config.getIniRaw() }));

  app.put<{ Body: { text: string } }>('/api/config/server/raw', { config: perm, schema: { body: rawBody } }, async (req) => {
    const r = await config.putIniRaw(req.body.text, who(req));
    if (r.applied !== 'unchanged') audit.log({ user: actor(req), action: 'config.server.raw', ip: req.ip });
    return r;
  });

  // --------------------------------------------------------------- sandbox
  app.get('/api/config/sandbox', { config: perm }, async () => config.getSandbox());

  app.put<{ Body: { changes: Record<string, string | number | boolean> } }>(
    '/api/config/sandbox',
    {
      config: perm,
      schema: {
        body: {
          type: 'object',
          required: ['changes'],
          additionalProperties: false,
          properties: { changes: { type: 'object', maxProperties: 400, additionalProperties: {} } },
        },
      },
    },
    async (req) => {
      // Fastify would coerce a typed union (true → "true"), so scalar types are checked here.
      for (const v of Object.values(req.body.changes)) if (!['string', 'number', 'boolean'].includes(typeof v)) throw new HttpError(400, 'validation');
      const r = config.applySandbox(req.body.changes, who(req));
      if (r.applied !== 'unchanged') audit.log({ user: actor(req), action: 'config.sandbox', detail: req.body.changes, ip: req.ip });
      return r;
    },
  );

  app.post<{ Params: { name: string } }>('/api/config/sandbox/presets/:name', { config: perm }, async (req) => {
    const r = config.applyPreset(req.params.name, who(req));
    audit.log({ user: actor(req), action: 'config.sandbox.preset', target: req.params.name, ip: req.ip });
    return r;
  });

  for (const file of ['sandbox', 'spawnregions', 'spawnpoints'] as const) {
    app.get(`/api/config/${file}/raw`, { config: perm }, async () => ({ text: config.getLuaRaw(file) }));
    app.put<{ Body: { text: string } }>(`/api/config/${file}/raw`, { config: perm, schema: { body: rawBody } }, async (req) => {
      const r = await config.putLuaRaw(file, req.body.text, who(req));
      if (r.applied !== 'unchanged') audit.log({ user: actor(req), action: `config.${file}.raw`, ip: req.ip });
      return r;
    });
  }

  // --------------------------------------------------------------- history
  app.get<{ Querystring: { file: ConfigFile } }>(
    '/api/config/history',
    { config: perm, schema: { querystring: { type: 'object', required: ['file'], properties: { file: { enum: CONFIG_FILES } } } } },
    async (req) => config.history(req.query.file),
  );

  app.get<{ Params: { id: number } }>(
    '/api/config/history/:id',
    { config: perm, schema: { params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } } } },
    async (req) => config.version(req.params.id),
  );

  app.post<{ Params: { id: number } }>(
    '/api/config/history/:id/revert',
    { config: perm, schema: { params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } } } },
    async (req) => {
      const r = await config.revert(req.params.id, who(req));
      audit.log({ user: actor(req), action: 'config.revert', target: String(req.params.id), ip: req.ip });
      return r;
    },
  );
}

function redactChanges(changes: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(changes)) out[k] = SECRET_INI.includes(k) ? '<hidden>' : v.slice(0, 200);
  return out;
}
