/**
 * Installs per loader, exactly as measured (UPD-01, UPD-05, UPD-06;
 * docs/verification/minecraft-26.3.md, "Install and pinning"):
 *   - vanilla: Mojang's server jar, checked against its SHA-1 and size;
 *   - Paper: the build's jar from Fill v3, checked against its SHA-256 and
 *     size, then Paper's patch-only step (it fetches Mojang's jar itself);
 *   - Fabric: the installer from Fabric's maven, checked against the
 *     `.sha256` next to it, run in server mode (it fetches Mojang's jar, which
 *     is then checked against Mojang's SHA-1).
 * The Java major comes from Mojang's version file for every loader. A marker
 * written last says what is installed. Nothing ever moves a server to
 * another Minecraft version: only builds of the pinned one (UPD-05).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { InstallCtx, InstalledInfo, JobResult, RuntimeCtx, VersionsResponse } from '@gsp/adapter-api';
import { INSTALL_MARKER, LOADER_JARS, type InstallMarker, type MinecraftVersionInfo } from '../shared/install';
import { channelAllows, isPaperChannel, LOADERS, type MinecraftLaunch, type PaperChannel } from '../shared/launch';
import { fabricGames, fabricLoadersFor, fabricStableLoader, mojangReleases, paperVersions } from '../shared/versions';
import { javaCommand, jreFor } from './java';
import { Api, checkUrl, fabricInstallers, mavenSha256, mojangVersionFile, mojangVersions, paperBuildById, paperBuilds, type PaperBuild } from './sources';

/** Downloads wait here, inside the install root, until they are checked. */
const STAGING = '.gsp-staging';
/** How many builds or loader versions the launch's own version lists. */
const DETAIL_LIMIT = 50;

// ------------------------------------------------------------------- the marker

function isMarker(x: unknown): x is InstallMarker {
  const m = x as Partial<InstallMarker> | null;
  return (
    typeof m === 'object' &&
    m !== null &&
    m.schema === 1 &&
    typeof m.loader === 'string' &&
    (LOADERS as readonly string[]).includes(m.loader) &&
    typeof m.version === 'string' &&
    typeof m.jar === 'string' &&
    typeof m.javaMajor === 'number' &&
    typeof m.jre === 'number' &&
    (m.channel === null || isPaperChannel(m.channel))
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

/** `installed()`: the version, the loader as the channel, Paper's build or Fabric's loader as the build. */
export function installedInfo(ctx: RuntimeCtx): InstalledInfo | null {
  const m = readMarker(ctx);
  if (!m || !existsSync(path.join(ctx.roots.install, m.jar))) return null;
  const build = m.loader === 'paper' ? String(m.build) : m.loader === 'fabric' ? (m.loaderVersion ?? undefined) : undefined;
  return { version: m.version, channel: m.loader, ...(build ? { build } : {}) };
}

/**
 * `installOnStart()`: an install is required when nothing is installed or
 * it isn't what the launch pins (another version or loader, another pinned
 * Paper build or Fabric loader, or a Paper build less stable than the
 * pinned channel now allows). Never 'update': newer builds of the pinned
 * version come through the panel's update policy (UPD-03).
 */
export function installNeeded(ctx: RuntimeCtx, p: MinecraftLaunch): 'required' | null {
  const m = readMarker(ctx);
  if (!m || !existsSync(path.join(ctx.roots.install, m.jar))) return 'required';
  if (m.loader !== p.loader || m.version !== p.version) return 'required';
  if (p.loader === 'paper') {
    if (p.build !== null && m.build !== p.build) return 'required';
    if (m.channel === null || !channelAllows(p.channel ?? 'STABLE', m.channel)) return 'required';
  }
  if (p.loader === 'fabric' && p.loaderVersion !== null && m.loaderVersion !== p.loaderVersion) return 'required';
  return null;
}

// ------------------------------------------------------------------- what to install

interface Target {
  marker: Omit<InstallMarker, 'installedAt'>;
  /** The file to download first: the server jar (vanilla, Paper) or the installer (Fabric). */
  download: { url: string; name: string; size?: number; sha1?: string; sha256?: string };
  /** Mojang's server jar, which Fabric's installer fetches: checked afterwards. */
  mojangServer: { sha1: string; size: number } | null;
}

const describe = (p: MinecraftLaunch) => `${p.loader === 'vanilla' ? 'Minecraft' : p.loader === 'paper' ? 'Paper for Minecraft' : 'Fabric for Minecraft'} ${p.version}`;

async function resolveTarget(ctx: InstallCtx, api: Api, p: MinecraftLaunch): Promise<Target> {
  ctx.progress(null, `Looking up ${describe(p)}`);
  const entry = (await mojangVersions(api)).find((v) => v.id === p.version);
  if (!entry || entry.type !== 'release') throw new Error(`Mojang lists no Minecraft release ${p.version}`);
  const vf = await mojangVersionFile(ctx, api, entry);
  const jre = jreFor(vf.javaMajor);
  const base = { schema: 1 as const, loader: p.loader, version: p.version, javaMajor: vf.javaMajor, jre, jar: LOADER_JARS[p.loader], build: null, channel: null, loaderVersion: null, installerVersion: null, sha1: null, sha256: null };

  if (p.loader === 'vanilla') {
    if (!vf.server) throw new Error(`Minecraft ${p.version} has no server download`);
    return { marker: { ...base, sha1: vf.server.sha1 }, download: { url: checkUrl(ctx, vf.server.url, 'the server jar'), name: 'server.jar', size: vf.server.size, sha1: vf.server.sha1 }, mojangServer: null };
  }

  if (p.loader === 'paper') {
    const pinned: PaperChannel = p.channel ?? 'STABLE';
    let build: PaperBuild | null;
    if (p.build !== null) {
      build = await paperBuildById(api, p.version, p.build);
      if (!build) throw new Error(`Paper has no build ${p.build} of Minecraft ${p.version}`);
      if (!channelAllows(pinned, build.channel)) throw new Error(`Paper build ${build.id} of ${p.version} is ${build.channel}, and this server takes ${pinned} builds only; choose the ${build.channel} channel to install it`);
    } else {
      const builds = await paperBuilds(api, p.version);
      if (builds === null) throw new Error(`Paper has no Minecraft ${p.version}`);
      build = builds.find((b) => channelAllows(pinned, b.channel)) ?? null;
      if (!build) {
        const newest = builds[0];
        throw new Error(newest ? `Paper has no ${pinned} build of Minecraft ${p.version} yet (the newest, ${newest.id}, is ${newest.channel}); choose the ${newest.channel} channel to install it, or another version` : `Paper has no builds of Minecraft ${p.version} yet`);
      }
    }
    const d = build.download;
    if (!d) throw new Error(`Paper build ${build.id} of ${p.version} has no server download`);
    return {
      marker: { ...base, build: build.id, channel: build.channel, sha256: d.sha256 },
      download: { url: checkUrl(ctx, d.url, d.name), name: 'paper.jar', size: d.size, sha256: d.sha256 },
      mojangServer: null,
    };
  }

  // Fabric: the installer, the loader it installs, and Mojang's jar it fetches.
  if (!vf.server) throw new Error(`Minecraft ${p.version} has no server download`);
  // The releases Fabric supports (the launch's version is always an offered release).
  if (!(await fabricGames(api.get, api.base('fabric'))).includes(p.version)) throw new Error(`Fabric does not support Minecraft ${p.version}`);
  const loaders = (await fabricLoadersFor(api.get, api.base('fabric'), p.version)) ?? [];
  let loaderVersion = p.loaderVersion;
  if (loaderVersion === null) {
    loaderVersion = loaders.find((l) => l.stable)?.version ?? null;
    if (loaderVersion === null) throw new Error(`Fabric has no stable loader for Minecraft ${p.version}`);
  } else if (!loaders.some((l) => l.version === loaderVersion)) throw new Error(`Fabric Loader ${loaderVersion} is not available for Minecraft ${p.version}`);
  const installers = await fabricInstallers(api);
  const installer = installers.find((i) => i.stable) ?? installers[0];
  if (!installer) throw new Error('Fabric lists no installer');
  if (!/^[0-9A-Za-z.+-]{1,32}$/.test(installer.version)) throw new Error('Fabric lists an installer with an odd version');
  const url = checkUrl(ctx, installer.url, `Fabric's installer ${installer.version}`);
  const sha256 = await mavenSha256(api, url);
  return {
    marker: { ...base, loaderVersion, installerVersion: installer.version, sha1: vf.server.sha1, sha256 },
    download: { url, name: `fabric-installer-${installer.version}.jar`, sha256 },
    mojangServer: { sha1: vf.server.sha1, size: vf.server.size },
  };
}

/** The same thing is installed: nothing to download. */
function same(m: InstallMarker, t: Target['marker']): boolean {
  return m.loader === t.loader && m.version === t.version && m.build === t.build && m.loaderVersion === t.loaderVersion && m.jre === t.jre;
}

// ------------------------------------------------------------------- install

function clearInstallRoot(root: string): void {
  for (const name of readdirSync(root)) if (name !== STAGING) rmSync(path.join(root, name), { recursive: true, force: true, maxRetries: 3 });
}

function sha1Of(file: string): string {
  return createHash('sha1').update(readFileSync(file)).digest('hex');
}

export async function install(ctx: InstallCtx, p: MinecraftLaunch, o: { validate: boolean }): Promise<JobResult> {
  const root = ctx.roots.install;
  const staging = path.join(root, STAGING);
  try {
    if (!ctx.download || !ctx.exec) throw new Error('This agent cannot install from the web: InstallCtx.download or exec is missing');
    const api = new Api(ctx);
    const t = await resolveTarget(ctx, api, p);
    const current = readMarker(ctx);
    if (!o.validate && current && same(current, t.marker) && existsSync(path.join(root, current.jar))) {
      ctx.progress(100, `${describe(p)} is already installed`);
      return { ok: true };
    }
    ctx.log(`Installing ${describe(p)}${t.marker.build !== null ? `, Paper build ${t.marker.build} (${t.marker.channel})` : ''}${t.marker.loaderVersion ? `, Fabric Loader ${t.marker.loaderVersion}` : ''}, on Java ${t.marker.jre}.`);
    mkdirSync(root, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const downloaded = path.join(staging, t.download.name);
    await ctx.download({ url: t.download.url, dest: downloaded, what: t.download.name, size: t.download.size, sha1: t.download.sha1, sha256: t.download.sha256 });

    // Only now that the new files are here and checked does the old install go.
    rmSync(path.join(root, INSTALL_MARKER), { force: true });
    clearInstallRoot(root);
    const java = javaCommand(ctx, t.marker.jre);
    if (p.loader === 'vanilla' || p.loader === 'paper') renameSync(downloaded, path.join(root, t.marker.jar));
    if (p.loader === 'paper') {
      ctx.progress(null, "Running Paper's patch step (it downloads Mojang's server jar)");
      const r = await ctx.exec([...java, '-Dpaperclip.patchonly=true', `-DbundlerRepoDir=${root}`, '-jar', path.join(root, t.marker.jar)], { cwd: root });
      if (r.code !== 0) throw new Error(`Paper's patch step failed (${r.signal ? `signal ${r.signal}` : `exit ${r.code}`})`);
    }
    if (p.loader === 'fabric') {
      ctx.progress(null, "Running Fabric's installer (it downloads Mojang's server jar)");
      const r = await ctx.exec([...java, '-jar', downloaded, 'server', '-mcversion', p.version, '-loader', t.marker.loaderVersion!, '-dir', root, '-downloadMinecraft'], { cwd: root });
      if (r.code !== 0) throw new Error(`Fabric's installer failed (${r.signal ? `signal ${r.signal}` : `exit ${r.code}`})`);
      for (const f of [t.marker.jar, 'server.jar']) if (!existsSync(path.join(root, f))) throw new Error(`Fabric's installer did not write ${f}`);
      if (t.mojangServer && sha1Of(path.join(root, 'server.jar')) !== t.mojangServer.sha1.toLowerCase()) throw new Error("The Minecraft server jar Fabric's installer fetched does not match Mojang's");
    }
    const marker: InstallMarker = { ...t.marker, installedAt: new Date().toISOString() };
    writeFileSync(path.join(root, `${INSTALL_MARKER}.tmp`), `${JSON.stringify(marker, null, 2)}\n`);
    renameSync(path.join(root, `${INSTALL_MARKER}.tmp`), path.join(root, INSTALL_MARKER));
    ctx.progress(100, `Installed ${describe(p)}`);
    return { ok: true };
  } catch (e) {
    const error = (e as Error).message;
    ctx.log(`Install failed: ${error}`);
    return { ok: false, error };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- versions

const unix = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
};

/**
 * `versions()` (UPD-02): Minecraft releases 1.16.5 and newer (Q11) the
 * launch's loader has, newest first, as `MinecraftVersionInfo`, from the
 * same listings the panel's create form reads (`shared/versions.ts`),
 * through the agent's fetch and cache:
 *   - vanilla: every release;
 *   - Paper: each version with its newest build and that build's channel,
 *     and `warning: 'paper-no-stable-build'` when it isn't STABLE (Q13).
 *     Measured on every Paper version from 1.16.5 to 26.3: a version's
 *     builds only move ALPHA → BETA → STABLE, so a version has a STABLE
 *     build exactly when its newest is one. The launch's own version also
 *     lists its builds;
 *   - Fabric: each release Fabric supports with the newest stable loader;
 *     the launch's own version also lists its loader versions.
 */
export async function listVersions(ctx: InstallCtx, p: MinecraftLaunch): Promise<VersionsResponse> {
  const api = new Api(ctx);
  let versions: MinecraftVersionInfo[];
  if (p.loader === 'paper') {
    ctx.progress(null, "Checking PaperMC's versions and builds");
    versions = (await paperVersions(api.get, api.base('paper'))).map((v) => ({
      id: v.id,
      build: String(v.build),
      channel: v.channel,
      timeUpdated: unix(v.time),
      ...(v.channel === 'STABLE' ? {} : { warning: 'paper-no-stable-build' as const }),
    }));
    const own = versions.find((v) => v.id === p.version);
    if (own) own.builds = ((await paperBuilds(api, p.version)) ?? []).slice(0, DETAIL_LIMIT).map((b) => ({ id: b.id, channel: b.channel, timeUpdated: unix(b.time) ?? 0 }));
  } else {
    ctx.progress(null, "Checking Mojang's version list");
    const releases = await mojangReleases(api.get, api.base('mojang'));
    if (p.loader === 'vanilla') {
      versions = releases.map((v) => ({ id: v.id, timeUpdated: unix(v.time) }));
    } else {
      ctx.progress(null, "Checking Fabric's versions and loaders");
      const released = new Map(releases.map((v) => [v.id, unix(v.time)]));
      const games = await fabricGames(api.get, api.base('fabric'));
      const loader = await fabricStableLoader(api.get, api.base('fabric'));
      versions = games.map((id) => ({ id, ...(loader ? { build: loader } : {}), timeUpdated: released.get(id) }));
      const own = versions.find((v) => v.id === p.version);
      if (own) own.loaders = ((await fabricLoadersFor(api.get, api.base('fabric'), p.version)) ?? []).slice(0, DETAIL_LIMIT);
    }
  }
  // Undefined fields don't travel; leave them out so the list compares as JSON.
  for (const v of versions) if (v.timeUpdated === undefined) delete v.timeUpdated;
  return { installed: installedInfo(ctx), versions };
}
