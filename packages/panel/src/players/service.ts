import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertSteamId, assertUsername, quoteArg, RconProtocolError } from '@pz/formats';
import type { AgentApi } from '../agent/client';
import { nowIso, type Db } from '../db/db';
import type { PanelEnv } from '../env';
import { HttpError } from '../http/context';
import type { AgentFeed } from '../http/deps';

export interface PlayerSession {
  id: number;
  username: string;
  joinedAt: string;
  leftAt: string | null;
}

export interface Account {
  username: string;
  displayName: string | null;
  role: string;
  lastConnection: string | null;
  steamId: string | null;
}

export interface Bans {
  steamIds: { steamId: string; reason: string | null }[];
  ips: { ip: string; username: string | null; reason: string | null }[];
}

export type PresenceEvent = { kind: 'join' | 'leave'; username: string; at: string };

/** B42 access levels accepted by `setaccesslevel` (from the 42.20.4 help text), plus "none". */
export const ACCESS_LEVELS = ['none', 'observer', 'gm', 'overseer', 'moderator', 'admin'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export interface PlayersDeps {
  env: PanelEnv;
  db: Db;
  agent: AgentApi;
  feed: AgentFeed;
}

/**
 * Who is online (from the agent's `players` polling), a join/leave history
 * the panel records itself (B42 no longer logs joins to the console), the
 * accounts PZ keeps in db/<name>.db, and RCON moderation commands.
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

  // --------------------------------------------------------- PZ accounts db

  private withGameDb<T>(fn: (db: DatabaseSync) => T, fallback: T): T {
    const file = path.join(this.d.env.pzDataDir, 'db', `${this.d.env.serverName}.db`);
    if (!existsSync(file)) return fallback;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 2000');
      return fn(db);
    } catch {
      // The game may hold a write lock or the schema may differ in a future build.
      return fallback;
    } finally {
      db?.close();
    }
  }

  accounts(): Account[] {
    return this.withGameDb((db) => {
      const roles = new Map((db.prepare('SELECT id, name FROM role').all() as { id: number; name: string }[]).map((r) => [r.id, r.name]));
      return (db.prepare('SELECT username, displayName, role, lastConnection, steamid FROM whitelist ORDER BY username COLLATE NOCASE').all() as {
        username: string;
        displayName: string | null;
        role: number;
        lastConnection: string | null;
        steamid: string | null;
      }[]).map((r) => ({ username: r.username, displayName: r.displayName, role: roles.get(r.role) ?? String(r.role), lastConnection: r.lastConnection, steamId: r.steamid }));
    }, []);
  }

  bans(): Bans {
    return this.withGameDb(
      (db) => ({
        steamIds: (db.prepare('SELECT steamid, reason FROM bannedid').all() as { steamid: string; reason: string | null }[]).map((r) => ({ steamId: r.steamid, reason: r.reason })),
        ips: (db.prepare('SELECT ip, username, reason FROM bannedip').all() as { ip: string; username: string | null; reason: string | null }[]).map((r) => ({ ip: r.ip, username: r.username, reason: r.reason })),
      }),
      { steamIds: [], ips: [] },
    );
  }

  // ------------------------------------------------------------ moderation

  private async run(cmd: string): Promise<string> {
    const r = await this.d.agent.command(cmd, 'rcon');
    return (r.output ?? '').trim();
  }

  private args(fn: () => string): string {
    try {
      return fn();
    } catch (e) {
      if (e instanceof RconProtocolError) throw new HttpError(400, 'invalid-argument', e.message);
      throw e;
    }
  }

  async kick(username: string, reason?: string): Promise<string> {
    const cmd = this.args(() => {
      assertUsername(username);
      return `${quoteArg(username)}${reason ? ` -r ${quoteArg(reason, 'reason')}` : ''}`;
    });
    // 42.20.4 lists the command as "kick" but its usage text still says "kickuser"; try both.
    const out = await this.run(`kickuser ${cmd}`);
    return /^Unknown command/i.test(out) ? this.run(`kick ${cmd}`) : out;
  }

  async ban(target: { username?: string; steamId?: string }, reason?: string): Promise<string> {
    if (target.steamId) {
      const id = target.steamId;
      this.args(() => (assertSteamId(id), ''));
      return this.run(`banid ${id}`);
    }
    if (!target.username) throw new HttpError(400, 'invalid-argument');
    const name = target.username;
    const cmd = this.args(() => {
      assertUsername(name);
      return `${quoteArg(name)}${reason ? ` -r ${quoteArg(reason, 'reason')}` : ''}`;
    });
    return this.run(`banuser ${cmd}`);
  }

  async unban(target: { username?: string; steamId?: string }): Promise<string> {
    if (target.steamId) {
      const id = target.steamId;
      this.args(() => (assertSteamId(id), ''));
      return this.run(`unbanid ${id}`);
    }
    if (!target.username) throw new HttpError(400, 'invalid-argument');
    const name = target.username;
    return this.run(`unbanuser ${this.args(() => (assertUsername(name), quoteArg(name)))}`);
  }

  async setAccess(username: string, level: AccessLevel): Promise<string> {
    return this.run(`setaccesslevel ${this.args(() => (assertUsername(username), quoteArg(username)))} ${level}`);
  }

  async whitelistAdd(username: string, password: string): Promise<string> {
    return this.run(`adduser ${this.args(() => (assertUsername(username), `${quoteArg(username)} ${quoteArg(password, 'password')}`))}`);
  }

  async whitelistRemove(username: string): Promise<string> {
    return this.run(`removeuserfromwhitelist ${this.args(() => (assertUsername(username), quoteArg(username)))}`);
  }
}
