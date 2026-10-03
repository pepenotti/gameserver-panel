/**
 * Loading a manifest (D4): `manifest.schema.json` first, then what a schema
 * can't say: ids that must exist and be unique, ports that follow one
 * another, defaults that fit their settings, placeholders allowed where
 * they are used, commands only for a game with a console. A manifest that
 * fails any of it is refused with every problem found, never half-used.
 */
import { PERMISSIONS, redirectProblem } from '@gsp/shared';
import schemaJson from '../../manifest.schema.json';
import { checkSchema, compiles, type JsonSchema } from './schema';
import { RESERVED_KEYS } from './settings';
import { fill, placeholders, safeRelative, type PlaceholderKind } from './templates';
import type { Condition, ManifestJoinSetting, ManifestSetting, SteamGameManifest, Template } from './types';

/** The manifest schema (draft 2020-12). */
export const MANIFEST_SCHEMA = schemaJson as JsonSchema;

/** A manifest that can't be used, with every problem found. */
export class ManifestError extends Error {
  constructor(
    readonly manifestId: string,
    readonly problems: string[],
  ) {
    super(`Manifest ${manifestId} is invalid:\n- ${problems.join('\n- ')}`);
  }
}

/** Formats whose files are keys and values: the only ones managed and secret keys can name. */
const KEYED = new Set(['ini', 'properties', 'json', 'json5', 'yaml', 'toml']);
/** An environment variable name, in the case the game reads it (Steam reads `SteamAppId`). */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function duplicates(values: readonly string[]): string[] {
  return [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
}

/** Everything wrong with a manifest that passed the schema. */
export function manifestProblems(m: SteamGameManifest): string[] {
  const out: string[] = [];
  const problem = (where: string, what: string) => out.push(`${where} ${what}`);
  const ports = new Map(m.ports.map((p) => [p.id, p]));
  const settings = new Map(m.settings.map((s) => [s.id, s]));
  const secrets = new Set((m.secrets ?? []).map((s) => s.id));
  const stdin = m.console.kind === 'stdin';
  const prefix = m.console.kind === 'stdin' ? (m.console.prefix ?? '') : '';
  const files = new Map((m.config?.files ?? []).map((f) => [f.id, f]));
  const parts = new Set(m.backups.parts.map((p) => p.id));

  const unique = (where: string, ids: string[]) => {
    for (const d of duplicates(ids)) problem(where, `has ${d} twice`);
  };
  unique('ports', m.ports.map((p) => p.id));
  unique('settings and secrets', [...m.settings.map((s) => s.id), ...(m.secrets ?? []).map((s) => s.id)]);
  unique('backups.parts', [...parts]);
  unique('resets', (m.resets ?? []).map((r) => r.id));
  unique('config.files', (m.config?.files ?? []).map((f) => f.id));
  unique('config.roots', (m.config?.roots ?? []).map((r) => r.id));
  unique('readiness.warnings', (m.readiness.warnings ?? []).map((w) => w.id));
  unique('log.progress', (m.log?.progress ?? []).map((p) => p.key));
  unique('notes', (m.notes ?? []).map((n) => n.id));
  if (m.console.kind === 'stdin') unique('console.commands', (m.console.commands ?? []).map((c) => c.name));
  for (const id of [...settings.keys(), ...secrets]) if ((RESERVED_KEYS as readonly string[]).includes(id)) problem(`setting ${id}`, `takes a name every manifest game's launch has (${RESERVED_KEYS.join(', ')})`);
  if (m.memory.defaultMb < m.memory.minMb) problem('memory.defaultMb', 'is below memory.minMb');
  if (m.memory.defaultMb % 256 !== 0) problem('memory.defaultMb', 'must be a multiple of 256');

  // ------------------------------------------------------------ ports
  const inside = new Set<string>();
  m.ports.forEach((p, i) => {
    const key = `${p.default}/${p.proto}`;
    if (inside.has(key)) problem(`port ${p.id}`, `has the default ${key} of another port`);
    inside.add(key);
    if (!p.follows) return;
    const base = m.ports.slice(0, i).find((x) => x.id === p.follows!.id);
    if (!base) return problem(`port ${p.id}`, `follows ${p.follows.id}, which isn't a port declared before it`);
    if (base.follows) problem(`port ${p.id}`, `follows ${base.id}, which follows another port itself`);
    if (base.publish !== p.publish) problem(`port ${p.id}`, `must be published like ${base.id}`);
    if (p.default !== base.default + p.follows.offset) problem(`port ${p.id}`, `must default to ${base.id}'s default plus its offset (${base.default + p.follows.offset})`);
    if (p.follows.offset === 0 && p.proto === base.proto) problem(`port ${p.id}`, `follows ${base.id} at 0 on the same protocol: it would be the same port`);
  });

  // ------------------------------------------------------------ settings
  const condition = (where: string, c: Condition | undefined) => {
    if (!c) return;
    const s = settings.get(c.setting);
    if (!s) return problem(where, `names the setting ${c.setting}, which isn't declared`);
    if (c.equals !== undefined) {
      const want = s.type === 'integer' ? 'number' : s.type === 'boolean' ? 'boolean' : 'string';
      if (typeof c.equals !== want) problem(where, `compares ${c.setting} with a ${typeof c.equals}, not a ${want}`);
    }
  };
  const settingProblems = (s: ManifestSetting) => {
    const where = `setting ${s.id}`;
    const only = (fields: (keyof ManifestSetting)[], types: string[]) => {
      for (const f of fields) if (s[f] !== undefined && !types.includes(s.type)) problem(where, `has ${f}, which only ${types.join(' and ')} settings take`);
    };
    only(['min', 'max', 'step', 'unit'], ['integer']);
    only(['minLength', 'maxLength', 'pattern'], ['string', 'secret']);
    only(['choices'], ['enum']);
    only(['onValue', 'offValue'], ['boolean']);
    if (s.type === 'enum' && !s.choices?.length) problem(where, 'is a choice without choices');
    if (s.type !== 'secret' && s.default === undefined) problem(where, 'needs a default');
    if (s.type === 'secret' && s.default !== undefined) problem(where, 'is a secret: its default is always empty');
    const d = s.default;
    if (d !== undefined) {
      const want = s.type === 'integer' ? 'number' : s.type === 'boolean' ? 'boolean' : 'string';
      if (typeof d !== want) problem(where, `has a default that is a ${typeof d}, not a ${want}`);
      else if (s.type === 'integer' && ((s.min !== undefined && (d as number) < s.min) || (s.max !== undefined && (d as number) > s.max))) problem(where, 'has a default outside its range');
      else if (s.type === 'integer' && s.step !== undefined && ((d as number) - (s.min ?? 0)) % s.step !== 0) problem(where, 'has a default off its steps');
      else if (s.type === 'enum' && !s.choices?.some((c) => c.value === d)) problem(where, 'has a default that is none of its choices');
      else if (s.type === 'string' && s.minLength !== undefined && [...(d as string)].length < s.minLength) problem(where, 'has a default shorter than its least length');
      else if (s.type === 'string' && s.pattern !== undefined && compiles(s.pattern) && !new RegExp(s.pattern).test(d as string)) problem(where, 'has a default its pattern refuses');
      else if (typeof d === 'string' && /[\r\n\0]/.test(d)) problem(where, 'has a default of more than one line');
    }
    if (s.min !== undefined && s.max !== undefined && s.min > s.max) problem(where, 'has min above max');
    if (s.minLength !== undefined && s.maxLength !== undefined && s.minLength > s.maxLength) problem(where, 'has minLength above maxLength');
    if (s.choices) unique(`${where} choices`, s.choices.map((c) => c.value));
    for (const [i, r] of (s.rules ?? []).entries()) {
      const rw = `${where} rule ${i + 1}`;
      condition(rw, r.if);
      if (r.minLength === undefined && !r.required && r.notIn === undefined) problem(rw, 'checks nothing');
      if ((r.minLength !== undefined || r.notIn !== undefined) && s.type !== 'string' && s.type !== 'secret') problem(rw, 'checks the length of a setting that is no text');
      if (r.notIn !== undefined && settings.get(r.notIn)?.type !== 'string') problem(rw, `names ${r.notIn}, which isn't a text setting`);
    }
  };
  m.settings.forEach(settingProblems);

  // ------------------------------------------------------------ templates
  const ALL: PlaceholderKind[] = ['installDir', 'dataDir', 'name', 'port', 'setting', 'secret'];
  const template = (where: string, t: Template, allowed: readonly PlaceholderKind[]) => {
    let found;
    try {
      found = placeholders(t);
    } catch (e) {
      return problem(where, (e as Error).message);
    }
    for (const p of found) {
      if (!allowed.includes(p.kind)) problem(where, `can't use {${p.kind}${p.id ? `:${p.id}` : ''}} here`);
      else if (p.kind === 'port' && !ports.has(p.id!)) problem(where, `names the port ${p.id}, which isn't declared`);
      else if (p.kind === 'setting' && !settings.has(p.id!) && p.id !== 'memoryMb' && p.id !== 'branch') problem(where, `names the setting ${p.id}, which isn't declared`);
      else if (p.kind === 'secret' && !secrets.has(p.id!)) problem(where, `names the secret ${p.id}, which isn't declared`);
    }
    if (/[\r\n\0]/.test(t)) problem(where, 'holds a line break');
  };
  /** A data-root path: `{name}` only, and relative once filled in. */
  const dataPath = (where: string, t: Template) => {
    template(where, t, ['name']);
    try {
      if (!safeRelative(fill(t, () => 'server'))) problem(where, 'must be a path inside the data folder');
    } catch {
      // The template's own problem is reported already.
    }
  };
  /** A console line: one command, no placeholders, behind the console's prefix. */
  const consoleLine = (where: string, line: string, o: { arg?: boolean } = {}) => {
    if (!stdin) problem(where, 'needs a console on stdin');
    template(where, line, o.arg ? ['arg'] : []);
    if (o.arg) {
      let n = 0;
      try {
        n = placeholders(line).filter((p) => p.kind === 'arg').length;
      } catch {
        // Reported already.
      }
      if (n !== 1) problem(where, 'must hold {arg} once');
    }
    if (prefix && !line.startsWith(prefix)) problem(where, `must start with the console's prefix ${prefix}`);
  };

  template('launch.executable', m.launch.executable, ALL);
  template('launch.cwd', m.launch.cwd, ALL);
  m.launch.args.forEach((a, i) => {
    if (typeof a === 'string') return template(`launch.args[${i}]`, a, ALL);
    condition(`launch.args[${i}].if`, a.if);
    a.args.forEach((x, j) => template(`launch.args[${i}].args[${j}]`, x, ALL));
  });
  for (const [k, v] of Object.entries(m.launch.env ?? {})) {
    if (!ENV_KEY.test(k)) problem(`launch.env.${k}`, 'is not an environment variable name');
    template(`launch.env.${k}`, v, ALL);
  }
  (m.prepare?.dirs ?? []).forEach((d, i) => dataPath(`prepare.dirs[${i}]`, d));
  for (const p of m.backups.parts) p.paths.forEach((x, i) => dataPath(`backup part ${p.id} path ${i + 1}`, x));

  // ------------------------------------------------------------ control
  if (m.stop.command !== undefined) consoleLine('stop.command', m.stop.command);
  if (m.save) consoleLine('save.command', m.save.command);
  if (m.players?.list) consoleLine('players.list.command', m.players.list.command);
  if (m.broadcast !== undefined) consoleLine('broadcast', m.broadcast, { arg: true });
  if (m.backups.running === 'save-then-copy' && !m.save) problem('backups.running', 'is save-then-copy, but the game has no save command');
  if (m.backups.running === 'copy-between-saves' && !m.autosave) problem('backups.running', "is copy-between-saves, but the game's autosave lines aren't declared");
  if (m.console.kind === 'stdin') {
    for (const c of m.console.commands ?? []) if (c.permission && !Object.hasOwn(PERMISSIONS, c.permission)) problem(`console command ${c.name}`, `asks for an unknown permission ${c.permission}`);
  }

  // ------------------------------------------------------------ resets, config, players, moderation
  for (const r of m.resets ?? []) {
    if (!Object.hasOwn(PERMISSIONS, r.permission)) problem(`reset ${r.id}`, `asks for an unknown permission ${r.permission}`);
    for (const p of r.removeParts) if (!parts.has(p)) problem(`reset ${r.id}`, `removes ${p}, which isn't a backup part`);
  }
  const paths: string[] = [];
  for (const f of m.config?.files ?? []) {
    const where = `config file ${f.id}`;
    dataPath(where, f.path);
    try {
      paths.push(fill(f.path, () => 'server'));
    } catch {
      // Reported already.
    }
    const keyed = KEYED.has(f.format);
    if (f.managed && !keyed) problem(where, `is ${f.format}: it has no keys to manage`);
    if (f.secretKeys?.length && !keyed) problem(where, `is ${f.format}: it has no keys to hide`);
    if (Array.isArray(f.restartKeys) && !keyed) problem(where, `is ${f.format}: its restart keys must be "*"`);
    if (f.stoppedOnly && f.restartKeys !== '*') problem(where, 'is edited only while stopped, so every key takes effect at the next start: restartKeys must be "*"');
    for (const [k, v] of Object.entries(f.managed ?? {})) {
      if (/[\r\n\0=]/.test(k) || k.trim() !== k || k === '') problem(`${where} managed key ${JSON.stringify(k)}`, 'is not a key');
      template(`${where} managed ${k}`, v, ALL);
    }
    if (f.seed !== undefined) {
      try {
        for (const p of placeholders(f.seed)) if (p.kind === 'arg' || (p.kind === 'port' && !ports.has(p.id!)) || (p.kind === 'setting' && !settings.has(p.id!)) || (p.kind === 'secret' && !secrets.has(p.id!))) problem(`${where} seed`, `can't use {${p.kind}${p.id ? `:${p.id}` : ''}}`);
      } catch (e) {
        problem(`${where} seed`, (e as Error).message);
      }
    }
  }
  unique('config file paths', paths);
  for (const r of m.config?.roots ?? []) {
    dataPath(`config root ${r.id}`, r.path);
    for (const g of [...r.include, ...(r.exclude ?? [])]) if (g.startsWith('/') || g.split('/').includes('..')) problem(`config root ${r.id}`, `has a glob outside its folder: ${g}`);
  }
  const pl = m.players;
  if (pl) {
    if (!!pl.join !== !!pl.leave) problem('players', 'needs both join and leave lines, or neither');
    if (pl.steamQuery) {
      if (!ports.has(pl.steamQuery.port)) problem('players.steamQuery.port', `names the port ${pl.steamQuery.port}, which isn't declared`);
      condition('players.steamQuery.when', pl.steamQuery.when);
    }
  }
  const mod = m.moderation;
  if (mod) {
    if (mod.kick !== undefined) consoleLine('moderation.kick', mod.kick, { arg: true });
    if (mod.ban !== undefined) consoleLine('moderation.ban', mod.ban, { arg: true });
    if (mod.unban !== undefined) consoleLine('moderation.unban', mod.unban, { arg: true });
    if (!!mod.ban !== !!mod.unban) problem('moderation', 'needs both ban and unban, or neither');
    if (mod.ban && mod.listFiles?.ban) problem('moderation', 'bans either on the console or in a list file, not both');
    if (mod.ban && !mod.banTargets) problem('moderation.banTargets', 'must say what a ban on the console names');
    const lf = mod.listFiles;
    if (lf) {
      for (const k of ['ban', 'allow', 'admin'] as const) {
        const id = lf[k];
        if (id === undefined) continue;
        const f = files.get(id);
        if (!f) problem(`moderation.listFiles.${k}`, `names the config file ${id}, which isn't declared`);
        else if (f.format !== 'lines') problem(`moderation.listFiles.${k}`, `names ${id}, which isn't a list (format "lines")`);
      }
      if (lf.ban && mod.banTargets && (mod.banTargets.length !== 1 || mod.banTargets[0] !== lf.target)) problem('moderation.banTargets', `must be [${lf.target}]: what the ban list holds`);
    }
    if (mod.banTargets && !mod.ban && !lf?.ban) problem('moderation.banTargets', 'are given without a way to ban');
  }

  // ------------------------------------------------------------ shared installs (HST-09, D12)
  const inst = m.install;
  if (inst) {
    if (!inst.shared && inst.redirects?.length) problem('install.redirects', 'are for a shared install only');
    for (const [i, r] of (inst.redirects ?? []).entries()) {
      const why = redirectProblem(r);
      if (why) problem(`install.redirects[${i}]`, why);
    }
    unique('install.redirects', (inst.redirects ?? []).map((r) => r.path));
  }

  // ------------------------------------------------------------ joining (SRV-08)
  const j = m.join;
  if (j) {
    const port = ports.get(j.port);
    if (!port) problem('join.port', `names the port ${j.port}, which isn't declared`);
    else if (!port.publish || port.follows) problem('join.port', `names ${j.port}, which players can't be given (published, following no other)`);
    if (j.defaultPort !== undefined && j.format !== 'host:port') problem('join.defaultPort', 'is for the host:port format only');
    const reads = (where: string, s: ManifestJoinSetting, secret: boolean) => {
      if ('setting' in s) {
        const x = settings.get(s.setting);
        if (!x) problem(where, `names the setting ${s.setting}, which isn't declared`);
        else if (secret && x.type !== 'secret') problem(where, `names ${s.setting}, which isn't a secret setting`);
      } else {
        const f = files.get(s.file);
        if (!f) problem(where, `names the config file ${s.file}, which isn't declared`);
        else if (secret && !(f.secretKeys ?? []).includes(s.key)) problem(where, `names ${s.file} ${s.key}, which isn't one of its secret keys`);
      }
    };
    if (j.password) reads('join.password', j.password, true);
    unique('join.steps', (j.steps ?? []).map((s) => s.id));
    for (const s of j.steps ?? []) {
      if (!s.when) continue;
      reads(`join step ${s.id}`, s.when, false);
      if ('setting' in s.when) condition(`join step ${s.id}`, { setting: s.when.setting, equals: s.when.equals });
    }
  }
  return out;
}

function deepFreeze<T>(x: T): T {
  if (typeof x === 'object' && x !== null) {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}

/** A manifest from its JSON, checked (the schema, then `manifestProblems`); a frozen copy. Throws `ManifestError`. */
export function loadManifest(json: unknown): SteamGameManifest {
  const id = typeof json === 'object' && json !== null && typeof (json as { id?: unknown }).id === 'string' ? (json as { id: string }).id : '(no id)';
  const issues = checkSchema(MANIFEST_SCHEMA, json).map((i) => `${i.path || '(the manifest)'} ${i.message}`);
  if (issues.length) throw new ManifestError(id, issues);
  const m = structuredClone(json) as SteamGameManifest;
  const problems = manifestProblems(m);
  if (problems.length) throw new ManifestError(id, problems);
  return deepFreeze(m);
}
