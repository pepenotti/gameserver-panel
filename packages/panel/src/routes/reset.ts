import type { FastifyInstance } from 'fastify';
import { can, type Permission } from '@pz/shared';
import type { ResetScope } from '../backups/flows';
import { COUNTDOWNS } from '../control/control';
import { actor, HttpError } from '../http/context';
import type { Deps } from '../http/deps';

const SCOPE_PERMISSION: Record<ResetScope, Permission> = {
  world: 'reset.world',
  full: 'reset.full',
  factory: 'reset.factory',
};

export function resetRoutes(app: FastifyInstance, deps: Deps): void {
  app.post<{ Body: { scope: ResetScope; confirm: string; countdownSec?: number; newSeed?: boolean; preset?: string } }>(
    '/api/reset',
    {
      // The minimum; each scope checks its own permission below.
      config: { permission: 'reset.world' },
      schema: {
        body: {
          type: 'object',
          required: ['scope', 'confirm'],
          additionalProperties: false,
          properties: {
            scope: { enum: ['world', 'full', 'factory'] },
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
      if (!can(req.auth!.user.role, SCOPE_PERMISSION[scope])) throw new HttpError(403, 'forbidden');
      // Typing the server name is the "are you really sure" for an irreversible action.
      if (req.body.confirm.trim() !== deps.env.serverName) throw new HttpError(400, 'confirm-mismatch');
      const op = deps.flows.startReset(req.auth!.user.username, scope, {
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
