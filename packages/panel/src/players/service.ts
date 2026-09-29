import type { AccessLevel, BanList, LevelHolder, PlayerAccount, PlayerOpKind, PlayerOps, PlayerRefusal, PlayerTarget, WhitelistInfo } from '@gsp/adapter-api';
import { RconProtocolError } from '@gsp/formats';
import { nowIso, type Db } from '../db/db';
import { HttpError } from '../http/context';
import type { AgentFeed } from '../http/deps';
import type { ServerHandle } from '../server/handle';

export interface PlayerSession {
  id: number;
  username: string;
  joinedAt: string;
  leftAt: string | null;
}

export type Account = PlayerAccount;
export type Bans = BanList;

export type PresenceEvent = { kind: 'join' | 'leave'; username: string; at: string };

export interface PlayersDeps {
  db: Db;
  feed: AgentFeed;
  server: ServerHandle;
}

/**
 * Who is online (from the agent's player polling) and a join/leave history
 * the panel records itself; accounts, bans and moderation go through the
 * game's adapter (`PlayerOps`).
 */
export class PlayersService {
  private online = new Map<string, string>();
  private readonly listeners = new Set<(e: PresenceEvent) => void>();

  constructor(private readonly d: PlayersDeps) {
    // After a panel restart, sessions left open belong to a previous run.
    d.db.prepare('UPDATE player_sessions SET left_at = ? WHERE server_id = ? AND left_at IS NULL').run(nowIso(), d.server.ref.id);
  }

  private get serverId(): string {
    return this.d.server.ref.id;
  }

  onPresence(l: (e: PresenceEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Feed each players snapshot here; joins and leaves are derived by diffing. */
  observe(names: string[] | null): PresenceEvent[] {
    const now = nowIso();
    const next = new Set(names ?? []);
    const events: PresenceEvent[] = [];
    for (const n of next) {
      if (!this.online.has(n)) {
        this.online.set(n, now);
        this.d.db.prepare('INSERT INTO player_sessions (server_id, username, joined_at) VALUES (?, ?, ?)').run(this.serverId, n, now);
        events.push({ kind: 'join', username: n, at: now });
      }
    }
    for (const n of [...this.online.keys()]) {
      if (!next.has(n)) {
        this.online.delete(n);
        this.d.db.prepare('UPDATE player_sessions SET left_at = ? WHERE server_id = ? AND username = ? AND left_at IS NULL').run(now, this.serverId, n);
        events.push({ kind: 'leave', username: n, at: now });
      }
    }
    for (const e of events) for (const l of this.listeners) l(e);
    return events;
  }

  /** Wire to the agent feed: players events, and "everyone left" when the server stops. */
  attach(): () => void {
    return this.d.feed.onEvent((e) => {
      if (e.event.type === 'players') this.observe(e.event.names);
      else if (e.event.type === 'state' && e.event.status.state !== 'running' && this.online.size) this.observe([]);
    });
  }

  onlineNow(): { username: string; since: string }[] {
    return [...this.online.entries()].map(([username, since]) => ({ username, since }));
  }

  history(limit = 200): PlayerSession[] {
    return (this.d.db.prepare('SELECT id, username, joined_at, left_at FROM player_sessions WHERE server_id = ? ORDER BY id DESC LIMIT ?').all(this.serverId, Math.min(limit, 1000)) as {
      id: number;
      username: string;
      joined_at: string;
      left_at: string | null;
    }[]).map((r) => ({ id: r.id, username: r.username, joinedAt: r.joined_at, leftAt: r.left_at }));
  }

  // --------------------------------------------------- the game's accounts

  /** The game's moderation for this server's flavour. */
  private get ops(): PlayerOps | undefined {
    return this.d.server.players();
  }

  /** Access levels `setAccess` takes (empty when the game has none). */
  accessLevels(): readonly AccessLevel[] {
    return this.ops?.accessLevels ?? [];
  }

  /** Null when the game keeps no accounts; empty when they can't be read right now. */
  async accounts(): Promise<Account[] | null> {
    const ops = this.ops;
    if (!ops?.accounts) return null;
    // The game may hold a lock, the agent may be down, a future build may change the schema.
    return ops.accounts(this.d.server.ctx()).catch(() => []);
  }

  async bans(): Promise<Bans | null> {
    const ops = this.ops;
    if (!ops?.bans) return null;
    return ops.bans(this.d.server.ctx()).catch(() => ({ steamIds: [], ips: [] }));
  }

  /** The game's whitelist as it stands; null when it can't be listed, empty when it can't be read right now. */
  async whitelist(): Promise<WhitelistInfo | null> {
    const ops = this.ops;
    if (!ops?.whitelist) return null;
    return ops.whitelist(this.d.server.ctx()).catch(() => ({ enabled: null, usernames: [] }));
  }

  /** Who holds a level above the lowest (the game's own list); null when it can't be listed. */
  async levelHolders(): Promise<LevelHolder[] | null> {
    const ops = this.ops;
    if (!ops?.levelHolders) return null;
    return ops.levelHolders(this.d.server.ctx()).catch(() => []);
  }

  /** Whether whitelist entries need a password (accounts a player joins with). */
  whitelistNeedsPassword(): boolean {
    return this.ops?.whitelistPassword !== false;
  }

  // ------------------------------------------------------------ moderation

  /**
   * The adapter's moderation, or 409 when the game has no such command, or
   * when it works only while the game is stopped (`stoppedOnly`) and it isn't.
   */
  private need(op: PlayerOpKind): PlayerOps {
    const ops = this.ops;
    if (!ops?.[op]) throw new HttpError(409, 'capability-unsupported');
    if (ops.stoppedOnly?.includes(op)) {
      const st = this.d.feed.status_?.state;
      if (st !== 'stopped' && st !== 'failed') throw new HttpError(409, 'server-running');
    }
    return ops;
  }

  /**
   * Arguments the game can't take become a 400; a command the game refused
   * (the adapter reads its reply, `PlayerOps.refused`) an error with the
   * game's own words in `output`, not a 200.
   */
  private async moderate(ops: PlayerOps, op: PlayerOpKind, call: () => Promise<string>): Promise<string> {
    let reply: string;
    try {
      reply = await call();
    } catch (e) {
      if (e instanceof RconProtocolError) throw new HttpError(400, 'invalid-argument', e.message);
      throw e;
    }
    const refusal = ops.refused?.(op, reply) ?? null;
    if (refusal) throw refusalError(op, refusal, reply);
    return reply;
  }

  kick(by: string | null, username: string, reason?: string): Promise<string> {
    const ops = this.need('kick');
    return this.moderate(ops, 'kick', () => ops.kick!(this.d.server.ctx(by), username, reason));
  }

  ban(by: string | null, target: PlayerTarget, reason?: string): Promise<string> {
    const ops = this.need('ban');
    return this.moderate(ops, 'ban', () => ops.ban!(this.d.server.ctx(by), target, reason));
  }

  unban(by: string | null, target: PlayerTarget): Promise<string> {
    const ops = this.need('unban');
    return this.moderate(ops, 'unban', () => ops.unban!(this.d.server.ctx(by), target));
  }

  setAccess(by: string | null, username: string, level: string): Promise<string> {
    const ops = this.need('setAccess');
    return this.moderate(ops, 'setAccess', () => ops.setAccess!(this.d.server.ctx(by), username, level));
  }

  whitelistAdd(by: string | null, username: string, password?: string): Promise<string> {
    const ops = this.need('whitelistAdd');
    return this.moderate(ops, 'whitelistAdd', () => ops.whitelistAdd!(this.d.server.ctx(by), username, password));
  }

  whitelistRemove(by: string | null, username: string): Promise<string> {
    const ops = this.need('whitelistRemove');
    return this.moderate(ops, 'whitelistRemove', () => ops.whitelistRemove!(this.d.server.ctx(by), username));
  }

  setWhitelistEnabled(by: string | null, on: boolean): Promise<string> {
    const ops = this.need('setWhitelistEnabled');
    return this.moderate(ops, 'setWhitelistEnabled', () => ops.setWhitelistEnabled!(this.d.server.ctx(by), on));
  }
}

/** A command that changed nothing, by what it was meant to do: what the web says about it. */
const NO_CHANGE: Record<PlayerOpKind, string> = {
  kick: 'no-change',
  ban: 'already-banned',
  unban: 'not-banned',
  setAccess: 'level-unchanged',
  whitelistAdd: 'already-whitelisted',
  whitelistRemove: 'not-whitelisted',
  setWhitelistEnabled: 'whitelist-unchanged',
};

/**
 * The game's refusal as an HTTP error: 404 `player-not-found` for a name it
 * knows no player by, 409 `player-not-online`, 502 `player-op-failed` when
 * it tried and failed, or 409 with what already was so; `output` keeps the
 * game's reply.
 */
function refusalError(op: PlayerOpKind, refusal: PlayerRefusal, reply: string): HttpError {
  const output = reply.slice(0, 500);
  if (refusal === 'player-not-found') return new HttpError(404, 'player-not-found', output, { output });
  if (refusal === 'player-not-online') return new HttpError(409, 'player-not-online', output, { output });
  if (refusal === 'failed') return new HttpError(502, 'player-op-failed', output, { output });
  return new HttpError(409, NO_CHANGE[op], output, { output });
}
