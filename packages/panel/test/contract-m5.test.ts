// What the adapter contract gained in M5 phase 3, through the panel with a
// Project Zomboid server made to use it (the Terraria adapter uses all of it:
// terraria.test.ts): a JSON object secret whole (CFG-04, CON-04), a file's
// note, a secret launch setting, moderation per flavour with more ban
// targets, bans of an address and commands that wait for a stopped game
// (PLY-03), refusals that failed, an adapter's own way to message players
// (CON-03, CON-04), and resets and console commands per flavour (BAK-04, AST-04).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandDoc, ConfigFileDecl, LaunchOption, PanelAdapter, PlayerOps, ResetDecl, ServerCtx } from '@gsp/adapter-api';
import { panelAdapter, panelAdapters } from '@gsp/adapters/panel';
import { RconProtocolError } from '@gsp/formats';
import { MASK } from '../src/config/service';
import { LAUNCH_MASK } from '../src/server/handle';
import { fakeStatus, makePanel, ownerReady, type Client, type TestPanel } from './harness';

const TOKEN = 'agent-token-0123456789abcdef';
const OWN_TOKEN = 'owners-own-token-9876543210';
/** A TShock-like config.json: a token as an object key, a password, other settings. */
const TOKENS_JSON = `{
  "Settings": {
    "ServerName": "Friends",
    "ServerPassword": "hunter2-hidden",
    "RestApiPort": 7878,
    "ApplicationRestTokens": {
      "${TOKEN}": {
        "Username": "gameserver-panel",
        "UserGroupName": "superadmin"
      },
      "${OWN_TOKEN}": {
        "Username": "owner-tool",
        "UserGroupName": "superadmin"
      }
    }
  }
}`;

const tokensFile: ConfigFileDecl = {
  id: 'tokens',
  root: 'data',
  rel: 'tokens.json',
  format: 'json',
  managedKeys: ['Settings.RestApiPort', 'Settings.ApplicationRestTokens'],
  secretKeys: ['Settings.ServerPassword'],
  secretTrees: ['Settings.ApplicationRestTokens'],
  restartKeys: '*',
  note: { en: 'The game rewrites this file at every start.', es: 'El juego reescribe este archivo en cada inicio.' },
};

/** The default (PZ) server with `change` applied to its adapter. */
async function panelWith(change: (a: PanelAdapter) => PanelAdapter): Promise<{ p: TestPanel; c: Client }> {
  const p = await makePanel({}, { adapters: [change(panelAdapter('pz')), ...panelAdapters.filter((a) => a.meta.id !== 'pz')] });
  const { client } = await ownerReady(p);
  return { p, c: client };
}

async function proposeApply(c: Client, body: Record<string, unknown>) {
  const proposed = await c.post('/api/servers/default/config/proposals', body);
  if (proposed.statusCode !== 200) return { proposed, applied: null };
  const { id } = proposed.json() as { id: string | null };
  return { proposed, applied: id ? await c.post(`/api/servers/default/config/proposals/${id}/apply`) : null };
}

describe('a JSON object secret whole: TShock-style tokens as keys (CFG-04, CON-04)', () => {
  async function setup() {
    const r = await panelWith((a) => ({ ...a, config: { ...a.config, files: (srv) => [...a.config.files(srv), tokensFile] } }));
    const file = path.join(r.p.deps.env.pzDataDir, 'tokens.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, TOKENS_JSON);
    return { ...r, file };
  }

  it('shows neither the tokens nor their keys in forms, raw text or the file list, and says what the file is', async () => {
    const { c } = await setup();
    const values = (await c.get('/api/servers/default/config/values?id=tokens')).json() as { values: Record<string, unknown> };
    expect(values.values).toEqual({ 'Settings.ServerName': 'Friends', 'Settings.ServerPassword': MASK, 'Settings.RestApiPort': 7878, 'Settings.ApplicationRestTokens': MASK });
    const content = (await c.get('/api/servers/default/config/files/content?id=tokens')).json() as { text: string; secretTrees: string[]; note: unknown };
    expect(content.text).toContain(`"ApplicationRestTokens": "${MASK}"`);
    expect(content).toMatchObject({ secretTrees: ['Settings.ApplicationRestTokens'], note: tokensFile.note });
    const meta = JSON.stringify(await (await c.get('/api/servers/default/config/meta')).json());
    const files = JSON.stringify(await (await c.get('/api/servers/default/config/files')).json());
    for (const text of [JSON.stringify(values), content.text, meta, files]) {
      for (const secret of [TOKEN, OWN_TOKEN, 'hunter2-hidden', 'owner-tool']) expect(text).not.toContain(secret);
    }
    expect(meta).toContain('"note":{"en":"The game rewrites this file at every start."');
  });

  it('keeps the tokens as on disk through form and raw edits, and never shows them in diffs or history', async () => {
    const { p, c, file } = await setup();
    // A form can't touch them, or anything inside them.
    const form = await proposeApply(c, { fileId: 'tokens', changes: { 'Settings.ApplicationRestTokens': 'x', [`Settings.ApplicationRestTokens.${TOKEN}.Username`]: 'me' } });
    expect(form.proposed.json()).toMatchObject({ error: 'invalid-options', fields: { 'Settings.ApplicationRestTokens': 'managed', [`Settings.ApplicationRestTokens.${TOKEN}.Username`]: 'managed' } });
    // A raw edit that leaves the mask in place changes the rest and keeps the tokens.
    const text = ((await c.get('/api/servers/default/config/files/content?id=tokens')).json() as { text: string }).text;
    const kept = await proposeApply(c, { fileId: 'tokens', text: text.replace('"Friends"', '"Neighbours"') });
    expect(kept.proposed.json()).toMatchObject({ changedKeys: ['Settings.ServerName'], reapplied: [] });
    expect(kept.applied?.statusCode).toBe(200);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { Settings: { ServerName: string; ServerPassword: string; ApplicationRestTokens: Record<string, unknown> } };
    expect(onDisk.Settings.ServerName).toBe('Neighbours');
    expect(onDisk.Settings.ServerPassword).toBe('hunter2-hidden');
    expect(Object.keys(onDisk.Settings.ApplicationRestTokens)).toEqual([TOKEN, OWN_TOKEN]);
    // A raw edit that writes its own tokens, or drops them, gets the disk's back with a note.
    for (const edited of [text.replace(`"ApplicationRestTokens": "${MASK}"`, '"ApplicationRestTokens": { "stolen": { "Username": "x" } }'), text.replace(/,\s*"ApplicationRestTokens": "[^"]*"/, '')]) {
      const r = await proposeApply(c, { fileId: 'tokens', text: edited });
      const preview = r.proposed.json() as { reapplied: { key: string; value: string }[]; before: string; after: string };
      expect(preview.reapplied).toEqual([{ key: 'Settings.ApplicationRestTokens', value: MASK, why: 'managed' }]);
      expect(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { Settings: { ApplicationRestTokens: object } }).Settings.ApplicationRestTokens)).toEqual([TOKEN, OWN_TOKEN]);
    }
    // Nothing the web or the database's proposals hold shows them.
    const everything = JSON.stringify([
      await (await c.get('/api/servers/default/config/proposals')).json(),
      ...(await Promise.all(p.srv.config.historyOf('tokens').map((v) => c.get(`/api/servers/default/config/history/${v.id}`).then((r) => r.json())))),
      p.deps.db.prepare('SELECT * FROM proposals').all(),
    ]);
    for (const secret of [TOKEN, OWN_TOKEN, 'hunter2-hidden']) expect(everything).not.toContain(secret);
  });

  it('still hides them in a file that no longer parses', async () => {
    const { c, file } = await setup();
    writeFileSync(file, TOKENS_JSON.replace('"Friends",', '"Friends",,'));
    const content = (await c.get('/api/servers/default/config/files/content?id=tokens')).json() as { text: string; issues: unknown[] };
    expect(content.issues.length).toBeGreaterThan(0);
    for (const secret of [TOKEN, OWN_TOKEN, 'owner-tool']) expect(content.text).not.toContain(secret);
    expect(content.text).toContain(`"ApplicationRestTokens": "${MASK}"`);
  });
});

describe('a secret launch setting: a server password (SRV-01, NFR-09)', () => {
  const password: LaunchOption = { key: 'joinPassword', type: 'string', secret: true, default: '', description: { en: 'Password to join.', es: 'Contraseña para entrar.' } };

  it('reads back masked, keeps what is stored when sent masked, and never reaches the audit log', async () => {
    const { p, c } = await panelWith((a) => ({ ...a, launch: { ...a.launch, schema: [...a.launch.schema, password], defaults: () => ({ ...(a.launch.defaults() as object), joinPassword: '' }) } }));
    const url = '/api/servers/default/server/launch';
    const current = (await c.get(url)).json() as Record<string, unknown>;
    expect(current.joinPassword).toBe('');
    const set = await c.req('PUT', url, { ...current, joinPassword: 'open-sesame-7' });
    expect(set.json()).toMatchObject({ joinPassword: LAUNCH_MASK });
    expect((await c.get(url)).json()).toMatchObject({ joinPassword: LAUNCH_MASK });
    expect(((await c.get('/api/servers/default/status')).json() as { launch: Record<string, unknown> }).launch.joinPassword).toBe(LAUNCH_MASK);
    // Sent back masked (another setting changed): the stored one stays.
    const again = await c.req('PUT', url, { ...(set.json() as object), memoryMb: 4096 });
    expect(again.statusCode).toBe(200);
    expect(p.srv.handle.launchSettings()).toMatchObject({ joinPassword: 'open-sesame-7', memoryMb: 4096 });
    // Cleared: no password.
    await c.req('PUT', url, { ...(again.json() as object), joinPassword: '' });
    expect(p.srv.handle.launchSettings()).toMatchObject({ joinPassword: '' });
    expect(JSON.stringify(p.deps.audit.list({ action: 'server.launch-settings' }))).not.toContain('open-sesame-7');
  });
});

describe('moderation per flavour, address bans and commands that wait for a stopped game (PLY-03)', () => {
  const calls: string[] = [];
  let reply = '';
  const byName: PlayerOps = {
    banTargets: ['username', 'uuid', 'account'],
    banByAddress: true,
    stoppedOnly: ['unban'],
    refused: (_op, r) => (r === 'broke' ? 'failed' : null),
    ban: async (_ctx, t) => (calls.push(`ban ${JSON.stringify(t)}`), reply),
    unban: async (_ctx, t) => (calls.push(`unban ${JSON.stringify(t)}`), reply),
    bans: async () => ({ steamIds: [], ips: [], uuids: [{ uuid: 'c0ffee00-1', reason: 'x' }], accounts: [{ account: 'Rick', reason: null }] }),
  };

  it('uses the flavour’s moderation, says what it takes, and refuses what waits for a stopped game while it runs', async () => {
    calls.length = 0;
    const { p, c } = await panelWith((a) => ({ ...a, playersOf: (flavour) => (flavour === null ? byName : undefined) }));
    const meta = (await c.get('/api/servers/default/meta')).json() as Record<string, unknown>;
    expect(meta).toMatchObject({ banTargets: ['username', 'uuid', 'account'], banByAddress: true, stoppedOnly: ['unban'], accessLevels: [] });
    expect((await c.post('/api/servers/default/players/ban', { uuid: 'c0ffee00-1', reason: 'griefing' })).statusCode).toBe(200);
    expect((await c.post('/api/servers/default/players/ban', { account: 'Rick' })).statusCode).toBe(200);
    expect(calls).toEqual(['ban {"uuid":"c0ffee00-1"}', 'ban {"account":"Rick"}']);
    expect(((await c.get('/api/servers/default/players')).json() as { bans: unknown }).bans).toMatchObject({ uuids: [{ uuid: 'c0ffee00-1' }], accounts: [{ account: 'Rick' }] });
    // The game tried and failed: an error, with its words.
    reply = 'broke';
    expect((await c.post('/api/servers/default/players/ban', { username: 'rick' })).json()).toEqual({ error: 'player-op-failed', output: 'broke' });
    reply = '';
    // Unban waits for a stopped game.
    p.feed.status_ = fakeStatus({ state: 'running' });
    expect((await c.post('/api/servers/default/players/unban', { account: 'Rick' })).json()).toEqual({ error: 'server-running' });
    p.feed.status_ = fakeStatus({ state: 'stopped' });
    expect((await c.post('/api/servers/default/players/unban', { account: 'Rick' })).statusCode).toBe(200);
    expect(calls.at(-1)).toBe('unban {"account":"Rick"}');
    // What the flavour's moderation lacks is unsupported, even when the adapter's has it.
    expect((await c.post('/api/servers/default/players/kick', { username: 'rick' })).json()).toMatchObject({ error: 'capability-unsupported' });
    expect(p.agent.calls.filter((x) => x.startsWith('command:'))).toEqual([]);
    expect(p.deps.audit.list({ action: 'player.' }).map((e) => [e.action, e.target])).toEqual([
      ['player.unban', 'Rick'],
      ['player.ban', 'Rick'],
      ['player.ban', 'c0ffee00-1'],
    ]);
  });
});

describe('an adapter’s own way to message players (CON-03, CON-04)', () => {
  it('sends broadcasts and countdowns through messages.send when the adapter has it', async () => {
    const sent: string[] = [];
    const send = async (_ctx: ServerCtx, text: string) => {
      if (text.includes('"')) throw new RconProtocolError('no quotes');
      sent.push(text);
    };
    const { p, c } = await panelWith((a) => ({ ...a, messages: { ...a.messages, send } }));
    p.feed.status_ = fakeStatus({ state: 'running' });
    expect((await c.post('/api/servers/default/server/broadcast', { message: 'Hello all' })).statusCode).toBe(200);
    expect((await c.post('/api/servers/default/server/broadcast', { message: 'say "hi"' })).json()).toEqual({ error: 'invalid-message' });
    expect(sent).toEqual(['Hello all']);
    expect(p.agent.calls.filter((x) => x.startsWith('command:'))).toEqual([]);
  });
});

describe('resets and console commands per flavour (BAK-04, AST-04)', () => {
  it('lists and runs only the scopes and commands of the server’s flavour', async () => {
    const onlyOther: ResetDecl = { id: 'players', label: { en: 'Players', es: 'Jugadores' }, permission: 'reset.full', removeParts: ['accounts'], flavours: ['other'] };
    const other: CommandDoc = { name: 'other-only', syntax: 'other-only', description: { en: 'x', es: 'x' }, flavours: ['other'] };
    const { c } = await panelWith((a) => ({ ...a, resets: [...a.resets, onlyOther], consoleCatalog: [...(a.consoleCatalog ?? []), other] }));
    const meta = (await c.get('/api/servers/default/meta')).json() as { resets: { id: string }[]; consoleCatalog: { name: string }[] };
    expect(meta.resets.map((r) => r.id)).not.toContain('players');
    expect(meta.consoleCatalog.map((x) => x.name)).not.toContain('other-only');
    expect(meta.consoleCatalog.length).toBeGreaterThan(0);
    const r = await c.post('/api/servers/default/reset', { scope: 'players', confirm: 'zomboid' });
    expect(r.json()).toMatchObject({ error: 'validation', message: 'unknown reset scope' });
  });
});

