// Shared installs as the API answers them (HST-09, D12): mirrors
// packages/panel/src/routes/installs.ts and packages/panel/src/servers/installs.ts.
import type { I18n } from './meta';

/** `installing`: its job runs (or runs again); `ready`; `failed`: its job failed (the next start tries again); `removing`. */
export type InstallState = 'installing' | 'ready' | 'failed' | 'removing';

/** What an install holds: the game's flavour, version, build and branch, each null when the game doesn't have it. */
export interface InstallKey {
  flavour: string | null;
  version: string | null;
  build: string | null;
  branch: string | null;
}

/** What a launch wants installed: an `InstallKey`'s fields it pins (null: the newest), and the release channel it takes. */
export interface InstallWanted extends InstallKey {
  channel: string | null;
}

/** Where an install's job is: a local `copy` (an update, a move off a server's own install), then the `install` job. */
export interface InstallProgress {
  phase: 'copy' | 'install';
  progress: number | null;
  message: string;
}

/** What a server runs from (`ServerSummary.install`, `GET /api/servers/:sid/install`). */
export interface ServerInstallView {
  /** `shared`: a shared install, read-only; `own`: an install of its own. */
  mode: 'shared' | 'own';
  id: string | null;
  state: InstallState | null;
  key: InstallKey | null;
  bytes: number | null;
  files: number | null;
  /** How many other servers run from it or wait for it. */
  sharedWith: number;
  job: InstallProgress | null;
  /** Why its job failed. */
  error: string | null;
  /** It has no container yet: its install is being made. */
  waiting: boolean;
  /** The install it moves to at its next start (`id` null: a shared one in place of its own). */
  next: { id: string | null; key: InstallKey | null; state: InstallState | null; job: InstallProgress | null } | null;
}

/** An install on the host page (`GET /api/host/installs`). */
export interface InstallView {
  id: string;
  adapter: string;
  adapterName: I18n | null;
  flavour: string | null;
  flavourName: I18n | null;
  state: InstallState;
  key: InstallKey | null;
  wanted: InstallWanted[];
  error: string | null;
  bytes: number | null;
  files: number | null;
  /** Downloaded, made by an update (a copy of another install), or adopted from a server's own install. */
  origin: 'download' | 'update' | 'adopted';
  /** An update replaced it. */
  superseded: boolean;
  servers: { id: string; name: string }[];
  job: InstallProgress | null;
  createdAt: string;
  readyAt: string | null;
  /** Nobody uses it: the owner may remove it. */
  removable: boolean;
}

/** A server's own install volume, left over after it moved to a shared install. */
export interface OwnInstallView {
  serverId: string;
  serverName: string | null;
  bytes: number | null;
  files: number | null;
  since: string;
}

export interface InstallsResponse {
  installs: InstallView[];
  leftovers: OwnInstallView[];
  totalBytes: number;
}

/** `POST /api/adapters/:id/install-plan`: what a new server would do about its game's files. */
export interface InstallPlan {
  mode: 'existing' | 'installing' | 'download' | 'own';
  bytes: number | null;
  servers: number;
}
