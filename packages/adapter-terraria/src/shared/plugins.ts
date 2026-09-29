/**
 * TShock's plugins (MOD-06), for both halves: where they live, what a
 * plugin file and a release link must be, and the runtime's action names.
 *
 * Measured on TShock 6.2.1 (docs/verification/terraria-1.4.5.8.md, "Mods
 * and plugins"): TShock loads `ServerPlugins/*.dll` next to `TShock.Server`
 * (the install folder), at start only, and ignores a broken `.dll` without a
 * word. An update replaces the install folder, so the plugins are kept in
 * the data folder and copied into `ServerPlugins` before every start:
 *   - `tshock/plugins/<name>.dll`: enabled, copied at the next start;
 *   - `tshock/plugins/disabled/<name>.dll`: disabled, kept, not copied;
 *   - `ServerPlugins/.gsp-plugins.json`: what the agent copied there at the
 *     last start (so it removes only its own, never TShock's `TShockAPI.dll`,
 *     and can tell which plugin files the server runs with).
 * Release links are GitHub release assets, downloaded by the server's agent
 * (D11) over HTTPS, following redirects only to GitHub's asset host.
 */
import type { PluginRefusal } from '@gsp/adapter-api';

export const PLUGINS = {
  /** Enabled plugins (data root). */
  enabled: 'tshock/plugins',
  /** Disabled plugins (data root), inside the enabled folder so a backup part covers both. */
  disabled: 'tshock/plugins/disabled',
  /** Where the panel writes an upload before the agent takes it (data root; no backup or editable folder covers it). */
  uploads: '.gsp-uploads/plugins',
  /** Where TShock loads plugins from, in its install folder. */
  serverPlugins: 'ServerPlugins',
  /** The agent's record of the plugins it copied into `ServerPlugins`. */
  record: '.gsp-plugins.json',
} as const;

/** A plugin file's ending. */
export const PLUGIN_EXTENSION = '.dll';

/**
 * Largest upload or download: the agent's file API takes 16 MiB per write
 * (`FS_WRITE_MAX_BYTES`), which an upload goes through. TShock's own plugin
 * (`TShockAPI.dll`) and the plugins seen are well under a megabyte.
 */
export const PLUGIN_MAX_BYTES = 16 * 1024 * 1024;
/** What a zip of plugins may unpack to, and hold. */
export const PLUGIN_ZIP_LIMITS = { bytes: 64 * 1024 * 1024, entries: 1000 } as const;
/** Plugin files one add may bring. */
export const PLUGIN_MAX_FILES = 64;

/** A plugin file name the server takes: plain characters, `.dll` in any case. */
export const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,95}\.dll$/i;
/** What the panel names an upload it hands the agent. */
export const UPLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(?:dll|zip)$/i;

export const isPluginName = (name: string): boolean => typeof name === 'string' && PLUGIN_NAME.test(name) && !name.includes('..');

/** The runtime's actions (`POST /v1/actions/<name>`); each answers a `PluginReply`. */
export const PLUGIN_ACTIONS = {
  list: 'tshock-plugins',
  add: 'tshock-plugin-add',
  set: 'tshock-plugin-set',
  remove: 'tshock-plugin-remove',
} as const;

// ------------------------------------------------------------------ release links

/**
 * Where release links point: github.com's release downloads, which answer
 * with a redirect to GitHub's asset host (measured for TShock's own release:
 * a 302 to `release-assets.githubusercontent.com`). Tests and the dev loop
 * point `env` at the fake download services, over plain HTTP.
 */
export const RELEASES = {
  env: 'GAME_TERRARIA_RELEASES_URL',
  url: 'https://github.com',
  /** The hosts github.com sends a release asset's download on to (measured). */
  assetHosts: ['release-assets.githubusercontent.com'],
} as const;

type Env = Readonly<Record<string, string | undefined>>;

const override = (env: Env): URL | null => {
  const v = env[RELEASES.env];
  if (v === undefined || v === '') return null;
  try {
    return new URL(v);
  } catch {
    return null;
  }
};

/** `/<owner>/<repo>/releases/download/<tag>/<file>` or `/<owner>/<repo>/releases/latest/download/<file>`. */
const ASSET_PATH = /^\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\/releases\/(?:download\/[^/]{1,200}|latest\/download)\/([^/]{1,200})$/;

/** The file name a release link downloads (its last path segment), or null. */
export function linkFileName(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = ASSET_PATH.exec(u.pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/**
 * Why the agent won't download a plugin from `url`; null when it will: an
 * HTTPS link to a GitHub release asset (`env` may point the release host
 * elsewhere), of a plugin file or a zip.
 */
export function pluginLinkRefusal(url: string, env: Env): PluginRefusal | null {
  if (typeof url !== 'string' || url.length > 2000) return 'link-invalid';
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return 'link-invalid';
  }
  const base = override(env);
  if (base) {
    if (u.origin !== base.origin) return u.protocol !== 'https:' && u.protocol !== 'http:' ? 'link-not-https' : 'link-host';
  } else {
    if (u.protocol !== 'https:') return 'link-not-https';
    if (u.hostname !== new URL(RELEASES.url).hostname || u.port !== '') return 'link-host';
  }
  if (u.username || u.password) return 'link-host';
  const name = linkFileName(u.href);
  if (name === null) return 'link-not-asset';
  const lower = name.toLowerCase();
  if (!lower.endsWith(PLUGIN_EXTENSION) && !lower.endsWith('.zip')) return 'not-a-plugin';
  if (!UPLOAD_NAME.test(name)) return 'bad-name';
  return null;
}

/**
 * Where a plugin download may go, the link and each redirect: github.com's
 * release downloads (a `latest` link redirects there first), then GitHub's
 * asset hosts, over HTTPS; or only the release host `env` names.
 */
export function pluginDownloadAllowed(env: Env): (u: URL) => boolean {
  const base = override(env);
  return (u) => {
    if (u.username || u.password) return false;
    if (base) return u.origin === base.origin;
    if (u.protocol !== 'https:' || u.port !== '') return false;
    if (u.hostname === new URL(RELEASES.url).hostname) return ASSET_PATH.test(u.pathname);
    return (RELEASES.assetHosts as readonly string[]).includes(u.hostname);
  };
}
