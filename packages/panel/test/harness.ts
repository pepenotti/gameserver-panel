import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { AgentStatus, SeqEvent } from '@pz/shared';
import type { AgentApi } from '../src/agent/client';
import { buildApp } from '../src/app';
import { Audit } from '../src/audit';
import { bootstrapOwner } from '../src/auth/bootstrap';
import { Sessions, SESSION_COOKIE } from '../src/auth/sessions';
import { GlobalBreaker } from '../src/auth/throttle';
import { base32Decode, currentStep, hotp } from '../src/auth/totp';
import { Users } from '../src/auth/users';
import { openDb } from '../src/db/db';
import type { PanelEnv } from '../src/env';
import type { AgentFeed, Deps } from '../src/http/deps';
import { BackupFlows } from '../src/backups/flows';
import { backupPanelDb } from '../src/backups/panel-db';
import { BackupService } from '../src/backups/service';
import { ConfigService } from '../src/config/service';
import { Control } from '../src/control/control';
import { PanelBus } from '../src/ops/bus';
import { OpRunner } from '../src/ops/runner';
import { ModsService } from '../src/mods/service';
import { DiscordNotifier } from '../src/notifier/discord';
import { wireNotifications } from '../src/notifier/events';
import { Scheduler } from '../src/scheduler/scheduler';
import { SteamWorkshop } from '../src/mods/steam';
import { PlayersService } from '../src/players/service';
import { Settings } from '../src/settings';

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
    gameVersion: '42.20.4',
    installed: { buildId: '24909800', branch: 'public' },
    players: null,
    rcon: { connected: false, lastError: null },
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
    appInfo: async () => ({ installed: null, branches: [] }),
    downloadWorkshop: async () => ({ ok: true }),
    lock: async () => ({ id: 'lock-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    renewLock: async () => undefined,
    unlock: async () => undefined,
  };
}

export interface TestPanel {
  app: FastifyInstance;
  deps: Deps;
  feed: FakeFeed;
  agent: ReturnType<typeof fakeAgent>;
}

export async function makePanel(envOver: Partial<PanelEnv> = {}, opts: { steam?: SteamWorkshop; fetch?: typeof fetch } = {}): Promise<TestPanel> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pz-panel-'));
  const env: PanelEnv = {
    version: 'test',
    host: '127.0.0.1',
    port: 0,
    dataDir: ':memory:',
    publicDir: null,
    agentUrl: 'http://agent.invalid',
    agentToken: 'x'.repeat(40),
    pzDataDir: path.join(tmp, 'data'),
    pzInstallDir: path.join(tmp, 'install'),
    backupDir: path.join(tmp, 'backups'),
    serverName: 'zomboid',
    pzAdminPassword: 'AdminPw-123456',
    origins: [ORIGIN],
    owner: OWNER,
    trustProxy: 'loopback',
    clientIpTrustworthy: false,
    secureCookies: true,
    ...envOver,
  };
  const db = openDb(':memory:');
  const feed = new FakeFeed();
  const agent = fakeAgent(feed);
  const audit = new Audit(db);
  const settings = new Settings(db);
  const bus = new PanelBus();
  const ops = new OpRunner(bus);
  const deps: Deps = {
    env,
    db,
    users: new Users(db),
    sessions: new Sessions(db),
    audit,
    settings,
    breaker: new GlobalBreaker(),
    agent,
    feed,
    bus,
    ops,
    control: new Control({ env, settings, agent, feed, ops, audit }),
    config: new ConfigService({ env, db, agent, feed, settings }),
    backups: new BackupService({ env, feed }),
    flows: undefined as unknown as BackupFlows,
    players: new PlayersService({ env, db, agent, feed }),
    mods: undefined as unknown as ModsService,
    notifier: new DiscordNotifier(settings, opts.fetch ?? ((() => Promise.reject(new Error('no network in tests'))) as unknown as typeof fetch)),
    scheduler: undefined as unknown as Scheduler,
  };
  deps.mods = new ModsService({ env, db, agent, feed, ops, settings, config: deps.config, steam: opts.steam ?? new SteamWorkshop(() => Promise.reject(new Error('no network in tests'))) });
  deps.flows = new BackupFlows({ agent, feed, ops, control: deps.control, backups: deps.backups, settings, config: deps.config, pzDataDir: env.pzDataDir });
  deps.scheduler = new Scheduler({ settings, agent, feed, ops, control: deps.control, flows: deps.flows, backups: deps.backups, mods: deps.mods, notifier: deps.notifier, audit, backupPanelDb: () => backupPanelDb(db, deps.env.backupDir) });
  wireNotifications({ feed, players: deps.players, bus, notifier: deps.notifier });
  deps.players.attach();
  deps.control.onBeforeStart = () => deps.config.seedIniIfMissing();
  await bootstrapOwner(deps);
  const app = await buildApp(deps);
  return { app, deps, feed, agent };
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
    if (this.csrf && method !== 'GET') headers['x-pz-csrf'] = this.csrf;
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
