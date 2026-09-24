import type { FastifyInstance } from 'fastify';
import { actor } from '../http/context';
import type { Deps } from '../http/deps';

const perm = { permission: 'mods.manage' as const };

export function modRoutes(app: FastifyInstance, deps: Deps): void {
  const { mods, audit } = deps;
  const who = (req: { auth: { user: { username: string } } | null }) => req.auth?.user.username ?? null;

  app.get('/api/mods', { config: perm }, async () => {
    mods.importFromIni();
    return { items: mods.items(), enabled: mods.enabled(), issues: mods.issues(), lines: mods.iniLines(), gameVersion: deps.feed.status_?.gameVersion ?? null };
  });

  app.post<{ Body: { refs: string[] } }>(
    '/api/mods',
    {
      config: perm,
      schema: { body: { type: 'object', required: ['refs'], additionalProperties: false, properties: { refs: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', maxLength: 300 } } } } },
    },
    async (req) => {
      const r = await mods.add(req.body.refs, who(req));
      audit.log({ user: actor(req), action: 'mods.add', detail: r.added.join(', '), ip: req.ip });
      return r;
    },
  );

  app.put<{ Body: { enabled: { modId: string; workshopId: string }[] } }>(
    '/api/mods/enabled',
    {
      config: perm,
      schema: {
        body: {
          type: 'object',
          required: ['enabled'],
          additionalProperties: false,
          properties: {
            enabled: {
              type: 'array',
              maxItems: 500,
              items: { type: 'object', required: ['modId', 'workshopId'], additionalProperties: false, properties: { modId: { type: 'string', maxLength: 200 }, workshopId: { type: 'string', pattern: '^\\d{5,20}$' } } },
            },
          },
        },
      },
    },
    async (req) => {
      const r = mods.setEnabled(req.body.enabled, who(req));
      audit.log({ user: actor(req), action: 'mods.enabled', detail: req.body.enabled.map((e) => e.modId).join(', ').slice(0, 1000), ip: req.ip });
      return { ...r, enabled: mods.enabled(), issues: mods.issues() };
    },
  );

  app.post('/api/mods/sort', { config: perm }, async (req) => {
    const enabled = mods.autoSort(who(req));
    audit.log({ user: actor(req), action: 'mods.sort', ip: req.ip });
    return { enabled, issues: mods.issues() };
  });

  app.post('/api/mods/check', { config: perm }, async () => ({ updates: await mods.checkUpdates(), items: mods.items() }));

  app.post<{ Body: { ids?: string[] } }>(
    '/api/mods/download',
    { config: perm, schema: { body: { type: 'object', additionalProperties: false, properties: { ids: { type: 'array', maxItems: 200, items: { type: 'string', pattern: '^\\d{5,20}$' } } } } } },
    async (req) => {
      const ids = req.body?.ids?.length ? req.body.ids : mods.items().map((i) => i.workshopId);
      audit.log({ user: actor(req), action: 'mods.download', detail: ids.join(', ').slice(0, 1000), ip: req.ip });
      return mods.startDownload(ids, who(req));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/mods/:id',
    { config: perm, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^\\d{5,20}$' } } } } },
    async (req) => {
      const r = mods.remove(req.params.id, who(req));
      audit.log({ user: actor(req), action: 'mods.remove', target: req.params.id, ip: req.ip });
      return r;
    },
  );
}
