import type { BanList, PlayerAccount, PlayerOps, PlayerTarget, ServerCtx } from '@gsp/adapter-api';
import { assertSteamId, assertUsername, quoteArg, RconProtocolError } from '@gsp/formats';
import { ACCOUNTS, BANS, type ServerDbInput } from '../../shared/actions';

/** B42 access levels accepted by `setaccesslevel` (from the 42.20.4 help text), plus "none". */
export const PZ_ACCESS_LEVELS = ['none', 'observer', 'gm', 'overseer', 'moderator', 'admin'] as const;

/** Reads through the agent must not hold a page for as long as a download may take. */
const READ_TIMEOUT_MS = 15_000;
const MAX_ROWS = 10_000;

async function run(ctx: ServerCtx, command: string): Promise<string> {
  const r = await ctx.command({ command, via: 'rcon' });
  return (r.output ?? '').trim();
}

function userArg(username: string): string {
  assertUsername(username);
  return quoteArg(username);
}

function reasonArg(reason?: string): string {
  return reason ? ` -r ${quoteArg(reason, 'reason')}` : '';
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// The agent runs next to mods (arbitrary code): its replies are checked, not trusted.
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

function rows(x: unknown, what: string): Record<string, unknown>[] {
  if (!Array.isArray(x)) throw new Error(`Unexpected ${what} reply from the agent`);
  return x.slice(0, MAX_ROWS).filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object');
}

export function parseAccounts(x: unknown): PlayerAccount[] {
  return rows(x, 'accounts')
    .map((r) => ({ username: str(r.username, 64), displayName: str(r.displayName, 64), role: str(r.role, 64) ?? '', lastConnection: str(r.lastConnection, 64), steamId: str(r.steamId, 32) }))
    .filter((r): r is PlayerAccount => r.username !== null);
}

export function parseBans(x: unknown): BanList {
  const o = x !== null && typeof x === 'object' ? (x as Record<string, unknown>) : null;
  if (!o) throw new Error('Unexpected bans reply from the agent');
  return {
    steamIds: rows(o.steamIds, 'bans')
      .map((r) => ({ steamId: str(r.steamId, 32), reason: str(r.reason) }))
      .filter((r): r is BanList['steamIds'][number] => r.steamId !== null),
    ips: rows(o.ips, 'bans')
      .map((r) => ({ ip: str(r.ip, 64), username: str(r.username, 64), reason: str(r.reason) }))
      .filter((r): r is BanList['ips'][number] => r.ip !== null),
  };
}

function target(t: PlayerTarget): { steamId: string } | { username: string } {
  if (t.steamId) {
    assertSteamId(t.steamId);
    return { steamId: t.steamId };
  }
  if (!t.username) throw new RconProtocolError('A username or a SteamID is needed');
  assertUsername(t.username);
  return { username: t.username };
}

export const pzPlayers: PlayerOps = {
  accessLevels: PZ_ACCESS_LEVELS,

  async kick(ctx, username, reason) {
    const args = `${userArg(username)}${reasonArg(reason)}`;
    // 42.20.4 lists the command as "kick" but its usage text still says "kickuser"; try both.
    const out = await run(ctx, `kickuser ${args}`);
    return /^Unknown command/i.test(out) ? run(ctx, `kick ${args}`) : out;
  },

  async ban(ctx, t, reason) {
    const who = target(t);
    if ('steamId' in who) return run(ctx, `banid ${who.steamId}`);
    return run(ctx, `banuser ${quoteArg(who.username)}${reasonArg(reason)}`);
  },

  async unban(ctx, t) {
    const who = target(t);
    if ('steamId' in who) return run(ctx, `unbanid ${who.steamId}`);
    return run(ctx, `unbanuser ${quoteArg(who.username)}`);
  },

  async setAccess(ctx, username, level) {
    if (!(PZ_ACCESS_LEVELS as readonly string[]).includes(level)) throw new RconProtocolError('Unknown access level');
    return run(ctx, `setaccesslevel ${userArg(username)} ${level}`);
  },

  async whitelistAdd(ctx, username, password) {
    if (!password) throw new RconProtocolError('A password is needed');
    return run(ctx, `adduser ${userArg(username)} ${quoteArg(password, 'password')}`);
  },

  async whitelistRemove(ctx, username) {
    return run(ctx, `removeuserfromwhitelist ${userArg(username)}`);
  },

  // The agent reads db/<name>.db next to the game; the panel never opens it.
  async accounts(ctx) {
    const input: ServerDbInput = { serverName: ctx.srv.gameName };
    return parseAccounts(await withTimeout(ctx.action(ACCOUNTS, input), READ_TIMEOUT_MS, 'Reading the accounts'));
  },

  async bans(ctx) {
    const input: ServerDbInput = { serverName: ctx.srv.gameName };
    return parseBans(await withTimeout(ctx.action(BANS, input), READ_TIMEOUT_MS, 'Reading the bans'));
  },
};
