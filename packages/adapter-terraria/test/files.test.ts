// The files the agent owns before every start (CFG-04, CON-04): the
// managed keys of serverconfig.txt (the game only reads it; flags override
// it), TShock's REST API with the agent's token and its setup lock, and
// tModLoader's mod list.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setServerConfig, terrariaRuntimeAdapter as tr, tshockConfig } from '../src/runtime';
import { parseTerrariaLaunch } from '../src/shared';
import { fixture, testCtx, type TestCtx } from './helpers';

let ctx: TestCtx | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

const launch = (x: Record<string, unknown> = {}) => parseTerrariaLaunch({ flavour: 'vanilla', world: 'myworld', worldSize: 2, maxPlayers: 8, memoryMb: 2048, ...x });
const read = (c: TestCtx, rel: string) => readFileSync(path.join(c.roots.data, ...rel.split('/')), 'utf8');
const keys = (text: string) => Object.fromEntries(text.split(/\r?\n/).flatMap((l) => (/^[a-z]+=/.test(l) ? [[l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]] : [])));

describe('serverconfig.txt (CFG-04)', () => {
  it("writes the managed keys: port, world, its folder, autocreate, the ban list, English, no UPnP", async () => {
    const c = (ctx = testCtx({ ports: { game: 7777, rest: 7878 } }));
    await tr.prepare(c, launch());
    const d = c.roots.data;
    expect(keys(read(c, 'serverconfig.txt'))).toEqual({
      port: '7777',
      world: path.join(d, 'Worlds', 'myworld.wld'),
      worldpath: path.join(d, 'Worlds'),
      autocreate: '2',
      banlist: path.join(d, 'banlist.txt'),
      language: 'en-US',
      upnp: '0',
    });
    expect(existsSync(path.join(d, 'Worlds'))).toBe(true);
    // A vanilla server gets nothing of TShock's or tModLoader's.
    expect(existsSync(path.join(d, 'tshock'))).toBe(false);
    expect(existsSync(path.join(d, 'Mods'))).toBe(false);
  });

  it("puts managed keys back in the owner's file, keeping comments, other keys and line endings", async () => {
    const c = (ctx = testCtx({ ports: { game: 7777, rest: 7878 } }));
    writeFileSync(path.join(c.roots.data, 'serverconfig.txt'), '# my server\r\nmotd=Hola ☃\r\nPort=1234\r\nlanguage=es-ES\r\n#world=old\r\nmaxplayers=16\r\n');
    await tr.prepare(c, launch());
    const text = read(c, 'serverconfig.txt');
    expect(text.startsWith('# my server\r\nmotd=Hola ☃\r\nport=7777\r\nlanguage=en-US\r\n#world=old\r\nmaxplayers=16\r\n')).toBe(true);
    expect(text).not.toMatch(/(^|\n)world=old/);
    expect(text.split('\r\n').filter((l) => l.startsWith('world=')).length).toBe(1);
  });

  it('writes the launch password there (never on the command line); null leaves the file\'s own, "" clears it', async () => {
    const c = (ctx = testCtx());
    await tr.prepare(c, launch({ password: 'Sw0rdfish' }));
    expect(keys(read(c, 'serverconfig.txt')).password).toBe('Sw0rdfish');
    await tr.prepare(c, launch());
    expect(keys(read(c, 'serverconfig.txt')).password).toBe('Sw0rdfish');
    await tr.prepare(c, launch({ password: '' }));
    expect(keys(read(c, 'serverconfig.txt')).password).toBe('');
  });

  it('refuses a value that would add a line', () => {
    expect(() => setServerConfig('', { motd: 'a\nport=1' })).toThrow(/Refusing/);
    expect(setServerConfig('', { port: '7777' })).toBe('port=7777\n');
  });
});

describe("TShock's REST API and setup (CON-04, CFG-04)", () => {
  it('turns the REST API on at the agent\'s port with the agent\'s token as a superadmin application token, and locks the setup', async () => {
    const c = (ctx = testCtx({ ports: { game: 7777, rest: 30578 } }));
    await tr.prepare(c, launch({ flavour: 'tshock' }));
    const cfg = JSON.parse(read(c, 'tshock/config.json')) as { Settings: Record<string, unknown> };
    expect(cfg.Settings).toEqual({ RestApiEnabled: true, RestApiPort: 30578, ApplicationRestTokens: { [c.state.controlSecret]: { Username: 'gameserver-panel', UserGroupName: 'superadmin' } } });
    // As TShock writes it: two spaces, no final newline.
    expect(read(c, 'tshock/config.json').endsWith('}')).toBe(true);
    expect(read(c, 'tshock/setup.lock')).toBe('');
  });

  it("keeps TShock's own keys and the owner's tokens, drops an old token of the agent's, and rewrites nothing that is already right", async () => {
    const c = (ctx = testCtx({ ports: { game: 7777, rest: 7878 } }));
    const generated = JSON.parse(fixture('tshock', 'config', 'config.json.generated')) as { Settings: Record<string, unknown> };
    generated.Settings.ApplicationRestTokens = { ownerToken: { Username: 'owner', UserGroupName: 'superadmin' }, oldAgentToken: { Username: 'gameserver-panel', UserGroupName: 'superadmin' } };
    mkdirSync(path.join(c.roots.data, 'tshock'), { recursive: true });
    writeFileSync(path.join(c.roots.data, 'tshock', 'config.json'), JSON.stringify(generated, null, 2));
    await tr.prepare(c, launch({ flavour: 'tshock' }));
    const after = JSON.parse(read(c, 'tshock/config.json')) as { Settings: Record<string, unknown> };
    expect(Object.keys(after.Settings)).toEqual(Object.keys(generated.Settings));
    expect(after.Settings).toMatchObject({ RestApiEnabled: true, RestApiPort: 7878, LogRest: false, ServerPassword: '' });
    expect(Object.keys(after.Settings.ApplicationRestTokens as object).sort()).toEqual([c.state.controlSecret, 'ownerToken'].sort());
    // Right as it is: left alone, byte for byte (TShock rewrites it at every start anyway).
    const text = read(c, 'tshock/config.json');
    expect(tshockConfig(text, c)).toBeNull();
    await tr.prepare(c, launch({ flavour: 'tshock' }));
    expect(read(c, 'tshock/config.json')).toBe(text);
  });

  it('refuses a config.json that is not JSON rather than overwrite it', async () => {
    const c = (ctx = testCtx());
    mkdirSync(path.join(c.roots.data, 'tshock'), { recursive: true });
    writeFileSync(path.join(c.roots.data, 'tshock', 'config.json'), '{ "Settings": { oops');
    await expect(tr.prepare(c, launch({ flavour: 'tshock' }))).rejects.toThrow(/tshock\/config.json is not valid JSON/);
    expect(read(c, 'tshock/config.json')).toBe('{ "Settings": { oops');
  });
});

describe("tModLoader's files (CFG-04, MOD-03)", () => {
  it('starts an empty mod list and the Workshop folder it reads, and keeps a list that exists', async () => {
    const c = (ctx = testCtx());
    await tr.prepare(c, launch({ flavour: 'tmodloader' }));
    expect(read(c, 'Mods/enabled.json')).toBe('[]');
    expect(existsSync(path.join(c.roots.data, '.workshop', 'steamapps', 'workshop'))).toBe(true);
    writeFileSync(path.join(c.roots.data, 'Mods', 'enabled.json'), '["RecipeBrowser"]');
    await tr.prepare(c, launch({ flavour: 'tmodloader' }));
    expect(read(c, 'Mods/enabled.json')).toBe('["RecipeBrowser"]');
  });
});
