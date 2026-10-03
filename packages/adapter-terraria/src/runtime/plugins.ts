/**
 * TShock's plugins next to the files (MOD-06): the runtime's actions that
 * list, add, enable, disable and remove them in the data folder, and the
 * step before every start (`syncServerPlugins`) that records which plugin
 * files the server starts with. TShock loads the enabled ones from the data
 * folder itself (`-additionalplugins`, not its subfolders, so the disabled
 * ones stay unloaded): nothing is copied into its install, which may be a
 * shared one, read-only (HST-09; measured on TShock 6.2.1,
 * docs/verification/shared-installs.md). Layout and limits: `shared/plugins.ts`.
 *
 * An add takes an upload the panel wrote into the uploads folder, or
 * downloads a release link itself (D11), with every address checked
 * (`pluginDownloadAllowed`) and the size capped; a zip is unpacked with the
 * agent's extraction, which refuses the whole archive for an entry outside
 * its folder or a link. Only `.dll` files that start like a Windows/.NET
 * executable (`MZ`) are taken; the rest of a zip is left out and named.
 * Nothing is moved into place before everything checked out. A plugin runs
 * code inside the server: the panel lets only admins do this, after a
 * warning, and records who added what.
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, readSync, closeSync, type Stats } from 'node:fs';
import path from 'node:path';
import type { InstallCtx, PluginAdded, PluginFile, PluginRefusal, PluginReply, RuntimeAction, RuntimeCtx } from '@gsp/adapter-api';
import { isPluginName, linkFileName, PLUGIN_ACTIONS, PLUGIN_EXTENSION, PLUGIN_MAX_BYTES, PLUGIN_MAX_FILES, PLUGIN_ZIP_LIMITS, PLUGINS, pluginDownloadAllowed, pluginLinkRefusal, UPLOAD_NAME } from '../shared/plugins';
import { installedEntry } from './install';

/** Uploads older than this are leftovers (a panel that went away mid-add): removed before a start. */
const STALE_UPLOAD_MS = 60 * 60_000;

const fail = (reason: PluginRefusal, message: string): { ok: false; reason: PluginRefusal; message: string } => ({ ok: false, reason, message });
const data = (ctx: RuntimeCtx, rel: string) => path.join(ctx.roots.data, ...rel.split('/'));
const lower = (s: string) => s.toLowerCase();

function lstat(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** Hex SHA-256 of a file (plugins are small: at most `PLUGIN_MAX_BYTES`). */
function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Whether a file starts like a Windows/.NET executable (`MZ`), as every assembly does. */
function looksLikeAssembly(file: string): boolean {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(2);
    return readSync(fd, head, 0, 2, 0) === 2 && head.toString('latin1') === 'MZ';
  } finally {
    closeSync(fd);
  }
}

interface Found {
  name: string;
  file: string;
  st: Stats;
}

/** Plugin files directly in a folder: plain files ending `.dll`; links, folders and anything else skipped. */
function pluginFiles(dir: string): Found[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Found[] = [];
  for (const name of names.sort()) {
    if (!lower(name).endsWith(PLUGIN_EXTENSION)) continue;
    const file = path.join(dir, name);
    const st = lstat(file);
    if (st?.isFile()) out.push({ name, file, st });
  }
  return out;
}

// ------------------------------------------------------------------ the record, and ServerPlugins

interface PluginRecord {
  schema: 1;
  /** Plugin file name → SHA-256 of the file. */
  files: Record<string, string>;
}

/** The installed TShock's `ServerPlugins` folder (its own plugins); null when TShock isn't installed. */
function serverPluginsOf(ctx: RuntimeCtx): string | null {
  const e = installedEntry(ctx);
  return e && e.marker.flavour === 'tshock' ? path.join(e.folder, PLUGINS.serverPlugins) : null;
}

function readRecordFile(file: string | null): PluginRecord {
  if (file === null) return { schema: 1, files: {} };
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as Partial<PluginRecord>;
    const files = r && typeof r.files === 'object' && r.files !== null ? Object.fromEntries(Object.entries(r.files).filter(([k, v]) => isPluginName(k) && typeof v === 'string')) : {};
    return { schema: 1, files };
  } catch {
    return { schema: 1, files: {} };
  }
}

/** Which plugin files the server started with: the agent's record, in its own folder (`RuntimeCtx.stateDir`). */
const startRecordFile = (ctx: RuntimeCtx) => path.join(ctx.stateDir, PLUGINS.startRecord);

/** The record an agent from before shared installs left in `ServerPlugins`, of the plugins it copied there. */
const legacyRecordFile = (dir: string | null) => (dir === null ? null : path.join(dir, PLUGINS.record));

/** TShock's own plugins (`TShockAPI.dll`): what its install put in `ServerPlugins` (an older agent's copies aside), lower case. */
function ownNames(dir: string | null): Set<string> {
  if (dir === null) return new Set();
  const copies = new Set(Object.keys(readRecordFile(legacyRecordFile(dir)).files).map(lower));
  return new Set(pluginFiles(dir).map((f) => lower(f.name)).filter((n) => !copies.has(n)));
}

/**
 * The plugin copies an agent from before shared installs put in TShock's
 * `ServerPlugins` (named by its record there), and that record, removed: the
 * plugins now load from the data folder, and a copy left there would load
 * twice. Only a writable install is touched (a server's own, or an install
 * job's copy of one: `warmUp`); returns what it removed.
 */
export function removeLegacyPluginCopies(ctx: RuntimeCtx): string[] {
  const dir = serverPluginsOf(ctx);
  const record = legacyRecordFile(dir);
  if (dir === null || record === null || lstat(record) === null) return [];
  if (ctx.sharedInstall) {
    ctx.log(`TShock's install holds plugin copies of an older agent (${PLUGINS.serverPlugins}/${PLUGINS.record}), and it is shared, read-only: they load besides the data folder's.`);
    return [];
  }
  const removed: string[] = [];
  for (const name of Object.keys(readRecordFile(record).files)) {
    const target = path.join(dir, name);
    if (lstat(target)?.isFile()) {
      rmSync(target, { force: true });
      removed.push(name);
    }
  }
  rmSync(record, { force: true });
  if (removed.length) ctx.log(`Plugins load from the data folder now: removed the copies an older agent put in ${PLUGINS.serverPlugins} (${removed.join(', ')}).`);
  return removed;
}

/**
 * Before every start of a TShock server: an older agent's copies in its
 * install removed, and the record of the plugin files it starts with (from
 * the folder `-additionalplugins` names) written, so the panel can tell
 * which changes wait for a restart (MOD-06). Stale uploads go too. Nothing
 * is written into the install.
 */
export function syncServerPlugins(ctx: RuntimeCtx): void {
  removeStaleUploads(ctx);
  removeLegacyPluginCopies(ctx);
  const own = ownNames(serverPluginsOf(ctx));
  const next: PluginRecord = { schema: 1, files: {} };
  for (const f of pluginFiles(data(ctx, PLUGINS.enabled))) {
    if (own.has(lower(f.name))) ctx.log(`Plugin ${f.name} has the name of one of TShock's own: TShock may load only one of the two.`);
    next.files[f.name] = sha256Of(f.file);
  }
  const file = startRecordFile(ctx);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  const loaded = Object.keys(next.files);
  if (loaded.length) ctx.log(`Plugins TShock loads from the data folder: ${loaded.join(', ')}.`);
}

function removeStaleUploads(ctx: RuntimeCtx): void {
  const dir = data(ctx, PLUGINS.uploads);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const st = lstat(path.join(dir, name));
    if (st && Date.now() - st.mtimeMs > STALE_UPLOAD_MS) rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ list

/** Every plugin in the data folder, enabled or not, and whether the server runs with that very file. */
export function listPlugins(ctx: RuntimeCtx): PluginFile[] {
  const record = readRecordFile(startRecordFile(ctx));
  const one = (f: Found, enabled: boolean): PluginFile => {
    const sha256 = sha256Of(f.file);
    return { name: f.name, enabled, active: record.files[f.name] === sha256, size: f.st.size, sha256, mtimeMs: Math.round(f.st.mtimeMs) };
  };
  return [...pluginFiles(data(ctx, PLUGINS.enabled)).map((f) => one(f, true)), ...pluginFiles(data(ctx, PLUGINS.disabled)).map((f) => one(f, false))].sort((a, b) => lower(a.name).localeCompare(lower(b.name)));
}

/** The plugin of that name (whatever its case), where it is. */
function find(ctx: RuntimeCtx, name: string): (Found & { enabled: boolean }) | null {
  for (const [rel, enabled] of [
    [PLUGINS.enabled, true],
    [PLUGINS.disabled, false],
  ] as const) {
    const f = pluginFiles(data(ctx, rel)).find((x) => lower(x.name) === lower(name));
    if (f) return { ...f, enabled };
  }
  return null;
}

// ------------------------------------------------------------------ add

type AddInput = { upload: string; name: string } | { url: string };

/** Only TShock servers take plugins; an agent not told its flavour (tests) takes them. */
function notTshock(ctx: RuntimeCtx): boolean {
  const f = ctx.env.GAME_FLAVOUR;
  return f !== undefined && f !== '' && f !== 'tshock';
}

/** The plugin files an upload or download holds, checked; or why it isn't taken. */
async function unpack(ctx: InstallCtx, file: string, name: string, staging: string): Promise<PluginReply<{ plugins: Found[]; skipped: string[] }>> {
  const st = lstat(file);
  if (!st?.isFile()) return fail('not-a-plugin', `${name} is not a file`);
  if (st.size > PLUGIN_MAX_BYTES) return fail('too-large', `${name} is ${st.size} bytes, more than the ${PLUGIN_MAX_BYTES} allowed`);
  const lowerName = lower(name);
  let plugins: Found[];
  const skipped: string[] = [];
  if (lowerName.endsWith('.zip')) {
    if (!ctx.extract) throw new Error('This agent cannot unpack archives: InstallCtx.extract is missing');
    const out = path.join(staging, 'unzipped');
    try {
      await ctx.extract({ file, dest: out, format: 'zip', limits: PLUGIN_ZIP_LIMITS });
    } catch (e) {
      const code = (e as { code?: string }).code;
      return fail(code === 'extract-too-large' ? 'too-large' : 'bad-archive', `${name}: ${(e as Error).message}`);
    }
    plugins = [];
    const walk = (dir: string, rel: string) => {
      for (const entry of readdirSync(dir).sort()) {
        const full = path.join(dir, entry);
        const est = lstat(full);
        const r = rel ? `${rel}/${entry}` : entry;
        if (est?.isDirectory()) walk(full, r);
        else if (est?.isFile() && lower(entry).endsWith(PLUGIN_EXTENSION)) plugins.push({ name: entry, file: full, st: est });
        else skipped.push(r);
      }
    };
    walk(out, '');
    if (plugins.length === 0) return fail('no-plugins', `${name} holds no ${PLUGIN_EXTENSION} file`);
    if (plugins.length > PLUGIN_MAX_FILES) return fail('too-large', `${name} holds ${plugins.length} plugin files, more than the ${PLUGIN_MAX_FILES} one add may bring`);
    const seen = new Set<string>();
    for (const p of plugins) {
      if (seen.has(lower(p.name))) return fail('bad-archive', `${name} holds two plugin files named ${p.name}`);
      seen.add(lower(p.name));
    }
  } else if (lowerName.endsWith(PLUGIN_EXTENSION)) {
    plugins = [{ name, file, st }];
  } else {
    return fail('not-a-plugin', `${name} is neither a ${PLUGIN_EXTENSION} plugin nor a .zip of them`);
  }
  for (const p of plugins) {
    if (!isPluginName(p.name)) return fail('bad-name', `The server takes plugin file names of plain letters, digits, dots and dashes, not ${JSON.stringify(p.name.slice(0, 120))}`);
    if (!looksLikeAssembly(p.file)) return fail('not-a-plugin', `${p.name} is not a .NET assembly (it doesn't start like one)`);
  }
  return { ok: true, plugins, skipped };
}

/** Puts each plugin in place, replacing one of the same name where it is (enabled or not); new ones are enabled. */
function place(ctx: RuntimeCtx, plugins: Found[]): { added: PluginFile[]; replaced: string[] } {
  const replaced: string[] = [];
  const names: string[] = [];
  for (const p of plugins) {
    const existing = find(ctx, p.name);
    const dir = data(ctx, existing && !existing.enabled ? PLUGINS.disabled : PLUGINS.enabled);
    mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${p.name}.gsp-tmp`);
    copyFileSync(p.file, tmp);
    if (existing) {
      replaced.push(p.name);
      if (existing.name !== p.name) rmSync(existing.file, { force: true });
    }
    renameSync(tmp, path.join(dir, p.name));
    names.push(lower(p.name));
  }
  const all = listPlugins(ctx);
  return { added: all.filter((f) => names.includes(lower(f.name))), replaced };
}

export async function addPlugins(ctx: InstallCtx, input: AddInput): Promise<PluginReply<PluginAdded>> {
  if (notTshock(ctx)) return fail('not-supported', 'Only TShock servers take plugins');
  const uploads = data(ctx, PLUGINS.uploads);
  const staging = path.join(uploads, `.add-${randomUUID()}`);
  const upload = 'upload' in input ? path.join(uploads, input.upload) : null;
  try {
    mkdirSync(staging, { recursive: true });
    let file: string;
    let name: string;
    if ('url' in input) {
      const refusal = pluginLinkRefusal(input.url, ctx.env);
      if (refusal) return fail(refusal, `Not a link the server downloads plugins from: ${input.url.slice(0, 200)}`);
      name = linkFileName(input.url)!;
      file = path.join(staging, name);
      if (!ctx.download) throw new Error('This agent cannot download: InstallCtx.download is missing');
      try {
        await ctx.download({ url: input.url, dest: file, what: name, allowUrl: pluginDownloadAllowed(ctx.env), maxBytes: PLUGIN_MAX_BYTES });
      } catch (e) {
        const code = (e as { code?: string }).code;
        const reason: PluginRefusal = code === 'download-refused' ? 'redirect-refused' : code === 'download-too-large' ? 'too-large' : 'download-failed';
        return fail(reason, (e as Error).message);
      }
    } else {
      name = input.name;
      file = upload!;
    }
    const r = await unpack(ctx, file, name, staging);
    if (!r.ok) return r;
    const own = ownNames(serverPluginsOf(ctx));
    const taken = r.plugins.find((p) => own.has(lower(p.name)));
    if (taken) return fail('name-taken', `TShock's own install has a plugin named ${taken.name}`);
    const placed = place(ctx, r.plugins);
    ctx.log(`Plugins added (${name}): ${placed.added.map((f) => `${f.name} (${f.size} bytes, sha256 ${f.sha256})`).join(', ')}.`);
    return { ok: true, ...placed, skipped: r.skipped };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (upload) rmSync(upload, { force: true });
  }
}

// ------------------------------------------------------------------ enable, disable, remove

export function setPlugin(ctx: RuntimeCtx, name: string, enabled: boolean): PluginReply<{ changed: boolean }> {
  if (notTshock(ctx)) return fail('not-supported', 'Only TShock servers take plugins');
  const f = find(ctx, name);
  if (!f) return fail('not-found', `No plugin named ${name}`);
  if (f.enabled === enabled) return { ok: true, changed: false };
  const dir = data(ctx, enabled ? PLUGINS.enabled : PLUGINS.disabled);
  mkdirSync(dir, { recursive: true });
  renameSync(f.file, path.join(dir, f.name));
  return { ok: true, changed: true };
}

export function removePlugin(ctx: RuntimeCtx, name: string): PluginReply {
  if (notTshock(ctx)) return fail('not-supported', 'Only TShock servers take plugins');
  const f = find(ctx, name);
  if (!f) return fail('not-found', `No plugin named ${name}`);
  rmSync(f.file, { force: true });
  return { ok: true };
}

// ------------------------------------------------------------------ the actions

function asObject(x: unknown): Record<string, unknown> {
  if (x === undefined || x === null) return {};
  if (typeof x !== 'object' || Array.isArray(x)) throw new Error('Give an object');
  return x as Record<string, unknown>;
}

function pluginName(v: unknown): string {
  if (typeof v !== 'string' || !isPluginName(v)) throw new Error('name must be a plugin file name (letters, digits, dots and dashes, ending .dll)');
  return v;
}

/**
 * `tshock-plugins` → `{ ok, plugins }`; `tshock-plugin-add { upload, name }
 * | { url }` → `{ ok, added, replaced, skipped }`; `tshock-plugin-set { name,
 * enabled }` → `{ ok, changed }`; `tshock-plugin-remove { name }` → `{ ok }`.
 * Each answers a refusal (`{ ok: false, reason, message }`) rather than
 * failing. They change only the data folder: the server takes the change at
 * its next start.
 */
export const PLUGIN_RUNTIME_ACTIONS: Record<string, RuntimeAction> = {
  [PLUGIN_ACTIONS.list]: {
    parse: (x) => (asObject(x), {}),
    run: async (ctx): Promise<PluginReply<{ plugins: PluginFile[] }>> => (notTshock(ctx) ? fail('not-supported', 'Only TShock servers take plugins') : { ok: true, plugins: listPlugins(ctx) }),
  },
  [PLUGIN_ACTIONS.add]: {
    parse(x): AddInput {
      const o = asObject(x);
      if (typeof o.url === 'string') {
        if (o.url.length > 2000) throw new Error('url is too long');
        return { url: o.url };
      }
      if (typeof o.upload !== 'string' || !UPLOAD_NAME.test(o.upload)) throw new Error('upload must be the name of a file in the uploads folder');
      if (typeof o.name !== 'string' || o.name.length < 1 || o.name.length > 200 || /[\x00-\x1f\x7f/\\]/.test(o.name)) throw new Error('name must be a file name');
      return { upload: o.upload, name: o.name };
    },
    run: (ctx, _ctl, input) => addPlugins(ctx, input as AddInput),
  },
  [PLUGIN_ACTIONS.set]: {
    parse(x) {
      const o = asObject(x);
      if (typeof o.enabled !== 'boolean') throw new Error('enabled must be true or false');
      return { name: pluginName(o.name), enabled: o.enabled };
    },
    run: async (ctx, _ctl, input) => {
      const i = input as { name: string; enabled: boolean };
      return setPlugin(ctx, i.name, i.enabled);
    },
  },
  [PLUGIN_ACTIONS.remove]: {
    parse: (x) => ({ name: pluginName(asObject(x).name) }),
    run: async (ctx, _ctl, input) => removePlugin(ctx, (input as { name: string }).name),
  },
};
