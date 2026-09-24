import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Client, fakeStatus, makePanel, ownerReady, type TestPanel } from './harness';

/** db/zomboid.db with PZ 42.20.4's real schema (fixtures/b42, verification log). */
function seedAccounts(p: TestPanel) {
  const dir = path.join(p.deps.env.pzDataDir, 'db');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'zomboid.db'));
  db.exec(`
    CREATE TABLE [whitelist] ([id] INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,[world] TEXT DEFAULT '' NULL,[username] TEXT NULL, [password] TEXT NULL, [lastConnection] TEXT NULL, [role] INTEGER NOT NULL, [authType] INTEGER NULL DEFAULT 1, [googleKey] TEXT NULL, [steamid] TEXT NULL, [ownerid] TEXT NULL, [displayName] TEXT NULL);
    CREATE TABLE [role] ([id] INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, [name] TEXT NOT NULL,[description] TEXT NULL, [colorR] REAL NOT NULL, [colorG] REAL NOT NULL, [colorB] REAL NOT NULL, [readonly] BOOLEAN NULL DEFAULT false, [position] INTEGER NOT NULL DEFAULT -1);
    CREATE TABLE [bannedid] ([steamid] TEXT NOT NULL, [reason] TEXT NULL);
    CREATE TABLE [bannedip] ([ip] TEXT NOT NULL,[username] TEXT NULL, [reason] TEXT NULL);
    INSERT INTO role (id, name, colorR, colorG, colorB) VALUES (2, 'user', 1, 1, 1), (7, 'admin', 1, 0, 0);
    INSERT INTO whitelist (world, username, password, role, steamid, lastConnection) VALUES ('zomboid', 'admin', '$2a$12$x', 7, NULL, NULL), ('zomboid', 'rick', '$2a$12$y', 2, '76561198000000001', '2026-09-23 10:00:00');
    INSERT INTO bannedid VALUES ('76561198000000009', 'griefing');
  `);
  db.close();
}

async function setup() {
  const p = await makePanel();
  seedAccounts(p);
  const { client } = await ownerReady(p);
  return { p, c: client };
}

async function asRole(p: TestPanel, owner: Client, role: 'viewer' | 'operator') {
  await owner.post('/api/users', { username: `u-${role}`, password: 'Temporal-12345', role });
  const c = new Client(p.app);
  await c.post('/api/auth/login', { username: `u-${role}`, password: 'Temporal-12345' });
  await c.post('/api/auth/password', { current: 'Temporal-12345', next: 'Propia-clave-2026' });
  return c;
}

describe('presence', () => {
  it('records joins and leaves from players snapshots and closes sessions when the server stops', async () => {
    const { p, c } = await setup();
    p.feed.emit({ type: 'players', count: 2, names: ['rick', 'daryl'] });
    p.feed.emit({ type: 'players', count: 1, names: ['rick'] });
    expect((await c.get('/api/players')).json()).toMatchObject({ online: [{ username: 'rick' }] });
    p.feed.emit({ type: 'state', status: fakeStatus({ state: 'stopped' }) });
    const h = (await c.get('/api/players/history')).json() as { username: string; leftAt: string | null }[];
    expect(h.map((x) => [x.username, x.leftAt !== null])).toEqual([
      ['daryl', true],
      ['rick', true],
    ]);
  });

  it('emits join/leave events for notifications', async () => {
    const { p } = await setup();
    const seen: string[] = [];
    p.deps.players.onPresence((e) => seen.push(`${e.kind}:${e.username}`));
    p.feed.emit({ type: 'players', count: 1, names: ['carol'] });
    p.feed.emit({ type: 'players', count: 0, names: [] });
    expect(seen).toEqual(['join:carol', 'leave:carol']);
  });
});

describe('accounts and bans from the game database', () => {
  it('reads PZ accounts and bans for operators, not viewers', async () => {
    const { p, c } = await setup();
    const full = (await c.get('/api/players')).json() as { accounts: { username: string; role: string; steamId: string | null }[]; bans: { steamIds: unknown[] } };
    expect(full.accounts).toEqual([
      { username: 'admin', displayName: null, role: 'admin', lastConnection: null, steamId: null },
      { username: 'rick', displayName: null, role: 'user', lastConnection: '2026-09-23 10:00:00', steamId: '76561198000000001' },
    ]);
    expect(full.bans.steamIds).toEqual([{ steamId: '76561198000000009', reason: 'griefing' }]);

    const viewer = await asRole(p, c, 'viewer');
    expect((await viewer.get('/api/players')).json()).toMatchObject({ accounts: null, bans: null });
    expect((await viewer.get('/api/players/history')).statusCode).toBe(403);
  });
});

describe('moderation', () => {
  it('kicks, bans and unbans with safely quoted arguments', async () => {
    const { p, c } = await setup();
    p.feed.status_ = fakeStatus({ state: 'running' });
    await c.post('/api/players/kick', { username: 'rick', reason: 'afk' });
    await c.post('/api/players/ban', { steamId: '76561198000000001' });
    await c.post('/api/players/ban', { username: 'rick', reason: 'duping' });
    await c.post('/api/players/unban', { username: 'rick' });
    expect(p.agent.calls.filter((x) => x.startsWith('command:'))).toEqual([
      'command:kickuser "rick" -r "afk"',
      'command:banid 76561198000000001',
      'command:banuser "rick" -r "duping"',
      'command:unbanuser "rick"',
    ]);
    expect((await c.post('/api/players/kick', { username: 'x"; quit' })).json()).toMatchObject({ error: 'invalid-argument' });
    expect((await c.post('/api/players/ban', { steamId: '123' })).statusCode).toBe(400);
    expect(p.deps.audit.list({ action: 'player.' }).map((e) => e.action)).toEqual(['player.unban', 'player.ban', 'player.ban', 'player.kick']);
  });

  it('falls back to "kick" if "kickuser" is unknown', async () => {
    const { p, c } = await setup();
    p.agent.command = async (cmd) => {
      p.agent.calls.push(`command:${cmd}`);
      return { via: 'rcon', output: cmd.startsWith('kickuser') ? 'Unknown command kickuser' : 'User rick kicked.' };
    };
    expect((await c.post('/api/players/kick', { username: 'rick' })).json()).toEqual({ output: 'User rick kicked.' });
  });

  it('keeps access levels and the whitelist for admins', async () => {
    const { p, c } = await setup();
    await c.post('/api/players/access', { username: 'rick', level: 'moderator' });
    await c.post('/api/players/whitelist', { username: 'glenn', password: 'pizza-delivery' });
    await c.req('DELETE', '/api/players/whitelist/glenn');
    expect(p.agent.calls.filter((x) => x.startsWith('command:'))).toEqual([
      'command:setaccesslevel "rick" moderator',
      'command:adduser "glenn" "pizza-delivery"',
      'command:removeuserfromwhitelist "glenn"',
    ]);
    expect((await c.post('/api/players/access', { username: 'rick', level: 'god' })).statusCode).toBe(400);
    // The whitelist password never reaches the audit log.
    expect(JSON.stringify(p.deps.audit.list({ action: 'player.' }))).not.toContain('pizza-delivery');

    const op = await asRole(p, c, 'operator');
    expect((await op.post('/api/players/access', { username: 'rick', level: 'admin' })).statusCode).toBe(403);
    expect((await op.post('/api/players/whitelist', { username: 'x', password: 'yyyy' })).statusCode).toBe(403);
    expect((await op.post('/api/players/kick', { username: 'rick' })).statusCode).toBe(200);
  });
});
