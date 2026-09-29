/**
 * TShock's REST API (CON-04, PLY-01, PLY-03, CON-03), as measured on 6.2.1
 * (docs/verification/terraria-1.4.5.8.md, "Control"; fixtures/terraria/
 * 1.4.5.8/tshock/rest): GET with query parameters and the agent's
 * application token, on the server's own REST port (never published), JSON
 * answers with a string `status`. Plain `fetch`, never retried: creating a
 * ban answers 500 while players are online but stores the ban, so every
 * change is confirmed by reading the list back instead.
 */
import type { InstallCtx, PlayerList, RuntimeAction, RuntimeCtx } from '@gsp/adapter-api';
import { port } from './files';

const TIMEOUT_MS = 10_000;
/** .NET ticks at the Unix epoch, and per millisecond. */
const EPOCH_TICKS = 621_355_968_000_000_000;
const TICKS_PER_MS = 10_000;
/** TShock's "never expires" (`DateTime.MaxValue`, 3155378976000000000 ticks). */
const FOREVER_TICKS = 3.1e18;

export interface RestReply {
  status: number;
  body: Record<string, unknown>;
}

/** One call. Rejects when nothing answered (no REST API: not TShock, or not running) or the answer isn't JSON. */
export async function rest(ctx: RuntimeCtx, endpoint: string, params: Record<string, string> = {}): Promise<RestReply> {
  const q = new URLSearchParams({ ...params, token: ctx.state.controlSecret });
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port(ctx, 'rest')}${endpoint}?${q.toString()}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`TShock's REST API did not answer (${(e as Error).message}): only TShock servers have it, while they run`, { cause: e });
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`TShock's REST API answered HTTP ${res.status} with something that isn't JSON`);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error(`TShock's REST API answered HTTP ${res.status} with an unexpected shape`);
  if (res.status === 403) throw new Error("TShock's REST API refused the agent's token");
  return { status: res.status, body: body as Record<string, unknown> };
}

const text = (v: unknown) => (typeof v === 'string' ? v : '');
/** TShock's own words for a failure. */
const why = (r: RestReply) => text(r.body.error) || text(r.body.response) || `HTTP ${r.status}`;

// ------------------------------------------------------------------ players

export interface RestPlayer {
  name: string;
  /** The TShock account the player is logged in to; null for guests. */
  account: string | null;
  group: string;
  active: boolean;
}

export async function restPlayers(ctx: RuntimeCtx): Promise<RestPlayer[]> {
  const r = await rest(ctx, '/v2/players/list');
  if (r.status !== 200 || !Array.isArray(r.body.players)) throw new Error(`TShock did not list its players: ${why(r)}`);
  return (r.body.players as Record<string, unknown>[]).flatMap((x) =>
    typeof x?.nickname === 'string' ? [{ name: x.nickname, account: text(x.username) || null, group: text(x.group), active: x.active === true }] : [],
  );
}

/** Who is online (PLY-01): the players that finished joining. */
export async function restPlayerList(ctx: RuntimeCtx): Promise<PlayerList> {
  const names = (await restPlayers(ctx)).filter((p) => p.active).map((p) => p.name);
  return { count: names.length, names };
}

// ------------------------------------------------------------------ bans

/** What a ban names, as TShock's identifiers do (`name:`, `ip:`, `uuid:`, `acc:`). */
export const BAN_KINDS = { name: 'name:', ip: 'ip:', uuid: 'uuid:', account: 'acc:' } as const;
export type BanKind = keyof typeof BAN_KINDS;

export interface BanTargetInput {
  kind: BanKind;
  value: string;
}

export interface RestBan {
  ticket: number;
  kind: BanKind | null;
  /** The identifier without its kind. */
  value: string;
  identifier: string;
  reason: string;
  by: string;
  /** ISO times; `until` null: never expires. */
  since: string | null;
  until: string | null;
}

const iso = (ticks: number) => (Number.isFinite(ticks) && ticks > EPOCH_TICKS ? new Date((ticks - EPOCH_TICKS) / TICKS_PER_MS).toISOString() : null);
const identifierOf = (t: BanTargetInput) => `${BAN_KINDS[t.kind]}${t.value}`;

/** The bans in force (a lifted ban stays listed, expired, unless it was deleted). */
export async function restBans(ctx: RuntimeCtx): Promise<RestBan[]> {
  const r = await rest(ctx, '/v3/bans/list');
  if (r.status !== 200 || !Array.isArray(r.body.bans)) throw new Error(`TShock did not list its bans: ${why(r)}`);
  const now = Date.now() * TICKS_PER_MS + EPOCH_TICKS;
  const out: RestBan[] = [];
  for (const b of r.body.bans as Record<string, unknown>[]) {
    if (typeof b?.ticket_number !== 'number' || typeof b.identifier !== 'string') continue;
    const end = typeof b.end_date_ticks === 'number' ? b.end_date_ticks : FOREVER_TICKS;
    if (end < now) continue;
    const kind = (Object.keys(BAN_KINDS) as BanKind[]).find((k) => (b.identifier as string).startsWith(BAN_KINDS[k])) ?? null;
    out.push({
      ticket: b.ticket_number,
      kind,
      value: kind ? b.identifier.slice(BAN_KINDS[kind].length) : b.identifier,
      identifier: b.identifier,
      reason: text(b.reason),
      by: text(b.banning_user),
      since: iso(typeof b.start_date_ticks === 'number' ? b.start_date_ticks : NaN),
      until: end >= FOREVER_TICKS ? null : iso(end),
    });
  }
  return out.sort((a, b) => a.ticket - b.ticket);
}

/** A refusal the panel words (`PlayerRefusal`), or a failure. */
export type ActionReply = { ok: true; message: string; [k: string]: unknown } | { ok: false; reason: 'player-not-found' | 'no-change' | 'failed'; message: string };

async function kick(ctx: RuntimeCtx, name: string, reason: string): Promise<ActionReply> {
  const r = await rest(ctx, '/v2/players/kick', { player: name, reason });
  if (r.status === 200) return { ok: true, message: text(r.body.response) || `Kicked ${name}` };
  if (r.status === 400) return { ok: false, reason: 'player-not-found', message: why(r) };
  return { ok: false, reason: 'failed', message: why(r) };
}

/**
 * Bans, then reads the list back: TShock answers 500 while players are
 * online yet stores the ban (measured), and never kicks. So a new ticket
 * for the identifier is the only proof; players it names who are online
 * are kicked then (a name, an account, or an address).
 */
async function ban(ctx: RuntimeCtx, target: BanTargetInput, reason: string): Promise<ActionReply> {
  const identifier = identifierOf(target);
  const before = await restBans(ctx);
  const existing = before.find((b) => b.identifier === identifier);
  if (existing) return { ok: false, reason: 'no-change', message: `Already banned (ticket ${existing.ticket})` };
  const r = await rest(ctx, '/v3/bans/create', { identifier, reason });
  if (r.status === 400) return { ok: false, reason: 'failed', message: why(r) };
  const made = (await restBans(ctx)).find((b) => b.identifier === identifier && !before.some((x) => x.ticket === b.ticket));
  if (!made) return { ok: false, reason: 'failed', message: `TShock did not store the ban: ${why(r)}` };
  const kicked: string[] = [];
  const online = (await restPlayers(ctx)).filter((p) => p.active);
  for (const p of online) {
    let hit = (target.kind === 'name' && p.name === target.value) || (target.kind === 'account' && p.account === target.value);
    if (!hit && target.kind === 'ip') {
      const read = await rest(ctx, '/v3/players/read', { player: p.name });
      hit = read.status === 200 && read.body.ip === target.value;
    }
    if (hit && (await kick(ctx, p.name, reason)).ok) kicked.push(p.name);
  }
  return { ok: true, message: `Banned ${identifier} (ticket ${made.ticket})`, ticket: made.ticket, kicked };
}

/** Lifts the bans for a ticket or an identifier, deleting them (without `fullDelete` they stay listed as expired). */
async function unban(ctx: RuntimeCtx, by: { ticket: number } | { target: BanTargetInput }): Promise<ActionReply> {
  const bans = await restBans(ctx);
  const hits = 'ticket' in by ? bans.filter((b) => b.ticket === by.ticket) : bans.filter((b) => b.identifier === identifierOf(by.target));
  if (hits.length === 0) return { ok: false, reason: 'no-change', message: 'Not banned' };
  for (const b of hits) {
    const r = await rest(ctx, '/v3/bans/destroy', { ticketNumber: String(b.ticket), fullDelete: 'true' });
    if (r.status !== 200) return { ok: false, reason: 'failed', message: `Ticket ${b.ticket}: ${why(r)}` };
  }
  return { ok: true, message: `Lifted ${hits.map((b) => `ticket ${b.ticket}`).join(', ')}`, tickets: hits.map((b) => b.ticket) };
}

// ------------------------------------------------------------------ the actions

function asObject(x: unknown): Record<string, unknown> {
  if (x === undefined || x === null) return {};
  if (typeof x !== 'object' || Array.isArray(x)) throw new Error('Give an object');
  return x as Record<string, unknown>;
}

/** Printable text without line breaks. */
function line(v: unknown, what: string, max: number, min = 1): string {
  if (typeof v !== 'string' || v.length < min || v.length > max || /[\x00-\x1f\x7f]/.test(v)) throw new Error(`${what} must be ${min}-${max} characters without line breaks`);
  return v;
}

const optionalReason = (v: unknown) => (v === undefined || v === null || v === '' ? '' : line(v, 'reason', 200));

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 = /^[0-9a-fA-F:]{2,39}$/;
const UUID = /^[0-9a-fA-F-]{8,64}$/;

function banTarget(x: unknown): BanTargetInput {
  const o = asObject(x);
  if (typeof o.kind !== 'string' || !Object.hasOwn(BAN_KINDS, o.kind)) throw new Error(`target.kind must be one of ${Object.keys(BAN_KINDS).join(', ')}`);
  const kind = o.kind as BanKind;
  const value = line(o.value, 'target.value', 64);
  if (kind === 'ip' && !IPV4.test(value) && !(IPV6.test(value) && value.includes(':'))) throw new Error('target.value must be an IP address');
  if (kind === 'uuid' && !UUID.test(value)) throw new Error('target.value must be a UUID');
  return { kind, value };
}

/** Runs only while the game does: TShock's REST API lives inside it. */
function running<T>(run: (ctx: InstallCtx, input: T) => Promise<unknown>): RuntimeAction['run'] {
  return async (ctx, ctl, input) => {
    if (!ctl) throw new Error('The server is not running');
    return run(ctx, input as T);
  };
}

/**
 * The runtime's actions for TShock (`POST /v1/actions/<name>`; each fails on
 * other flavours, which have no REST API). Replies: `tshock-players` →
 * `{ players: RestPlayer[] }`; `tshock-bans` → `{ bans: RestBan[] }`; the
 * others an `ActionReply`.
 */
export const TSHOCK_ACTIONS: Record<string, RuntimeAction> = {
  'tshock-players': {
    parse: (x) => (asObject(x), {}),
    run: running(async (ctx) => ({ players: await restPlayers(ctx) })),
  },
  'tshock-kick': {
    parse: (x) => {
      const o = asObject(x);
      return { name: line(o.name, 'name', 32), reason: optionalReason(o.reason) };
    },
    run: running<{ name: string; reason: string }>((ctx, i) => kick(ctx, i.name, i.reason || 'Kicked by an admin')),
  },
  'tshock-ban': {
    parse: (x) => {
      const o = asObject(x);
      return { target: banTarget(o.target), reason: optionalReason(o.reason) };
    },
    run: running<{ target: BanTargetInput; reason: string }>((ctx, i) => ban(ctx, i.target, i.reason || 'Banned')),
  },
  'tshock-unban': {
    parse: (x) => {
      const o = asObject(x);
      if (o.ticket !== undefined) {
        if (typeof o.ticket !== 'number' || !Number.isInteger(o.ticket) || o.ticket < 1) throw new Error('ticket must be a ban ticket number');
        return { ticket: o.ticket };
      }
      return { target: banTarget(o.target) };
    },
    run: running<{ ticket: number } | { target: BanTargetInput }>((ctx, i) => unban(ctx, i)),
  },
  'tshock-bans': {
    parse: (x) => (asObject(x), {}),
    run: running(async (ctx) => ({ bans: await restBans(ctx) })),
  },
  'tshock-broadcast': {
    parse: (x) => ({ message: line(asObject(x).message, 'message', 500) }),
    run: running<{ message: string }>(async (ctx, i): Promise<ActionReply> => {
      const r = await rest(ctx, '/v2/server/broadcast', { msg: i.message });
      return r.status === 200 ? { ok: true, message: text(r.body.response) || 'Sent' } : { ok: false, reason: 'failed', message: why(r) };
    }),
  },
};
