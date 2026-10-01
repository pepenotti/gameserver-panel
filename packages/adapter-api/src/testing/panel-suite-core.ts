// The contract every panel adapter passes, minus its config half (see
// panel-suite-config.ts). Call it from a test file of the adapter's package:
//   panelAdapterCoreSuite(pzPanelAdapter, { server: () => ({ … }), secrets: () => ({ … }) });
import { describe, expect, it } from 'vitest';
import { RconProtocolError } from '@gsp/formats';
import { FS_WRITE_MAX_BYTES, PERMISSIONS } from '@gsp/shared';
import type { AgentCommand, AnnounceKind, BanTarget, Capability, Lang, PanelAdapter, PlayerOps, SecretBag, ServerCtx, ServerFiles, ServerRef } from '../index';
import { expectI18n, expectUnique, metaTests } from './meta';

export interface PanelCoreSuiteOptions {
  /** A server of this adapter; enables the checks that call per-server functions. */
  server?: () => ServerRef;
  /** Secrets `launch.toAgent` needs; with `server`, enables the launch round trip. */
  secrets?: () => SecretBag;
  /**
   * A player as the game's moderation names one, for the checks that must
   * reach the game (default `bob`; a game whose lists hold SteamIDs gives
   * one).
   */
  player?: string;
}

const KINDS: (AnnounceKind | 'cancelled')[] = ['restart', 'stop', 'update', 'restore', 'reset', 'cancelled'];
const LANGS: Lang[] = ['en', 'es'];
/** Arguments no game command may carry: quote breaks, line breaks, NUL. */
const HOSTILE = ['x"; quit', 'x\nquit', 'x\rquit', 'x\0'];
const BAN_TARGETS: readonly BanTarget[] = ['username', 'steamId', 'ip', 'uuid', 'account'];
const PLAYER_OPS = ['kick', 'ban', 'unban', 'setAccess', 'whitelistAdd', 'whitelistRemove', 'setWhitelistEnabled'] as const;

/** Each flavour (or none, for an adapter without flavours), with its capabilities and its moderation. */
function flavoursOf<S>(adapter: PanelAdapter<S>): { flavour: string | null; caps: Set<Capability>; players: PlayerOps | undefined }[] {
  const ids: (string | null)[] = adapter.meta.flavours.length ? adapter.meta.flavours.map((f) => f.id) : [null];
  return ids.map((flavour) => {
    const f = flavour === null ? undefined : adapter.meta.flavours.find((x) => x.id === flavour);
    return { flavour, caps: new Set(f?.capabilities ?? adapter.meta.capabilities), players: adapter.playersOf?.(flavour) ?? adapter.players };
  });
}

/**
 * A server with no files and no agent: commands, runtime actions and config
 * writes are recorded (an action answers nothing), the agent knows no
 * versions, everything else is refused.
 */
function bareCtx<S>(adapter: PanelAdapter<S>, srv: ServerRef): ServerCtx & { commands: AgentCommand[]; actions: [string, unknown][]; configCalls: unknown[][] } {
  const commands: AgentCommand[] = [];
  const actions: [string, unknown][] = [];
  const configCalls: unknown[][] = [];
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
    actor: 'contract-suite',
    status: () => null,
    command: async (c) => {
      commands.push(c);
      return { via: 'rcon', output: '' };
    },
    action: async (name, input) => void actions.push([name, input]),
    versions: async () => ({ installed: null, versions: [] }),
    launchSettings: () => adapter.launch.defaults(),
    config: {
      set: async (fileId, values, note) => void configCalls.push(['set', fileId, values, note]),
      seedIfMissing: async () => (configCalls.push(['seedIfMissing']), false),
      applyPreset: async (name) => void configCalls.push(['applyPreset', name]),
    },
    onLog: () => () => undefined,
    commands,
    actions,
    configCalls,
  };
}

export function panelAdapterCoreSuite<S>(adapter: PanelAdapter<S>, opts: PanelCoreSuiteOptions = {}): void {
  describe(`panel adapter contract (core): ${adapter.meta.id}`, () => {
    metaTests(adapter.meta);
    const caps = () => new Set<Capability>([...adapter.meta.capabilities, ...adapter.meta.flavours.flatMap((f) => f.capabilities ?? [])]);
    const server = (): ServerRef => opts.server?.() ?? { id: 'contract', gameName: 'contract', flavour: null };

    it('implements what its capabilities promise, flavour by flavour', () => {
      const missing: string[] = [];
      for (const { flavour, caps: c, players: p } of flavoursOf(adapter)) {
        const on = flavour === null ? '' : ` (${flavour})`;
        const need = (cap: Capability, ok: boolean, what: string) => {
          if (c.has(cap) && !ok) missing.push(`${cap}${on}: ${what}`);
        };
        need('broadcast', !!adapter.messages.broadcast || !!adapter.messages.send, 'messages.broadcast or messages.send');
        need('kick', !!p?.kick, 'players.kick');
        need('ban', !!p?.ban && !!p.unban, 'players.ban/unban');
        need('whitelist', !!p?.whitelistAdd && !!p.whitelistRemove, 'players.whitelistAdd/Remove');
        need('accessLevels', !!p?.setAccess && (p.accessLevels?.length ?? 0) > 0, 'players.setAccess and players.accessLevels');
        need('accounts', !!p?.accounts, 'players.accounts');
        // What only a game with a whitelist or access levels can have.
        if (!c.has('whitelist') && (p?.setWhitelistEnabled || p?.whitelist)) missing.push(`players.setWhitelistEnabled/whitelist without the whitelist capability${on}`);
        if (!c.has('accessLevels') && p?.levelHolders) missing.push(`players.levelHolders without the accessLevels capability${on}`);
        need('updateCheck', !!adapter.updates, 'updates.check');
        for (const cap of c) if (cap.startsWith('mods:')) need(cap, !!adapter.mods?.some((m) => m.capability === cap) || !!adapter.plugins?.some((m) => m.capability === cap), `a mod or plugin source for ${cap}`);
      }
      const all = caps();
      for (const m of adapter.mods ?? []) if (!all.has(m.capability)) missing.push(`mod source ${m.id} without the ${m.capability} capability`);
      for (const m of adapter.plugins ?? []) if (!all.has(m.capability)) missing.push(`plugin source ${m.id} without the ${m.capability} capability`);
      expect(missing).toEqual([]);
    });

    it('flavour-only resets and console commands name declared flavours', () => {
      const flavours = adapter.meta.flavours.map((f) => f.id);
      for (const [what, list] of [
        ['reset', adapter.resets],
        ['console command', adapter.consoleCatalog ?? []],
      ] as const) {
        for (const x of list) {
          const f = 'id' in x ? x.id : x.name;
          if (x.flavours === undefined) continue;
          expect(x.flavours.length, `${what} ${f} is for no flavour`).toBeGreaterThan(0);
          expect(x.flavours.filter((id) => !flavours.includes(id)), `${what} ${f} flavours`).toEqual([]);
        }
      }
      if (adapter.playersOf) expect(adapter.meta.flavours.length, 'playersOf without flavours').toBeGreaterThan(0);
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
        expect(Object.keys(r.options ?? {}).filter((k) => k !== 'newSeed' && k !== 'preset'), `reset ${r.id} options`).toEqual([]);
      }
    });

    it('launch settings have unique keys, both languages, and defaults for every key', () => {
      const keys = adapter.launch.schema.map((o) => o.key);
      expectUnique(keys, 'launch setting keys');
      for (const o of adapter.launch.schema) {
        expect(o.description.en?.trim(), `launch setting ${o.key} (en)`).toBeTruthy();
        expect(o.description.es?.trim(), `launch setting ${o.key} (es)`).toBeTruthy();
        if (o.step !== undefined) expect(o.step, `launch setting ${o.key} step`).toBeGreaterThan(0);
        if (o.role === 'memory') expect(o.type, `launch setting ${o.key} (memory) type`).toBe('integer');
      }
      for (const role of ['version', 'memory'] as const) expect(adapter.launch.schema.filter((o) => o.role === role).length, `launch settings with role ${role}`).toBeLessThanOrEqual(1);
      const defaults = adapter.launch.defaults();
      expect(defaults !== null && typeof defaults === 'object', 'launch defaults are an object').toBe(true);
      expect(Object.keys(defaults as object).sort()).toEqual([...keys].sort());
    });

    it('launch settings name only declared flavours, and every warning is worded in both languages (UPD-02, Q13)', () => {
      const flavours = adapter.meta.flavours.map((f) => f.id);
      for (const o of adapter.launch.schema) {
        if (o.flavours === undefined) continue;
        expect(o.flavours.length, `launch setting ${o.key} is for no flavour`).toBeGreaterThan(0);
        expect(o.flavours.filter((f) => !flavours.includes(f)), `launch setting ${o.key} flavours`).toEqual([]);
      }
      for (const [code, text] of Object.entries(adapter.launch.warnings ?? {})) {
        expect(code).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
        expectI18n(text, `warning ${code}`);
      }
    });

    it('launch choices refuse, or answer something, when the download services cannot be reached; they never hang', async () => {
      const choices = adapter.launch.choices;
      if (!choices) return;
      const ctx = { fetch: async (): Promise<Response> => Promise.reject(new Error('no network in the contract suite')), env: {} };
      for (const flavour of adapter.meta.flavours.length ? adapter.meta.flavours.map((f) => f.id) : [null]) {
        for (const version of [null, '1']) {
          const r = await choices({ flavour, version }, ctx).then(
            (x) => x,
            (e: unknown) => e,
          );
          if (r instanceof Error) continue;
          expect(r !== null && typeof r === 'object', `choices for ${flavour}`).toBe(true);
          for (const [key, list] of Object.entries(r as Record<string, unknown[]>)) {
            expect(adapter.launch.schema.map((o) => o.key), `choices for an unknown setting ${key}`).toContain(key);
            expect(Array.isArray(list)).toBe(true);
          }
        }
      }
    });

    it('launch secrets are labelled, unique and not part of the settings form', () => {
      const secrets = adapter.launch.secrets ?? [];
      expectUnique(
        secrets.map((s) => s.key),
        'launch secret keys',
      );
      for (const s of secrets) {
        expect(s.key).toMatch(/^[A-Za-z][A-Za-z0-9]{0,63}$/);
        expectI18n(s.label, `launch secret ${s.key}`);
        // The form (and the settings the panel shows) never holds a secret.
        expect(adapter.launch.schema.map((o) => o.key), `launch secret ${s.key}`).not.toContain(s.key);
      }
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
        if (c.secretArgs !== undefined) expect(typeof c.secretArgs, `secretArgs of ${c.name}`).toBe('boolean');
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

    it('plugin sources: labelled, warn in both languages, take plugin files within the upload limit, refuse junk links (MOD-06)', () => {
      const sources = adapter.plugins ?? [];
      expectUnique(
        sources.map((m) => m.id),
        'plugin source ids',
      );
      for (const m of sources) {
        expectI18n(m.label, `plugin source ${m.id}`);
        expectI18n(m.warning, `plugin source ${m.id} warning`);
        if (m.linkHint) expectI18n(m.linkHint, `plugin source ${m.id} link hint`);
        expect(m.extensions.length, `${m.id} extensions`).toBeGreaterThan(0);
        for (const x of m.extensions) expect(x, `${m.id} extension`).toMatch(/^\.[a-z0-9]{1,10}$/);
        expect(m.extensions, `${m.id}: a zip is how several plugins come, not a plugin`).not.toContain('.zip');
        expect(Number.isInteger(m.maxBytes) && m.maxBytes > 0 && m.maxBytes <= FS_WRITE_MAX_BYTES, `${m.id} maxBytes`).toBe(true);
        expect(m.uploadDir, `${m.id} uploadDir`).toMatch(/^(?![/\\])(?!.*(^|[/\\])\.\.([/\\]|$))[^\\]+$/);
        for (const junk of ['', '   ', 'not a link', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/a.dll', 'http://example.com/a.dll', 'https://example.invalid/a.dll', '../../etc/passwd']) {
          expect(m.checkLink(junk, {}), `${m.id} checkLink(${JSON.stringify(junk)})`).not.toBeNull();
        }
      }
    });

    it('player moderation refuses arguments the game cannot take, sending nothing', async () => {
      for (const { flavour, players: p } of flavoursOf(adapter)) {
        if (!p) continue;
        const on = flavour === null ? '' : ` (${flavour})`;
        if (p.accessLevels) {
          expectUnique(
            p.accessLevels.map((l) => l.id),
            `access levels${on}`,
          );
          for (const l of p.accessLevels) expectI18n(l.label, `access level ${l.id}${on}`);
        }
        expect([...(p.banTargets ?? [])].filter((t) => !BAN_TARGETS.includes(t)), `ban targets${on}`).toEqual([]);
        if (p.ban) expect(p.banTargets?.length ?? 0, `players.ban without banTargets${on}`).toBeGreaterThan(0);
        if (p.banByAddress) expect(!!p.ban, `players.banByAddress without players.ban${on}`).toBe(true);
        for (const op of p.stoppedOnly ?? []) expect(!!p[op], `players.stoppedOnly names ${op}, which it doesn't have${on}`).toBe(true);
        const targets = p.banTargets ?? [];
        const ctx = { ...bareCtx(adapter, { ...server(), flavour }) };
        const player = opts.player ?? 'bob';
        // What reaches the game: commands, runtime actions, and changes to its files (a game moderated through list files).
        const sent = () => ctx.commands.length + ctx.actions.length + ctx.configCalls.filter((c) => c[0] === 'set').length;
        for (const bad of HOSTILE) {
          // Every field it bans by refuses what no game command may carry (a name, an address, an id).
          for (const t of targets) {
            if (p.ban) await expect(p.ban(ctx, { [t]: bad }), `ban ${t} ${JSON.stringify(bad)}${on}`).rejects.toBeInstanceOf(RconProtocolError);
            if (p.unban) await expect(p.unban(ctx, { [t]: bad }), `unban ${t} ${JSON.stringify(bad)}${on}`).rejects.toBeInstanceOf(RconProtocolError);
          }
          if (p.kick) await expect(p.kick(ctx, bad), `kick ${JSON.stringify(bad)}${on}`).rejects.toBeInstanceOf(RconProtocolError);
          if (p.kick) await expect(p.kick(ctx, player, bad), `kick reason ${JSON.stringify(bad)}${on}`).rejects.toBeInstanceOf(RconProtocolError);
          if (p.ban && targets.includes('username')) await expect(p.ban(ctx, { username: player }, bad), `ban reason ${JSON.stringify(bad)}${on}`).rejects.toBeInstanceOf(RconProtocolError);
          if (p.whitelistAdd) await expect(p.whitelistAdd(ctx, bad, 'secret-pw'), `whitelistAdd ${JSON.stringify(bad)}${on}`).rejects.toBeInstanceOf(RconProtocolError);
          if (p.whitelistRemove) await expect(p.whitelistRemove(ctx, bad), `whitelistRemove ${JSON.stringify(bad)}${on}`).rejects.toBeInstanceOf(RconProtocolError);
          if (p.setAccess) await expect(p.setAccess(ctx, bad, p.accessLevels?.[0]?.id ?? 'x'), `setAccess ${JSON.stringify(bad)}${on}`).rejects.toBeInstanceOf(RconProtocolError);
        }
        if (p.ban) await expect(p.ban(ctx, {}), `ban without a target${on}`).rejects.toBeInstanceOf(RconProtocolError);
        // A field it doesn't ban by is refused, not taken for another.
        for (const t of BAN_TARGETS.filter((x) => !targets.includes(x))) if (p.ban) await expect(p.ban(ctx, { [t]: 'bob' }), `ban by ${t}${on}`).rejects.toBeInstanceOf(RconProtocolError);
        if (p.setAccess) await expect(p.setAccess(ctx, player, 'not-a-level; quit'), `unknown access level${on}`).rejects.toBeInstanceOf(RconProtocolError);
        expect(sent(), `sent to the game${on}`).toBe(0);
        if (p.ban && targets.includes('ip')) await expect(p.ban(ctx, { ip: 'not-an-address' }), `ban a word as an ip${on}`).rejects.toBeInstanceOf(RconProtocolError);
        expect(sent(), `sent to the game${on}`).toBe(0);
        // A normal kick reaches the game.
        if (p.kick) {
          await p.kick(ctx, player, 'afk');
          expect(sent(), `kick${on}`).toBeGreaterThan(0);
        }
        // A whitelist without passwords takes a name alone.
        if (p.whitelistAdd && p.whitelistPassword === false) {
          const before = sent();
          await p.whitelistAdd(ctx, player);
          expect(sent(), `whitelistAdd without a password${on}`).toBeGreaterThan(before);
        }
      }
    });

    it('tells a refusal from a reply only by what the game answers, and only for the commands it has (PLY-03)', () => {
      for (const { flavour, players: p } of flavoursOf(adapter)) {
        if (!p?.refused) continue;
        const ops = PLAYER_OPS.filter((op) => p[op]);
        expect(ops.length, `players.refused without a command to refuse (${flavour})`).toBeGreaterThan(0);
        for (const op of ops) {
          // An empty reply (a stdin command, a game that says nothing) and anything made up are no refusal.
          for (const reply of ['', 'ok', 'x'.repeat(5000), '\n\n']) expect(p.refused(op, reply), `${op} ${JSON.stringify(reply.slice(0, 20))} (${flavour})`).toBeNull();
        }
      }
    });

    it("reads the whitelist, who holds a level and the bans from the game's files, empty on a server without any", async () => {
      for (const { flavour, players: p } of flavoursOf(adapter)) {
        if (!p) continue;
        const ctx = bareCtx(adapter, { ...server(), flavour });
        if (p.whitelist) {
          const w = await p.whitelist(ctx);
          expect(w.usernames).toEqual([]);
          expect([true, false, null]).toContain(w.enabled);
        }
        if (p.levelHolders) expect(await p.levelHolders(ctx)).toEqual([]);
        expect(ctx.commands, `reads send nothing to the game (${flavour})`).toEqual([]);
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
          if (ref) expect(await m.scan(bareCtx(adapter, srv()), ref, '')).toBeNull();
        }
      });

      it('plugin sources keep their uploads out of backups and the editor, refuse bad names and links without reaching the server, and never claim what the server did not say (MOD-06)', async () => {
        const within = (rel: string, dir: string) => dir === '' || rel === dir || rel.startsWith(`${dir.replace(/\/+$/, '')}/`) || dir.startsWith(`${rel.replace(/\/+$/, '')}/`);
        for (const m of adapter.plugins ?? []) {
          for (const x of adapter.backups.parts) for (const p of x.paths(srv())) expect(within(p, m.uploadDir), `${m.id} uploads under backup part ${x.id} (${p})`).toBe(false);
          for (const r of adapter.config.roots(srv())) if (r.root === 'data') expect(r.rel !== '' && within(m.uploadDir, r.rel), `${m.id} uploads in editable folder ${r.id}`).toBe(false);
          const ctx = bareCtx(adapter, srv());
          for (const bad of ['../x.dll', 'a/b.dll', '', 'x\n.dll']) {
            expect(await m.setEnabled(ctx, bad, true), `${m.id} setEnabled(${JSON.stringify(bad)})`).toMatchObject({ ok: false, reason: 'bad-name' });
            expect(await m.remove(ctx, bad), `${m.id} remove(${JSON.stringify(bad)})`).toMatchObject({ ok: false, reason: 'bad-name' });
          }
          // (Which hosts are allowed is `checkLink`'s, asked first with the panel's environment; the agent asks again.)
          expect(await m.add(ctx, { url: 'not a link' }), `${m.id} add of a junk link`).toMatchObject({ ok: false });
          expect(await m.add(ctx, { url: 'javascript:alert(1)' }), `${m.id} add of a script link`).toMatchObject({ ok: false });
          expect(await m.add(ctx, { upload: '../escape.dll', name: 'escape.dll' }), `${m.id} add of an upload outside its folder`).toMatchObject({ ok: false });
          expect(ctx.actions, `${m.id} reached the server`).toEqual([]);
          // A server that answers nothing did nothing.
          for (const reply of [await m.list(ctx).catch(() => null), await m.setEnabled(ctx, 'x.dll', true).catch(() => null), await m.remove(ctx, 'x.dll').catch(() => null)]) {
            if (reply !== null) expect(reply.ok, `${m.id} claimed success without an answer`).toBe(false);
          }
        }
      });

      it('update checks answer, or say they cannot tell, when the agent lists no versions', async () => {
        if (!adapter.updates) return;
        const r = await adapter.updates.check(bareCtx(adapter, srv()), adapter.launch.defaults());
        if (r !== null) expect(typeof r.available).toBe('boolean');
      });

      it('resets and the first-start hook change only declared config files, through the panel', async () => {
        const declared = adapter.config.files(srv()).map((f) => f.id);
        const presetFile = adapter.config.presets?.fileId;
        const runs: [string, (ctx: ServerCtx) => Promise<void>][] = adapter.resets.map((r) => [`reset ${r.id}`, (ctx) => r.after?.(ctx, { newSeed: true }) ?? Promise.resolve()]);
        if (adapter.hooks?.beforeStart) runs.push(['beforeStart', adapter.hooks.beforeStart.bind(adapter.hooks)]);
        for (const [what, run] of runs) {
          const ctx = bareCtx(adapter, srv());
          await run(ctx);
          for (const call of ctx.configCalls) {
            if (call[0] === 'set') expect(declared, `${what} sets keys of ${String(call[1])}`).toContain(call[1]);
            if (call[0] === 'applyPreset') expect(presetFile, `${what} applies a preset without config.presets`).toBeDefined();
          }
          // Files change through ctx.config (history, actor), never behind the panel's back.
          expect(ctx.commands, `${what} sends commands to a stopped server`).toEqual([]);
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
