/**
 * Minecraft moderation over RCON (PLY-03), with the commands and replies
 * measured on 26.3 (docs/verification/minecraft-26.3.md, "Control"): kick,
 * ban and pardon a name (the game looks up its account), ban-ip and
 * pardon-ip an address, op and deop (the levels player and operator),
 * whitelist add, remove, on and off. The lists themselves (whitelist,
 * operators, bans) are read from the JSON files the game writes.
 */
import { isIP } from 'node:net';
import type { AccessLevel, BanList, LevelHolder, PlayerOps, PlayerTarget, ServerCtx, WhitelistInfo } from '@gsp/adapter-api';
import { parseProperties, propertiesToRecord, RconProtocolError } from '@gsp/formats';

export const MINECRAFT_ACCESS_LEVELS: readonly AccessLevel[] = [
  { id: 'player', label: { en: 'Player', es: 'Jugador' } },
  { id: 'operator', label: { en: 'Operator', es: 'Operador' } },
];

/** A Minecraft account name: letters, digits and underscores, 1 to 16 (anything else can't be one, and can't carry a second command). */
const NAME = /^[A-Za-z0-9_]{1,16}$/;
const REASON_MAX = 200;
/** The lists are small; a bigger file isn't the game's. */
const LIST_MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 10_000;
/** How long the game gets to write server.properties after `whitelist on|off`. */
const REWRITE_WAIT_MS = 3000;

function nameArg(name: string): string {
  if (!NAME.test(name)) throw new RconProtocolError('Invalid player name');
  return name;
}

function ipArg(ip: string): string {
  if (isIP(ip) === 0) throw new RconProtocolError('Invalid IP address');
  return ip;
}

/** The rest of the command line: one line, no quotes or control characters, not too long. */
function reasonArg(reason?: string): string {
  if (reason === undefined || reason.trim() === '') return '';
  const r = reason.trim();
  if (r.length > REASON_MAX || /["\r\n\0]|[\x00-\x1f\x7f]/.test(r)) throw new RconProtocolError('The reason contains a quote or control character, or is too long');
  return ` ${r}`;
}

async function run(ctx: ServerCtx, command: string): Promise<string> {
  const r = await ctx.command({ command, via: 'rcon' });
  return (r.output ?? '').trim();
}

// The game runs next to plugins and mods (arbitrary code): its files are checked, not trusted.
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

/** A JSON array the game wrote (`[]` when the file isn't there yet). */
async function readList(ctx: ServerCtx, rel: string): Promise<Record<string, unknown>[]> {
  const buf = await ctx.files.read('data', rel, { maxBytes: LIST_MAX_BYTES });
  if (!buf) return [];
  let x: unknown;
  try {
    x = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error(`${rel} is not valid JSON`);
  }
  if (!Array.isArray(x)) throw new Error(`${rel} is not a list`);
  return x.slice(0, MAX_ROWS).filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object');
}

async function readProperties(ctx: ServerCtx): Promise<Record<string, string> | null> {
  const buf = await ctx.files.read('data', 'server.properties', { maxBytes: LIST_MAX_BYTES });
  if (!buf) return null;
  try {
    return propertiesToRecord(parseProperties(buf.toString('utf8')));
  } catch {
    return null;
  }
}

function target(t: PlayerTarget): { ip: string } | { name: string } {
  if (t.steamId !== undefined) throw new RconProtocolError('Minecraft bans a player name or an IP address');
  if (t.ip !== undefined) return { ip: ipArg(t.ip) };
  if (t.username === undefined) throw new RconProtocolError('A player name or an IP address is needed');
  return { name: nameArg(t.username) };
}

/**
 * `whitelist on|off` makes the game rewrite server.properties from memory
 * (measured), so settings the panel saved since the game started would be
 * lost: they are read before, and written back once the game has rewritten
 * the file (whatever differs from before, but the whitelist itself).
 */
async function setWhitelistEnabled(ctx: ServerCtx, on: boolean): Promise<string> {
  const before = await readProperties(ctx);
  const out = await run(ctx, `whitelist ${on ? 'on' : 'off'}`);
  if (!before) return out;
  const want = String(on);
  let after = await readProperties(ctx);
  for (const end = Date.now() + REWRITE_WAIT_MS; after && after['white-list'] !== want && Date.now() < end; ) {
    await new Promise((r) => setTimeout(r, 100));
    after = await readProperties(ctx);
  }
  if (!after) return out;
  const lost: Record<string, string> = {};
  for (const [k, v] of Object.entries(before)) if (k !== 'white-list' && after[k] !== v) lost[k] = v;
  if (Object.keys(lost).length) await ctx.config.set('properties', lost, 'kept settings saved since the server started (the whitelist was switched)');
  return out;
}

export const minecraftPlayers: PlayerOps = {
  accessLevels: MINECRAFT_ACCESS_LEVELS,
  banTargets: ['username', 'ip'],
  whitelistPassword: false,

  kick: async (ctx, username, reason) => run(ctx, `kick ${nameArg(username)}${reasonArg(reason)}`),

  async ban(ctx, t, reason) {
    const who = target(t);
    return 'ip' in who ? run(ctx, `ban-ip ${who.ip}${reasonArg(reason)}`) : run(ctx, `ban ${who.name}${reasonArg(reason)}`);
  },

  async unban(ctx, t) {
    const who = target(t);
    return 'ip' in who ? run(ctx, `pardon-ip ${who.ip}`) : run(ctx, `pardon ${who.name}`);
  },

  async setAccess(ctx, username, level) {
    const name = nameArg(username);
    if (level === 'operator') return run(ctx, `op ${name}`);
    if (level === 'player') return run(ctx, `deop ${name}`);
    throw new RconProtocolError('Unknown access level');
  },

  whitelistAdd: async (ctx, username) => run(ctx, `whitelist add ${nameArg(username)}`),
  whitelistRemove: async (ctx, username) => run(ctx, `whitelist remove ${nameArg(username)}`),
  setWhitelistEnabled,

  async whitelist(ctx): Promise<WhitelistInfo> {
    const rows = await readList(ctx, 'whitelist.json');
    const flag = (await readProperties(ctx))?.['white-list'];
    return {
      enabled: flag === 'true' ? true : flag === 'false' ? false : null,
      usernames: rows.map((r) => str(r.name, 64)).filter((n): n is string => n !== null),
    };
  },

  async levelHolders(ctx): Promise<LevelHolder[]> {
    return (await readList(ctx, 'ops.json')).map((r) => str(r.name, 64)).filter((n): n is string => n !== null).map((username) => ({ username, level: 'operator' }));
  },

  async bans(ctx): Promise<BanList> {
    const players = await readList(ctx, 'banned-players.json');
    const ips = await readList(ctx, 'banned-ips.json');
    return {
      steamIds: [],
      usernames: players
        .map((r) => ({ username: str(r.name, 64), id: str(r.uuid, 64), reason: str(r.reason) }))
        .filter((r): r is { username: string; id: string | null; reason: string | null } => r.username !== null),
      ips: ips.map((r) => ({ ip: str(r.ip, 64), username: null, reason: str(r.reason) })).filter((r): r is { ip: string; username: null; reason: string | null } => r.ip !== null),
    };
  },
};
