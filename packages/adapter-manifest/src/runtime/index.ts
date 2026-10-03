/**
 * A manifest game, agent side (D4, M6): a `RuntimeAdapter` made from a
 * manifest. steamcmd installs the manifest's app (UPD-01…03); `prepare`
 * makes the folders it names, writes missing config files from their seeds
 * and sets the keys the agent manages; the command line is its template
 * with the ports, settings and secrets filled in; its lines are read with
 * its patterns (ready, version, fatal, warnings, progress, joins, saves);
 * it stops with its console command or its signal, saves on request, and a
 * running backup follows its declared method (BAK-02); players come from
 * its console, Steam's queries (a hook) or its join and leave lines.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ControlHandle, InstallCtx, InstalledInfo, LaunchCommand, LineSignal, PlayerList, RuntimeAdapter, RuntimeCtx, SteamCmd } from '@gsp/adapter-api';
import { formatFor, parseAppManifest, stripAnsi } from '@gsp/formats';
import type { ManifestRuntimeHooks } from '../shared/hooks';
import { manifestMeta } from '../shared/meta';
import { holds, parseLaunch, type ManifestLaunch, type SettingValue } from '../shared/settings';
import { fill, type Placeholder } from '../shared/templates';
import type { SteamGameManifest, Template } from '../shared/types';

export type { ManifestLaunch, ManifestRuntimeHooks };

/** The orchestrator's mounts for the steam family: the server's data and install volumes. */
export const MANIFEST_ROOTS = { data: '/data', install: '/opt/game' } as const;

/** How long a player list gets to arrive (PLY-01). */
const LIST_MS = 5_000;
/** How long a running copy waits for an autosave in progress, when the manifest doesn't say. */
const AUTOSAVE_MS = 5 * 60_000;

/** The manifest's patterns, compiled once. */
function compile(m: SteamGameManifest) {
  const re = (p: string | undefined) => (p === undefined ? null : new RegExp(p));
  return {
    strip: re(m.log?.strip),
    ready: new RegExp(m.readiness.ready),
    version: re(m.readiness.version),
    fatal: (m.readiness.fatal ?? []).map((p) => new RegExp(p)),
    warnings: (m.readiness.warnings ?? []).map((w) => ({ re: new RegExp(w.pattern), message: w.message })),
    progress: (m.log?.progress ?? []).map((p) => ({ re: new RegExp(p.pattern), key: p.key, text: p.text })),
    join: re(m.players?.join),
    leave: re(m.players?.leave),
    saved: re(m.save?.done),
    autosaveStart: re(m.autosave?.start),
    autosaveDone: re(m.autosave?.done),
    listCount: re(m.players?.list?.count),
    listItem: re(m.players?.list?.item),
  };
}

/** A setting's value as a command line or a file takes it (a boolean as its `onValue`/`offValue`). */
function settingText(m: SteamGameManifest, id: string, v: SettingValue | undefined): string {
  if (typeof v === 'boolean') {
    const s = m.settings.find((x) => x.id === id);
    return v ? (s?.onValue ?? 'true') : (s?.offValue ?? 'false');
  }
  return v === undefined ? '' : String(v);
}

/** A port's number: the agent's (it computes the ones that follow another), else the default. */
function portOf(m: SteamGameManifest, ctx: RuntimeCtx, id: string): number {
  const given = ctx.ports[id];
  if (given !== undefined) return given;
  const p = m.ports.find((x) => x.id === id)!;
  return p.follows ? portOf(m, ctx, p.follows.id) + p.follows.offset : p.default;
}

/** Fills the agent's templates: folders, the game name, ports, settings and secrets. */
export function fillerFor(m: SteamGameManifest, ctx: RuntimeCtx, p: ManifestLaunch): (t: Template) => string {
  const value = (ph: Placeholder): string => {
    switch (ph.kind) {
      case 'installDir':
        return ctx.roots.install;
      case 'dataDir':
        return ctx.roots.data;
      case 'name':
        return p.name;
      case 'port':
        return String(portOf(m, ctx, ph.id!));
      case 'setting':
        return settingText(m, ph.id!, p[ph.id!]);
      case 'secret':
        return String(p[ph.id!] ?? '');
      case 'arg':
        throw new Error('{arg} is for console templates only');
    }
  };
  return (t) => fill(t, value);
}

/** A data-root path's file on disk; refused when it is a link (the agent writes only plain files). */
function dataFile(ctx: RuntimeCtx, rel: string): string {
  const file = path.join(ctx.roots.data, ...rel.split('/'));
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return file;
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${rel} is not a plain file`);
  return file;
}

function steam(ctx: InstallCtx): SteamCmd {
  if (!ctx.steam) throw new Error('No steamcmd driver: this game is installed with steamcmd');
  return ctx.steam;
}

/** The RuntimeAdapter a manifest describes; `hooks` add what it can't say. */
export function manifestRuntimeAdapter(m: SteamGameManifest, hooks: ManifestRuntimeHooks = {}): RuntimeAdapter<ManifestLaunch> {
  const re = compile(m);
  const stdin = m.console.kind === 'stdin';
  const prefix = m.console.kind === 'stdin' ? (m.console.prefix ?? '') : '';
  /** What the running game said: who is online (join and leave lines), whether it is saving on its own. */
  const live = { online: new Set<string>(), saving: false, autosaves: 0 };

  const installed = (ctx: RuntimeCtx): InstalledInfo | null => {
    try {
      const a = parseAppManifest(readFileSync(path.join(ctx.roots.install, 'steamapps', `appmanifest_${m.steam.appId}.acf`), 'utf8'));
      return { version: ctx.state.gameVersion, channel: a.branch, build: a.buildId };
    } catch {
      return null;
    }
  };

  const classify = (raw: string): LineSignal => {
    let text = m.log?.stripAnsi ? stripAnsi(raw) : raw;
    if (re.strip) text = text.replace(re.strip, '');
    const s: LineSignal = { message: text };
    if (re.ready.test(text)) s.ready = true;
    const v = re.version?.exec(text);
    if (v?.[1]) s.version = v[1];
    if (re.fatal.some((x) => x.test(text))) s.fatal = true;
    const w = re.warnings.find((x) => x.re.test(text));
    if (w) s.warning = w.message;
    // The ready line stays in the log whatever else it matches.
    const pr = s.ready ? undefined : re.progress.find((x) => x.re.test(text));
    if (pr) s.progress = pr.text === undefined ? { key: pr.key } : { key: pr.key, text: pr.text };
    const j = re.join?.exec(text);
    if (j?.[1]) {
      s.join = j[1].trim();
      live.online.add(s.join);
    }
    const l = re.leave?.exec(text);
    if (l?.[1]) {
      s.leave = l[1].trim();
      live.online.delete(s.leave);
    }
    if (re.autosaveStart?.test(text)) {
      live.saving = true;
      live.autosaves++;
    }
    if (re.autosaveDone?.test(text)) live.saving = false;
    if (re.saved?.test(text) || re.autosaveDone?.test(text)) s.saved = true;
    return s;
  };

  /** The save command, then its done line within `budgetMs`. */
  const save = async (ctl: ControlHandle, o: { budgetMs: number }): Promise<void> => {
    const done = ctl.waitForLine(re.saved!, o.budgetMs);
    if (!ctl.stdin(m.save!.command)) throw new Error('Could not write to the server console');
    if (!(await done)) throw new Error('The server did not report that it finished saving');
  };

  /** The console's player list: the count line, then one line per player (PLY-01). */
  const consoleList = async (ctl: ControlHandle): Promise<PlayerList | null> => {
    const list = m.players!.list!;
    const countRe = re.listCount!;
    const names = (lines: readonly string[], from: number, n: number): string[] =>
      lines
        .slice(from + 1)
        .map((l) => (re.listItem ? (re.listItem.exec(l)?.[1] ?? null) : l.trim()))
        .filter((x): x is string => x !== null && x.trim() !== '')
        .slice(0, n);
    const complete = (lines: readonly string[]): boolean => {
      const i = lines.findIndex((l) => countRe.test(l));
      if (i < 0) return false;
      const n = Number(countRe.exec(lines[i]!)![1]);
      return n === 0 || names(lines, i, n).length >= n;
    };
    const count = ctl.waitForLine(countRe, LIST_MS);
    const all = ctl.waitForLines ? ctl.waitForLines(complete, LIST_MS) : Promise.resolve(null);
    if (!ctl.stdin(list.command)) throw new Error('Could not write to the server console');
    const c = await count;
    if (!c) throw new Error(`The server did not answer ${list.command}`);
    const n = Number(c[1]);
    if (!Number.isInteger(n) || n < 0) return null;
    // The count is the game's; names only when they came as one per line (the count stands either way).
    const lines = await all;
    const at = lines ? lines.findIndex((l) => countRe.test(l)) : -1;
    return { count: n, names: lines && at >= 0 ? names(lines, at, n) : [] };
  };

  const hotCopy = ((): RuntimeAdapter<ManifestLaunch>['hotCopy'] => {
    const select = hooks.hotCopySelect;
    switch (m.backups.running) {
      case 'stopped-only':
        return undefined;
      case 'save-then-copy':
        return {
          // BAK-02: ask the game to save, then copy what it wrote.
          before: (ctl) => save(ctl, { budgetMs: m.save!.budgetMs }),
          after: async () => undefined,
          ...(select ? { select } : {}),
        };
      case 'copy-between-saves': {
        let startedAt = 0;
        const budgetMs = m.autosave!.budgetMs ?? AUTOSAVE_MS;
        return {
          // The game can't be asked to save: wait out a save of its own in progress, then copy. A selection
          // picks files the save in progress doesn't touch (the newest complete save), so it needs no wait.
          before: async (ctl) => {
            if (live.saving && !select) {
              const done = ctl.waitForLine(re.autosaveDone!, budgetMs);
              if (live.saving && !(await done)) throw new Error('The game did not finish saving on its own in time');
            }
            startedAt = live.autosaves;
          },
          // Without a selection, a save the game started meanwhile may be half in the copy: the backup fails.
          after: async () => {
            if (!select && live.autosaves !== startedAt) throw new Error('The game started saving on its own during the copy; take the backup again');
          },
          ...(select ? { select } : {}),
        };
      }
    }
  })();

  const adapter: RuntimeAdapter<ManifestLaunch> = {
    meta: manifestMeta(m),
    parseLaunch: (input) => parseLaunch(m, input),

    // Whatever a launch holds that is secret: the agent's own secret, secret settings, generated secrets.
    secrets: (p, st) => [st.controlSecret, ...m.settings.filter((s) => s.type === 'secret').map((s) => p[s.id]), ...(m.secrets ?? []).map((s) => p[s.id])].filter((x): x is string => typeof x === 'string' && x !== ''),

    installed,

    // A shared install's identity (HST-09): the Steam branch and build (the version line is learnt per server).
    installKey(ctx) {
      const i = installed(ctx);
      return i ? { flavour: null, version: null, build: i.build ?? null, branch: i.channel ?? null } : null;
    },

    async install(ctx, p, { validate }) {
      ctx.progress(null, `${validate ? 'Validating' : 'Installing/updating'} (${p.branch})`);
      // Always named, public too: steamcmd keeps an install on a beta branch otherwise (measured).
      return steam(ctx).appUpdate({ appId: m.steam.appId, branch: p.branch, validate });
    },

    installOnStart(ctx, p) {
      const i = installed(ctx);
      if (!i || i.channel !== p.branch) return 'required';
      return p.updateOnStart ? 'update' : null;
    },

    async versions(ctx) {
      ctx.progress(null, 'Checking Steam for the latest builds');
      const all = await steam(ctx).branches({ appId: m.steam.appId });
      const offered = m.steam.branches === 'listed' ? null : new Set([m.steam.defaultBranch, ...m.steam.branches]);
      return { installed: installed(ctx), versions: offered ? all.filter((v) => offered.has(v.id)) : all };
    },

    async prepare(ctx, p) {
      const filled = fillerFor(m, ctx, p);
      for (const d of m.prepare?.dirs ?? []) mkdirSync(path.join(ctx.roots.data, ...filled(d).split('/')), { recursive: true });
      for (const f of m.config?.files ?? []) {
        const file = dataFile(ctx, filled(f.path));
        // A file the game would create itself, written first with what the panel needs in it (it completes the rest).
        if (f.seed !== undefined && !existsSync(file)) {
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, filled(f.seed));
        }
        // CFG-04: the keys the agent owns, set before every start in a file that exists.
        if (f.managed && existsSync(file)) {
          const before = readFileSync(file, 'utf8');
          const values = Object.fromEntries(Object.entries(f.managed).map(([k, v]) => [k, filled(v)]));
          const after = formatFor({ format: f.format }).edit(before, values);
          if (after !== before) writeFileSync(file, after);
        }
      }
    },

    command(ctx, p): LaunchCommand {
      // A new run: nobody online yet, and no save of its own in progress.
      live.online.clear();
      live.saving = false;
      const filled = fillerFor(m, ctx, p);
      const args = m.launch.args.flatMap((a) => (typeof a === 'string' ? [filled(a)] : holds(a.if, p) ? a.args.map(filled) : []));
      return {
        argv: [...(ctx.tools.launcher ?? [filled(m.launch.executable)]), ...args],
        cwd: filled(m.launch.cwd),
        ...(m.launch.env ? { env: Object.fromEntries(Object.entries(m.launch.env).map(([k, v]) => [k, filled(v)])) } : {}),
      };
    },

    classify,

    ...(m.log?.stripAnsi || re.strip
      ? {
          display: (text: string) => {
            const t = m.log?.stripAnsi ? stripAnsi(text) : text;
            return re.strip ? t.replace(re.strip, '') : t;
          },
        }
      : {}),

    ...(prefix ? { consoleLine: (cmd: string) => (cmd.startsWith(prefix) ? cmd : `${prefix}${cmd}`) } : {}),

    channel: () => (stdin ? { kind: 'stdin' } : { kind: 'none' }),

    async stop(ctl) {
      // The console's stop once the game reads its console; before that (or without one), the signal (both save).
      if (ctl.ready && stdin && m.stop.command !== undefined && ctl.stdin(m.stop.command)) return;
      ctl.signal(m.stop.signal);
    },

    ...(stdin && m.save ? { save } : {}),
    ...(hotCopy ? { hotCopy } : {}),

    ...(manifestMeta(m).capabilities.includes('players')
      ? {
          async listPlayers(ctl: ControlHandle, ctx?: RuntimeCtx, p?: ManifestLaunch): Promise<PlayerList | null> {
            const pl = m.players!;
            if (stdin && pl.list) return consoleList(ctl);
            const q = pl.steamQuery;
            if (q && hooks.steamQuery && ctx && p && (!q.when || holds(q.when, p))) return hooks.steamQuery(ctx, portOf(m, ctx, q.port));
            if (re.join && re.leave) return { count: live.online.size, names: [...live.online] };
            return null;
          },
        }
      : {}),

    roots: () => ({ ...MANIFEST_ROOTS }),
  };
  return hooks.runtime ? hooks.runtime(adapter) : adapter;
}
