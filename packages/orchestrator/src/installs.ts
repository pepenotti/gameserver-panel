import { SHARED_INSTALL_MARKER, type InstallJobKind, type InstallJobSpec, type RuntimeFamily, type ServerSpec, type SharedInstallMarker } from '@gsp/shared';
import { DEFAULT_STOP_TIMEOUT_SEC, imageName, INSTALL_TARGET, installNames, LABEL, LOG_CONFIG, PIDS_LIMIT, ROOT_ENV, SERVER_USER, TMPFS, type StackContext } from './derive';
import { canonicalJson, sha256 } from './hash';

// Shared installs (HST-09, D12): everything about an install's volume and
// its jobs is derived here, from the job spec's id, runtime and variant,
// and never taken from the caller (NFR-02, D3), as for servers: the image,
// user, capabilities, filesystem, mounts, network, memory, names.

/** An install job's memory limit (MiB): measured peaks were 149–311 MiB (docs/verification/shared-installs.md). */
export const JOB_MEMORY_MB = 1024;
/**
 * An install job's `/data`: the agent keeps only its state there (measured:
 * 380 bytes). A tmpfs, so nothing of a job outlives it but the install.
 */
export const JOB_DATA_TMPFS = 'rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700';
/** The agent's mode an install job runs in (`SPEC_ENV_DENIED`: only the orchestrator sets it). */
export const JOB_MODE_ENV: Readonly<Record<string, string>> = { GSP_AGENT_MODE: 'install-job' };
/** Jobs at once per stack: enough for a server being created while an update installs, never a pile of downloads. */
export const MAX_INSTALL_JOBS = 4;
/**
 * The copy job's command, fixed here (never the caller's): every file of
 * the source (read-only at `/src`) into the new install, links kept as
 * links, modes and times kept. Measured: the target must be mounted where
 * the image has a folder the `node` user owns (`/opt/game`), or the copy
 * fails (docs/verification/shared-installs.md).
 */
export const COPY_COMMAND: readonly string[] = ['cp', '-a', '/src/.', `${INSTALL_TARGET}/`];
const COPY_SOURCE = '/src';
/** A job's HOME (the steam family keeps steamcmd there, seeded from the image). */
const HOME_TARGET = '/home/node';

/** Where a copy comes from: another install of the stack, or a server's own install volume. */
export type CopySource = { install: string } | { server: string };

/** `InstallJob.from`: an install id, or `server:<id>`. */
export const fromLabel = (src: CopySource | null) => (src === null ? '' : 'install' in src ? src.install : `server:${src.server}`);

/** The labels an install's volume carries from its creation: whose and which game it holds. */
export function installVolumeLabels(stack: string, spec: InstallJobSpec): Record<string, string> {
  return {
    [LABEL.stack]: stack,
    [LABEL.install]: spec.id,
    [LABEL.installAdapter]: spec.env.GAME_ADAPTER,
    [LABEL.installFlavour]: spec.env.GAME_FLAVOUR ?? '',
    [LABEL.installRuntime]: spec.runtime,
    [LABEL.installVariant]: spec.variant ?? '',
  };
}

/** The game an install volume's labels say it holds. */
export interface InstallGame {
  adapter: string;
  flavour: string | null;
  runtime: RuntimeFamily;
  variant: string | null;
}

const RUNTIMES: ReadonlySet<string> = new Set(['steam', 'java', 'native']);

/** The game of an install volume of this stack and id (its labels), or null when the labels aren't an install's. */
export function installGameOf(labels: Readonly<Record<string, string>> | null | undefined, stack: string, id: string): InstallGame | null {
  if (!labels || labels[LABEL.stack] !== stack || labels[LABEL.install] !== id) return null;
  const adapter = labels[LABEL.installAdapter];
  const runtime = labels[LABEL.installRuntime];
  if (!adapter || !runtime || !RUNTIMES.has(runtime)) return null;
  const flavour = labels[LABEL.installFlavour] ?? '';
  const variant = labels[LABEL.installVariant] ?? '';
  return { adapter, flavour: flavour === '' ? null : flavour, runtime: runtime as RuntimeFamily, variant: variant === '' ? null : variant };
}

/** Why a spec (a server's or a job's) doesn't fit an install of `game`, or null when it does: another adapter, flavour, image family or variant. */
export function gameMismatch(game: InstallGame, spec: { runtime: RuntimeFamily; variant?: string; env: { GAME_ADAPTER: string; GAME_FLAVOUR?: string } }): string | null {
  const want: InstallGame = { adapter: spec.env.GAME_ADAPTER, flavour: spec.env.GAME_FLAVOUR ?? null, runtime: spec.runtime, variant: spec.variant ?? null };
  const say = (g: InstallGame) => `${g.adapter}${g.flavour ? `/${g.flavour}` : ''} in the ${g.runtime}${g.variant ? `-${g.variant}` : ''} image`;
  if (game.adapter !== want.adapter || game.flavour !== want.flavour || game.runtime !== want.runtime || game.variant !== want.variant) return `it holds ${say(game)}, not ${say(want)}`;
  return null;
}

/** The server spec's game against an install's: the same check, named for a server. */
export const serverMismatch = (game: InstallGame, spec: ServerSpec) => gameMismatch(game, spec);

/** The `POST /containers/create` body of a job or probe (the Docker Engine API fields this service sets). */
export interface JobCreateBody {
  Image: string;
  User: string;
  Env: string[];
  Cmd?: string[];
  Labels: Record<string, string>;
  ExposedPorts: Record<string, never>;
  StopTimeout: number;
  HostConfig: {
    Memory: number;
    MemorySwap: number;
    PidsLimit: number;
    CapDrop: string[];
    SecurityOpt: string[];
    Privileged: false;
    ReadonlyRootfs: true;
    Tmpfs: Record<string, string>;
    Mounts: { Type: 'volume'; Source: string; Target: string; ReadOnly: boolean }[];
    PortBindings: Record<string, never>;
    NetworkMode: string;
    RestartPolicy: { Name: 'no' };
    LogConfig: typeof LOG_CONFIG;
    IpcMode: 'private';
  };
  NetworkingConfig?: { EndpointsConfig: Record<string, Record<string, never>> };
}

export interface JobPlan {
  kind: InstallJobKind;
  name: string;
  image: string;
  /** The job's own network (install jobs); null: none at all (copy jobs). */
  network: string | null;
  /** The job's HOME volume (install jobs of the steam family), removed with it. */
  home: string | null;
  /** The install's volume. */
  volume: string;
  /** The copy's source volume. */
  source: string | null;
  /** Hash of what was asked (spec, kind, source): the same PUT again finds the same job. */
  specHash: string;
  body: JobCreateBody;
}

const MIB = 1024 * 1024;

/** Hardening every job and probe shares with servers (NFR-02): only its tmpfs, mounts, network and memory differ. */
function hardened(o: { memoryMb: number; tmpfs: Record<string, string>; mounts: JobCreateBody['HostConfig']['Mounts']; network: string }): JobCreateBody['HostConfig'] {
  const memory = o.memoryMb * MIB;
  return {
    Memory: memory,
    MemorySwap: memory,
    PidsLimit: PIDS_LIMIT,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    Privileged: false,
    ReadonlyRootfs: true,
    Tmpfs: o.tmpfs,
    Mounts: o.mounts,
    PortBindings: {},
    NetworkMode: o.network,
    RestartPolicy: { Name: 'no' },
    LogConfig: LOG_CONFIG,
    IpcMode: 'private',
  };
}

/** The volume a copy reads: another install's, or a server's own install volume. */
export const copySourceVolume = (stack: string, src: CopySource) => ('install' in src ? installNames(stack, src.install).volume : `${stack}-srv-${src.server}-install`);

/**
 * The job that fills an install (HST-09, D12): an install job runs the
 * runtime image's agent in install-job mode, with the install writable, on
 * its own network (the panel drives its agent there), `/data` a tmpfs and,
 * for the steam family, a HOME of its own; a copy job runs `COPY_COMMAND`
 * with no network at all. Both are as hardened as a server, publish
 * nothing and never restart on their own.
 */
export function planInstallJob(spec: InstallJobSpec, ctx: StackContext, src: CopySource | null): JobPlan {
  const n = installNames(ctx.stack, spec.id);
  const kind: InstallJobKind = src === null ? 'install' : 'copy';
  const image = `gsp/${imageName(spec.runtime, spec.variant, ctx.allowFake)}:${ctx.imageTag}`;
  const labels: Record<string, string> = { ...installVolumeLabels(ctx.stack, spec), [LABEL.job]: kind, [LABEL.jobFrom]: fromLabel(src) };
  const specHash = sha256(canonicalJson({ spec, kind, from: fromLabel(src) }));
  labels[LABEL.specHash] = specHash;
  if (src !== null) {
    const source = copySourceVolume(ctx.stack, src);
    return {
      kind,
      name: n.job,
      image,
      network: null,
      home: null,
      volume: n.volume,
      source,
      specHash,
      body: {
        Image: image,
        User: SERVER_USER,
        // Nothing of the caller's reaches a copy: not its token, not its knobs.
        Env: [],
        Cmd: [...COPY_COMMAND],
        Labels: labels,
        ExposedPorts: {},
        StopTimeout: DEFAULT_STOP_TIMEOUT_SEC,
        HostConfig: hardened({
          memoryMb: JOB_MEMORY_MB,
          tmpfs: { ...TMPFS },
          mounts: [
            { Type: 'volume', Source: source, Target: COPY_SOURCE, ReadOnly: true },
            { Type: 'volume', Source: n.volume, Target: INSTALL_TARGET, ReadOnly: false },
          ],
          network: 'none',
        }),
      },
    };
  }
  const env: Record<string, string | undefined> = { ...spec.env, ...ROOT_ENV, ...JOB_MODE_ENV };
  const Env = Object.keys(env)
    .filter((k) => env[k] !== undefined)
    .sort()
    .map((k) => `${k}=${env[k]}`);
  const home = spec.runtime === 'steam' ? n.home : null;
  const mounts: JobCreateBody['HostConfig']['Mounts'] = [{ Type: 'volume', Source: n.volume, Target: INSTALL_TARGET, ReadOnly: false }];
  if (home) mounts.push({ Type: 'volume', Source: home, Target: HOME_TARGET, ReadOnly: false });
  return {
    kind,
    name: n.job,
    image,
    network: n.network,
    home,
    volume: n.volume,
    source: null,
    specHash,
    body: {
      Image: image,
      User: SERVER_USER,
      Env,
      Labels: labels,
      ExposedPorts: {},
      StopTimeout: DEFAULT_STOP_TIMEOUT_SEC,
      HostConfig: hardened({ memoryMb: JOB_MEMORY_MB, tmpfs: { ...TMPFS, '/data': JOB_DATA_TMPFS }, mounts, network: n.network }),
      NetworkingConfig: { EndpointsConfig: { [n.network]: {} } },
    },
  };
}

/**
 * A container that is created, read from and removed, never started: it
 * mounts an install read-only so the orchestrator can read the install's
 * shared-install marker (`GET /containers/{id}/archive`), with nothing to
 * run and no network.
 */
export function planProbe(stack: string, id: string, game: InstallGame, ctx: StackContext): { name: string; body: JobCreateBody } {
  const n = installNames(stack, id);
  const image = `gsp/${imageName(game.runtime, game.variant ?? undefined, ctx.allowFake)}:${ctx.imageTag}`;
  return {
    name: n.probe,
    body: {
      Image: image,
      User: SERVER_USER,
      Env: [],
      Cmd: ['true'],
      Labels: { [LABEL.stack]: stack, [LABEL.install]: id, [LABEL.probe]: '1' },
      ExposedPorts: {},
      StopTimeout: 1,
      HostConfig: hardened({ memoryMb: 64, tmpfs: { ...TMPFS }, mounts: [{ Type: 'volume', Source: n.volume, Target: INSTALL_TARGET, ReadOnly: true }], network: 'none' }),
    },
  };
}

/** Where the probe reads the marker. */
export const MARKER_PATH = `${INSTALL_TARGET}/${SHARED_INSTALL_MARKER}`;

/** The first file of a tar archive (Docker's archive endpoint answers one file as a tar), or null when there is none. */
export function firstTarFile(tar: Buffer): Buffer | null {
  if (tar.length < 512) return null;
  const header = tar.subarray(0, 512);
  if (header.every((b) => b === 0)) return null;
  const type = String.fromCharCode(header[156] ?? 0);
  if (type !== '0' && type !== '\0') return null;
  const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8);
  if (!Number.isSafeInteger(size) || size < 0 || 512 + size > tar.length) return null;
  return tar.subarray(512, 512 + size);
}

/** A shared-install marker as read from an install (`SharedInstallMarker`), or null when it isn't one. */
export function parseMarker(data: Buffer | null): SharedInstallMarker | null {
  if (!data || data.length > 64 * 1024) return null;
  try {
    const m = JSON.parse(data.toString('utf8')) as Partial<SharedInstallMarker>;
    if (m.schema !== 1 || typeof m.adapter !== 'string' || (m.flavour !== null && typeof m.flavour !== 'string') || typeof m.key !== 'object' || m.key === null) return null;
    return m as SharedInstallMarker;
  } catch {
    return null;
  }
}
