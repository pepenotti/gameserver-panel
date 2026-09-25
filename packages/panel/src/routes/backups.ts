import { createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BackupPart } from '../backups/service';
import { COUNTDOWNS, type GameLang } from '../control/control';
import { by, HttpError, srvOf } from '../http/context';
import type { Deps } from '../http/deps';

const nameParam = { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 120 } } } as const;
const MAX_UPLOAD = 20 * 1024 ** 3;

export function backupRoutes(app: FastifyInstance, deps: Deps): void {
  const { audit } = deps;
  const who = (req: FastifyRequest) => req.auth?.user.username ?? null;
  const lang = (req: FastifyRequest): GameLang => (req.auth?.user.lang === 'en' ? 'en' : 'es');

  app.get('/backups', { config: { permission: 'server.view' } }, async (req) => {
    const { backups, flows } = srvOf(req);
    return { backups: backups.list(), lastRestore: flows.lastRestore() };
  });

  app.post('/backups', { config: { permission: 'backups.create' } }, async (req) => {
    const op = srvOf(req).flows.startBackup(who(req));
    audit.log({ ...by(req), action: 'backup.create' });
    return op;
  });

  app.patch<{ Params: { name: string }; Body: { pinned: boolean } }>(
    '/backups/:name',
    {
      config: { permission: 'backups.delete' },
      schema: { params: nameParam, body: { type: 'object', required: ['pinned'], additionalProperties: false, properties: { pinned: { type: 'boolean' } } } },
    },
    async (req) => {
      const b = srvOf(req).backups.setPinned(req.params.name, req.body.pinned);
      audit.log({ ...by(req), action: req.body.pinned ? 'backup.pin' : 'backup.unpin', target: req.params.name });
      return b;
    },
  );

  app.delete<{ Params: { name: string } }>('/backups/:name', { config: { permission: 'backups.delete' }, schema: { params: nameParam } }, async (req) => {
    srvOf(req).backups.delete(req.params.name);
    audit.log({ ...by(req), action: 'backup.delete', target: req.params.name });
    return { ok: true };
  });

  // Backups hold account hashes and the join password: admins only, and audited.
  app.get<{ Params: { name: string } }>('/backups/:name/download', { config: { permission: 'backups.download' }, schema: { params: nameParam } }, async (req, reply) => {
    const { backups } = srvOf(req);
    const b = backups.get(req.params.name);
    audit.log({ ...by(req), action: 'backup.download', target: b.name });
    reply.header('content-type', 'application/zstd');
    reply.header('content-length', String(b.size));
    reply.header('content-disposition', `attachment; filename="${b.name}"`);
    return reply.send(createReadStream(backups.filePath(b.name)));
  });

  app.post<{ Params: { name: string }; Body: { parts: BackupPart[]; countdownSec?: number } }>(
    '/backups/:name/restore',
    {
      config: { permission: 'backups.restore' },
      schema: {
        params: nameParam,
        body: {
          type: 'object',
          required: ['parts'],
          additionalProperties: false,
          properties: { parts: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: { type: 'string', maxLength: 64 } }, countdownSec: { enum: [...COUNTDOWNS] } },
        },
      },
    },
    async (req) => {
      const { backups, flows } = srvOf(req);
      // The server's adapter names its parts.
      const known = backups.parts();
      if (req.body.parts.some((p) => !known.includes(p))) throw new HttpError(400, 'validation', 'unknown backup part', { message: 'unknown backup part' });
      backups.assertName(req.params.name);
      const op = flows.startRestore(who(req), req.params.name, req.body.parts, { countdownSec: req.body.countdownSec ?? 0, lang: lang(req) });
      audit.log({ ...by(req), action: 'backup.restore', target: req.params.name, detail: { parts: req.body.parts } });
      return op;
    },
  );

  app.post('/backups/undo-restore', { config: { permission: 'backups.restore' } }, async (req) => {
    const op = srvOf(req).flows.startUndoRestore(who(req));
    audit.log({ ...by(req), action: 'backup.undo-restore' });
    return op;
  });

  // Upload an archive (e.g. moving from another machine). Owner only.
  app.post('/backups/upload', { config: { permission: 'backups.upload' } }, async (req) => {
    const { backups } = srvOf(req);
    if (!req.isMultipart()) throw new HttpError(415, 'expected-multipart');
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD, files: 1 } });
    if (!file) throw new HttpError(400, 'no-file');
    mkdirSync(backups.dir, { recursive: true });
    const tmp = path.join(backups.dir, `.upload-${Date.now()}-${Math.random().toString(36).slice(2)}.partial`);
    try {
      await pipeline(file.file, createWriteStream(tmp));
      if (file.file.truncated) throw new HttpError(413, 'too-large');
      const info = await backups.adopt(tmp);
      audit.log({ ...by(req), action: 'backup.upload', target: info.name });
      return info;
    } catch (e) {
      rmSync(tmp, { force: true });
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'invalid-backup', (e as Error).message, { message: (e as Error).message });
    }
  });
}
