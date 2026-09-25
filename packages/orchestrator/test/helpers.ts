import { randomBytes } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ServerSpec } from '@gsp/shared';
import { startFakeDocker, type FakeDocker } from '../../../tools/fake-docker/fake-docker';
import { DockerBackend } from '../src/docker-backend';
import { DockerClient } from '../src/docker';
import type { StackContext } from '../src/derive';
import type { Policy } from '../src/policy';

export const STACK = 'gsp-s1';
export const TOKEN = 'orch-test-token-0123456789abcdef0123456789';
export const AGENT_TOKEN = 'agent-test-token-0123456789abcdef012345678';

export const policy: Policy = { hostPorts: [[30150, 30199]], maxMemMb: 4096, maxServers: 3, allowFake: true };
export const ctx: StackContext = { stack: STACK, imageTag: 's1', publishAddr: '127.0.0.1', allowFake: true };

/** A spec the policy above accepts. */
export function spec(over: Partial<ServerSpec> = {}): ServerSpec {
  return {
    id: 'pz',
    runtime: 'steam',
    variant: 'fake',
    env: { AGENT_TOKEN, GAME_ADAPTER: 'pz', TZ: 'Europe/Madrid', GAME_PORT_GAME: '30161', GAME_PORT_UDP: '30162' },
    ports: [
      { container: 30161, host: 30161, proto: 'udp' },
      { container: 30162, host: 30162, proto: 'udp' },
    ],
    memoryMb: 2048,
    ...over,
  };
}

/** A unix socket path, or a named pipe on Windows (what Node listens on there). */
export function socketPath(name: string): string {
  const tag = `${name}-${process.pid}-${randomBytes(4).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\gsp-test-${tag}` : path.join(os.tmpdir(), `gsp-${tag}.sock`);
}

export interface DockerStack {
  fd: FakeDocker;
  docker: DockerClient;
  backend: DockerBackend;
  /** This stack's panel container. */
  panelId: string;
}

/** A fake Docker with this stack's orchestrator and panel containers, and a backend on it. */
export async function dockerStack(o: { panel?: boolean; policy?: Policy } = {}): Promise<DockerStack> {
  const fd = await startFakeDocker();
  fd.addContainer({ name: `${STACK}-orchestrator-1`, id: 'f00dcafe'.repeat(8), image: 'gsp/orchestrator:s1', running: true, labels: { 'com.docker.compose.project': STACK, 'com.docker.compose.service': 'orchestrator' } });
  let panelId = '';
  if (o.panel !== false) {
    panelId = fd.addContainer({ name: `${STACK}-panel-1`, image: 'gsp/panel:s1', running: true, labels: { 'com.docker.compose.project': STACK, 'com.docker.compose.service': 'panel' }, networks: [`${STACK}_panel`] }).Id;
  }
  const docker = new DockerClient({ url: fd.url });
  return { fd, docker, backend: new DockerBackend({ docker, ctx, policy: o.policy ?? policy }), panelId };
}

export interface Answer {
  status: number;
  body: unknown;
}

/** One request to an orchestrator listening on `socket`. */
export function request(socket: string, method: string, urlPath: string, o: { body?: unknown; raw?: string; token?: string | null; contentType?: string } = {}): Promise<Answer> {
  const payload = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
  const headers: Record<string, string> = {};
  if (o.token !== null) headers.authorization = `Bearer ${o.token ?? TOKEN}`;
  if (payload !== undefined) {
    headers['content-type'] = o.contentType ?? 'application/json';
    // Explicit: Node's client sends GET and DELETE bodies without a length otherwise.
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    // A fresh connection per request: one test's half-read body never leaks into the next.
    const req = http.request({ socketPath: socket, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as unknown) : undefined });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
