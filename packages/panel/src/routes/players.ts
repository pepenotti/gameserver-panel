import type { FastifyInstance, FastifyRequest } from 'fastify';
import { allowed, by, HttpError, srvOf } from '../http/context';
import type { Deps } from '../http/deps';

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
  const { audit } = deps;
  const who = (req: FastifyRequest) => req.auth?.user.username ?? null;

  app.get('/players', { config: { permission: 'players.view', capability: 'players' } }, async (req) => {
    const { players } = srvOf(req);
    const full = allowed(req, 'accounts.view');
    return {
      online: players.onlineNow(),
      // Accounts, SteamIDs and bans are for operators and up.
      accounts: full ? await players.accounts() : null,
      bans: full ? await players.bans() : null,
      ipBansTrustworthy: deps.env.clientIpTrustworthy,
    };
  });

  app.get<{ Querystring: { limit?: number } }>(
    '/players/history',
    {
      config: { permission: 'accounts.view', capability: 'playerHistory' },
      schema: { querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 1000 } } } },
    },
    async (req) => srvOf(req).players.history(req.query.limit),
  );

  app.post<{ Body: { username: string; reason?: string } }>(
    '/players/kick',
    {
      config: { permission: 'players.moderate', capability: 'kick' },
      schema: { body: { type: 'object', required: ['username'], additionalProperties: false, properties: { username, reason } } },
    },
    async (req) => {
      const output = await srvOf(req).players.kick(who(req), req.body.username, req.body.reason);
      audit.log({ ...by(req), action: 'player.kick', target: req.body.username, detail: req.body.reason ?? null });
      return { output };
    },
  );

  app.post<{ Body: { username?: string; steamId?: string; reason?: string } }>(
    '/players/ban',
    { config: { permission: 'players.moderate', capability: 'ban' }, schema: { body: target } },
    async (req) => {
      const output = await srvOf(req).players.ban(who(req), { username: req.body.username, steamId: req.body.steamId }, req.body.reason);
      audit.log({ ...by(req), action: 'player.ban', target: req.body.steamId ?? req.body.username ?? null, detail: req.body.reason ?? null });
      return { output };
    },
  );

  app.post<{ Body: { username?: string; steamId?: string } }>(
    '/players/unban',
    { config: { permission: 'players.moderate', capability: 'ban' }, schema: { body: target } },
    async (req) => {
      const output = await srvOf(req).players.unban(who(req), { username: req.body.username, steamId: req.body.steamId });
      audit.log({ ...by(req), action: 'player.unban', target: req.body.steamId ?? req.body.username ?? null });
      return { output };
    },
  );

  app.post<{ Body: { username: string; level: string } }>(
    '/players/access',
    {
      config: { permission: 'players.accessLevel', capability: 'accessLevels' },
      schema: { body: { type: 'object', required: ['username', 'level'], additionalProperties: false, properties: { username, level: { type: 'string', minLength: 1, maxLength: 32 } } } },
    },
    async (req) => {
      const { players } = srvOf(req);
      // The server's adapter lists its levels.
      const levels = players.accessLevels();
      if (levels.length && !levels.some((l) => l.id === req.body.level)) throw new HttpError(400, 'validation', 'unknown access level', { message: 'unknown access level' });
      const output = await players.setAccess(who(req), req.body.username, req.body.level);
      audit.log({ ...by(req), action: 'player.access-level', target: req.body.username, detail: req.body.level });
      return { output };
    },
  );

  app.post<{ Body: { username: string; password: string } }>(
    '/players/whitelist',
    {
      config: { permission: 'whitelist.manage', capability: 'whitelist' },
      schema: { body: { type: 'object', required: ['username', 'password'], additionalProperties: false, properties: { username, password: { type: 'string', minLength: 4, maxLength: 64 } } } },
    },
    async (req) => {
      const output = await srvOf(req).players.whitelistAdd(who(req), req.body.username, req.body.password);
      audit.log({ ...by(req), action: 'player.whitelist-add', target: req.body.username });
      return { output };
    },
  );

  app.delete<{ Params: { username: string } }>(
    '/players/whitelist/:username',
    { config: { permission: 'whitelist.manage', capability: 'whitelist' }, schema: { params: { type: 'object', required: ['username'], properties: { username } } } },
    async (req) => {
      const output = await srvOf(req).players.whitelistRemove(who(req), req.params.username);
      audit.log({ ...by(req), action: 'player.whitelist-remove', target: req.params.username });
      return { output };
    },
  );
}
