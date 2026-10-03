/**
 * Installs per flavour, exactly as measured (UPD-01, UPD-02;
 * docs/verification/terraria-1.4.5.8.md, "Install and versions"):
 *   - vanilla: terraria.org's zip, checked against the size and SHA-256
 *     pinned here for every measured version (terraria.org publishes no
 *     checksum); only its `<id>/Linux/` folder is unpacked, and the binary
 *     made executable (the zip stores no modes);
 *   - TShock: the release's Linux x86-64 zip from GitHub, checked against the
 *     digest GitHub publishes; it holds one tar, which keeps the exec bits;
 *   - tModLoader: the release's `tModLoader.zip` from GitHub, checked the
 *     same way (Steam won't serve it anonymously).
 * Each install is one folder under the install root; a marker written last
 * says what is installed. Nothing moves a server to another version on its
 * own: only a pinned version, or the newest when none is pinned and nothing
 * is installed yet.
 */
import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { InstallCtx, InstalledInfo, InstallKey, JobResult, RuntimeCtx, VersionsResponse } from '@gsp/adapter-api';
import { DOWNLOAD_SOURCES, ENTRY, INSTALL_MARKER, REPOS, VANILLA_PINS, type InstallMarker, type TerrariaVersionInfo } from '../shared/install';
import { FLAVOURS, vanillaId, type TerrariaFlavour, type TerrariaLaunch } from '../shared/launch';
import { githubRelease, githubReleases, sourceUrls, tmlChannel, tmlTerraria, tmlVersions, tshockAsset, tshockTerraria, tshockVersions, vanillaVersions, type GithubRelease, type Get } from '../shared/versions';
import { cachedGet, checkUrl } from './sources';

/** Downloads and unpacking happen here, inside the install root, until they are checked. */
const STAGING = '.gsp-staging';

// ------------------------------------------------------------------- the marker

function isMarker(x: unknown): x is InstallMarker {
  const m = x as Partial<InstallMarker> | null;
  return (
    typeof m === 'object' &&
    m !== null &&
    m.schema === 1 &&
    typeof m.flavour === 'string' &&
    (FLAVOURS as readonly string[]).includes(m.flavour) &&
    typeof m.version === 'string' &&
    typeof m.folder === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m.folder)
  );
}

/** What the marker says is installed; null when there is no whole install. */
export function readMarker(ctx: RuntimeCtx): InstallMarker | null {
  try {
    const m: unknown = JSON.parse(readFileSync(path.join(ctx.roots.install, INSTALL_MARKER), 'utf8'));
    return isMarker(m) ? m : null;
  } catch {
    return null;
  }
}

/** The installed flavour's folder, and what it starts in it; null when nothing whole is installed. */
export function installedEntry(ctx: RuntimeCtx): { marker: InstallMarker; folder: string; entry: string } | null {
  const m = readMarker(ctx);
  if (!m) return null;
  const folder = path.join(ctx.roots.install, m.folder);
  const entry = path.join(folder, ENTRY[m.flavour]);
  return existsSync(entry) ? { marker: m, folder, entry } : null;
}

/**
 * `installed()`: `version` is the Terraria version (what players need),
 * `channel` the flavour, `build` TShock's or tModLoader's release tag. For
 * tModLoader the release says only the Terraria line (`1.4.4`); the version
 * the game printed when it last ran completes it.
 */
export function installedInfo(ctx: RuntimeCtx): InstalledInfo | null {
  const e = installedEntry(ctx);
  if (!e) return null;
  const m = e.marker;
  if (m.flavour === 'vanilla') return { version: m.version, channel: 'vanilla' };
  const printed = ctx.state.gameVersion;
  const version = m.flavour === 'tmodloader' && m.terraria && printed?.startsWith(`${m.terraria}.`) ? printed : m.terraria;
  return { version, channel: m.flavour, build: m.version };
}

/** `installKey()` (HST-09): the flavour and what was installed (vanilla's version, TShock's or tModLoader's release tag). */
export function installKey(ctx: RuntimeCtx): InstallKey | null {
  const e = installedEntry(ctx);
  return e ? { flavour: e.marker.flavour, version: e.marker.version, build: null, branch: null } : null;
}

/**
 * `installOnStart()`: required when nothing whole is installed, when it is
 * another flavour or another pinned version, or (tModLoader) a preview on a
 * server that takes stable releases only. Never 'update': a newer release
 * comes through the panel's update policy (UPD-03).
 */
export function installNeeded(ctx: RuntimeCtx, p: TerrariaLaunch): 'required' | null {
  const e = installedEntry(ctx);
  if (!e || e.marker.flavour !== p.flavour) return 'required';
  if (p.version !== null && e.marker.version !== p.version) return 'required';
  if (p.flavour === 'tmodloader' && p.channel === 'stable' && e.marker.channel !== 'stable') return 'required';
  return null;
}

// ------------------------------------------------------------------- what to install

interface Target {
  marker: Omit<InstallMarker, 'installedAt' | 'sha256' | 'verified'>;
  download: { url: string; name: string; size?: number; sha256?: string };
}

const describe = (flavour: TerrariaFlavour, version: string) => (flavour === 'vanilla' ? `Terraria ${version}` : flavour === 'tshock' ? `TShock ${version}` : `tModLoader ${version}`);

async function vanillaTarget(ctx: InstallCtx, get: Get, p: TerrariaLaunch): Promise<Target> {
  let version = p.version;
  if (version === null) {
    const { versions, unreachable } = await vanillaVersions(get, sourceUrls(ctx.env).terraria);
    if (unreachable) ctx.log(`Could not read terraria.org's version list (${unreachable}); taking the newest version known to this panel.`);
    version = versions[0]!.id;
  }
  const id = vanillaId(version);
  const base = sourceUrls(ctx.env).terraria;
  // The pins are terraria.org's files; a source the environment points elsewhere (tests, the dev loop) serves others.
  const fromTerrariaOrg = base === DOWNLOAD_SOURCES.terraria.url;
  const pin = fromTerrariaOrg ? VANILLA_PINS[id] : undefined;
  if (!pin) {
    ctx.log(
      fromTerrariaOrg
        ? `terraria.org publishes no checksum, and ${describe('vanilla', version)} was not measured: its download can only be checked for being a whole zip.`
        : `Downloading from ${base}, not terraria.org: the checksums pinned for terraria.org's files don't apply.`,
    );
  }
  return {
    marker: { schema: 1, flavour: 'vanilla', version, terraria: version, channel: null, folder: `vanilla-${id}` },
    download: { url: `${base}/api/download/pc-dedicated-server/terraria-server-${id}.zip`, name: `terraria-server-${id}.zip`, ...(pin ? { size: pin.size, sha256: pin.sha256 } : {}) },
  };
}

/** A release by tag, from the cached list when it is there. */
async function releaseByTag(get: Get, base: string, repo: string, tag: string): Promise<GithubRelease | null> {
  return (await githubReleases(get, base, repo)).find((r) => r.tag === tag) ?? (await githubRelease(get, base, repo, tag));
}

async function tshockTarget(ctx: InstallCtx, get: Get, p: TerrariaLaunch): Promise<Target> {
  const base = sourceUrls(ctx.env).github;
  let r: GithubRelease | null;
  if (p.version === null) {
    r = (await githubReleases(get, base, REPOS.tshock)).find((x) => !x.prerelease && tshockAsset(x) !== null) ?? null;
    if (!r) throw new Error('TShock has no release with a Linux x86-64 build');
  } else {
    r = await releaseByTag(get, base, REPOS.tshock, p.version);
    if (!r) throw new Error(`TShock has no release ${p.version}`);
  }
  const asset = tshockAsset(r);
  if (!asset) throw new Error(`TShock ${r.tag} has no Linux x86-64 build`);
  if (!asset.sha256) ctx.log(`GitHub publishes no digest for ${asset.name}: only its size is checked.`);
  return {
    marker: { schema: 1, flavour: 'tshock', version: r.tag, terraria: tshockTerraria(r.name), channel: r.prerelease ? 'prerelease' : 'stable', folder: `tshock-${r.tag}` },
    download: { url: checkUrl(ctx, asset.url, asset.name), name: asset.name, size: asset.size, ...(asset.sha256 ? { sha256: asset.sha256 } : {}) },
  };
}

async function tmlTarget(ctx: InstallCtx, get: Get, p: TerrariaLaunch): Promise<Target> {
  const base = sourceUrls(ctx.env).github;
  const takes = p.channel ?? 'stable';
  let r: GithubRelease | null;
  if (p.version === null) {
    const newest = tmlVersions(await githubReleases(get, base, REPOS.tmodloader)).find((v) => takes === 'preview' || v.channel === 'stable');
    r = newest ? await releaseByTag(get, base, REPOS.tmodloader, newest.id) : null;
    if (!r) throw new Error(`tModLoader has no ${takes} release`);
  } else {
    r = await releaseByTag(get, base, REPOS.tmodloader, p.version);
    if (!r) throw new Error(`tModLoader has no release ${p.version}`);
  }
  const channel = tmlChannel(r);
  if (!channel) throw new Error(`tModLoader ${r.tag} is neither a stable nor a preview release of this tModLoader`);
  if (channel === 'preview' && takes === 'stable') throw new Error(`tModLoader ${r.tag} is a preview, and this server takes stable releases only; choose the preview channel to install it`);
  const asset = r.assets.find((a) => a.name === 'tModLoader.zip')!;
  if (!asset.sha256) ctx.log('GitHub publishes no digest for tModLoader.zip: only its size is checked.');
  return {
    marker: { schema: 1, flavour: 'tmodloader', version: r.tag, terraria: tmlTerraria(r.name), channel, folder: `tmodloader-${r.tag}` },
    download: { url: checkUrl(ctx, asset.url, asset.name), name: asset.name, size: asset.size, ...(asset.sha256 ? { sha256: asset.sha256 } : {}) },
  };
}

function resolveTarget(ctx: InstallCtx, get: Get, p: TerrariaLaunch): Promise<Target> {
  ctx.progress(null, p.version === null ? `Looking up the newest ${p.flavour === 'vanilla' ? 'Terraria' : p.flavour === 'tshock' ? 'TShock' : 'tModLoader'}` : `Looking up ${describe(p.flavour, p.version)}`);
  if (p.flavour === 'vanilla') return vanillaTarget(ctx, get, p);
  if (p.flavour === 'tshock') return tshockTarget(ctx, get, p);
  return tmlTarget(ctx, get, p);
}

// ------------------------------------------------------------------- install

function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Unpacks the download into `dest` as the flavour's archive is laid out. */
async function unpack(ctx: InstallCtx, t: Target, file: string, staging: string, dest: string): Promise<void> {
  const extract = ctx.extract!;
  if (t.marker.flavour === 'vanilla') {
    const id = vanillaId(t.marker.version);
    // Windows and Mac builds sit next to Linux's: only `<id>/Linux/` is needed.
    const r = await extract({ file, dest, format: 'zip', only: `${id}/Linux`, strip: 2 });
    if (r.files === 0) throw new Error(`The download has no ${id}/Linux folder`);
    // The zip stores no modes: the binary (and its wrapper script) are made executable here.
    for (const f of ['TerrariaServer.bin.x86_64', 'TerrariaServer']) if (existsSync(path.join(dest, f))) chmodSync(path.join(dest, f), 0o755);
    return;
  }
  if (t.marker.flavour === 'tshock') {
    // The zip holds one tar, which keeps the exec bits.
    const zipOut = path.join(staging, 'zip');
    await extract({ file, dest: zipOut, format: 'zip' });
    const tars = readdirSync(zipOut).filter((f) => f.endsWith('.tar'));
    if (tars.length === 1) await extract({ file: path.join(zipOut, tars[0]!), dest, format: 'tar' });
    else if (existsSync(path.join(zipOut, ENTRY.tshock))) renameSync(zipOut, dest);
    else throw new Error(`TShock's download holds neither one tar nor ${ENTRY.tshock}`);
    if (existsSync(path.join(dest, ENTRY.tshock))) chmodSync(path.join(dest, ENTRY.tshock), 0o755);
    return;
  }
  await extract({ file, dest, format: 'zip' });
}

/** The same thing is installed: nothing to download. */
const same = (m: InstallMarker, t: Target['marker']) => m.flavour === t.flavour && m.version === t.version && m.folder === t.folder;

export async function install(ctx: InstallCtx, p: TerrariaLaunch, o: { validate: boolean }): Promise<JobResult> {
  const root = ctx.roots.install;
  const staging = path.join(root, STAGING);
  try {
    if (!ctx.download || !ctx.extract) throw new Error('This agent cannot install from the web: InstallCtx.download or extract is missing');
    const t = await resolveTarget(ctx, cachedGet(ctx), p);
    const current = installedEntry(ctx);
    if (!o.validate && current && same(current.marker, t.marker)) {
      ctx.progress(100, `${describe(t.marker.flavour, t.marker.version)} is already installed`);
      return { ok: true };
    }
    ctx.log(`Installing ${describe(t.marker.flavour, t.marker.version)}${t.marker.terraria ? ` (Terraria ${t.marker.terraria})` : ''}.`);
    mkdirSync(root, { recursive: true });
    rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
    mkdirSync(staging, { recursive: true });
    const file = path.join(staging, t.download.name);
    await ctx.download({ url: t.download.url, dest: file, what: t.download.name, size: t.download.size, sha256: t.download.sha256 });
    const sha256 = t.download.sha256 ?? (await sha256Of(file));

    ctx.progress(null, `Unpacking ${t.download.name}`);
    const unpacked = path.join(staging, t.marker.folder);
    await unpack(ctx, t, file, staging, unpacked);
    if (!existsSync(path.join(unpacked, ENTRY[t.marker.flavour]))) throw new Error(`The download holds no ${ENTRY[t.marker.flavour]}`);

    // Only now that the new files are here and checked does the old install go.
    rmSync(path.join(root, INSTALL_MARKER), { force: true });
    for (const name of readdirSync(root)) if (name !== STAGING) rmSync(path.join(root, name), { recursive: true, force: true, maxRetries: 3 });
    renameSync(unpacked, path.join(root, t.marker.folder));
    const marker: InstallMarker = { ...t.marker, sha256, verified: t.download.sha256 !== undefined, installedAt: new Date().toISOString() };
    writeFileSync(path.join(root, `${INSTALL_MARKER}.tmp`), `${JSON.stringify(marker, null, 2)}\n`);
    renameSync(path.join(root, `${INSTALL_MARKER}.tmp`), path.join(root, INSTALL_MARKER));
    ctx.progress(100, `Installed ${describe(t.marker.flavour, t.marker.version)}`);
    return { ok: true };
  } catch (e) {
    const error = (e as Error).message;
    ctx.log(`Install failed: ${error}`);
    return { ok: false, error };
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
  }
}

// ------------------------------------------------------------------- versions

/**
 * `versions()` (UPD-02) for the launch's flavour, newest first, as
 * `TerrariaVersionInfo`, from the same listings the panel's create form
 * reads (`shared/versions.ts`), through the agent's fetch and cache.
 */
export async function listVersions(ctx: InstallCtx, p: TerrariaLaunch): Promise<VersionsResponse> {
  const get = cachedGet(ctx);
  const bases = sourceUrls(ctx.env);
  let versions: TerrariaVersionInfo[];
  if (p.flavour === 'vanilla') {
    ctx.progress(null, "Checking terraria.org's versions");
    const r = await vanillaVersions(get, bases.terraria);
    if (r.unreachable) ctx.log(`Could not read terraria.org's version list (${r.unreachable}); listing the versions known to this panel.`);
    versions = r.versions;
  } else if (p.flavour === 'tshock') {
    ctx.progress(null, "Checking TShock's releases on GitHub");
    versions = tshockVersions(await githubReleases(get, bases.github, REPOS.tshock));
  } else {
    ctx.progress(null, "Checking tModLoader's releases on GitHub");
    versions = tmlVersions(await githubReleases(get, bases.github, REPOS.tmodloader));
  }
  return { installed: installedInfo(ctx), versions };
}
