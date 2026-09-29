import type { FastifyInstance, FastifyRequest } from 'fastify';
import { by, HttpError, srvOf } from '../http/context';
import type { Deps } from '../http/deps';
import { PluginRefused, type PluginAddResult, type PluginFrom } from '../plugins/service';

/**
 * A server's plugin files (MOD-06): admins only (`mods.manage`), since a
 * plugin runs code inside the server. The audit log records who added what:
 * each file's name, size and SHA-256, and the upload or link it came from;
 * refusals too.
 */
const perm = { permission: 'mods.manage' as const };
/** A plugin file name as sources take them (each checks its own). */
const name = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$' } as const;

export function pluginRoutes(app: FastifyInstance, deps: Deps): void {
  const { audit } = deps;
  const who = (req: { auth: { user: { username: string } } | null }) => req.auth?.user.username ?? null;

  /** An add, in the audit log whichever way it went. */
  const audited = async (req: FastifyRequest, from: () => PluginFrom | null, add: () => Promise<PluginAddResult>): Promise<PluginAddResult> => {
    try {
      const r = await add();
      audit.log({
        ...by(req),
        action: 'plugins.add',
        target: r.added.map((f) => f.name).join(', ').slice(0, 500),
        detail: { from: r.from, added: r.added.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })), replaced: r.replaced, skipped: r.skipped.slice(0, 50) },
      });
      return r;
    } catch (e) {
      const refused = e instanceof PluginRefused;
      audit.log({ ...by(req), action: 'plugins.add', ok: false, detail: { from: refused ? e.from : from(), reason: refused ? e.reason : 'failed', message: (e as Error).message.slice(0, 500) } });
      throw e;
    }
  };

  app.get('/plugins', { config: perm }, async (req) => srvOf(req).plugins.list());

  // One plugin file, or a zip of them, as multipart form data.
  app.post('/plugins/upload', { config: perm }, async (req) => {
    const { plugins } = srvOf(req);
    if (!plugins.available) throw new HttpError(409, 'capability-unsupported');
    if (!req.isMultipart()) throw new HttpError(415, 'expected-multipart');
    const max = plugins.sources[0]!.maxBytes;
    const file = await req.file({ limits: { fileSize: max, files: 1 } });
    if (!file) throw new HttpError(400, 'no-file');
    const chunks: Buffer[] = [];
    for await (const c of file.file) chunks.push(c as Buffer);
    const data = Buffer.concat(chunks);
    return audited(
      req,
      () => ({ upload: file.filename, size: data.length, sha256: null }),
      () => {
        if (file.file.truncated) throw new PluginRefused('too-large', `${file.filename} is more than the ${max} bytes allowed`, { upload: file.filename, size: data.length, sha256: null });
        return plugins.addUpload(file.filename, data, who(req));
      },
    );
  });

  app.post<{ Body: { url: string } }>(
    '/plugins',
    { config: perm, schema: { body: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', minLength: 1, maxLength: 2000 } } } } },
    async (req) => audited(req, () => ({ url: req.body.url.slice(0, 2000) }), () => srvOf(req).plugins.addLink(req.body.url, who(req))),
  );

  app.put<{ Params: { name: string }; Body: { enabled: boolean } }>(
    '/plugins/:name',
    {
      config: perm,
      schema: {
        params: { type: 'object', required: ['name'], properties: { name } },
        body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } },
      },
    },
    async (req) => {
      const r = await srvOf(req).plugins.setEnabled(req.params.name, req.body.enabled, who(req));
      if (r.changed) audit.log({ ...by(req), action: req.body.enabled ? 'plugins.enable' : 'plugins.disable', target: req.params.name });
      return r;
    },
  );

  app.delete<{ Params: { name: string } }>('/plugins/:name', { config: perm, schema: { params: { type: 'object', required: ['name'], properties: { name } } } }, async (req) => {
    const r = await srvOf(req).plugins.remove(req.params.name, who(req));
    audit.log({ ...by(req), action: 'plugins.remove', target: req.params.name });
    return r;
  });
}
