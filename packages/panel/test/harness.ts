import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { ModSource, PanelAdapter } from '@gsp/adapter-api';
import { createWorkshopSource } from '@gsp/adapter-pz/panel/core';
import { ORCHESTRATOR_API_VERSION, type AgentStatus, type CpuArch, type GrantRole, type SeqEvent, type ServerContainer, type ServerSpec } from '@gsp/shared';
import { AgentCallError, type AgentApi } from '../src/agent/client';
import { buildApp } from '../src/app';
import { bootstrapOwner } from '../src/auth/bootstrap';
import { syncRoleWithGrants } from '../src/auth/grants';
import { SESSION_COOKIE } from '../src/auth/sessions';
import { base32Decode, currentStep, hotp } from '../src/auth/totp';
import { openDb, type Db } from '../src/db/db';
import type { PanelEnv } from '../src/env';
import { LocalServerFiles } from '../src/files/local';
import type { AgentFeed, Deps } from '../src/http/deps';
import type { ServerContext } from '../src/servers/context';
import { OrchestratorCallError, type OrchestratorClient } from '../src/servers/orchestrator';
import type { AgentTarget } from '../src/servers/registry';
import { createPanelDeps, FACTORIES, isManaged } from '../src/wiring';

export const ORIGIN = 'https://panel.test:8443';
export const OWNER = { username: 'alice', password: 'Primera-clave-2026' };

export function fakeStatus(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    agentVersion: 'test',
    bootId: 'boot-1',
    state: 'stopped',
    desired: 'stopped',
    pid: null,
    startedAt: null,
    readyAt: null,
    lastExit: null,
    failure: null,
    installedInfo: { version: '42.20.4', channel: 'public', build: '24909800' },
    players: null,
    control: { kind: 'rcon', connected: false, lastError: null },
    lock: null,
    job: null,
    recentCrashes: [],
    launch: null,
    process: null,
    disks: [],
    now: new Date().toISOString(),
    ...over,
  };
}

export class FakeFeed implements AgentFeed {
  connected = true;
  status_: AgentStatus | null = fakeStatus();
  logs: SeqEvent[] = [];
  private listeners = new Set<(e: SeqEvent) => void>();
  private seq = 0;
  recentLogs() {
    return this.logs;
  }
  onEvent(l: (e: SeqEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(event: SeqEvent['event']) {
    const e = { seq: ++this.seq, at: new Date().toISOString(), event };
    for (const l of this.listeners) l(e);
  }
}

/** Records calls; tests override methods as needed. */
export function fakeAgent(feed: FakeFeed): AgentApi & { calls: string[] } {
  const calls: string[] = [];
  const st = async () => feed.status_ ?? fakeStatus();
  return {
    calls,
    status: st,
    setLaunch: async () => (calls.push('setLaunch'), st()),
    start: async () => (calls.push('start'), st()),
    stop: async () => (calls.push('stop'), st()),
    restart: async () => (calls.push('restart'), st()),
    kill: async () => (calls.push('kill'), st()),
    command: async (c) => (calls.push(`command:${c}`), { via: 'rcon' as const, output: 'ok' }),
    install: async () => (calls.push('install'), { ok: true }),
    versions: async () => ({ installed: null, versions: [] }),
    save: async () => (calls.push('save'), { ok: true }),
    action: async (name) => {
      calls.push(`action:${name}`);
      throw new AgentCallError(404, 'not-found', `No action ${name}`);
    },
    lock: async () => ({ id: 'lock-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    renewLock: async () => undefined,
    unlock: async () => undefined,
  };
}

export const noNetwork = (() => Promise.reject(new Error('no network in tests'))) as unknown as typeof fetch;

/**
 * The orchestrator in memory (D3's API, `@gsp/shared` orchestrator-api):
 * containers by id with the spec each was created from, every call made,
 * and failures on demand.
 */
export class FakeOrchestrator implements OrchestratorClient {
  arch: CpuArch = 'amd64';
  cpus = 8;
  readonly containers = new Map<string, ServerContainer & { spec: ServerSpec; volumes: boolean }>();
  /** Volumes left behind by removals that kept them, by server id. */
  readonly keptVolumes = new Set<string>();
  readonly calls: string[] = [];
  /** The next call of a method fails with this error (once). */
  readonly failNext = new Map<keyof OrchestratorClient, OrchestratorCallError>();
  /** Every call fails with this: the orchestrator is down. */
  down: OrchestratorCallError | null = null;

  private check(method: keyof OrchestratorClient, detail = ''): void {
    this.calls.push(detail ? `${method} ${detail}` : method);
    if (this.down) throw this.down;
    const f = this.failNext.get(method);
    if (f) {
      this.failNext.delete(method);
      throw f;
    }
  }

  private get(id: string) {
    const c = this.containers.get(id);
    if (!c) throw new OrchestratorCallError(404, 'not-found', `No server ${id}`);
    return c;
  }

  private view(c: ServerContainer & { spec: ServerSpec; volumes: boolean }): ServerContainer {
    const { spec: _spec, volumes: _volumes, ...rest } = c;
    return rest;
  }

  async health() {
    this.check('health');
    return { ok: true as const, version: 'fake', api: ORCHESTRATOR_API_VERSION };
  }
  async host() {
    this.check('host');
    return { arch: this.arch, cpus: this.cpus, memBytes: 64 * 1024 ** 3, dockerVersion: 'fake', os: 'fake' };
  }
  async list() {
    this.check('list');
    return [...this.containers.values()].map((c) => this.view(c));
  }
  async apply(spec: ServerSpec) {
    this.check('apply', spec.id);
    const specHash = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
    const cur = this.containers.get(spec.id);
    if (cur?.specHash === specHash) return this.view(cur);
    const c = { id: spec.id, state: 'created' as const, startedAt: null, finishedAt: null, exitCode: null, image: `gsp/${spec.runtime}:fake`, specHash, agentUrl: `http://gsp-${spec.id}:8081`, spec, volumes: true };
    this.containers.set(spec.id, c);
    return this.view(c);
  }
  async start(id: string) {
    this.check('start', id);
    const c = this.get(id);
    c.state = 'running';
    c.startedAt = new Date().toISOString();
    return this.view(c);
  }
  async stop(id: string) {
    this.check('stop', id);
    const c = this.get(id);
    c.state = 'exited';
    return this.view(c);
  }
  async restart(id: string) {
    this.check('restart', id);
    const c = this.get(id);
    c.state = 'running';
    return this.view(c);
  }
  async stats(id: string) {
    this.check('stats', id);
    this.get(id);
    return { id, at: new Date().toISOString(), cpuPercent: 0, memBytes: 0, memLimitBytes: null, netRxBytes: 0, netTxBytes: 0 };
  }
  async remove(id: string, o: { removeVolumes: boolean }) {
    this.check('remove', `${id} volumes=${o.removeVolumes}`);
    this.get(id);
    this.containers.delete(id);
    if (!o.removeVolumes) this.keptVolumes.add(id);
    return { removed: true, volumesRemoved: o.removeVolumes };
  }
}

/** An orchestrator-run server's fakes: its agent, its live mirror, and its files on the test's disk. */
export interface FakeServer {
  agent: ReturnType<typeof fakeAgent>;
  feed: FakeFeed;
  dataDir: string;
  /** Where the registry says its agent answers, and its token. */
  target?: AgentTarget;
  /** How many times the panel asked for its agent client (once per server: rebuilt contexts reuse it). */
  made?: number;
}

export interface TestPanel {
  app: FastifyInstance;
  deps: Deps;
  feed: FakeFeed;
  agent: ReturnType<typeof fakeAgent>;
  /** The server the environment describes (`default`): its services. */
  srv: ServerContext;
  /** The orchestrator the panel was built with. */
  orch: FakeOrchestrator;
  /** The fakes of an orchestrator-run server, by id (made on first use). */
  fakes(id: string): FakeServer;
}

export async function makePanel(envOver: Partial<PanelEnv> = {}, opts: { mods?: ModSource[]; fetch?: typeof fetch; db?: Db; orch?: FakeOrchestrator; adapters?: readonly PanelAdapter[] } = {}): Promise<TestPanel> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pz-panel-'));
  const env: PanelEnv = {
    version: 'test',
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    dataDir: ':memory:',
    publicDir: null,
    agentUrl: 'http://agent.invalid',
    agentToken: 'x'.repeat(40),
    orchestrator: null,
    serverImageVariant: null,
    pzDataDir: path.join(tmp, 'data'),
    pzInstallDir: path.join(tmp, 'install'),
    backupDir: path.join(tmp, 'backups'),
    serverName: 'zomboid',
    secrets: { adminPassword: 'AdminPw-123456' },
    ports: {},
    origins: [ORIGIN],
    owner: OWNER,
    trustProxy: 'loopback',
    clientIpTrustworthy: false,
    secureCookies: true,
    ...envOver,
  };
  const db = opts.db ?? openDb(':memory:');
  const feed = new FakeFeed();
  const agent = fakeAgent(feed);
  const orch = opts.orch ?? new FakeOrchestrator();
  const servers = new Map<string, FakeServer>();
  const fakes = (id: string): FakeServer => {
    let s = servers.get(id);
    if (!s) {
      const f = new FakeFeed();
      s = { agent: fakeAgent(f), feed: f, dataDir: path.join(tmp, 'servers', id, 'data') };
      servers.set(id, s);
    }
    return s;
  };
  // The same construction as main.ts, without the network (Discord, the Steam Workshop API, Docker).
  const deps = createPanelDeps({
    env,
    db,
    agent,
    feed,
    fetch: opts.fetch ?? noNetwork,
    mods: opts.mods ?? [createWorkshopSource({ fetch: noNetwork })],
    orchestrator: orch,
    adapters: opts.adapters,
    // Orchestrator-run servers: fake agents, and their files (as the panel sees them once M2-C lands) on the test's disk.
    factories: {
      agent: (row, target) => Object.assign(fakes(row.id), { target, made: (fakes(row.id).made ?? 0) + 1 }),
      files: (row, target, e) => (isManaged(row) ? new LocalServerFiles({ data: fakes(row.id).dataDir, install: path.join(tmp, 'servers', row.id, 'install') }) : FACTORIES.files(row, target, e)),
      dataDir: (row, e) => (isManaged(row) ? fakes(row.id).dataDir : FACTORIES.dataDir(row, e)),
    },
  });
  await bootstrapOwner(deps);
  const app = await buildApp(deps);
  return { app, deps, feed, agent, srv: deps.servers.get('default')!, orch, fakes };
}

/** A tiny cookie-jar client that behaves like the web UI (Origin + CSRF header). */
export class Client {
  cookie: string | null = null;
  csrf: string | null = null;

  constructor(
    private readonly app: FastifyInstance,
    private readonly origin: string | null = ORIGIN,
  ) {}

  async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, extra: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { ...extra };
    if (this.origin) headers.origin = this.origin;
    if (this.cookie) headers.cookie = `${SESSION_COOKIE}=${this.cookie}`;
    if (this.csrf && method !== 'GET') headers['x-gsp-csrf'] = this.csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.app.inject({ method, url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.cookies.find((c) => c.name === SESSION_COOKIE);
    if (set) this.cookie = set.value || null;
    if (res.statusCode < 300 && res.headers['content-type']?.toString().includes('json')) {
      const j = res.json() as { csrf?: string };
      if (j && typeof j === 'object' && 'csrf' in j && j.csrf) this.csrf = j.csrf;
    }
    return res;
  }

  get(url: string) {
    return this.req('GET', url);
  }
  post(url: string, body: unknown = {}) {
    return this.req('POST', url, body);
  }
}

/** A valid code for the step after the current one (never replays the enrolment step). */
export function totpCode(secret: string, offsetSteps = 1): string {
  return hotp(base32Decode(secret), currentStep() + offsetSteps);
}

/** Sign in as the owner and finish the forced password change and 2FA enrolment. */
export async function ownerReady(p: TestPanel): Promise<{ client: Client; secret: string; password: string; recoveryCodes: string[] }> {
  const c = new Client(p.app);
  await c.post('/api/auth/login', OWNER);
  const password = 'Nueva-clave-segura-2026';
  await c.post('/api/auth/password', { current: OWNER.password, next: password });
  const setup = (await c.post('/api/auth/totp/setup')).json() as { secret: string };
  const enabled = (await c.post('/api/auth/totp/enable', { code: totpCode(setup.secret, 0) })).json() as { recoveryCodes: string[] };
  return { client: c, secret: setup.secret, password, recoveryCodes: enabled.recoveryCodes };
}

/**
 * A friend signed in and ready: password changed, 2FA enrolled when their
 * role needs it. With `grants`, an account of scope `granted` holding those
 * roles (a bare role: on `default`; `null`: on nothing).
 */
export async function friend(p: TestPanel, owner: Client, name: string, role: 'viewer' | 'operator' | 'admin', grants?: GrantRole | Record<string, GrantRole> | null): Promise<Client> {
  const created = (await owner.post('/api/users', { username: name, password: 'Temporal-12345', role })).json() as { id: number };
  if (grants !== undefined) {
    p.deps.users.setScope(created.id, 'granted');
    const byServer = grants === null ? {} : typeof grants === 'string' ? { default: grants } : grants;
    for (const [sid, r] of Object.entries(byServer)) p.deps.grants.set(created.id, sid, r);
    syncRoleWithGrants(p.deps.users, p.deps.grants, created.id);
  }
  const c = new Client(p.app);
  await c.post('/api/auth/login', { username: name, password: 'Temporal-12345' });
  const after = (await c.post('/api/auth/password', { current: 'Temporal-12345', next: 'La-mia-propia-2026' })).json() as { pending: string | null };
  if (after.pending === 'enrol') {
    const { secret } = (await c.post('/api/auth/totp/setup')).json() as { secret: string };
    await c.post('/api/auth/totp/enable', { code: totpCode(secret, 0) });
  }
  return c;
}

/** What a websocket received, parsed. */
export type WsSeen = { type: string; serverId?: string; servers?: { serverId: string }[] } & Record<string, unknown>;

/** Opens the websocket as `c` and collects what it receives. */
export async function listenWs(p: TestPanel, c: Client): Promise<{ ws: { terminate(): void }; messages: WsSeen[] }> {
  await p.app.ready();
  const messages: WsSeen[] = [];
  const ws = await p.app.injectWS('/api/ws', { headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${c.cookie}` } }, {
    onInit: (sock) => sock.on('message', (d) => messages.push(JSON.parse(d.toString()) as WsSeen)),
  });
  await until(() => messages.length > 0);
  return { ws, messages };
}

/** Waits until `ok()` holds (at most `ms`, scaled like every test timeout); throws when it never does. */
export async function until(ok: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms * Number(process.env.TEST_TIME_SCALE || 1);
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}
