import { ACCOUNTS, BANS } from '@gsp/adapter-pz/shared';
import { describe, expect, it } from 'vitest';
import { Client, fakeStatus, makePanel, ownerReady, type TestPanel } from './harness';

const ACCOUNT_ROWS = [
  { username: 'admin', displayName: null, role: 'admin', lastConnection: null, steamId: null },
  { username: 'rick', displayName: null, role: 'user', lastConnection: '2026-09-23 10:00:00', steamId: '76561198000000001' },
];

/** The agent reads db/zomboid.db next to the game; the panel only sees the actions' replies. */
function seedAccounts(p: TestPanel) {
  p.agent.action = async (name, input) => {
    p.agent.calls.push(`action:${name}:${JSON.stringify(input)}`);
    if (name === ACCOUNTS) return ACCOUNT_ROWS;
    if (name === BANS) return { steamIds: [{ steamId: '76561198000000009', reason: 'griefing' }], ips: [] };
    throw new Error(`unexpected action ${name}`);
  };
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
    p.srv.players.onPresence((e) => seen.push(`${e.kind}:${e.username}`));
    p.feed.emit({ type: 'players', count: 1, names: ['carol'] });
    p.feed.emit({ type: 'players', count: 0, names: [] });
    expect(seen).toEqual(['join:carol', 'leave:carol']);
  });
});

describe('accounts and bans from the game database', () => {
  it('reads PZ accounts and bans through the agent for operators, not viewers', async () => {
    const { p, c } = await setup();
    const full = (await c.get('/api/players')).json() as { accounts: { username: string; role: string; steamId: string | null }[]; bans: { steamIds: unknown[] } };
    expect(full.accounts).toEqual(ACCOUNT_ROWS);
    expect(full.bans.steamIds).toEqual([{ steamId: '76561198000000009', reason: 'griefing' }]);
    expect(p.agent.calls).toEqual([`action:${ACCOUNTS}:{"serverName":"zomboid"}`, `action:${BANS}:{"serverName":"zomboid"}`]);

    const viewer = await asRole(p, c, 'viewer');
    expect((await viewer.get('/api/players')).json()).toMatchObject({ accounts: null, bans: null });
    expect((await viewer.get('/api/players/history')).statusCode).toBe(403);
  });

  it('shows no accounts rather than failing when the agent cannot read them', async () => {
    const { p, c } = await setup();
    p.agent.action = async () => {
      throw new Error('agent down');
    };
    expect((await c.get('/api/players')).json()).toMatchObject({ accounts: [], bans: { steamIds: [], ips: [] } });
    // A reply that isn't the documented shape is not shown either.
    p.agent.action = async () => ({ rows: 'nope' });
    expect((await c.get('/api/players')).json()).toMatchObject({ accounts: [], bans: { steamIds: [], ips: [] } });
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
