import type { FastifyInstance, FastifyRequest } from 'fastify';
import { allowed, by, HttpError, srvOf } from '../http/context';
import type { Deps } from '../http/deps';
import { addressesTrustworthy } from '../host/traits';

const username = { type: 'string', minLength: 1, maxLength: 32 } as const;
const reason = { type: 'string', maxLength: 200 } as const;
const steamId = { type: 'string', pattern: '^\\d{17}$' } as const;
/** An IPv4 or IPv6 address, as far as a schema can tell (the adapter checks it for real). */
const ip = { type: 'string', minLength: 2, maxLength: 45, pattern: '^[0-9A-Fa-f.:]+$' } as const;
/** The id a game client sends (TShock's UUID), as far as a schema can tell. */
const uuid = { type: 'string', minLength: 8, maxLength: 64, pattern: '^[0-9A-Fa-f-]+$' } as const;
/** An account the game server keeps (TShock's), as the adapter checks it. */
const account = { type: 'string', minLength: 1, maxLength: 32 } as const;
/** Whom a ban names: a player's name, a SteamID, an address, a client id or an account (the server's adapter says which it takes). */
const target = {
  type: 'object',
  additionalProperties: false,
  properties: { username, steamId, ip, uuid, account, reason },
  anyOf: [{ required: ['username'] }, { required: ['steamId'] }, { required: ['ip'] }, { required: ['uuid'] }, { required: ['account'] }],
} as const;

type Target = { username?: string; steamId?: string; ip?: string; uuid?: string; account?: string };
const FIELDS = ['username', 'steamId', 'ip', 'uuid', 'account'] as const;
const targetOf = (b: Target): Target => Object.fromEntries(FIELDS.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
const named = (b: Target) => b.steamId ?? b.ip ?? b.uuid ?? b.account ?? b.username ?? null;

export function playerRoutes(app: FastifyInstance, deps: Deps): void {
  const { audit } = deps;
  const who = (req: FastifyRequest) => req.auth?.user.username ?? null;

  app.get('/players', { config: { permission: 'players.view', capability: 'players' } }, async (req) => {
    const { players } = srvOf(req);
    const full = allowed(req, 'accounts.view');
    // HST-07: whether players' addresses reach the game here (the host's trait, or the owner's word), for the notes on address bans.
    const addresses = await deps.hostTraits.addresses();
    return {
      online: players.onlineNow(),
      // Accounts, SteamIDs, bans, the whitelist and who holds a level are for operators and up.
      accounts: full ? await players.accounts() : null,
      bans: full ? await players.bans() : null,
      whitelist: full ? await players.whitelist() : null,
      levelHolders: full ? await players.levelHolders() : null,
      // A ban of an address names one player's: their own address arrives (or is expected to, on Docker Engine).
      ipBansTrustworthy: addressesTrustworthy(addresses),
      addresses,
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

  app.post<{ Body: Target & { reason?: string } }>('/players/ban', { config: { permission: 'players.moderate', capability: 'ban' }, schema: { body: target } }, async (req) => {
    const output = await srvOf(req).players.ban(who(req), targetOf(req.body), req.body.reason);
    audit.log({ ...by(req), action: 'player.ban', target: named(req.body), detail: req.body.reason ?? null });
    return { output };
  });

  app.post<{ Body: Target }>('/players/unban', { config: { permission: 'players.moderate', capability: 'ban' }, schema: { body: target } }, async (req) => {
    const output = await srvOf(req).players.unban(who(req), targetOf(req.body));
    audit.log({ ...by(req), action: 'player.unban', target: named(req.body) });
    return { output };
  });

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

  // A password when the game's whitelist is accounts players join with (the adapter says); a name alone otherwise.
  app.post<{ Body: { username: string; password?: string } }>(
    '/players/whitelist',
    {
      config: { permission: 'whitelist.manage', capability: 'whitelist' },
      schema: { body: { type: 'object', required: ['username'], additionalProperties: false, properties: { username, password: { type: 'string', minLength: 4, maxLength: 64 } } } },
    },
    async (req) => {
      const { players } = srvOf(req);
      const withPassword = players.whitelistNeedsPassword();
      if (withPassword && req.body.password === undefined) throw new HttpError(400, 'validation', 'password is required', { message: 'password is required' });
      const output = await players.whitelistAdd(who(req), req.body.username, withPassword ? req.body.password : undefined);
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

  // The whitelist switched on or off on the running game (where the adapter can).
  app.post<{ Body: { enabled: boolean } }>(
    '/players/whitelist/enabled',
    {
      config: { permission: 'whitelist.manage', capability: 'whitelist' },
      schema: { body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } } },
    },
    async (req) => {
      const output = await srvOf(req).players.setWhitelistEnabled(who(req), req.body.enabled);
      audit.log({ ...by(req), action: req.body.enabled ? 'player.whitelist-on' : 'player.whitelist-off' });
      return { output };
    },
  );
}
