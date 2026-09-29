/**
 * Minecraft moderation over RCON (PLY-03), with the commands and replies
 * measured on 26.3 (docs/verification/minecraft-26.3.md, "Control"): kick,
 * ban and pardon a name (the game looks up its account), ban-ip and
 * pardon-ip an address, op and deop (the levels player and operator),
 * whitelist add, remove, on and off. The lists themselves (whitelist,
 * operators, bans) are read from the JSON files the game writes.
 */
import { isIP } from 'node:net';
import type { AccessLevel, BanList, LevelHolder, PlayerOpKind, PlayerOps, PlayerRefusal, PlayerTarget, ServerCtx, WhitelistInfo } from '@gsp/adapter-api';
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

/** `whitelist on|off` did it. */
const WHITELIST_SWITCHED = /^Whitelist is now turned (?:on|off)$/;

/**
 * The game's replies when it didn't do a command, measured on 26.3 (vanilla,
 * Paper and Fabric alike: `*\/rcon/moderation.json`, `players-offline.json`):
 * a name it can't look up is "That player does not exist" (ban, pardon, op,
 * deop, whitelist add and remove), a kick of someone not online "No player
 * was found", op of an operator and deop of a player "Nothing changed. …",
 * `whitelist on` when it is on "Whitelist is already turned on". The other
 * "already" replies are the game's own English texts the fake server uses
 * (docs/verification/minecraft-26.3.md, "Control"): "Nothing changed. The
 * player is already banned" / "isn't banned" (and "That IP …"), "Player is
 * already whitelisted" / "is not whitelisted", "Whitelist is already turned off".
 */
const REFUSALS: readonly [RegExp, PlayerRefusal][] = [
  [/^That player does not exist$/, 'player-not-found'],
  [/^No player was found$/, 'player-not-online'],
  [/^Nothing changed\. /, 'no-change'],
  [/^Player is (?:already|not) whitelisted$/, 'no-change'],
  [/^Whitelist is already turned (?:on|off)$/, 'no-change'],
];

/** `PlayerOps.refused`: what a reply means when the game didn't do the command. */
export function minecraftRefused(_op: PlayerOpKind, reply: string): PlayerRefusal | null {
  const r = reply.trim();
  return REFUSALS.find(([re]) => re.test(r))?.[1] ?? null;
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
 * the file (whatever differs from before, but the whitelist itself). The
 * whitelist's own key is one the game now holds: the panel's
 * next-start re-apply (`reapplyAtStart`) leaves it to the game.
 */
async function setWhitelistEnabled(ctx: ServerCtx, on: boolean): Promise<string> {
  const before = await readProperties(ctx);
  const out = await run(ctx, `whitelist ${on ? 'on' : 'off'}`);
  // "Whitelist is already turned on": the game rewrote nothing.
  if (!before || !WHITELIST_SWITCHED.test(out)) return out;
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
  await ctx.config.set('properties', { 'white-list': want }, `the whitelist was switched ${on ? 'on' : 'off'} in the game`, { live: true });
  return out;
}

export const minecraftPlayers: PlayerOps = {
  accessLevels: MINECRAFT_ACCESS_LEVELS,
  banTargets: ['username', 'ip'],
  whitelistPassword: false,
  refused: minecraftRefused,

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
