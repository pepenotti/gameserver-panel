import type { RuntimeFamily, ServerSpec } from '@gsp/shared';
import { refused } from './errors';
import { canonicalJson, sha256, specHash } from './hash';

// Everything that makes a server container safe is decided here, from the
// spec's id, runtime and variant, and never taken from the caller (NFR-02,
// D3): image, user, capabilities, filesystem, mounts, network, limits, names.

/** Where every server's agent listens inside its container; never published. */
export const AGENT_PORT = 8081;
/** The unprivileged `node` user of the runtime images. */
export const SERVER_USER = '1000:1000';
/** Processes and threads per server (a JVM with many plugins stays far below). */
export const PIDS_LIMIT = 4096;
/** Seconds Docker waits after SIGTERM when nobody says otherwise: room to save a big world (NFR-04). */
export const DEFAULT_STOP_TIMEOUT_SEC = 240;
/** The only writable path outside the server's volumes. Not noexec: JVMs load native libraries from /tmp. */
export const TMPFS: Readonly<Record<string, string>> = { '/tmp': 'rw,nosuid,nodev,size=256m' };
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
} as const;

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
const ROOT_ENV: Readonly<Record<string, string>> = { GAME_DATA_DIR: '/data', GAME_INSTALL_DIR: '/opt/game' };

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
    Mounts: { Type: 'volume'; Source: string; Target: string; ReadOnly: false }[];
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
  volumes: { kind: VolumeKind; name: string }[];
  image: string;
  specHash: string;
  configHash: string;
  body: ContainerCreateBody;
}

/** The container a validated spec becomes. */
export function planContainer(spec: ServerSpec, ctx: StackContext): ContainerPlan {
  const n = names(ctx.stack, spec.id);
  const image = `gsp/${imageName(spec.runtime, spec.variant, ctx.allowFake)}:${ctx.imageTag}`;
  const env: Record<string, string | undefined> = { ...spec.env, ...ROOT_ENV };
  const Env = Object.keys(env)
    .filter((k) => env[k] !== undefined)
    .sort()
    .map((k) => `${k}=${env[k]}`);
  const volumes = MOUNTS[spec.runtime].map((m) => ({ kind: m.volume, name: n.volume(m.volume), target: m.target }));
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
      Mounts: volumes.map((v) => ({ Type: 'volume', Source: v.name, Target: v.target, ReadOnly: false })),
      PortBindings,
      NetworkMode: n.network,
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      LogConfig: LOG_CONFIG,
      IpcMode: 'private',
    },
    NetworkingConfig: { EndpointsConfig: { [n.network]: {} } },
  };
  const sHash = specHash(spec);
  const labels = { [LABEL.stack]: ctx.stack, [LABEL.server]: spec.id, [LABEL.specHash]: sHash };
  const configHash = sha256(canonicalJson({ ...unlabelled, Labels: labels }));
  return {
    name: n.container,
    network: n.network,
    volumes: volumes.map(({ kind, name }) => ({ kind, name })),
    image,
    specHash: sHash,
    configHash,
    body: { ...unlabelled, Labels: { ...labels, [LABEL.configHash]: configHash } },
  };
}
