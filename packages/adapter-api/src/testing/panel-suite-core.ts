// The contract every panel adapter passes, minus its config half (see
// panel-suite-config.ts). Call it from a test file of the adapter's package:
//   panelAdapterCoreSuite(pzPanelAdapter, { server: () => ({ … }), secrets: () => ({ … }) });
import { describe, expect, it } from 'vitest';
import { RconProtocolError } from '@gsp/formats';
import { PERMISSIONS } from '@gsp/shared';
import type { AgentCommand, AnnounceKind, Capability, Lang, PanelAdapter, SecretBag, ServerCtx, ServerFiles, ServerRef } from '../index';
import { expectI18n, expectUnique, metaTests } from './meta';

export interface PanelCoreSuiteOptions {
  /** A server of this adapter; enables the checks that call per-server functions. */
  server?: () => ServerRef;
  /** Secrets `launch.toAgent` needs; with `server`, enables the launch round trip. */
  secrets?: () => SecretBag;
}

const KINDS: (AnnounceKind | 'cancelled')[] = ['restart', 'stop', 'update', 'restore', 'reset', 'cancelled'];
const LANGS: Lang[] = ['en', 'es'];
/** Arguments no game command may carry: quote breaks, line breaks, NUL. */
const HOSTILE = ['x"; quit', 'x\nquit', 'x\rquit', 'x\0'];

/** A server with no files and no agent: commands are recorded, everything else is refused. */
function bareCtx(srv: ServerRef): ServerCtx & { commands: AgentCommand[] } {
  const commands: AgentCommand[] = [];
  const refuse = async (): Promise<never> => {
    throw new Error('not available in the contract suite');
  };
  const files: ServerFiles = {
    stat: async () => null,
    list: async () => [],
    read: async () => null,
    writeAtomic: refuse,
    remove: refuse,
    pack: refuse,
    stage: refuse,
    swap: refuse,
    undo: refuse,
    purgeTrash: refuse,
  };
  return {
    srv,
    files,
    status: () => null,
    command: async (c) => {
      commands.push(c);
      return { via: 'rcon', output: '' };
    },
    action: refuse,
    onLog: () => () => undefined,
    commands,
  };
}

export function panelAdapterCoreSuite<S>(adapter: PanelAdapter<S>, opts: PanelCoreSuiteOptions = {}): void {
  describe(`panel adapter contract (core): ${adapter.meta.id}`, () => {
    metaTests(adapter.meta);
    const caps = () => new Set<Capability>([...adapter.meta.capabilities, ...adapter.meta.flavours.flatMap((f) => f.capabilities ?? [])]);
    const server = (): ServerRef => opts.server?.() ?? { id: 'contract', gameName: 'contract', flavour: null };

    it('implements what its capabilities promise', () => {
      const c = caps();
      const p = adapter.players;
      const missing: string[] = [];
      const need = (cap: Capability, ok: boolean, what: string) => {
        if (c.has(cap) && !ok) missing.push(`${cap}: ${what}`);
      };
      need('broadcast', !!adapter.messages.broadcast, 'messages.broadcast');
      need('kick', !!p?.kick, 'players.kick');
      need('ban', !!p?.ban && !!p.unban, 'players.ban/unban');
      need('whitelist', !!p?.whitelistAdd && !!p.whitelistRemove, 'players.whitelistAdd/Remove');
      need('accessLevels', !!p?.setAccess && (p.accessLevels?.length ?? 0) > 0, 'players.setAccess and players.accessLevels');
      need('accounts', !!p?.accounts, 'players.accounts');
      need('updateCheck', !!adapter.updates, 'updates.check');
      for (const cap of c) if (cap.startsWith('mods:')) need(cap, !!adapter.mods?.some((m) => m.capability === cap), `a mod source for ${cap}`);
      for (const m of adapter.mods ?? []) if (!c.has(m.capability)) missing.push(`mod source ${m.id} without the ${m.capability} capability`);
      expect(missing).toEqual([]);
    });

    it('backup parts and resets are labelled and consistent', () => {
      const parts = adapter.backups.parts.map((x) => x.id);
      expectUnique(parts, 'backup part ids');
      for (const x of adapter.backups.parts) expectI18n(x.label, `backup part ${x.id}`);
      expectUnique(
        adapter.resets.map((r) => r.id),
        'reset ids',
      );
      for (const r of adapter.resets) {
        expectI18n(r.label, `reset ${r.id}`);
        expect(r.removeParts.filter((x) => !parts.includes(x)), `reset ${r.id} removes unknown parts`).toEqual([]);
        expect(r.removeParts.length, `reset ${r.id} removes nothing`).toBeGreaterThan(0);
        expect(Object.keys(PERMISSIONS), `reset ${r.id} permission`).toContain(r.permission);
      }
    });

    it('launch settings have unique keys, both languages, and defaults for every key', () => {
      const keys = adapter.launch.schema.map((o) => o.key);
      expectUnique(keys, 'launch setting keys');
      for (const o of adapter.launch.schema) {
        expect(o.description.en?.trim(), `launch setting ${o.key} (en)`).toBeTruthy();
        expect(o.description.es?.trim(), `launch setting ${o.key} (es)`).toBeTruthy();
      }
      const defaults = adapter.launch.defaults();
      expect(defaults !== null && typeof defaults === 'object', 'launch defaults are an object').toBe(true);
      expect(Object.keys(defaults as object).sort()).toEqual([...keys].sort());
    });

    it('announces every countdown in both languages; broadcasts are commands', () => {
      const canShow = caps().has('broadcast');
      for (const lang of LANGS) {
        for (const kind of KINDS) {
          for (const seconds of [900, 60, 10]) {
            const text = adapter.messages.announce(kind, seconds, lang);
            if (canShow) expect(text?.trim(), `${kind} ${seconds}s (${lang})`).toBeTruthy();
            else expect(text === null || typeof text === 'string').toBe(true);
          }
        }
      }
      if (adapter.messages.broadcast) expect(adapter.messages.broadcast('Hello').command.trim()).not.toBe('');
    });

    it('console catalog: unique names, usage and both languages', () => {
      const catalog = adapter.consoleCatalog ?? [];
      expectUnique(
        catalog.map((c) => c.name),
        'console command names',
      );
      for (const c of catalog) {
        expect(c.name.trim()).not.toBe('');
        expect(c.syntax.trim(), `syntax of ${c.name}`).not.toBe('');
        expectI18n(c.description, `console command ${c.name}`);
        if (c.permission) expect(Object.keys(PERMISSIONS), `permission of ${c.name}`).toContain(c.permission);
      }
    });

    it('mod sources: labelled, refuse junk refs, round-trip an empty list', () => {
      const sources = adapter.mods ?? [];
      expectUnique(
        sources.map((m) => m.id),
        'mod source ids',
      );
      for (const m of sources) {
        expectI18n(m.label, `mod source ${m.id}`);
        for (const junk of ['', '   ', 'not a mod', 'javascript:alert(1)', '../../etc/passwd']) expect(m.parseRef(junk), `${m.id} parseRef(${JSON.stringify(junk)})`).toBeNull();
        const empty = m.toConfig([], new Map());
        expect(empty.fileId.trim(), `${m.id} config file`).not.toBe('');
        if (m.fromConfig) expect(m.fromConfig(empty.values)).toEqual({ items: [], enabled: [] });
      }
    });

    it('player moderation refuses arguments the game cannot take, sending nothing', async () => {
      const p = adapter.players;
      if (!p) return;
      if (p.accessLevels) expectUnique(p.accessLevels, 'access levels');
      const ctx = bareCtx(server());
      for (const bad of HOSTILE) {
        if (p.kick) await expect(p.kick(ctx, bad), `kick ${JSON.stringify(bad)}`).rejects.toBeInstanceOf(RconProtocolError);
        if (p.kick) await expect(p.kick(ctx, 'bob', bad), `kick reason ${JSON.stringify(bad)}`).rejects.toBeInstanceOf(RconProtocolError);
        if (p.ban) await expect(p.ban(ctx, { username: bad }), `ban ${JSON.stringify(bad)}`).rejects.toBeInstanceOf(RconProtocolError);
        if (p.unban) await expect(p.unban(ctx, { username: bad }), `unban ${JSON.stringify(bad)}`).rejects.toBeInstanceOf(RconProtocolError);
        if (p.whitelistAdd) await expect(p.whitelistAdd(ctx, bad, 'secret-pw'), `whitelistAdd ${JSON.stringify(bad)}`).rejects.toBeInstanceOf(RconProtocolError);
        if (p.whitelistRemove) await expect(p.whitelistRemove(ctx, bad), `whitelistRemove ${JSON.stringify(bad)}`).rejects.toBeInstanceOf(RconProtocolError);
        if (p.setAccess) await expect(p.setAccess(ctx, bad, p.accessLevels?.[0] ?? 'x'), `setAccess ${JSON.stringify(bad)}`).rejects.toBeInstanceOf(RconProtocolError);
      }
      if (p.ban) await expect(p.ban(ctx, {}), 'ban without a target').rejects.toBeInstanceOf(RconProtocolError);
      if (p.setAccess) await expect(p.setAccess(ctx, 'bob', 'not-a-level; quit'), 'unknown access level').rejects.toBeInstanceOf(RconProtocolError);
      expect(ctx.commands).toEqual([]);
      // A normal kick reaches the game.
      if (p.kick) {
        await p.kick(ctx, 'bob', 'afk');
        expect(ctx.commands.length).toBeGreaterThan(0);
      }
    });

    if (opts.server) {
      const srv = opts.server;
      it('backup paths stay relative to the data root', () => {
        for (const x of adapter.backups.parts) for (const p of x.paths(srv())) expect(p).toMatch(/^(?![/\\])(?!.*(^|[/\\])\.\.([/\\]|$))/);
      });

      it('mod sources find nothing on a server without files', async () => {
        for (const m of adapter.mods ?? []) {
          const ref = m.parseRef('1234567890');
          if (ref) expect(await m.scan(bareCtx(srv()), ref, '')).toBeNull();
        }
      });

      if (opts.secrets) {
        const secrets = opts.secrets;
        it('launch defaults turn into plain-data agent params', () => {
          const params = adapter.launch.toAgent(srv(), adapter.launch.defaults(), secrets());
          expect(params).not.toBeNull();
          expect(JSON.parse(JSON.stringify(params))).toEqual(params);
        });
      }
    }
  });
}
