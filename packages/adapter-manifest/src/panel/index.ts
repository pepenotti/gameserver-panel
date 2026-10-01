/**
 * A manifest game, panel side (D4, M6): a `PanelAdapter` made from a
 * manifest. Its launch settings form (the Steam branch, updates before a
 * start, the game's memory, then the manifest's settings with their checks
 * and EN/ES refusals); its config files edited as text (formats, keys the
 * agent manages locked, secret keys masked, files the game rewrites only
 * while stopped) and the folders the editor may browse; its backup parts
 * and resets; countdown messages and broadcasts when it has a console;
 * moderation from console templates or list files; update checks against
 * Steam; its console catalog.
 */
import { isIP } from 'node:net';
import type {
  AnnounceKind,
  BanList,
  BanTarget,
  CommandDoc,
  ConfigFileDecl,
  EditableRoot,
  Lang,
  LaunchOption,
  PanelAdapter,
  PlayerOpKind,
  PlayerOps,
  PlayerRefusal,
  PlayerTarget,
  ServerCtx,
  ServerRef,
  UpdateInfo,
  WhitelistInfo,
} from '@gsp/adapter-api';
import { parseLines, RconProtocolError } from '@gsp/formats';
import type { ManifestPanelHooks } from '../shared/hooks';
import { manifestMeta } from '../shared/meta';
import { checkSettings, MEMORY_MAX_MB, MEMORY_STEP, parseLaunch, settingDefault, settingDefaults, type ManifestSettings } from '../shared/settings';
import { fill, placeholders } from '../shared/templates';
import type { ManifestSetting, SteamGameManifest, Template } from '../shared/types';

export type { ManifestPanelHooks, ManifestSettings };

/** How long the panel listens for the game's reply to a console command it sent for people (PLY-03). */
export const REPLY_MS = 2_000;
/** The longest player name or message the panel sends to a console. */
const NAME_MAX = 64;
const MESSAGE_MAX = 300;
const LIST_MAX_BYTES = 1024 * 1024;

/** A data-root path with the server's game name in it. */
const named = (t: Template, srv: ServerRef) => fill(t, () => srv.gameName);

// ------------------------------------------------------------------ launch settings

function optionOf(s: ManifestSetting): LaunchOption {
  const o: LaunchOption = {
    key: s.id,
    type: s.type === 'secret' ? 'string' : s.type,
    label: s.label,
    description: s.description,
    default: String(settingDefault(s)),
  };
  if (s.type === 'secret') o.secret = true;
  if (s.min !== undefined) o.min = s.min;
  if (s.max !== undefined) o.max = s.max;
  if (s.step !== undefined) o.step = s.step;
  if (s.unit !== undefined) o.unit = s.unit;
  if (s.choices) o.options = s.choices.map((c) => ({ value: c.value, label: c.label }));
  if (s.advanced) o.advanced = true;
  return o;
}

/** The form every manifest game has (branch, updates, memory), then the manifest's own settings. */
export function launchSchema(m: SteamGameManifest): LaunchOption[] {
  const fixed = m.steam.branches === 'listed' ? null : [m.steam.defaultBranch, ...m.steam.branches];
  return [
    {
      key: 'branch',
      type: fixed ? 'enum' : 'string',
      role: 'version',
      default: m.steam.defaultBranch,
      ...(fixed ? { options: fixed.map((b) => ({ value: b, label: { en: b, es: b } })) } : {}),
      label: { en: 'Steam branch', es: 'Rama de Steam' },
      description: {
        en: `The Steam branch installed and run: ${m.steam.defaultBranch} is the current release; others are test or older versions, as the game offers them.`,
        es: `La rama de Steam que se instala y ejecuta: ${m.steam.defaultBranch} es la versión actual; las demás son versiones de prueba o anteriores, según las ofrezca el juego.`,
      },
    },
    {
      key: 'updateOnStart',
      type: 'boolean',
      default: 'true',
      label: { en: 'Update before every start', es: 'Actualizar antes de cada inicio' },
      description: { en: 'Look for an update of the game with steamcmd before every start.', es: 'Buscar una actualización del juego con steamcmd antes de cada inicio.' },
    },
    {
      key: 'memoryMb',
      type: 'integer',
      role: 'memory',
      unit: 'MiB',
      step: MEMORY_STEP,
      min: m.memory.minMb,
      max: MEMORY_MAX_MB,
      default: String(m.memory.defaultMb),
      label: { en: 'Game memory', es: 'Memoria del juego' },
      description: {
        en: `Memory for the game, in MiB (a multiple of ${MEMORY_STEP}); the container gets ${m.memory.overheadMb} MiB more. The game uses what it needs within it.`,
        es: `Memoria para el juego, en MiB (múltiplo de ${MEMORY_STEP}); el contenedor recibe ${m.memory.overheadMb} MiB más. El juego usa lo que necesita dentro de ese límite.`,
      },
    },
    ...m.settings.map(optionOf),
  ];
}

// ------------------------------------------------------------------ config files

function configFiles(m: SteamGameManifest, srv: ServerRef): ConfigFileDecl[] {
  const lf = m.moderation?.listFiles;
  const lists = new Set([lf?.ban, lf?.allow, lf?.admin].filter((v): v is string => v !== undefined));
  return (m.config?.files ?? []).map((f) => ({
    id: f.id,
    ...(f.label ? { label: f.label } : {}),
    root: 'data',
    rel: named(f.path, srv),
    format: f.format,
    managedKeys: Object.keys(f.managed ?? {}),
    secretKeys: [...(f.secretKeys ?? [])],
    restartKeys: f.restartKeys === '*' ? '*' : [...f.restartKeys],
    ...(f.stoppedOnly ? { stoppedOnly: true } : {}),
    ...(f.note ? { note: f.note } : {}),
    // A list the panel moderates through starts empty when the game hasn't written it yet.
    ...(lists.has(f.id) ? { seed: {} } : {}),
  }));
}

function editableRoots(m: SteamGameManifest, srv: ServerRef): EditableRoot[] {
  return (m.config?.roots ?? []).map((r) => ({ id: r.id, root: 'data', rel: named(r.path, srv), include: [...r.include], exclude: [...(r.exclude ?? [])], label: r.label }));
}

/**
 * The managed values the panel knows itself: those without placeholders, or
 * with the game name only. The others (ports, folders, settings) are the
 * agent's, set before every start; the panel keeps what is on disk for them.
 */
function managedValues(m: SteamGameManifest, srv: ServerRef): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const f of m.config?.files ?? []) {
    const known = Object.entries(f.managed ?? {}).filter(([, v]) => placeholders(v).every((p) => p.kind === 'name'));
    if (known.length) out[f.id] = Object.fromEntries(known.map(([k, v]) => [k, named(v, srv)]));
  }
  return out;
}

// ------------------------------------------------------------------ messages

const MSG: Record<Lang, Record<AnnounceKind | 'cancelled', string> & { min: (n: number) => string; sec: (n: number) => string }> = {
  es: {
    restart: 'El servidor se reinicia en {t}.',
    stop: 'El servidor se apaga en {t}.',
    update: 'El servidor se actualiza en {t}.',
    restore: 'El servidor se apaga en {t} para restaurar una copia de seguridad.',
    reset: 'El mundo se reinicia en {t}. Todo lo construido se va a perder.',
    cancelled: 'Se canceló el reinicio del servidor.',
    min: (n) => (n === 1 ? '1 minuto' : `${n} minutos`),
    sec: (n) => `${n} segundos`,
  },
  en: {
    restart: 'Server restarting in {t}.',
    stop: 'Server shutting down in {t}.',
    update: 'Server updating in {t}.',
    restore: 'Server shutting down in {t} to restore a backup.',
    reset: 'The world resets in {t}. Everything built will be lost.',
    cancelled: 'The server restart was cancelled.',
    min: (n) => (n === 1 ? '1 minute' : `${n} minutes`),
    sec: (n) => `${n} seconds`,
  },
};

function announce(kind: AnnounceKind | 'cancelled', secondsLeft: number, lang: Lang): string {
  const msg = MSG[lang];
  if (kind === 'cancelled') return msg.cancelled;
  const t = secondsLeft >= 60 ? msg.min(Math.round(secondsLeft / 60)) : msg.sec(secondsLeft);
  return msg[kind].replace('{t}', t);
}

/** A message as a console takes it: one line, no control characters, not too long. */
function messageArg(text: string): string {
  const t = text.trim();
  if (t === '') throw new RconProtocolError('Empty message');
  if ([...t].length > MESSAGE_MAX) throw new RconProtocolError(`A message can have at most ${MESSAGE_MAX} characters`);
  if (/[\x00-\x1f\x7f]/.test(t)) throw new RconProtocolError('The message contains a control character');
  return t;
}

// ------------------------------------------------------------------ moderation

/** A player name a console takes as one argument: one line, no quotes, no blanks around it, not a command of its own. */
function nameArg(v: unknown, prefix: string): string {
  if (typeof v !== 'string' || v === '' || [...v].length > NAME_MAX || v.trim() !== v || /["\x00-\x1f\x7f]/.test(v) || (prefix !== '' && v.startsWith(prefix))) throw new RconProtocolError('Invalid player name');
  return v;
}

/** A reason: checked like any argument, though the manifest's templates pass none on. */
function reasonArg(reason: string | undefined): void {
  if (reason === undefined || reason.trim() === '') return;
  if (reason.length > 200 || /["\x00-\x1f\x7f]/.test(reason)) throw new RconProtocolError('The reason contains a quote or control character, or is too long');
}

function steamIdArg(v: unknown): string {
  if (typeof v !== 'string' || !/^\d{17}$/.test(v)) throw new RconProtocolError('Invalid SteamID');
  return v;
}

/** The one field of a ban target this game takes. */
function targetOf(t: PlayerTarget, allowed: readonly BanTarget[]): { field: BanTarget; value: string } {
  const given = (Object.keys(t) as (keyof PlayerTarget)[]).filter((k) => t[k] !== undefined);
  if (given.length !== 1 || !allowed.includes(given[0]!)) throw new RconProtocolError(`Name one of: ${allowed.join(', ')}`);
  return { field: given[0]!, value: t[given[0]!]! };
}

/**
 * A console command sent for people, and the first line the game printed
 * after it (its reply, as far as a console says one), or nothing after
 * `REPLY_MS`. On a server that isn't running it is sent and nothing awaited.
 */
async function consoleReply(ctx: ServerCtx, command: string): Promise<string> {
  if (ctx.status()?.state !== 'running') {
    await ctx.command({ command, via: 'stdin' });
    return '';
  }
  let off: () => void = () => undefined;
  let timer: NodeJS.Timeout | undefined;
  const reply = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(''), REPLY_MS);
    off = ctx.onLog((line) => {
      const t = line.trim();
      if (t !== '' && t !== command) resolve(t);
    });
  });
  try {
    await ctx.command({ command, via: 'stdin' });
    return await reply;
  } finally {
    clearTimeout(timer);
    off();
  }
}

function consoleModeration(m: SteamGameManifest): PlayerOps {
  const mod = m.moderation!;
  const prefix = m.console.kind === 'stdin' ? (m.console.prefix ?? '') : '';
  const refusals = (mod.refusals ?? []).map((r) => ({ re: new RegExp(r.pattern), refusal: r.refusal }));
  const run = (template: string, arg: string) => fill(template, () => arg);
  const targets = mod.banTargets ?? ['username'];
  const banArg = (t: PlayerTarget) => {
    const { field, value } = targetOf(t, targets);
    if (field === 'steamId') return steamIdArg(value);
    if (field === 'ip') {
      if (isIP(value) === 0) throw new RconProtocolError('Invalid IP address');
      return value;
    }
    return nameArg(value, prefix);
  };
  const ops: PlayerOps = {};
  // PLY-03: the replies that say the game didn't do it.
  if (refusals.length) {
    ops.refused = (_op: PlayerOpKind, reply: string): PlayerRefusal | null => {
      for (const line of reply.split(/\r?\n/)) for (const r of refusals) if (r.re.test(line.trim())) return r.refusal;
      return null;
    };
  }
  if (mod.kick !== undefined) {
    const kick = mod.kick;
    ops.kick = async (ctx, username, reason) => {
      const name = nameArg(username, prefix);
      reasonArg(reason);
      return consoleReply(ctx, run(kick, name));
    };
  }
  if (mod.ban !== undefined && mod.unban !== undefined) {
    const ban = mod.ban;
    const unban = mod.unban;
    ops.banTargets = targets;
    ops.ban = async (ctx, t, reason) => {
      const v = banArg(t);
      reasonArg(reason);
      return consoleReply(ctx, run(ban, v));
    };
    ops.unban = async (ctx, t) => consoleReply(ctx, run(unban, banArg(t)));
  }
  return ops;
}

/**
 * Moderation by list files (a game without a console, like Valheim): a ban,
 * an allowed player or an admin is a line in a declared list file, changed
 * through the panel's settings service (its history keeps every change).
 */
function listModeration(m: SteamGameManifest): PlayerOps {
  const lf = m.moderation!.listFiles!;
  const files = new Map((m.config?.files ?? []).map((f) => [f.id, f]));
  const entry = (v: unknown) => (lf.target === 'steamId' ? steamIdArg(v) : nameArg(v, ''));
  const what = lf.target === 'steamId' ? 'SteamID' : 'player';
  /** A list file's entries, as the game keeps them (none when it doesn't exist yet). */
  const read = async (ctx: ServerCtx, id: string): Promise<string[]> => {
    const buf = await ctx.files.read('data', named(files.get(id)!.path, ctx.srv), { maxBytes: LIST_MAX_BYTES });
    return buf ? parseLines(buf.toString('utf8')).entries.map((e) => e.value) : [];
  };
  /** Adds or removes an entry; a list the game hasn't written yet starts empty (its panel seed). */
  const change = async (ctx: ServerCtx, id: string, value: string, on: boolean, note: string): Promise<string> => {
    await ctx.config.seedIfMissing();
    await ctx.config.set(id, { [value]: on }, note);
    return `${on ? 'Added' : 'Removed'} ${value} ${on ? 'to' : 'from'} ${named(files.get(id)!.path, ctx.srv)}`;
  };
  const stoppedOnly: PlayerOpKind[] = [];
  const ops: PlayerOps = { whitelistPassword: false };
  if (lf.ban) {
    const id = lf.ban;
    ops.banTargets = [lf.target];
    ops.ban = async (ctx, t, reason) => {
      const v = entry(targetOf(t, [lf.target]).value);
      reasonArg(reason);
      return change(ctx, id, v, true, `ban ${what} ${v}`);
    };
    ops.unban = async (ctx, t) => {
      const v = entry(targetOf(t, [lf.target]).value);
      return change(ctx, id, v, false, `unban ${what} ${v}`);
    };
    ops.bans = async (ctx): Promise<BanList> => {
      const list = await read(ctx, id);
      return lf.target === 'steamId' ? { steamIds: list.map((steamId) => ({ steamId, reason: null })), ips: [] } : { steamIds: [], ips: [], usernames: list.map((username) => ({ username, id: null, reason: null })) };
    };
    stoppedOnly.push('ban', 'unban');
  }
  if (lf.allow) {
    const id = lf.allow;
    ops.whitelistAdd = async (ctx, name) => change(ctx, id, entry(name), true, `allow ${what} ${entry(name)}`);
    ops.whitelistRemove = async (ctx, name) => change(ctx, id, entry(name), false, `disallow ${what} ${entry(name)}`);
    // An empty list lets everyone in.
    ops.whitelist = async (ctx): Promise<WhitelistInfo> => {
      const list = await read(ctx, id);
      return { enabled: list.length > 0, usernames: list };
    };
    stoppedOnly.push('whitelistAdd', 'whitelistRemove');
  }
  if (lf.admin) {
    const id = lf.admin;
    ops.accessLevels = [
      { id: 'player', label: { en: 'Player', es: 'Jugador' } },
      { id: 'admin', label: { en: 'Admin', es: 'Admin' } },
    ];
    ops.setAccess = async (ctx, name, level) => {
      const v = entry(name);
      if (level !== 'player' && level !== 'admin') throw new RconProtocolError('Unknown access level');
      return change(ctx, id, v, level === 'admin', `${level === 'admin' ? 'make' : 'unmake'} ${what} ${v} an admin`);
    };
    ops.levelHolders = async (ctx) => (await read(ctx, id)).map((username) => ({ username, level: 'admin' }));
    stoppedOnly.push('setAccess');
  }
  if (lf.stoppedOnly) ops.stoppedOnly = stoppedOnly;
  return ops;
}

function moderation(m: SteamGameManifest): PlayerOps | undefined {
  const mod = m.moderation;
  if (!mod) return undefined;
  const onConsole = m.console.kind === 'stdin' && (mod.kick !== undefined || mod.ban !== undefined) ? consoleModeration(m) : {};
  const byLists = mod.listFiles ? listModeration(m) : {};
  const ops: PlayerOps = { ...byLists, ...onConsole };
  return Object.keys(ops).length ? ops : undefined;
}

// ------------------------------------------------------------------ updates

/** The installed build against the newest of the pinned branch (steamcmd, through the agent); null when the branch isn't listed. */
async function checkUpdate(m: SteamGameManifest, ctx: ServerCtx, launch: ManifestSettings): Promise<UpdateInfo | null> {
  const { branch } = checkSettings(m, launch);
  const info = await ctx.versions();
  const latest = info.versions.find((v) => v.id === branch);
  if (!latest?.build) return null;
  const inst = info.installed;
  return { available: !inst || inst.channel !== branch || inst.build !== latest.build, current: inst?.build ?? null, latest: latest.build, channel: branch };
}

// ------------------------------------------------------------------ the adapter

/** The PanelAdapter a manifest describes; `hooks` add what it can't say. */
export function manifestPanelAdapter(m: SteamGameManifest, hooks: ManifestPanelHooks = {}): PanelAdapter<ManifestSettings> {
  const stdin = m.console.kind === 'stdin';
  const broadcast = stdin && m.broadcast !== undefined ? m.broadcast : null;
  const players = moderation(m);
  const catalog: CommandDoc[] = m.console.kind === 'stdin' ? (m.console.commands ?? []).map((c) => ({ name: c.name, syntax: c.syntax, description: c.description, ...(c.permission ? { permission: c.permission } : {}), ...(c.secretArgs !== undefined ? { secretArgs: c.secretArgs } : {}) })) : [];
  const schema = launchSchema(m);
  const adapter: PanelAdapter<ManifestSettings> = {
    meta: manifestMeta(m),
    launch: {
      schema,
      ...(m.secrets?.length ? { secrets: m.secrets.map((s) => ({ key: s.id, label: s.label })) } : {}),
      defaults: () => settingDefaults(m),
      toAgent(srv, s, secrets, o = {}) {
        const v = checkSettings(m, s);
        const generated: Record<string, string> = {};
        for (const x of m.secrets ?? []) {
          const value = secrets[x.id];
          if (!value) throw new Error(`The secret ${x.id} is not set`);
          generated[x.id] = value;
        }
        // The start follows an install the panel just ran: no update before it.
        return parseLaunch(m, { ...v, ...(o.afterInstall ? { updateOnStart: false } : {}), ...generated, name: srv.gameName });
      },
    },
    config: {
      files: (srv) => configFiles(m, srv),
      roots: (srv) => editableRoots(m, srv),
      schemas: {},
      managedValues: (srv) => managedValues(m, srv),
    },
    backups: { parts: m.backups.parts.map((p) => ({ id: p.id, label: p.label, paths: (srv: ServerRef) => p.paths.map((x) => named(x, srv)) })) },
    resets: (m.resets ?? []).map((r) => ({ id: r.id, label: r.label, permission: r.permission, removeParts: [...r.removeParts] })),
    messages: {
      announce: (kind, secondsLeft, lang) => (broadcast ? announce(kind, secondsLeft, lang) : null),
      ...(broadcast ? { broadcast: (text: string) => ({ command: fill(broadcast, () => messageArg(text)), via: 'stdin' as const }) } : {}),
    },
    ...(players ? { players } : {}),
    updates: { check: (ctx, launch) => checkUpdate(m, ctx, launch) },
    ...(catalog.length ? { consoleCatalog: catalog } : {}),
  };
  return hooks.panel ? hooks.panel(adapter) : adapter;
}
