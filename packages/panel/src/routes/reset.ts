import type { FastifyInstance } from 'fastify';
import { can, type Permission } from '@gsp/shared';
import { COUNTDOWNS } from '../control/control';
import { actor, HttpError } from '../http/context';
import type { Deps } from '../http/deps';

/** The lowest permission any reset asks for: who may open the route at all. */
const MINIMUM: Permission = 'reset.world';

export function resetRoutes(app: FastifyInstance, deps: Deps): void {
  const scopes = deps.flows.resets();
  if (scopes.length === 0) return;

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
            scope: { enum: scopes.map((s) => s.id) },
            confirm: { type: 'string', maxLength: 64 },
            countdownSec: { enum: [...COUNTDOWNS] },
            newSeed: { type: 'boolean' },
            preset: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$' },
          },
        },
      },
    },
    async (req) => {
      const { scope } = req.body;
      const decl = scopes.find((s) => s.id === scope)!;
      if (!can(req.auth!.user.role, decl.permission)) throw new HttpError(403, 'forbidden');
      // Typing the server name is the "are you really sure" for an irreversible action.
      if (req.body.confirm.trim() !== deps.server.ref.gameName) throw new HttpError(400, 'confirm-mismatch');
      const op = await deps.flows.startReset(req.auth!.user.username, scope, {
        countdownSec: req.body.countdownSec ?? 0,
        lang: req.auth!.user.lang,
        newSeed: req.body.newSeed ?? false,
        preset: req.body.preset,
      });
      deps.audit.log({ user: actor(req), action: `reset.${scope}`, detail: { newSeed: req.body.newSeed ?? false, preset: req.body.preset ?? null }, ip: req.ip });
      return op;
    },
  );
}
