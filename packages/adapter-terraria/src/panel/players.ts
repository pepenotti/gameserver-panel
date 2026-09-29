/**
 * Terraria moderation (PLY-03), per flavour, as measured
 * (docs/verification/terraria-1.4.5.8.md, "Control"):
 *   - vanilla and tModLoader, on the console: `kick <name>` and `ban <name>`
 *     disconnect a player who is online and say nothing otherwise (so the
 *     panel watches the log for the player leaving); a ban bans the address
 *     the player joined from, into `banlist.txt` (`//<name>`, then the
 *     address). Behind Docker Desktop every player arrives from the same
 *     address, so one ban shuts everyone out: the panel warns first
 *     (`banByAddress`, PRD §7). There is no unban command: the ban list is
 *     edited while the game is stopped (`stoppedOnly`), since the running
 *     game keeps it in memory.
 *   - TShock, through its REST API (CON-04) and the runtime's actions:
 *     kick with a reason, and bans by character name, address, the id the
 *     game client sends (UUID) or account, listed and lifted by ticket.
 * Access levels (TShock's groups) and accounts aren't offered: the runtime
 * half has no action for them yet.
 */
import { isIP } from 'node:net';
import type { BanList, BanTarget, PlayerOpKind, PlayerOps, PlayerRefusal, PlayerTarget, ServerCtx } from '@gsp/adapter-api';
import { RconProtocolError } from '@gsp/formats';
import { DATA } from '../shared/install';

/** The longest name, account or reason the runtime's actions take (and a sane bound on the console). */
const NAME_MAX = 32;
const REASON_MAX = 200;
/** How long the game gets to say a player it disconnected has left. */
export const LEFT_MS = 5000;
const BANLIST_MAX_BYTES = 1024 * 1024;

// ------------------------------------------------------------------ arguments

/** One line of printable text without quotes or spaces around it: a name the game (or TShock) could take, never a second command. */
function textArg(v: string | undefined, what: string, max: number): string {
  if (typeof v !== 'string' || v === '' || v.length > max || v.trim() !== v || /["\x00-\x1f\x7f]/.test(v)) throw new RconProtocolError(`Invalid ${what}`);
  return v;
}

const nameArg = (name: string | undefined) => textArg(name, 'player name', NAME_MAX);

function reasonArg(reason: string | undefined): string {
  if (reason === undefined || reason.trim() === '') return '';
  const r = reason.trim();
  if (r.length > REASON_MAX || /["\x00-\x1f\x7f]/.test(r)) throw new RconProtocolError('The reason contains a quote or control character, or is too long');
  return r;
}

function ipArg(ip: string | undefined): string {
  if (typeof ip !== 'string' || isIP(ip) === 0) throw new RconProtocolError('Invalid IP address');
  return ip;
}

function uuidArg(uuid: string | undefined): string {
  if (typeof uuid !== 'string' || !/^[0-9A-Fa-f-]{8,64}$/.test(uuid)) throw new RconProtocolError('Invalid UUID');
  return uuid;
}

// ------------------------------------------------------------------ refusals

/**
 * A command the game didn't do reads `(<refusal>) <what happened>`, so
 * `refused` can tell (the reply is all it sees); the panel then answers
 * with an error, keeping the text.
 */
const REFUSAL = /^\((player-not-found|player-not-online|no-change|failed)\) /;
const refusal = (why: PlayerRefusal, message: string) => `(${why}) ${message}`;

/** `PlayerOps.refused`: what a reply means when the game didn't do the command. */
export function terrariaRefused(_op: PlayerOpKind, reply: string): PlayerRefusal | null {
  return (REFUSAL.exec(reply)?.[1] as PlayerRefusal | undefined) ?? null;
}

// ------------------------------------------------------------------ vanilla and tModLoader

type Heard = 'left' | 'invalid' | 'timeout' | 'unknown';

/**
 * A console command that disconnects `name`, and what the game said: the
 * player left, the command was invalid, or nothing in time. On a server
 * whose state is unknown, the command is sent and nothing is waited for.
 */
async function disconnect(ctx: ServerCtx, command: string, name: string): Promise<Heard> {
  if (ctx.status()?.state !== 'running') {
    await ctx.command({ command, via: 'stdin' });
    return 'unknown';
  }
  const want = name.toLowerCase();
  let off: () => void = () => undefined;
  let timer: NodeJS.Timeout | undefined;
  const heard = new Promise<Heard>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), LEFT_MS);
    off = ctx.onLog((line) => {
      const t = line.trim();
      const left = /^(.+) has left\.$/.exec(t);
      if (left && left[1]!.toLowerCase() === want) resolve('left');
      else if (t === 'Invalid command.') resolve('invalid');
    });
  });
  try {
    await ctx.command({ command, via: 'stdin' });
    return await heard;
  } finally {
    clearTimeout(timer);
    off();
  }
}

/** The ban list's entries: each address, with the names written above it (`//<name>`). */
export function parseBanlist(text: string): { ip: string; names: string[] }[] {
  const out = new Map<string, string[]>();
  let pending: string[] = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('//')) {
      if (line.length > 2) pending.push(line.slice(2).trim());
      continue;
    }
    const names = out.get(line) ?? [];
    for (const n of pending) if (!names.includes(n)) names.push(n);
    out.set(line, names);
    pending = [];
  }
  return [...out].map(([ip, names]) => ({ ip, names }));
}

async function readBanlist(ctx: ServerCtx): Promise<string> {
  return (await ctx.files.read('data', DATA.banlist, { maxBytes: BANLIST_MAX_BYTES }))?.toString('utf8') ?? '';
}

/**
 * The ban list without `ips`: their lines, and each `//<name>` line whose
 * every copy is above one of them (a name also above another address
 * stays). As `lines` changes: an entry and `false` removes it.
 */
export function unbanChanges(text: string, ips: ReadonlySet<string>): Record<string, false> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim());
  const changes: Record<string, false> = {};
  const comments = new Map<string, boolean>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (ips.has(line)) changes[line] = false;
    if (!line.startsWith('//')) continue;
    const next = lines.slice(i + 1).find((l) => l !== '' && !l.startsWith('//'));
    const lifted = next !== undefined && ips.has(next);
    comments.set(line, (comments.get(line) ?? true) && lifted);
  }
  for (const [c, all] of comments) if (all) changes[c] = false;
  return changes;
}

/** Moderation of vanilla and tModLoader: on the console, and the ban list while stopped. */
export const consolePlayers: PlayerOps = {
  banTargets: ['username'],
  banByAddress: true,
  stoppedOnly: ['unban'],
  refused: terrariaRefused,

  async kick(ctx, username, reason) {
    const name = nameArg(username);
    // The console's kick takes no reason; one given is still checked.
    reasonArg(reason);
    const heard = await disconnect(ctx, `kick ${name}`, name);
    if (heard === 'timeout') return refusal('player-not-online', `${name} is not online`);
    return heard === 'left' ? `Kicked ${name}` : '';
  },

  async ban(ctx, t, reason) {
    if (t.username === undefined || Object.keys(t).some((k) => k !== 'username' && t[k as keyof PlayerTarget] !== undefined)) {
      throw new RconProtocolError('This game bans a player who is online, by name (it bans their address)');
    }
    const name = nameArg(t.username);
    reasonArg(reason);
    const heard = await disconnect(ctx, `ban ${name}`, name);
    if (heard === 'timeout') return refusal('player-not-online', `${name} is not online`);
    if (heard === 'invalid') return refusal('failed', 'The game could not write its ban list');
    if (heard !== 'left') return '';
    const entry = parseBanlist(await readBanlist(ctx)).find((e) => e.names.some((n) => n.toLowerCase() === name.toLowerCase()));
    return entry ? `Banned ${name} (address ${entry.ip})` : `Banned ${name}`;
  },

  async unban(ctx, t) {
    const by: { name: string } | { ip: string } =
      t.ip !== undefined ? { ip: ipArg(t.ip) } : t.username !== undefined ? { name: nameArg(t.username) } : (() => {
        throw new RconProtocolError('Name a banned player or address');
      })();
    const st = ctx.status()?.state;
    if (st !== undefined && st !== 'stopped' && st !== 'failed') throw new Error('The ban list can be changed only while the server is stopped');
    const text = await readBanlist(ctx);
    const entries = parseBanlist(text);
    const hits = 'ip' in by ? entries.filter((e) => e.ip === by.ip) : entries.filter((e) => e.names.some((n) => n.toLowerCase() === by.name.toLowerCase()));
    if (hits.length === 0) return refusal('no-change', `${'ip' in by ? by.ip : by.name} is not banned`);
    const ips = new Set(hits.map((e) => e.ip));
    await ctx.config.set('banlist', unbanChanges(text, ips), `unbanned ${[...ips].join(', ')}`);
    const who = hits.flatMap((e) => e.names);
    return `Lifted the ban on ${[...ips].join(', ')}${who.length ? ` (${who.join(', ')})` : ''}`;
  },

  async bans(ctx): Promise<BanList> {
    const entries = parseBanlist(await readBanlist(ctx));
    return { steamIds: [], ips: entries.map((e) => ({ ip: e.ip.slice(0, 64), username: e.names.length ? e.names.join(', ').slice(0, 200) : null, reason: null })) };
  },
};

// ------------------------------------------------------------------ TShock

/** What a ban names, as the runtime's actions take it. */
type TshockKind = 'name' | 'ip' | 'uuid' | 'account';
const KINDS: Record<Exclude<BanTarget, 'steamId'>, TshockKind> = { username: 'name', ip: 'ip', uuid: 'uuid', account: 'account' };

function tshockTarget(t: PlayerTarget): { kind: TshockKind; value: string } {
  if (t.steamId !== undefined) throw new RconProtocolError('TShock bans a name, an address, a UUID or an account');
  const given = (Object.keys(KINDS) as (keyof typeof KINDS)[]).filter((k) => t[k] !== undefined);
  if (given.length !== 1) throw new RconProtocolError('Name one player, address, UUID or account');
  const field = given[0]!;
  const v = t[field];
  const value = field === 'ip' ? ipArg(v) : field === 'uuid' ? uuidArg(v) : textArg(v, field === 'account' ? 'account' : 'player name', NAME_MAX);
  return { kind: KINDS[field], value };
}

/** A runtime action's reply (`{ ok, message, … }`); a refusal reads as one (`terrariaRefused`). */
async function act(ctx: ServerCtx, name: string, input: unknown, onRefusal: (reason: string) => PlayerRefusal = (r) => (r === 'no-change' ? 'no-change' : r === 'player-not-found' ? 'player-not-found' : 'failed')): Promise<string> {
  const r = (await ctx.action(name, input)) as { ok?: unknown; message?: unknown; reason?: unknown; kicked?: unknown } | null | undefined;
  const message = typeof r?.message === 'string' ? r.message.slice(0, 500) : '';
  if (r?.ok === false) return refusal(onRefusal(typeof r.reason === 'string' ? r.reason : 'failed'), message);
  const kicked = Array.isArray(r?.kicked) ? r.kicked.filter((k): k is string => typeof k === 'string') : [];
  return kicked.length ? `${message}; kicked ${kicked.join(', ')}` : message;
}

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

/** Moderation of TShock, through its REST API (CON-04). */
export const tshockPlayers: PlayerOps = {
  banTargets: ['username', 'ip', 'uuid', 'account'],
  refused: terrariaRefused,

  async kick(ctx, username, reason) {
    const name = nameArg(username);
    const why = reasonArg(reason);
    // TShock finds only players who are online.
    return act(ctx, 'tshock-kick', { name, ...(why ? { reason: why } : {}) }, (r) => (r === 'player-not-found' ? 'player-not-online' : 'failed'));
  },

  async ban(ctx, t, reason) {
    const target = tshockTarget(t);
    const why = reasonArg(reason);
    return act(ctx, 'tshock-ban', { target, ...(why ? { reason: why } : {}) });
  },

  async unban(ctx, t) {
    return act(ctx, 'tshock-unban', { target: tshockTarget(t) });
  },

  async bans(ctx): Promise<BanList> {
    const r = (await ctx.action('tshock-bans', {})) as { bans?: unknown } | null;
    const list = Array.isArray(r?.bans) ? (r.bans as Record<string, unknown>[]).slice(0, 10_000) : [];
    const out: Required<BanList> = { steamIds: [], ips: [], usernames: [], uuids: [], accounts: [] };
    for (const b of list) {
      const value = str(b?.value, 64);
      if (value === null) continue;
      const reason = str(b.reason);
      if (b.kind === 'name') out.usernames.push({ username: value, id: null, reason });
      else if (b.kind === 'ip') out.ips.push({ ip: value, username: null, reason });
      else if (b.kind === 'uuid') out.uuids.push({ uuid: value, reason });
      else if (b.kind === 'account') out.accounts.push({ account: value, reason });
    }
    return out;
  },
};

/** The moderation of a flavour. */
export function terrariaPlayersOf(flavour: string | null): PlayerOps | undefined {
  return flavour === 'tshock' ? tshockPlayers : flavour === 'vanilla' || flavour === 'tmodloader' ? consolePlayers : undefined;
}
