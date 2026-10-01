// Valheim's panel half (M6): the launch form with the public list and
// crossplay off by default and their notes (Q14, Q15, CFG-01), the password
// rules refused in both languages before anything starts, the list files
// edited as text and by moderation while stopped (CFG-04, PLY-03), backups
// and resets (BAK-01, BAK-04), and no messages without a console (CON-03).
import { describe, expect, it } from 'vitest';
import type { LaunchSettingRefusal, ServerCtx } from '@gsp/adapter-api';
import { memoryServerFiles } from '@gsp/adapter-api/testing/panel-suite-config';
import { RconProtocolError } from '@gsp/formats';
import { valheimPanelAdapter as vh } from '../src/panel';
import { fixture } from './helpers';

const srv = { id: 'my-world', gameName: 'my-world', flavour: null };

describe('launch settings (CFG-01, UPD-02, SRV-05)', () => {
  it('the branch, updates, memory, then the server name, password, public list, crossplay and autosave', () => {
    expect(vh.launch.schema.map((o) => [o.key, o.type, o.secret ?? false, o.default])).toEqual([
      ['branch', 'string', false, 'public'],
      ['updateOnStart', 'boolean', false, 'true'],
      ['memoryMb', 'integer', false, '3072'],
      ['serverName', 'string', false, 'Valheim server'],
      ['password', 'string', true, ''],
      ['public', 'boolean', false, 'false'],
      ['crossplay', 'boolean', false, 'false'],
      ['saveInterval', 'integer', false, '300'],
    ]);
    expect(vh.launch.schema.find((o) => o.key === 'memoryMb')).toMatchObject({ min: 2048, step: 256, unit: 'MiB' });
    expect(vh.launch.schema.find((o) => o.key === 'saveInterval')).toMatchObject({ min: 60, max: 3600, step: 60, unit: 's', advanced: true });
    expect(vh.launch.defaults()).toEqual({ branch: 'public', updateOnStart: true, memoryMb: 3072, serverName: 'Valheim server', password: '', public: false, crossplay: false, saveInterval: 300 });
    expect(vh.launch.secrets).toBeUndefined();
  });

  it('the public list and crossplay switches say what they mean on the create form (Q14, Q15)', () => {
    const d = (key: string) => vh.launch.schema.find((o) => o.key === key)!.description!;
    expect(d('public').en).toMatch(/password of at least 5 characters that isn't part of its name, checked before it starts\.$/);
    expect(d('public').es).toMatch(/al menos 5 caracteres que no forme parte de su nombre/);
    expect(d('crossplay').en).toMatch(/registers this host's public address with PlayFab, and the address also shows in the server's log\.$/);
    expect(d('crossplay').es).toMatch(/dirección pública de este equipo en PlayFab/);
  });

  it('turn into the agent params, the world named after the server; refused in both languages as Valheim would refuse them', () => {
    expect(vh.launch.toAgent(srv, { ...vh.launch.defaults(), password: 'hunter22' }, {})).toEqual({ name: 'my-world', branch: 'public', updateOnStart: true, memoryMb: 3072, serverName: 'Valheim server', password: 'hunter22', public: false, crossplay: false, saveInterval: 300 });
    const refused = (s: Record<string, unknown>) => {
      try {
        vh.launch.toAgent(srv, { ...vh.launch.defaults(), ...s } as never, {});
      } catch (e) {
        return e as Error & LaunchSettingRefusal;
      }
      throw new Error('expected a refusal');
    };
    expect(refused({ public: true, password: 'abc' })).toMatchObject({ field: 'password', text: { en: expect.stringMatching(/at least 5 characters/), es: expect.stringMatching(/al menos 5 caracteres/) } });
    expect(refused({ public: true })).toMatchObject({ field: 'password' });
    expect(refused({ public: true, password: 'valheim' })).toMatchObject({ field: 'password', text: { en: expect.stringMatching(/part of its name/) } });
    expect(() => vh.launch.toAgent(srv, { ...vh.launch.defaults(), public: true, password: 'hunter22' }, {})).not.toThrow();
    expect(() => vh.launch.toAgent(srv, { ...vh.launch.defaults(), password: 'abc' }, {})).not.toThrow();
  });
});

describe('the lists (CFG-04, CFG-07…09)', () => {
  it('are line lists edited only while stopped, each with what it holds; no folders to browse, no forms', () => {
    const files = vh.config.files(srv);
    expect(files.map((f) => [f.id, f.rel, f.format, f.stoppedOnly ?? false, f.restartKeys])).toEqual([
      ['admins', 'adminlist.txt', 'lines', true, '*'],
      ['banned', 'bannedlist.txt', 'lines', true, '*'],
      ['permitted', 'permittedlist.txt', 'lines', true, '*'],
    ]);
    for (const f of files) {
      expect(f.note!.en).toMatch(/^One SteamID \(17 digits\) per line/);
      // A list the game hasn't written yet starts empty when the panel moderates through it.
      expect(f.seed).toEqual({});
    }
    expect(vh.config.roots(srv)).toEqual([]);
    expect(vh.config.schemas).toEqual({});
    expect(vh.config.managedValues(srv)).toEqual({});
  });
});

describe('moderation by list, while stopped (PLY-03)', () => {
  function ctxWith(files: Record<string, string>) {
    const calls: unknown[][] = [];
    const ctx = {
      srv,
      files: memoryServerFiles(files),
      actor: 'alice',
      status: () => null,
      command: async () => ({ via: 'stdin', output: null }),
      action: async () => null,
      versions: async () => ({ installed: null, versions: [] }),
      launchSettings: () => ({}),
      config: { set: async (...a: unknown[]) => void calls.push(['set', ...a]), seedIfMissing: async () => (calls.push(['seedIfMissing']), false), applyPreset: async () => undefined },
      onLog: () => () => undefined,
    } as unknown as ServerCtx;
    return { ctx, calls };
  }

  it('bans, allows and makes admins by SteamID in the lists, and reads them back without the game\'s heading', async () => {
    const p = vh.players!;
    expect(p.banTargets).toEqual(['steamId']);
    expect(p.stoppedOnly).toEqual(['ban', 'unban', 'whitelistAdd', 'whitelistRemove', 'setAccess']);
    const lists = { 'data/adminlist.txt': fixture('files', 'adminlist.txt'), 'data/bannedlist.txt': `${fixture('files', 'bannedlist.txt')}76561198000000002\n`, 'data/permittedlist.txt': fixture('files', 'permittedlist.txt') };
    const { ctx, calls } = ctxWith(lists);
    expect(await p.bans!(ctx)).toEqual({ steamIds: [{ steamId: '76561198000000002', reason: null }], ips: [] });
    // Empty (only the game's heading): everyone may join.
    expect(await p.whitelist!(ctx)).toEqual({ enabled: false, usernames: [] });
    expect(await p.levelHolders!(ctx)).toEqual([]);
    expect(await p.ban!(ctx, { steamId: '76561198000000001' })).toBe('Added 76561198000000001 to bannedlist.txt');
    expect(await p.whitelistAdd!(ctx, '76561198000000003')).toBe('Added 76561198000000003 to permittedlist.txt');
    expect(await p.setAccess!(ctx, '76561198000000004', 'admin')).toBe('Added 76561198000000004 to adminlist.txt');
    expect(calls.filter((c) => c[0] === 'set').map((c) => c.slice(1, 3))).toEqual([
      ['banned', { '76561198000000001': true }],
      ['permitted', { '76561198000000003': true }],
      ['admins', { '76561198000000004': true }],
    ]);
    // A name or an address isn't what the lists hold.
    await expect(p.ban!(ctx, { username: 'bob' })).rejects.toBeInstanceOf(RconProtocolError);
    await expect(p.whitelistAdd!(ctx, 'bob')).rejects.toBeInstanceOf(RconProtocolError);
    expect(p.kick).toBeUndefined();
  });
});

describe('backups, resets and messages (BAK-01, BAK-04, CON-03)', () => {
  it("back up the world's folder and the lists; reset the world, or the world and the lists", () => {
    expect(vh.backups.parts.map((p) => [p.id, p.paths(srv)])).toEqual([
      ['world', ['worlds_local/my-world']],
      ['lists', ['adminlist.txt', 'bannedlist.txt', 'permittedlist.txt']],
    ]);
    expect(vh.resets.map((r) => [r.id, r.permission, r.removeParts])).toEqual([
      ['world', 'reset.world', ['world']],
      ['factory', 'reset.factory', ['world', 'lists']],
    ]);
  });

  it('sends no countdowns or messages: Valheim has no console', () => {
    expect(vh.messages.announce('restart', 300, 'en')).toBeNull();
    expect(vh.messages.broadcast).toBeUndefined();
  });
});
