import type { FastifyInstance } from 'fastify';
import { by, srvOf } from '../http/context';
import type { Deps } from '../http/deps';

const perm = { permission: 'mods.manage' as const };
/** Item ids as sources use them (Workshop ids, project ids); each source checks its own. */
const itemId = { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' } as const;

export function modRoutes(app: FastifyInstance, deps: Deps): void {
  const { audit } = deps;
  const who = (req: { auth: { user: { username: string } } | null }) => req.auth?.user.username ?? null;

  app.get('/mods', { config: perm }, async (req) => {
    const { mods, feed } = srvOf(req);
    await mods.importFromConfig();
    const items = await mods.items();
    return { items, enabled: mods.enabled(), issues: mods.issues(items), lines: mods.configValues().values, gameVersion: feed.status_?.installedInfo?.version ?? null };
  });

  app.post<{ Body: { refs: string[] } }>(
    '/mods',
    {
      config: perm,
      schema: { body: { type: 'object', required: ['refs'], additionalProperties: false, properties: { refs: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', maxLength: 300 } } } } },
    },
    async (req) => {
      const r = await srvOf(req).mods.add(req.body.refs, who(req));
      audit.log({ ...by(req), action: 'mods.add', detail: r.added.join(', ') });
      return r;
    },
  );

  app.put<{ Body: { enabled: { modId: string; workshopId: string }[] } }>(
    '/mods/enabled',
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
              items: { type: 'object', required: ['modId', 'workshopId'], additionalProperties: false, properties: { modId: { type: 'string', maxLength: 200 }, workshopId: itemId } },
            },
          },
        },
      },
    },
    async (req) => {
      const { mods } = srvOf(req);
      const r = await mods.setEnabled(req.body.enabled, who(req));
      audit.log({ ...by(req), action: 'mods.enabled', detail: req.body.enabled.map((e) => e.modId).join(', ').slice(0, 1000) });
      return { ...r, enabled: mods.enabled(), issues: mods.issues(await mods.items()) };
    },
  );

  app.post('/mods/sort', { config: perm }, async (req) => {
    const { mods } = srvOf(req);
    const enabled = await mods.autoSort(who(req));
    audit.log({ ...by(req), action: 'mods.sort' });
    return { enabled, issues: mods.issues(await mods.items()) };
  });

  app.post('/mods/check', { config: perm }, async (req) => {
    const { mods } = srvOf(req);
    return { updates: await mods.checkUpdates(), items: await mods.items() };
  });

  app.post<{ Body: { ids?: string[] } }>(
    '/mods/download',
    { config: perm, schema: { body: { type: 'object', additionalProperties: false, properties: { ids: { type: 'array', maxItems: 200, items: itemId } } } } },
    async (req) => {
      const { mods } = srvOf(req);
      const ids = req.body?.ids?.length ? req.body.ids : mods.itemIds();
      audit.log({ ...by(req), action: 'mods.download', detail: ids.join(', ').slice(0, 1000) });
      return mods.startDownload(ids, who(req));
    },
  );

  app.delete<{ Params: { id: string } }>('/mods/:id', { config: perm, schema: { params: { type: 'object', required: ['id'], properties: { id: itemId } } } }, async (req) => {
    const r = await srvOf(req).mods.remove(req.params.id, who(req));
    audit.log({ ...by(req), action: 'mods.remove', target: req.params.id });
    return r;
  });
}
