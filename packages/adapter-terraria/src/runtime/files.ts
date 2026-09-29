/**
 * The files the agent owns in the data root, written before every start
 * (`prepare`, CFG-04): `serverconfig.txt`'s managed keys for every flavour
 * (the game only reads it); for TShock, its REST API with the agent's token
 * in `tshock/config.json` (CON-04) and `setup.lock`, so no setup code is ever
 * needed; for tModLoader, its mod list and Workshop folder.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeCtx } from '@gsp/adapter-api';
import { DATA, REST_TOKEN_USER, type MANAGED_SERVERCONFIG } from '../shared/install';
import type { TerrariaLaunch } from '../shared/launch';
import { TERRARIA_META } from '../shared/meta';

export function port(ctx: RuntimeCtx, id: 'game' | 'rest'): number {
  return ctx.ports[id] ?? TERRARIA_META.ports.find((p) => p.id === id)!.default;
}

/** Absolute paths of the data folder's files. */
export function dataPath(ctx: RuntimeCtx, rel: string): string {
  return path.join(ctx.roots.data, ...rel.split('/'));
}

/** The world file the server loads, or creates on its first start. */
export const worldFile = (ctx: RuntimeCtx, p: TerrariaLaunch) => path.join(dataPath(ctx, DATA.worlds), `${p.world}.wld`);

/** The values of `MANAGED_SERVERCONFIG` for this server (the launch flags say the same; flags win). */
export function managedServerConfig(ctx: RuntimeCtx, p: TerrariaLaunch): Record<(typeof MANAGED_SERVERCONFIG)[number], string> {
  return {
    port: String(port(ctx, 'game')),
    world: worldFile(ctx, p),
    worldpath: dataPath(ctx, DATA.worlds),
    autocreate: String(p.worldSize),
    banlist: dataPath(ctx, DATA.banlist),
    // Any other language translates the console, and nothing could read it.
    language: 'en-US',
    // Nothing opens router ports (§4).
    upnp: '0',
  };
}

/** Writes through a temporary file, only when the text changes. */
function writeIfChanged(file: string, before: string | null, after: string): void {
  if (after === before) return;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.gsp-tmp`, after);
  renameSync(`${file}.gsp-tmp`, file);
}

/**
 * Sets `key=value` lines of `serverconfig.txt` (the game reads `key=value`,
 * `#` comments, keys in any case): every line of a key is replaced, missing
 * keys are appended; comments and other keys stay as they are.
 */
export function setServerConfig(text: string, values: Record<string, string>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-z]+$/.test(key) || /[\r\n\0]/.test(value)) throw new Error(`Refusing a serverconfig.txt value for ${key}`);
    const re = new RegExp(`^\\s*${key}\\s*=`, 'i');
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        lines[i] = `${key}=${value}`;
        found = true;
      }
    }
    if (!found) lines.push(`${key}=${value}`);
  }
  return lines.length ? `${lines.join(eol)}${eol}` : '';
}

const SERVERCONFIG_HEADER = [
  '# Terraria dedicated server settings, read at every start.',
  '# The panel sets the port, the world, its folder, the ban list, the language and UPnP itself:',
  '# changes to those keys are put back before the next start.',
  '',
].join('\n');

/** TShock's `config.json` with the REST API on the agent's port and the agent's token; null when nothing needs to change. */
export function tshockConfig(text: string | null, ctx: RuntimeCtx): string | null {
  let doc: Record<string, unknown> = {};
  if (text !== null && text.trim() !== '') {
    try {
      doc = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`${DATA.tshockConfig} is not valid JSON (${(e as Error).message}); fix it in the file editor`, { cause: e });
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new Error(`${DATA.tshockConfig} must hold a JSON object`);
  }
  const settings = typeof doc.Settings === 'object' && doc.Settings !== null && !Array.isArray(doc.Settings) ? (doc.Settings as Record<string, unknown>) : {};
  const tokens = typeof settings.ApplicationRestTokens === 'object' && settings.ApplicationRestTokens !== null && !Array.isArray(settings.ApplicationRestTokens) ? (settings.ApplicationRestTokens as Record<string, unknown>) : {};
  const secret = ctx.state.controlSecret;
  const mine = { Username: REST_TOKEN_USER, UserGroupName: 'superadmin' };
  // The owner's own tokens stay; an old one of the agent's (a secret that changed) goes.
  const stale = Object.keys(tokens).filter((k) => k !== secret && (tokens[k] as { Username?: unknown } | null)?.Username === REST_TOKEN_USER);
  const current = tokens[secret] as { Username?: unknown; UserGroupName?: unknown } | undefined;
  const ok = settings.RestApiEnabled === true && settings.RestApiPort === port(ctx, 'rest') && stale.length === 0 && current?.Username === mine.Username && current?.UserGroupName === mine.UserGroupName;
  if (ok && text !== null) return null;
  const nextTokens = Object.fromEntries(Object.entries(tokens).filter(([k]) => !stale.includes(k) && k !== secret));
  nextTokens[secret] = mine;
  const next = { ...doc, Settings: { ...settings, RestApiEnabled: true, RestApiPort: port(ctx, 'rest'), ApplicationRestTokens: nextTokens } };
  // As TShock writes it: two spaces, no final newline.
  return JSON.stringify(next, null, 2);
}

/**
 * Before every start: the data folders, `serverconfig.txt`'s managed keys
 * (and the launch's password, never on the command line), and each
 * flavour's own files.
 */
export async function prepare(ctx: RuntimeCtx, p: TerrariaLaunch): Promise<void> {
  mkdirSync(dataPath(ctx, DATA.worlds), { recursive: true });

  const cfgFile = dataPath(ctx, DATA.serverConfig);
  const before = existsSync(cfgFile) ? readFileSync(cfgFile, 'utf8') : null;
  const values: Record<string, string> = { ...managedServerConfig(ctx, p) };
  if (p.password !== null) values.password = p.password;
  writeIfChanged(cfgFile, before, setServerConfig(before ?? SERVERCONFIG_HEADER, values));

  if (p.flavour === 'tshock') {
    const file = dataPath(ctx, DATA.tshockConfig);
    const next = tshockConfig(existsSync(file) ? readFileSync(file, 'utf8') : null, ctx);
    if (next !== null) writeIfChanged(file, null, next);
    const lock = dataPath(ctx, DATA.tshockSetupLock);
    if (!existsSync(lock)) writeIfChanged(lock, null, '');
  }

  if (p.flavour === 'tmodloader') {
    const enabled = dataPath(ctx, DATA.tmlEnabled);
    if (!existsSync(enabled)) writeIfChanged(enabled, null, '[]');
    mkdirSync(dataPath(ctx, DATA.workshop), { recursive: true });
  }
}
