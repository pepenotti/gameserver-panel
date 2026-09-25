import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import type { DockerTarget } from './docker';
import { parsePortRanges, type Policy } from './policy';

export interface OrchestratorConfig {
  version: string;
  /** `ORCH_SOCKET`: the unix socket it listens on (in a volume only the panel also mounts). */
  socket: string;
  /** `ORCH_TOKEN`: the panel's bearer token. */
  token: string;
  /** `ORCH_DOCKER_URL` (tests), else `ORCH_DOCKER_SOCKET` (default /var/run/docker.sock). */
  docker: DockerTarget;
  policy: Policy;
  /** `ORCH_PUBLISH_ADDR`: host address server ports are published on; empty: every address. */
  publishAddr: string;
  /** This container's id or name, to read its own Compose project and image tag (default: the hostname Docker gave it). */
  self: string;
}

/** The image copies the repo's VERSION next to the bundle. */
function bundledVersion(): string {
  try {
    return readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim();
  } catch {
    return '0.0.0-dev';
  }
}

function int(env: NodeJS.ProcessEnv, key: string, dflt: number, min: number, max: number): number {
  const v = env[key];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < min || n > max) throw new Error(`${key} must be a whole number from ${min} to ${max}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const socket = env.ORCH_SOCKET ?? '';
  if (!socket) throw new Error('ORCH_SOCKET must be set (the unix socket to listen on)');
  const token = env.ORCH_TOKEN ?? '';
  if (token.length < 32) throw new Error('ORCH_TOKEN must be set (at least 32 characters)');
  const hostPorts = env.ORCH_HOST_PORTS ?? '';
  if (!hostPorts) throw new Error('ORCH_HOST_PORTS must be set (the host ports servers may publish, e.g. 30150-30199)');
  const allowFake = env.ORCH_ALLOW_FAKE ?? '0';
  if (allowFake !== '0' && allowFake !== '1') throw new Error('ORCH_ALLOW_FAKE must be 0 or 1');
  const publishAddr = env.ORCH_PUBLISH_ADDR || '0.0.0.0';
  if (!isIP(publishAddr)) throw new Error('ORCH_PUBLISH_ADDR must be an IP address');
  return {
    version: env.ORCH_VERSION ?? bundledVersion(),
    socket,
    token,
    docker: env.ORCH_DOCKER_URL ? { url: env.ORCH_DOCKER_URL } : { socketPath: env.ORCH_DOCKER_SOCKET || '/var/run/docker.sock' },
    policy: {
      hostPorts: parsePortRanges(hostPorts),
      maxMemMb: int(env, 'ORCH_MAX_MEM_MB', 16384, 128, 1024 * 1024),
      maxServers: int(env, 'ORCH_MAX_SERVERS', 10, 1, 100),
      allowFake: allowFake === '1',
    },
    publishAddr,
    self: env.ORCH_SELF || os.hostname(),
  };
}
