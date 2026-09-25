import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Scalar } from '@gsp/adapter-api';
import { MAX_TEXT_BYTES } from '../files/policy';
import { by, HttpError, srvOf } from '../http/context';
import type { Deps } from '../http/deps';
import { PROPOSAL_STATUSES, type ProposalInput, type ProposalStatus } from '../proposals/service';
import { FILE_ID } from './config';

const perm = { permission: 'config.edit' as const };
const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } } } as const;

/**
 * Change proposals (AST-03): every settings and file change is submitted,
 * shown as a diff, and applied or rejected by a person — forms and the text
 * editor alike (CFG-07).
 */
export function proposalRoutes(app: FastifyInstance, deps: Deps): void {
  const { audit } = deps;
  const who = (req: FastifyRequest) => req.auth?.user.username ?? null;

  app.post<{ Body: ProposalInput }>(
    '/config/proposals',
    {
      config: perm,
      // A file may be up to 1 MiB of text; JSON escaping makes the body larger.
      bodyLimit: 4 * MAX_TEXT_BYTES,
      schema: {
        body: {
          type: 'object',
          required: ['fileId'],
          additionalProperties: false,
          properties: {
            fileId: FILE_ID,
            text: { type: 'string', maxLength: MAX_TEXT_BYTES },
            changes: { type: 'object', maxProperties: 1000, additionalProperties: {} },
            preset: { type: 'string', minLength: 1, maxLength: 100 },
            revert: { type: 'integer', minimum: 1 },
            baseSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            note: { type: 'string', maxLength: 300 },
          },
        },
      },
    },
    async (req) => {
      const b = req.body;
      if ([b.text, b.changes, b.preset, b.revert].filter((x) => x !== undefined).length !== 1) throw new HttpError(400, 'validation', 'Send one of text, changes, preset or revert');
      // Fastify would coerce a typed union (true → "true"), so scalar types are checked here.
      for (const v of Object.values(b.changes ?? {}) as unknown[]) if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) throw new HttpError(400, 'validation');
      if (b.changes) for (const k of Object.keys(b.changes)) if (k.length > 200) throw new HttpError(400, 'validation');
      const r = await srvOf(req).changes.propose({ ...b, changes: b.changes as Record<string, Scalar | null> | undefined }, who(req));
      if (r.id) audit.log({ ...by(req), action: 'config.propose', target: b.fileId, detail: { proposal: r.id, keys: r.changedKeys.slice(0, 50) } });
      return r;
    },
  );

  app.get<{ Querystring: { status?: ProposalStatus; file?: string } }>(
    '/config/proposals',
    { config: perm, schema: { querystring: { type: 'object', properties: { status: { enum: PROPOSAL_STATUSES }, file: FILE_ID } } } },
    async (req) => srvOf(req).changes.list({ status: req.query.status, fileId: req.query.file }),
  );

  app.get<{ Params: { id: string } }>('/config/proposals/:id', { config: perm, schema: { params: idParam } }, async (req) => srvOf(req).changes.get(req.params.id));

  app.post<{ Params: { id: string } }>('/config/proposals/:id/apply', { config: perm, schema: { params: idParam } }, async (req) => {
    const r = await srvOf(req).changes.apply(req.params.id, who(req));
    // Keys only: the history has the text, and the audit log never holds a secret.
    audit.log({
      ...by(req),
      action: 'config.apply',
      target: r.proposal.fileId,
      detail: { proposal: r.proposal.id, applied: r.applied, keys: r.changedKeys.slice(0, 50), reapplied: r.reapplied.map((x) => x.key) },
    });
    return r;
  });

  app.post<{ Params: { id: string } }>('/config/proposals/:id/reject', { config: perm, schema: { params: idParam } }, async (req) => {
    const p = srvOf(req).changes.reject(req.params.id, who(req));
    audit.log({ ...by(req), action: 'config.reject', target: p.fileId, detail: { proposal: p.id } });
    return p;
  });
}
