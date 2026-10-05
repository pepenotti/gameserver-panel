/**
 * Shared installs (HST-09, D12): a game's server files are installed once
 * per game, flavour and version by an install job (a short-lived container
 * whose agent runs in install-job mode, D3) and mounted read-only by every
 * server on that version. These shapes are shared by the adapters (how
 * their installs are shared), the agent (install-job mode and the shared
 * runtime mode) and the panel (what it keeps and shows). What was measured
 * per game is in docs/verification/shared-installs.md.
 */
import type { InstalledInfo } from './agent-api';

/**
 * How a game's (or a flavour's) install is shared:
 * - `shared`: one read-only install per game, flavour and version, filled
 *   by an install job; paths the game writes inside it are redirected into
 *   each server's data (`InstallSharing.redirects`);
 * - `copy`: a per-server install filled by a local copy of the shared one
 *   (for a game that writes into its install where no redirect works; none
 *   of today's games needs it);
 * - `own`: the server's own install, installed and updated by its agent as
 *   before shared installs (a game not measured for sharing yet).
 */
export type InstallSharingMode = 'shared' | 'copy' | 'own';

/**
 * A path the game writes inside its install while it runs (measured), made
 * a symbolic link into the server's data by the install job, so the game
 * writes there instead (a log folder next to its binaries, its own
 * downloads of mods). Each server's agent creates the target before every start: a
 * link whose target is missing fails like no link (measured).
 */
export interface InstallRedirect {
  /**
   * Relative to the install root, `/`-separated, no `.` or `..` segments.
   * A folder above the linked path may hold `*` (any characters but `/`)
   * when its name depends on the version (`server-*`): the
   * job links the path in every plain folder that matches.
   */
  path: string;
  /** Where the link points: `/data/<path>`, inside the server's data root (the job never links anywhere else). */
  to: string;
}

/** How a game's (or a flavour's) install is shared, as its adapter declares it (`AdapterMeta.install`, `Flavour.install`). */
export interface InstallSharing {
  mode: InstallSharingMode;
  /** For `shared` installs: what the install job links into the server's data. */
  redirects?: InstallRedirect[];
}

/**
 * What an install is, once installed (a runtime adapter's `installKey()`):
 * the identity the panel keeps, so servers asking for the same thing share
 * one install. Two installs with equal keys hold the same files.
 */
export interface InstallKey {
  /** The flavour installed; null for games without flavours. */
  flavour: string | null;
  /** What was installed, in the launch's terms (a game version, a release tag); null when the build says it all (Steam). */
  version: string | null;
  /** The build of it (a Steam build id, a Paper build, a Fabric loader version); null when the version says it all. */
  build: string | null;
  /** The Steam branch; null for games without branches. */
  branch: string | null;
}

/**
 * What a server's launch settings want installed, before any job ran (a
 * panel adapter's `install.wanted()`): the fields of an `InstallKey` the
 * launch pins, each null where it takes whatever is newest (a Steam game
 * names its branch, never its build, which only an install job learns).
 * An install fits it when its key has the flavour it names and every other
 * field it pins. `channel` is the least stable release channel the launch
 * takes (a loader's build channel), compared as it is written:
 * an install made for one channel isn't given to a launch of another. The
 * agent still refuses a start whose launch its install doesn't fit
 * (`install-mismatch`).
 */
export interface InstallWanted {
  flavour: string | null;
  version: string | null;
  build: string | null;
  branch: string | null;
  channel: string | null;
}

/**
 * Whether an install's key fits what a launch wants: the flavour it names,
 * and every other field it pins (`InstallWanted`; the channel is compared
 * with the one the install was made for, not with the key).
 */
export function keyFits(key: InstallKey, w: InstallWanted): boolean {
  return key.flavour === w.flavour && (w.version === null || key.version === w.version) && (w.build === null || key.build === w.build) && (w.branch === null || key.branch === w.branch);
}

/** The shared-install marker, relative to the install root: written last by an install job, so it exists only after a whole one. */
export const SHARED_INSTALL_MARKER = '.gsp-shared-install.json';

/** `SHARED_INSTALL_MARKER`'s content. */
export interface SharedInstallMarker {
  schema: 1;
  /** The runtime adapter that installed it (`GAME_ADAPTER`) and the flavour (`GAME_FLAVOUR`). */
  adapter: string;
  flavour: string | null;
  mode: InstallSharingMode;
  key: InstallKey;
  /** The adapter's `installed()` right after the job. */
  installed: InstalledInfo | null;
  /** The links the job made, each path as found (no `*`). */
  redirects: InstallRedirect[];
  /** Bytes of the install's files (links and folders not counted) and how many files it holds, the marker aside. */
  bytes: number;
  files: number;
  agentVersion: string;
  /** ISO time the job finished. */
  finishedAt: string;
}

/**
 * How a server's agent is installed (`AgentStatus.install`):
 * - `own`: its own install volume, which it installs and updates;
 * - `shared`: a shared install mounted read-only (the orchestrator says so
 *   with `GSP_INSTALL_SHARED=1`): it never installs, updates or validates,
 *   and refuses to start a launch that wants another install;
 * - `job`: an install job (`GSP_AGENT_MODE=install-job`): it installs,
 *   warms up, links the redirects and writes the marker, and never starts
 *   the game.
 */
export type AgentInstallMode = 'own' | 'shared' | 'job';

export interface AgentInstallStatus {
  mode: AgentInstallMode;
  /** The adapter's (or the server's flavour's) declared sharing. */
  sharing: InstallSharing;
  /** The shared-install marker at the install root; null when there is none (yet). */
  marker: SharedInstallMarker | null;
  /**
   * `shared` only: the last start was refused because the launch asks for
   * another install than this one (`install-mismatch`): what is installed,
   * and why it doesn't fit. The panel moves the server to an install that
   * fits; null otherwise.
   */
  mismatch: { installed: InstalledInfo | null; message: string } | null;
}

/**
 * Why the agent refused a request because of how it is installed
 * (`AgentError.install`, with `conflict`, 409):
 * - `install-job`: an install job never starts the game, runs its
 *   commands or actions, or writes files through the file API;
 * - `shared-install`: a server on a shared install doesn't install, update
 *   or validate: a new install comes from an install job;
 * - `install-mismatch`: the launch asks for another install than the shared
 *   one this server mounts.
 */
export type AgentInstallRefusal = 'install-job' | 'shared-install' | 'install-mismatch';

/** The flavour's declared sharing, else the adapter's; `own` when neither says (a game not measured for sharing). */
export function installSharingOf(meta: { install?: InstallSharing; flavours: readonly { id: string; install?: InstallSharing }[] }, flavour: string | null): InstallSharing {
  const f = flavour === null ? undefined : meta.flavours.find((x) => x.id === flavour);
  return f?.install ?? meta.install ?? { mode: 'own' };
}

const SEGMENT = /^[A-Za-z0-9_.*+-]{1,100}$/;

/** `/`-separated segments of a redirect's path, or null when it isn't one (absolute, empty, `.`/`..`, odd characters). */
function segmentsOf(rel: string): string[] | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512 || rel.startsWith('/') || rel.endsWith('/')) return null;
  const parts = rel.split('/');
  for (const p of parts) if (!SEGMENT.test(p) || p === '.' || p === '..' || /^\.+$/.test(p.replace(/\*/g, ''))) return null;
  return parts;
}

/**
 * What is wrong with a declared redirect, or null when it is fine: a path
 * inside the install (no `..`, `*` within segments only, not the root, not
 * the shared marker) and a target `/data/<path>` inside the data root.
 */
export function redirectProblem(r: InstallRedirect): string | null {
  if (typeof r !== 'object' || r === null) return 'is not a redirect';
  const from = segmentsOf(r.path);
  if (!from) return `has a path that isn't one inside the install: ${JSON.stringify(r.path)}`;
  if (from[0] === SHARED_INSTALL_MARKER) return 'would replace the shared-install marker';
  if (from.at(-1)!.includes('*')) return 'must name the linked path itself: a * only in the folders above it';
  if (typeof r.to !== 'string' || !r.to.startsWith('/data/')) return `must point under /data/, not ${JSON.stringify(r.to)}`;
  const to = segmentsOf(r.to.slice('/data/'.length));
  if (!to) return `has a target that isn't one inside the data root: ${JSON.stringify(r.to)}`;
  if (to.some((s) => s.includes('*'))) return 'has a * in its target';
  return null;
}

/** A redirect's target relative to the data root (`/data/a/b` → `a/b`); null when it isn't valid. */
export function redirectTarget(r: InstallRedirect): string | null {
  return redirectProblem(r) === null ? r.to.slice('/data/'.length) : null;
}

/** Whether a path segment matches a redirect's segment (`*`: any characters but `/`). */
export function segmentMatches(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+^${}()|[\]\\?-]/g, '\\$&')).join('[^/]*')}$`);
  return re.test(name);
}
