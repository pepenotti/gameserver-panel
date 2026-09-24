import { createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { assertBackupName, PARTS, type BackupPart } from '../backups/service';
import { COUNTDOWNS, type GameLang } from '../control/control';
import { actor, HttpError } from '../http/context';
import type { Deps } from '../http/deps';

const nameParam = { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 120 } } } as const;
const MAX_UPLOAD = 20 * 1024 ** 3;

export function backupRoutes(app: FastifyInstance, deps: Deps): void {
  const { backups, flows, audit } = deps;
  const who = (req: FastifyRequest) => req.auth?.user.username ?? null;
  const lang = (req: FastifyRequest): GameLang => (req.auth?.user.lang === 'en' ? 'en' : 'es');

  app.get('/api/backups', { config: { permission: 'dashboard.view' } }, async () => ({
    backups: backups.list(),
    lastRestore: flows.lastRestore(),
  }));

  app.post('/api/backups', { config: { permission: 'backups.create' } }, async (req) => {
    const op = flows.startBackup(who(req));
    audit.log({ user: actor(req), action: 'backup.create', ip: req.ip });
    return op;
  });

  app.patch<{ Params: { name: string }; Body: { pinned: boolean } }>(
    '/api/backups/:name',
    {
      config: { permission: 'backups.delete' },
      schema: { params: nameParam, body: { type: 'object', required: ['pinned'], additionalProperties: false, properties: { pinned: { type: 'boolean' } } } },
    },
    async (req) => {
      const b = backups.setPinned(req.params.name, req.body.pinned);
      audit.log({ user: actor(req), action: req.body.pinned ? 'backup.pin' : 'backup.unpin', target: req.params.name, ip: req.ip });
      return b;
    },
  );

  app.delete<{ Params: { name: string } }>('/api/backups/:name', { config: { permission: 'backups.delete' }, schema: { params: nameParam } }, async (req) => {
    backups.delete(req.params.name);
    audit.log({ user: actor(req), action: 'backup.delete', target: req.params.name, ip: req.ip });
    return { ok: true };
  });

  // Backups hold account hashes and the join password: admins only, and audited.
  app.get<{ Params: { name: string } }>('/api/backups/:name/download', { config: { permission: 'backups.download' }, schema: { params: nameParam } }, async (req, reply) => {
    const b = backups.get(req.params.name);
    audit.log({ user: actor(req), action: 'backup.download', target: b.name, ip: req.ip });
    reply.header('content-type', 'application/zstd');
    reply.header('content-length', String(b.size));
    reply.header('content-disposition', `attachment; filename="${b.name}"`);
    return reply.send(createReadStream(backups.filePath(b.name)));
  });

  app.post<{ Params: { name: string }; Body: { parts: BackupPart[]; countdownSec?: number } }>(
    '/api/backups/:name/restore',
    {
      config: { permission: 'backups.restore' },
      schema: {
        params: nameParam,
        body: {
          type: 'object',
          required: ['parts'],
          additionalProperties: false,
          properties: { parts: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: PARTS } }, countdownSec: { enum: [...COUNTDOWNS] } },
        },
      },
    },
    async (req) => {
      assertBackupName(req.params.name);
      const op = flows.startRestore(who(req), req.params.name, req.body.parts, { countdownSec: req.body.countdownSec ?? 0, lang: lang(req) });
      audit.log({ user: actor(req), action: 'backup.restore', target: req.params.name, detail: { parts: req.body.parts }, ip: req.ip });
      return op;
    },
  );

  app.post('/api/backups/undo-restore', { config: { permission: 'backups.restore' } }, async (req) => {
    const op = flows.startUndoRestore(who(req));
    audit.log({ user: actor(req), action: 'backup.undo-restore', ip: req.ip });
    return op;
  });

  // Upload an archive (e.g. moving from another machine). Owner only.
  app.post('/api/backups/upload', { config: { permission: 'backups.upload' } }, async (req) => {
    if (!req.isMultipart()) throw new HttpError(415, 'expected-multipart');
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD, files: 1 } });
    if (!file) throw new HttpError(400, 'no-file');
    mkdirSync(deps.env.backupDir, { recursive: true });
    const tmp = path.join(deps.env.backupDir, `.upload-${Date.now()}-${Math.random().toString(36).slice(2)}.partial`);
    try {
      await pipeline(file.file, createWriteStream(tmp));
      if (file.file.truncated) throw new HttpError(413, 'too-large');
      const info = await backups.adopt(tmp);
      audit.log({ user: actor(req), action: 'backup.upload', target: info.name, ip: req.ip });
      return info;
    } catch (e) {
      rmSync(tmp, { force: true });
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'invalid-backup', (e as Error).message, { message: (e as Error).message });
    }
  });
}
