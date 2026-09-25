import type { FastifyInstance } from 'fastify';
import type { Permission } from '@gsp/shared';
import { COUNTDOWNS } from '../control/control';
import { allowed, by, HttpError, srvOf } from '../http/context';
import type { Deps } from '../http/deps';

/** The lowest permission any reset asks for: who may open the route at all. */
const MINIMUM: Permission = 'reset.world';

export function resetRoutes(app: FastifyInstance, deps: Deps): void {
  app.post<{ Body: { scope: string; confirm: string; countdownSec?: number; newSeed?: boolean; preset?: string } }>(
    '/api/reset',
    {
      // The minimum; each scope checks its own permission below.
      config: { permission: MINIMUM },
      schema: {
        body: {
          type: 'object',
          required: ['scope', 'confirm'],
          additionalProperties: false,
          properties: {
            scope: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
            confirm: { type: 'string', maxLength: 64 },
            countdownSec: { enum: [...COUNTDOWNS] },
            newSeed: { type: 'boolean' },
            preset: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$' },
          },
        },
      },
    },
    async (req) => {
      const s = srvOf(req);
      const { scope } = req.body;
      // The server's adapter names its scopes (none: this game has no resets).
      const decl = s.flows.resets().find((r) => r.id === scope);
      if (!decl) throw new HttpError(400, 'validation', 'unknown reset scope', { message: 'unknown reset scope' });
      if (!allowed(req, decl.permission)) throw new HttpError(403, 'forbidden');
      // Typing the server name is the "are you really sure" for an irreversible action.
      if (req.body.confirm.trim() !== s.handle.ref.gameName) throw new HttpError(400, 'confirm-mismatch');
      const op = await s.flows.startReset(req.auth!.user.username, scope, {
        countdownSec: req.body.countdownSec ?? 0,
        lang: req.auth!.user.lang,
        newSeed: req.body.newSeed ?? false,
        preset: req.body.preset,
      });
      deps.audit.log({ ...by(req), action: `reset.${scope}`, detail: { newSeed: req.body.newSeed ?? false, preset: req.body.preset ?? null } });
      return op;
    },
  );
}
