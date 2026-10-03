/**
 * Shared installs on the agent's side (HST-09, D12;
 * docs/verification/shared-installs.md): what an install job does after the
 * adapter's install (the redirect links, the size, the marker written last)
 * and what a server on a shared install does before each start (the
 * redirects' targets in its data). Nothing here follows a link out of the
 * install root, and nothing writes outside the install and data roots.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { redirectProblem, redirectTarget, segmentMatches, SHARED_INSTALL_MARKER, type InstallRedirect, type SharedInstallMarker } from '@gsp/shared';

function lstatOrNull(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** The shared-install marker at the install root; null when there is none or it isn't one. */
export function readSharedMarker(installRoot: string): SharedInstallMarker | null {
  try {
    const st = lstatSync(path.join(installRoot, SHARED_INSTALL_MARKER));
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const m = JSON.parse(readFileSync(path.join(installRoot, SHARED_INSTALL_MARKER), 'utf8')) as Partial<SharedInstallMarker>;
    return m.schema === 1 && typeof m.adapter === 'string' && typeof m.key === 'object' && m.key !== null ? (m as SharedInstallMarker) : null;
  } catch {
    return null;
  }
}

/** First thing an install job does: an install being written is no finished one (a copy brings its source's marker along). */
export function removeSharedMarker(installRoot: string): void {
  rmSync(path.join(installRoot, SHARED_INSTALL_MARKER), { force: true });
}

/** Last thing an install job does: the marker, through a temporary file and a rename. */
export function writeSharedMarker(installRoot: string, m: SharedInstallMarker): void {
  const file = path.join(installRoot, SHARED_INSTALL_MARKER);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(m, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/**
 * The install-root paths a redirect names, `/`-separated: each folder
 * segment holding `*` matched against the plain folders there (never a
 * link), in name order; a path whose folders aren't all there names
 * nothing.
 */
export function resolveRedirect(installRoot: string, r: InstallRedirect): string[] {
  const why = redirectProblem(r);
  if (why) throw new Error(`The redirect ${r.path} ${why}`);
  const parts = r.path.split('/');
  let found: string[] = [''];
  for (const seg of parts.slice(0, -1)) {
    const next: string[] = [];
    for (const rel of found) {
      const dir = path.join(installRoot, ...rel.split('/').filter(Boolean));
      if (!seg.includes('*')) {
        if (lstatOrNull(path.join(dir, seg))?.isDirectory()) next.push(rel ? `${rel}/${seg}` : seg);
        continue;
      }
      let names: string[] = [];
      try {
        names = readdirSync(dir).sort();
      } catch {
        // not there
      }
      for (const name of names) if (segmentMatches(seg, name) && lstatOrNull(path.join(dir, name))?.isDirectory()) next.push(rel ? `${rel}/${name}` : name);
    }
    found = next;
  }
  const last = parts.at(-1)!;
  return found.map((rel) => (rel ? `${rel}/${last}` : last));
}

/**
 * Makes `rel` (a resolved redirect path) a link to the redirect's target in
 * the data root, replacing what is there (a folder a game wrote into an
 * install the job copied: its Workshop downloads, its logs). The target is
 * made in the job's own data too and the link checked to lead there: a link
 * whose target is missing fails the game like no link (measured). Refused
 * when a folder on the way is a link (never anything outside the install).
 */
export function linkRedirect(installRoot: string, dataRoot: string, rel: string, r: InstallRedirect): void {
  const to = redirectTarget(r);
  if (to === null) throw new Error(`The redirect ${r.path} ${redirectProblem(r)}`);
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error(`Not a path inside the install: ${rel}`);
  let cur = installRoot;
  for (const p of parts.slice(0, -1)) {
    cur = path.join(cur, p);
    const st = lstatOrNull(cur);
    if (st && !st.isDirectory()) throw new Error(`${rel}: ${path.relative(installRoot, cur)} is not a plain folder`);
  }
  const at = path.join(installRoot, ...parts);
  const target = path.join(dataRoot, ...to.split('/'));
  const st = lstatOrNull(at);
  if (st?.isSymbolicLink()) unlinkSync(at);
  else if (st?.isDirectory()) rmSync(at, { recursive: true, force: true, maxRetries: 3 });
  else if (st) unlinkSync(at);
  mkdirSync(target, { recursive: true });
  mkdirSync(path.dirname(at), { recursive: true });
  // A junction on Windows (the dev loop: no privilege needed, an absolute target); a symbolic link elsewhere.
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  if (realpathSync(at) !== realpathSync(target)) throw new Error(`${rel} does not lead to ${r.to}`);
}

/**
 * Before each start of a server on a shared install: every redirect's target
 * made in its data (a link to a missing target fails like no link,
 * measured). Refused when the target is there but isn't a plain folder.
 */
export function makeRedirectTargets(dataRoot: string, redirects: readonly InstallRedirect[]): void {
  for (const r of redirects) {
    const to = redirectTarget(r);
    if (to === null) continue;
    let cur = dataRoot;
    for (const p of to.split('/')) {
      cur = path.join(cur, p);
      const st = lstatOrNull(cur);
      if (st && !st.isDirectory()) throw new Error(`${r.to} is in the way of the install's redirect ${r.path}: it is not a plain folder`);
      if (!st) mkdirSync(cur);
    }
  }
}

/** Bytes and number of an install's files (links and folders not counted, the marker aside), walked without following links. */
export async function measureInstall(installRoot: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (dir: string, top: boolean): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (top && (name === SHARED_INSTALL_MARKER || name === `${SHARED_INSTALL_MARKER}.tmp`)) continue;
      const p = path.join(dir, name);
      const st = await lstat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await walk(p, false);
      else if (st.isFile()) {
        bytes += st.size;
        files += 1;
      }
    }
  };
  await walk(installRoot, true);
  return { bytes, files };
}
