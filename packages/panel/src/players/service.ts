import type { BanList, PlayerAccount, PlayerOps, PlayerTarget } from '@gsp/adapter-api';
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
    d.db.prepare('UPDATE player_sessions SET left_at = ? WHERE left_at IS NULL').run(nowIso());
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
        this.d.db.prepare('INSERT INTO player_sessions (username, joined_at) VALUES (?, ?)').run(n, now);
        events.push({ kind: 'join', username: n, at: now });
      }
    }
    for (const n of [...this.online.keys()]) {
      if (!next.has(n)) {
        this.online.delete(n);
        this.d.db.prepare('UPDATE player_sessions SET left_at = ? WHERE username = ? AND left_at IS NULL').run(now, n);
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
    return (this.d.db.prepare('SELECT id, username, joined_at, left_at FROM player_sessions ORDER BY id DESC LIMIT ?').all(Math.min(limit, 1000)) as {
      id: number;
      username: string;
      joined_at: string;
      left_at: string | null;
    }[]).map((r) => ({ id: r.id, username: r.username, joinedAt: r.joined_at, leftAt: r.left_at }));
  }

  // --------------------------------------------------- the game's accounts

  private get ops(): PlayerOps | undefined {
    return this.d.server.adapter.players;
  }

  /** Access levels `setAccess` takes (empty when the game has none). */
  accessLevels(): readonly string[] {
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

  // ------------------------------------------------------------ moderation

  /** The adapter's moderation, or 409 when the game has no such command. */
  private need(op: 'kick' | 'ban' | 'unban' | 'setAccess' | 'whitelistAdd' | 'whitelistRemove'): PlayerOps {
    const ops = this.ops;
    if (!ops?.[op]) throw new HttpError(409, 'capability-unsupported');
    return ops;
  }

  /** Arguments the game can't take become a 400. */
  private async moderate(call: () => Promise<string>): Promise<string> {
    try {
      return await call();
    } catch (e) {
      if (e instanceof RconProtocolError) throw new HttpError(400, 'invalid-argument', e.message);
      throw e;
    }
  }

  kick(by: string | null, username: string, reason?: string): Promise<string> {
    const ops = this.need('kick');
    return this.moderate(() => ops.kick!(this.d.server.ctx(by), username, reason));
  }

  ban(by: string | null, target: PlayerTarget, reason?: string): Promise<string> {
    const ops = this.need('ban');
    return this.moderate(() => ops.ban!(this.d.server.ctx(by), target, reason));
  }

  unban(by: string | null, target: PlayerTarget): Promise<string> {
    const ops = this.need('unban');
    return this.moderate(() => ops.unban!(this.d.server.ctx(by), target));
  }

  setAccess(by: string | null, username: string, level: string): Promise<string> {
    const ops = this.need('setAccess');
    return this.moderate(() => ops.setAccess!(this.d.server.ctx(by), username, level));
  }

  whitelistAdd(by: string | null, username: string, password?: string): Promise<string> {
    const ops = this.need('whitelistAdd');
    return this.moderate(() => ops.whitelistAdd!(this.d.server.ctx(by), username, password));
  }

  whitelistRemove(by: string | null, username: string): Promise<string> {
    const ops = this.need('whitelistRemove');
    return this.moderate(() => ops.whitelistRemove!(this.d.server.ctx(by), username));
  }
}
