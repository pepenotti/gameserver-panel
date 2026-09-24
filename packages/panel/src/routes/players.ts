import type { FastifyInstance } from 'fastify';
import { can } from '@pz/shared';
import { actor } from '../http/context';
import type { Deps } from '../http/deps';
import { ACCESS_LEVELS, type AccessLevel } from '../players/service';

const username = { type: 'string', minLength: 1, maxLength: 32 } as const;
const reason = { type: 'string', maxLength: 200 } as const;
const steamId = { type: 'string', pattern: '^\\d{17}$' } as const;
const target = {
  type: 'object',
  additionalProperties: false,
  properties: { username, steamId, reason },
  anyOf: [{ required: ['username'] }, { required: ['steamId'] }],
} as const;

export function playerRoutes(app: FastifyInstance, deps: Deps): void {
  const { players, audit } = deps;

  app.get('/api/players', { config: { permission: 'players.view' } }, async (req) => {
    const role = req.auth!.user.role;
    const full = can(role, 'accounts.view');
    return {
      online: players.onlineNow(),
      // Accounts, SteamIDs and bans are for operators and up.
      accounts: full ? players.accounts() : null,
      bans: full ? players.bans() : null,
      ipBansTrustworthy: deps.env.clientIpTrustworthy,
    };
  });

  app.get<{ Querystring: { limit?: number } }>(
    '/api/players/history',
    { config: { permission: 'accounts.view' }, schema: { querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 1000 } } } } },
    async (req) => players.history(req.query.limit),
  );

  app.post<{ Body: { username: string; reason?: string } }>(
    '/api/players/kick',
    { config: { permission: 'players.moderate' }, schema: { body: { type: 'object', required: ['username'], additionalProperties: false, properties: { username, reason } } } },
    async (req) => {
      const output = await players.kick(req.body.username, req.body.reason);
      audit.log({ user: actor(req), action: 'player.kick', target: req.body.username, detail: req.body.reason ?? null, ip: req.ip });
      return { output };
    },
  );

  app.post<{ Body: { username?: string; steamId?: string; reason?: string } }>('/api/players/ban', { config: { permission: 'players.moderate' }, schema: { body: target } }, async (req) => {
    const output = await players.ban(req.body, req.body.reason);
    audit.log({ user: actor(req), action: 'player.ban', target: req.body.steamId ?? req.body.username ?? null, detail: req.body.reason ?? null, ip: req.ip });
    return { output };
  });

  app.post<{ Body: { username?: string; steamId?: string } }>('/api/players/unban', { config: { permission: 'players.moderate' }, schema: { body: target } }, async (req) => {
    const output = await players.unban(req.body);
    audit.log({ user: actor(req), action: 'player.unban', target: req.body.steamId ?? req.body.username ?? null, ip: req.ip });
    return { output };
  });

  app.post<{ Body: { username: string; level: AccessLevel } }>(
    '/api/players/access',
    {
      config: { permission: 'players.accessLevel' },
      schema: { body: { type: 'object', required: ['username', 'level'], additionalProperties: false, properties: { username, level: { enum: [...ACCESS_LEVELS] } } } },
    },
    async (req) => {
      const output = await players.setAccess(req.body.username, req.body.level);
      audit.log({ user: actor(req), action: 'player.access-level', target: req.body.username, detail: req.body.level, ip: req.ip });
      return { output };
    },
  );

  app.post<{ Body: { username: string; password: string } }>(
    '/api/players/whitelist',
    {
      config: { permission: 'whitelist.manage' },
      schema: { body: { type: 'object', required: ['username', 'password'], additionalProperties: false, properties: { username, password: { type: 'string', minLength: 4, maxLength: 64 } } } },
    },
    async (req) => {
      const output = await players.whitelistAdd(req.body.username, req.body.password);
      audit.log({ user: actor(req), action: 'player.whitelist-add', target: req.body.username, ip: req.ip });
      return { output };
    },
  );

  app.delete<{ Params: { username: string } }>(
    '/api/players/whitelist/:username',
    { config: { permission: 'whitelist.manage' }, schema: { params: { type: 'object', required: ['username'], properties: { username } } } },
    async (req) => {
      const output = await players.whitelistRemove(req.params.username);
      audit.log({ user: actor(req), action: 'player.whitelist-remove', target: req.params.username, ip: req.ip });
      return { output };
    },
  );
}
