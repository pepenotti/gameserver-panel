import { AGENT_CONTAINER_PORT, type DerivationState, type RuntimeFamily, type ServerSpec } from '@gsp/shared';
import { refused } from './errors';
import { canonicalJson, sha256, specHash } from './hash';

// Everything that makes a server container safe is decided here, from the
// spec's id, runtime and variant, and never taken from the caller (NFR-02,
// D3): image, user, capabilities, filesystem, mounts, network, limits, names.

/** Where every server's agent listens inside its container; never published. */
export const AGENT_PORT = AGENT_CONTAINER_PORT;
/** The unprivileged `node` user of the runtime images. */
export const SERVER_USER = '1000:1000';
/** Processes and threads per server (a JVM with many plugins stays far below). */
export const PIDS_LIMIT = 4096;
/** Seconds Docker waits after SIGTERM when nobody says otherwise: room to save a big world (NFR-04). */
export const DEFAULT_STOP_TIMEOUT_SEC = 240;
/**
 * The only writable path outside the server's volumes. `exec` must be explicit:
 * Docker mounts every tmpfs noexec unless told otherwise, and JVMs load native
 * libraries they unpack into /tmp (a JDBC SQLite driver, for one, won't start
 * without it). It grants nothing new: the game already runs code from its volumes.
 */
export const TMPFS: Readonly<Record<string, string>> = { '/tmp': 'rw,exec,nosuid,nodev,size=256m' };
export const LOG_CONFIG = { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } } as const;
const MIB = 1024 * 1024;

export const LABEL = {
  /** The Compose project of the orchestrator that owns it. */
  stack: 'gsp.stack',
  server: 'gsp.server',
  volume: 'gsp.volume',
  specHash: 'gsp.spec-hash',
  /** Hash of the whole derived container config: a PUT that would create the same container is a no-op. */
  configHash: 'gsp.config-hash',
  /** `DERIVATION_VERSION` of the orchestrator that derived it (part of the config hash). */
  derivation: 'gsp.derivation',
  /** An install's id (HST-09): on its volume, its job, the job's network and HOME, a probe. */
  install: 'gsp.install',
  /** The game an install volume holds (set when it is created): adapter, flavour ('' for none), image family and variant ('' for none). */
  installAdapter: 'gsp.install.adapter',
  installFlavour: 'gsp.install.flavour',
  installRuntime: 'gsp.install.runtime',
  installVariant: 'gsp.install.variant',
  /** A job container's kind (`install` or `copy`) and a copy's source. */
  job: 'gsp.job',
  jobFrom: 'gsp.job.from',
  /** A container made only to read a file of a volume, never started. */
  probe: 'gsp.probe',
} as const;

/**
 * Version of how `planContainer` derives a container from a spec (SRV-06,
 * NFR-02): the same spec derives the same container as long as it stays the
 * same. Raise it with every change to what is derived (a test pins each
 * family's config hash per version). Each container is labelled with it, and
 * the label is part of its config hash, so a container another release
 * derived is one this orchestrator would build differently
 * (`ServerContainer.derivation`). 1: the first labelled one; containers
 * from before carry no label and count as 0.
 */
export const DERIVATION_VERSION = 1;

/**
 * The oldest derivation still safe to keep while its game runs (NFR-02). A
 * change that closes a security gap raises it to that change's own version:
 * every container derived before it is recreated at its next PUT, even while
 * its game runs and even when the panel asks to keep it (`keepDerivation`),
 * and the orchestrator logs why. 0: no derivation so far is unsafe to keep
 * (before versions, the one change was the tmpfs `exec` fix, and a container
 * without it is the stricter one).
 */
export const SAFE_DERIVATION = 0;

/** The derivation an orchestrator builds, and the oldest it keeps: `DERIVATION_VERSION` and `SAFE_DERIVATION` (tests stand in for other releases). */
export interface Derivation {
  version: number;
  safeFrom: number;
}

export const DERIVATION: Derivation = { version: DERIVATION_VERSION, safeFrom: SAFE_DERIVATION };

/** The derivation version a container's labels name: 0 when it has none (from before versions) or it isn't one. */
export function derivationOf(labels: Readonly<Record<string, string>> | null | undefined): number {
  const raw = labels?.[LABEL.derivation];
  return raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : 0;
}

/** How this orchestrator derives a container now against how it was derived (`DerivationState`), from its labels. */
export function derivationState(labels: Readonly<Record<string, string>> | null | undefined, d: Derivation = DERIVATION): DerivationState {
  const v = derivationOf(labels);
  if (v === d.version) return 'current';
  return v < d.safeFrom ? 'security-fix' : 'changed';
}

export type VolumeKind = 'data' | 'install' | 'steam';

/** Image repositories by runtime family and variant (`''`: the plain image). */
const IMAGES: Readonly<Record<RuntimeFamily, Readonly<Record<string, string>>>> = {
  steam: { '': 'steam', fake: 'steam-fake' },
  java: { '': 'java', fake: 'java-fake' },
  native: { '': 'native', fake: 'native-fake' },
};
/** Variants that run fake games: only where `ORCH_ALLOW_FAKE=1` (tests, development slots). */
const FAKE_VARIANTS: ReadonlySet<string> = new Set(['fake']);

/** Each family's mounts: the server's own named volumes, nothing from the host. */
export const MOUNTS: Readonly<Record<RuntimeFamily, readonly { volume: VolumeKind; target: string }[]>> = {
  // steamcmd lives in HOME (the image seeds the volume), so it can update itself on a read-only root.
  steam: [
    { volume: 'data', target: '/data' },
    { volume: 'install', target: '/opt/game' },
    { volume: 'steam', target: '/home/node' },
  ],
  java: [
    { volume: 'data', target: '/data' },
    { volume: 'install', target: '/opt/game' },
  ],
  native: [
    { volume: 'data', target: '/data' },
    { volume: 'install', target: '/opt/game' },
  ],
};

/** The agent's roots, matching the mounts (`SPEC_ENV_DENIED`: the spec can't move them). */
export const ROOT_ENV: Readonly<Record<string, string>> = { GAME_DATA_DIR: '/data', GAME_INSTALL_DIR: '/opt/game' };
/** Where the install goes in every family's mounts: a server's own install volume, a shared install (read-only) or an install job's. */
export const INSTALL_TARGET = '/opt/game';
/** Tells a server's agent its install is shared and read-only (HST-09; `SPEC_ENV_DENIED`: only the orchestrator sets it). */
export const SHARED_INSTALL_ENV: Readonly<Record<string, string>> = { GSP_INSTALL_SHARED: '1' };

/** The image repository a runtime and variant run, or a refusal. */
export function imageName(runtime: RuntimeFamily, variant: string | undefined, allowFake: boolean): string {
  const table = IMAGES[runtime];
  const key = variant ?? '';
  const name = Object.hasOwn(table, key) ? table[key] : undefined;
  if (name === undefined) throw refused('variant', `${runtime} has no image variant "${key}"`);
  if (FAKE_VARIANTS.has(key) && !allowFake) throw refused('variant', `the ${key} variant is not allowed on this host`);
  return name;
}

/** What the orchestrator knows about the stack it serves; none of it comes from the caller. */
export interface StackContext {
  /** Its own Compose project: prefixes every name and labels everything it creates. */
  stack: string;
  /** Its own image tag: the runtime images are built with the same one. */
  imageTag: string;
  /** Host address server ports are published on (127.0.0.1 in development slots). */
  publishAddr: string;
  allowFake: boolean;
}

export const VOLUME_KINDS: readonly VolumeKind[] = ['data', 'install', 'steam'];

export function names(stack: string, id: string) {
  return {
    container: `${stack}-srv-${id}`,
    network: `${stack}-net-${id}`,
    volume: (kind: VolumeKind) => `${stack}-srv-${id}-${kind}`,
  };
}

/**
 * An install's names (HST-09, D12), from its id: its volume, its job's
 * container, network and HOME volume, and the probe that reads its marker.
 * None can be a server's: those are `<stack>-srv-…` and `<stack>-net-…`.
 */
export function installNames(stack: string, id: string) {
  return {
    volume: `${stack}-inst-${id}`,
    job: `${stack}-job-${id}`,
    network: `${stack}-jobnet-${id}`,
    home: `${stack}-job-${id}-steam`,
    probe: `${stack}-probe-${id}`,
  };
}

/** Where the panel reaches a server's agent: by container name, on the server's own network. */
export const agentUrl = (stack: string, id: string) => `http://${names(stack, id).container}:${AGENT_PORT}`;

/** The `POST /containers/create` body (the Docker Engine API fields this service sets). */
export interface ContainerCreateBody {
  Image: string;
  User: string;
  Env: string[];
  Labels: Record<string, string>;
  ExposedPorts: Record<string, Record<string, never>>;
  StopTimeout: number;
  HostConfig: {
    Memory: number;
    MemorySwap: number;
    NanoCpus?: number;
    PidsLimit: number;
    CapDrop: string[];
    SecurityOpt: string[];
    Privileged: false;
    ReadonlyRootfs: true;
    Tmpfs: Record<string, string>;
    /** Named volumes only; read-only for a shared install (HST-09), writable for the server's own. */
    Mounts: { Type: 'volume'; Source: string; Target: string; ReadOnly: boolean }[];
    PortBindings: Record<string, { HostIp: string; HostPort: string }[]>;
    NetworkMode: string;
    RestartPolicy: { Name: 'unless-stopped'; MaximumRetryCount: 0 };
    LogConfig: typeof LOG_CONFIG;
    IpcMode: 'private';
  };
  NetworkingConfig: { EndpointsConfig: Record<string, Record<string, never>> };
}

export interface ContainerPlan {
  name: string;
  network: string;
  /** The server's own volumes (created for it, owned by it). */
  volumes: { kind: VolumeKind; name: string }[];
  /** The shared install it mounts read-only (`ServerSpec.install`); null: its own install volume. */
  install: { id: string; volume: string } | null;
  image: string;
  specHash: string;
  configHash: string;
  body: ContainerCreateBody;
}

/** The container a validated spec becomes (as the derivation `d` builds it: this release's unless a test says otherwise). */
export function planContainer(spec: ServerSpec, ctx: StackContext, d: Derivation = DERIVATION): ContainerPlan {
  const n = names(ctx.stack, spec.id);
  const image = `gsp/${imageName(spec.runtime, spec.variant, ctx.allowFake)}:${ctx.imageTag}`;
  // A shared install (HST-09, D12) takes the place of the server's own install volume, read-only, and the agent is told.
  const shared = spec.install === undefined ? null : { id: spec.install, volume: installNames(ctx.stack, spec.install).volume };
  const env: Record<string, string | undefined> = { ...spec.env, ...ROOT_ENV, ...(shared ? SHARED_INSTALL_ENV : {}) };
  const Env = Object.keys(env)
    .filter((k) => env[k] !== undefined)
    .sort()
    .map((k) => `${k}=${env[k]}`);
  const mounts = MOUNTS[spec.runtime].map((m) =>
    m.volume === 'install' && shared ? { kind: m.volume, name: shared.volume, target: m.target, readOnly: true, own: false } : { kind: m.volume, name: n.volume(m.volume), target: m.target, readOnly: false, own: true },
  );
  const ExposedPorts: Record<string, Record<string, never>> = {};
  const PortBindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
  for (const p of spec.ports) {
    const key = `${p.container}/${p.proto}`;
    ExposedPorts[key] = {};
    PortBindings[key] = [{ HostIp: ctx.publishAddr, HostPort: String(p.host) }];
  }
  const memory = spec.memoryMb * MIB;
  const unlabelled: Omit<ContainerCreateBody, 'Labels'> = {
    Image: image,
    User: SERVER_USER,
    Env,
    ExposedPorts,
    StopTimeout: DEFAULT_STOP_TIMEOUT_SEC,
    HostConfig: {
      Memory: memory,
      MemorySwap: memory,
      ...(spec.cpus !== undefined ? { NanoCpus: Math.round(spec.cpus * 1e9) } : {}),
      PidsLimit: PIDS_LIMIT,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      ReadonlyRootfs: true,
      Tmpfs: { ...TMPFS },
      Mounts: mounts.map((v) => ({ Type: 'volume', Source: v.name, Target: v.target, ReadOnly: v.readOnly })),
      PortBindings,
      NetworkMode: n.network,
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      LogConfig: LOG_CONFIG,
      IpcMode: 'private',
    },
    NetworkingConfig: { EndpointsConfig: { [n.network]: {} } },
  };
  const sHash = specHash(spec);
  const labels = { [LABEL.stack]: ctx.stack, [LABEL.server]: spec.id, [LABEL.specHash]: sHash, [LABEL.derivation]: String(d.version) };
  const configHash = sha256(canonicalJson({ ...unlabelled, Labels: labels }));
  return {
    name: n.container,
    network: n.network,
    volumes: mounts.filter((v) => v.own).map(({ kind, name }) => ({ kind, name })),
    install: shared,
    image,
    specHash: sHash,
    configHash,
    body: { ...unlabelled, Labels: { ...labels, [LABEL.configHash]: configHash } },
  };
}
