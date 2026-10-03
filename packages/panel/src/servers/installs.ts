// Shared installs, panel side (HST-09, D12): which installs exist and what
// each holds, finding the one a server's launch wants, and driving the jobs
// that fill new ones through the orchestrator (D3) and the job's agent. A
// game's files are downloaded once per game, flavour and version: a second
// server gets the install the first one has (or waits for the one being
// installed), an update starts from a local copy of the install it
// replaces, and a server's own install from before shared installs is
// adopted by a local copy. The servers registry decides which server runs
// from which install; this module never touches a server's container.
import { randomBytes } from 'node:crypto';
import { keyFits, type InstallJobSpec, type InstallKey, type InstallPutOptions, type InstallWanted, type LaunchEnvelope, type RuntimeFamily, type SharedInstallMarker } from '@gsp/shared';
import type { AgentApi } from '../agent/client';
import type { Actor, Audit } from '../audit';
import { nowIso, type Db } from '../db/db';
import { HttpError } from '../http/context';
import { OrchestratorCallError, type OrchestratorClient } from './orchestrator';

/** `installing`: its job runs (or will again); `ready`: a job finished it; `failed`: its job failed (a retry runs it again); `removing`: on its way out. */
export type InstallState = 'installing' | 'ready' | 'failed' | 'removing';

/** The game an install holds, as its servers' specs name it: what the orchestrator checks a server against before mounting it. */
export interface InstallGame {
  adapter: string;
  flavour: string | null;
  runtime: RuntimeFamily;
  /** The image variant (`SERVER_IMAGE_VARIANT`), null for the real images. */
  variant: string | null;
}

/** An install as the panel keeps it (`installs`). */
export interface InstallRow extends InstallGame {
  /** `INSTALL_ID_PATTERN`; names its volume and job. */
  id: string;
  /** What it was made for, and what else wanted the files it holds (a job that found the same thing). */
  wanted: InstallWanted[];
  /** What it holds, from the shared-install marker its job wrote; null until it is ready. */
  key: InstallKey | null;
  state: InstallState;
  /** What it was filled from: null downloaded; an install id (an update starts from a copy of the install it replaces); `server:<id>` (a server's own install, adopted). */
  source: string | null;
  bytes: number | null;
  files: number | null;
  marker: SharedInstallMarker | null;
  /** Why its job failed. */
  error: string | null;
  /** The install an update replaced it with: new servers never get it. */
  supersededBy: string | null;
  createdAt: string;
  createdBy: number | null;
  readyAt: string | null;
}

/** Where an install's job is, while one runs. */
export interface InstallProgress {
  /** `copy`: a local copy (of the install an update replaces, or of a server's own); `install`: the install job. */
  phase: 'copy' | 'install';
  /** 0-100, when the job says. */
  progress: number | null;
  /** What the job says it is doing. */
  message: string;
}

/** A server's own install volume, left over once it moved to a shared install, until the owner removes it (`install_leftovers`). */
export interface LeftoverRow {
  serverId: string;
  bytes: number | null;
  files: number | null;
  since: string;
}

interface DbInstall {
  id: string;
  adapter: string;
  flavour: string | null;
  runtime: string;
  variant: string | null;
  wanted: string;
  key: string | null;
  state: InstallState;
  source: string | null;
  bytes: number | null;
  files: number | null;
  marker: string | null;
  error: string | null;
  superseded_by: string | null;
  created_at: string;
  created_by: number | null;
  ready_at: string | null;
}

const parse = <T>(text: string | null): T | null => (text === null ? null : (JSON.parse(text) as T));

function toRow(r: DbInstall): InstallRow {
  return {
    id: r.id,
    adapter: r.adapter,
    flavour: r.flavour,
    runtime: r.runtime as RuntimeFamily,
    variant: r.variant,
    wanted: parse<InstallWanted[]>(r.wanted) ?? [],
    key: parse<InstallKey>(r.key),
    state: r.state,
    source: r.source,
    bytes: r.bytes,
    files: r.files,
    marker: parse<SharedInstallMarker>(r.marker),
    error: r.error,
    supersededBy: r.superseded_by,
    createdAt: r.created_at,
    createdBy: r.created_by,
    readyAt: r.ready_at,
  };
}

/** What `InstallsStore.set` changes. */
type InstallPatch = Partial<Pick<InstallRow, 'wanted' | 'key' | 'state' | 'source' | 'bytes' | 'files' | 'marker' | 'error' | 'supersededBy' | 'readyAt'>>;

const COLUMN: Record<keyof InstallPatch, string> = {
  wanted: 'wanted',
  key: 'key',
  state: 'state',
  source: 'source',
  bytes: 'bytes',
  files: 'files',
  marker: 'marker',
  error: 'error',
  supersededBy: 'superseded_by',
  readyAt: 'ready_at',
};

/** The `installs` and `install_leftovers` tables. */
export class InstallsStore {
  constructor(private readonly db: Db) {}

  list(): InstallRow[] {
    return (this.db.prepare('SELECT * FROM installs ORDER BY created_at, id').all() as unknown as DbInstall[]).map(toRow);
  }

  get(id: string): InstallRow | null {
    const r = this.db.prepare('SELECT * FROM installs WHERE id = ?').get(id) as DbInstall | undefined;
    return r ? toRow(r) : null;
  }

  insert(row: InstallRow): InstallRow {
    this.db
      .prepare('INSERT INTO installs (id, adapter, flavour, runtime, variant, wanted, key, state, source, bytes, files, marker, error, superseded_by, created_at, created_by, ready_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        row.id,
        row.adapter,
        row.flavour,
        row.runtime,
        row.variant,
        JSON.stringify(row.wanted),
        row.key ? JSON.stringify(row.key) : null,
        row.state,
        row.source,
        row.bytes,
        row.files,
        row.marker ? JSON.stringify(row.marker) : null,
        row.error,
        row.supersededBy,
        row.createdAt,
        row.createdBy,
        row.readyAt,
      );
    return this.get(row.id)!;
  }

  set(id: string, patch: InstallPatch): InstallRow | null {
    for (const [k, v] of Object.entries(patch) as [keyof InstallPatch, unknown][]) {
      const value = v === null || v === undefined ? null : k === 'wanted' || k === 'key' || k === 'marker' ? JSON.stringify(v) : (v as string | number);
      this.db.prepare(`UPDATE installs SET ${COLUMN[k]} = ? WHERE id = ?`).run(value, id);
    }
    return this.get(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM installs WHERE id = ?').run(id);
  }

  leftovers(): LeftoverRow[] {
    return (this.db.prepare('SELECT server_id, bytes, files, since FROM install_leftovers ORDER BY since, server_id').all() as { server_id: string; bytes: number | null; files: number | null; since: string }[]).map((r) => ({
      serverId: r.server_id,
      bytes: r.bytes,
      files: r.files,
      since: r.since,
    }));
  }

  addLeftover(serverId: string, size: { bytes: number | null; files: number | null }): void {
    this.db.prepare('INSERT OR REPLACE INTO install_leftovers (server_id, bytes, files, since) VALUES (?,?,?,?)').run(serverId, size.bytes, size.files, nowIso());
  }

  dropLeftover(serverId: string): void {
    this.db.prepare('DELETE FROM install_leftovers WHERE server_id = ?').run(serverId);
  }
}

/** Two wanted installs are the same request (the channel included). */
export function sameWanted(a: InstallWanted, b: InstallWanted): boolean {
  return a.flavour === b.flavour && a.version === b.version && a.build === b.build && a.branch === b.branch && (a.channel ?? null) === (b.channel ?? null);
}

/** Two installs hold the same files: equal keys. */
export function sameKey(a: InstallKey | null, b: InstallKey | null): boolean {
  return !!a && !!b && a.flavour === b.flavour && a.version === b.version && a.build === b.build && a.branch === b.branch;
}

const sameGame = (a: InstallGame, b: InstallGame) => a.adapter === b.adapter && a.flavour === b.flavour && a.runtime === b.runtime && a.variant === b.variant;

/** An install id: `i` and 16 random hex digits (`INSTALL_ID_PATTERN`). */
export const newInstallId = () => `i${randomBytes(8).toString('hex')}`;

export interface InstallManagerDeps {
  db: Db;
  orchestrator: OrchestratorClient;
  audit: Audit;
  /** An install job's agent, at its address with its token (production: an `AgentClient`; tests: fakes). */
  jobAgent(url: string, token: string): AgentApi;
  /** tz database name the jobs run in, as servers do. */
  tz: string;
  /**
   * An install the manager ran settled: `result` is the install servers
   * that waited for `id` run from now (it, or another that holds the same
   * files), or null when its job failed.
   */
  settled(id: string, result: InstallRow | null): void;
  /** How often a job's progress and a copy are looked at, ms (default 1000). */
  pollMs?: number;
  /** How long a job's agent gets to answer once its container started, ms (default 120 s). */
  agentWaitMs?: number;
}

/** How a job is run. */
export interface RunOptions {
  by: Actor;
  /** The server it runs for (its audit entries name it). */
  serverId: string | null;
  /** A file check (Steam's validate) on a copy: what it makes replaces the install it was copied from, even when it holds the same thing. */
  validate?: boolean;
}

/** Every refusal the orchestrator words for an install's state, as the API answers it. */
export function installRefusal(e: unknown): HttpError | null {
  if (!(e instanceof OrchestratorCallError) || !e.reason) return null;
  return new HttpError(409, e.reason, e.message, { message: e.message });
}

/**
 * The installs of this panel and their jobs (HST-09, D12). One job per
 * install at a time; a server asking for what an install being made will
 * hold waits for it instead of starting another.
 */
export class InstallManager {
  readonly store: InstallsStore;
  /** Jobs running in this process, by install id. */
  private readonly running = new Map<string, Promise<InstallRow>>();
  private readonly progressOf = new Map<string, InstallProgress>();
  /** Whether the orchestrator has shared installs; null until it was asked. */
  private supported: boolean | null = null;

  constructor(private readonly d: InstallManagerDeps) {
    this.store = new InstallsStore(d.db);
  }

  private get pollMs(): number {
    return this.d.pollMs ?? 1000;
  }

  /**
   * Whether this orchestrator has shared installs (an older one answers
   * `not-found`, and then servers keep installs of their own); throws when
   * it can't be asked the first time.
   */
  async available(): Promise<boolean> {
    try {
      await this.d.orchestrator.installs();
      this.supported = true;
    } catch (e) {
      if (e instanceof OrchestratorCallError && (e.code === 'not-found' || e.code === 'not-implemented')) this.supported = false;
      else if (this.supported === null) throw e;
    }
    return this.supported;
  }

  /** What the orchestrator said last (false until it was asked). */
  get knownAvailable(): boolean {
    return this.supported === true;
  }

  get(id: string): InstallRow | null {
    return this.store.get(id);
  }

  list(): InstallRow[] {
    return this.store.list();
  }

  /** Where its job is, while one runs in this panel. */
  progress(id: string): InstallProgress | null {
    return this.progressOf.get(id) ?? null;
  }

  /** Whether its job runs in this panel now. */
  busy(id: string): boolean {
    return this.running.has(id);
  }

  /**
   * Whether an install is for `game` and fits `w`: a ready one by what it
   * holds (its key) and the channel it was made for; one being made by what
   * it was made for.
   */
  fits(row: InstallRow, game: InstallGame, w: InstallWanted): boolean {
    if (!sameGame(row, game)) return false;
    if (row.key) return keyFits(row.key, w) && row.wanted.some((x) => (x.channel ?? null) === (w.channel ?? null));
    return row.wanted.some((x) => sameWanted(x, w));
  }

  /**
   * The ready install a server of `game` wanting `w` gets: never one an
   * update replaced; one a download or an update made before one adopted
   * from a server's own install; the newest first.
   */
  find(game: InstallGame, w: InstallWanted): InstallRow | null {
    const adopted = (r: InstallRow) => (r.source?.startsWith('server:') ? 1 : 0);
    const fit = this.store.list().filter((r) => r.state === 'ready' && r.supersededBy === null && this.fits(r, game, w));
    fit.sort((a, b) => adopted(a) - adopted(b) || (b.readyAt ?? '').localeCompare(a.readyAt ?? ''));
    return fit[0] ?? null;
  }

  /** An install of `game` being made for exactly `w` (from `source`, when given): a server waits for it rather than starting another job. */
  pending(game: InstallGame, w: InstallWanted, source?: string | null): InstallRow | null {
    const rows = this.store.list().filter((r) => r.state === 'installing' && sameGame(r, game) && r.wanted.some((x) => sameWanted(x, w)) && (source === undefined || r.source === source));
    return rows.at(-1) ?? null;
  }

  /** A new install of `game` for `w`, being installed (from `source`, when given); audited. Its job runs with `run`. */
  begin(game: InstallGame, w: InstallWanted, by: Actor, serverId: string | null, source: string | null = null): InstallRow {
    const row = this.store.insert({
      id: newInstallId(),
      ...game,
      wanted: [w],
      key: null,
      state: 'installing',
      source,
      bytes: null,
      files: null,
      marker: null,
      error: null,
      supersededBy: null,
      createdAt: nowIso(),
      createdBy: by.user?.id ?? null,
      readyAt: null,
    });
    this.d.audit.log({ actor: by, serverId, action: 'install.create', target: row.id, detail: { adapter: row.adapter, flavour: row.flavour, wanted: w, ...(source ? { from: source } : {}) } });
    return row;
  }

  /**
   * Runs install `id`'s jobs (a copy first, when it is made from another
   * install or a server's own; then the install job) with `launch`, or joins
   * the ones running. Resolves with the install servers that wanted it run
   * from now: it, or a ready one that turned out to hold the same files (the
   * new one is then removed: nothing is kept twice). Rejects when a job
   * failed; the install then says why, and running it again retries.
   */
  run(id: string, launch: LaunchEnvelope, o: RunOptions): Promise<InstallRow> {
    const busy = this.running.get(id);
    if (busy) return busy;
    const row = this.store.get(id);
    if (!row) return Promise.reject(new HttpError(409, 'install-missing', `Install ${id} is gone`));
    if (row.state === 'ready') return Promise.resolve(row);
    if (row.state === 'removing') return Promise.reject(new HttpError(409, 'install-removing', `Install ${id} is being removed`));
    if (row.state === 'failed') this.store.set(id, { state: 'installing', error: null });
    const p = this.execute(this.store.get(id)!, launch, o).then(
      (r) => {
        this.running.delete(id);
        this.d.settled(id, r);
        return r;
      },
      (e: unknown) => {
        this.running.delete(id);
        this.d.settled(id, null);
        throw e;
      },
    );
    this.running.set(id, p);
    return p;
  }

  /** Install `id` ready: as it is, once its running job ends, or after running it again (one that failed, or one a restart of the panel interrupted). */
  ensureReady(id: string, launch: () => LaunchEnvelope, o: RunOptions): Promise<InstallRow> {
    const row = this.store.get(id);
    if (row?.state === 'ready') return Promise.resolve(row);
    return this.run(id, launch(), o);
  }

  private setProgress(id: string, p: InstallProgress): void {
    this.progressOf.set(id, p);
  }

  /** The job spec: the game and the agent's token; the orchestrator derives the rest (NFR-02). */
  private jobSpec(row: InstallRow, token: string): InstallJobSpec {
    return {
      id: row.id,
      runtime: row.runtime,
      ...(row.variant ? { variant: row.variant } : {}),
      env: { AGENT_TOKEN: token, GAME_ADAPTER: row.adapter, ...(row.flavour !== null ? { GAME_FLAVOUR: row.flavour } : {}), TZ: this.d.tz },
    };
  }

  private copyFrom(row: InstallRow): InstallPutOptions | null {
    if (!row.source) return null;
    return row.source.startsWith('server:') ? { fromServer: row.source.slice('server:'.length) } : { from: row.source };
  }

  private async execute(row: InstallRow, launch: LaunchEnvelope, o: RunOptions): Promise<InstallRow> {
    const id = row.id;
    const orch = this.d.orchestrator;
    try {
      // Whatever an earlier attempt left running goes first (a job is killed where it stands: an install without a marker is never mounted).
      await orch.removeInstallJob(id).catch(() => undefined);
      const copy = this.copyFrom(row);
      if (copy) {
        this.setProgress(id, { phase: 'copy', progress: null, message: '' });
        // A copy goes into a new install: an earlier attempt's half copy goes first.
        await orch.removeInstall(id).catch(() => undefined);
        await orch.putInstall(this.jobSpec(row, randomBytes(32).toString('base64url')), copy);
        await this.copied(id);
        await orch.removeInstallJob(id);
      }
      this.setProgress(id, { phase: 'install', progress: null, message: '' });
      const token = randomBytes(32).toString('base64url');
      const info = await orch.putInstall(this.jobSpec(row, token));
      const url = info.job?.agentUrl;
      if (!url) throw new Error('The install job has no agent to drive');
      const agent = this.d.jobAgent(url, token);
      await this.agentUp(id, agent);
      await agent.setLaunch(launch);
      const marker = await this.install(id, agent, o.validate === true);
      await orch.removeInstallJob(id).catch(() => undefined);
      if (marker.adapter !== row.adapter || marker.flavour !== row.flavour) throw new Error(`The install job installed ${marker.adapter}${marker.flavour ? `/${marker.flavour}` : ''}, not ${row.adapter}${row.flavour ? `/${row.flavour}` : ''}`);
      return await this.finish(row, marker, o);
    } catch (e) {
      await orch.removeInstallJob(id).catch(() => undefined);
      const err = installRefusal(e) ?? (e as Error);
      const message = err.message || 'The install job failed';
      this.store.set(id, { state: 'failed', error: message.slice(0, 500) });
      this.d.audit.log({ actor: o.by, serverId: o.serverId, action: 'install.failed', target: id, detail: { adapter: row.adapter, flavour: row.flavour, error: message.slice(0, 500) }, ok: false });
      throw err;
    } finally {
      this.progressOf.delete(id);
    }
  }

  /** Until the copy job exited: exit 0 is a copy. */
  private async copied(id: string): Promise<void> {
    const end = Date.now() + 2 * 3_600_000;
    for (;;) {
      const job = (await this.d.orchestrator.installs()).find((i) => i.id === id)?.job ?? null;
      if (!job) throw new Error('The copy job is gone');
      if (job.state === 'exited' || job.state === 'dead') {
        if (job.exitCode === 0) return;
        throw new Error(`The copy failed (exit ${job.exitCode ?? '?'})`);
      }
      if (Date.now() > end) throw new Error('The copy did not finish within 2 hours');
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  /** Until the job's agent answers; a job whose container stopped meanwhile (its agent never will) fails at once. */
  private async agentUp(id: string, agent: AgentApi): Promise<void> {
    const end = Date.now() + (this.d.agentWaitMs ?? 120_000);
    for (let n = 0; ; n++) {
      try {
        await agent.status();
        return;
      } catch {
        if (Date.now() > end) throw new Error("The install job's agent did not answer");
      }
      if (n % 3 === 2) {
        const job = (await this.d.orchestrator.installs().catch(() => null))?.find((i) => i.id === id)?.job;
        if (job === null) throw new Error('The install job is gone');
        if (job && (job.state === 'exited' || job.state === 'dead')) throw new Error(`The install job stopped before its agent answered (exit ${job.exitCode ?? '?'})`);
      }
      await new Promise((r) => setTimeout(r, Math.min(this.pollMs, 1000)));
    }
  }

  /**
   * The job's install: its progress followed on its status meanwhile. An
   * install that outlives the HTTP request (a big download) is followed on
   * its status until the job ends. Resolves with the marker it wrote.
   */
  private async install(id: string, agent: AgentApi, validate: boolean): Promise<SharedInstallMarker> {
    let stop = false;
    const follow = (async () => {
      while (!stop) {
        const s = await agent.status().catch(() => null);
        if (s?.job) this.setProgress(id, { phase: 'install', progress: s.job.progress, message: s.job.message });
        await new Promise((r) => setTimeout(r, this.pollMs));
      }
    })();
    let outcome: { ok: boolean; error?: string } | null = null;
    try {
      outcome = await agent.install({ validate });
    } catch (e) {
      // The request gave up (a long install outlives an HTTP request); the job goes on in the agent: follow it.
      const end = Date.now() + 6 * 3_600_000;
      for (;;) {
        const s = await agent.status().catch(() => null);
        if (s && !s.job && s.state !== 'installing') {
          if (!s.install?.marker) throw new Error(`The install job failed: ${(e as Error).message}`, { cause: e });
          break;
        }
        if (Date.now() > end) throw new Error('The install job did not finish within 6 hours', { cause: e });
        await new Promise((r) => setTimeout(r, this.pollMs));
      }
    } finally {
      stop = true;
      await follow;
    }
    if (outcome && !outcome.ok) throw new Error(outcome.error ?? 'The install job failed');
    const marker = (await agent.status()).install?.marker ?? null;
    if (!marker) throw new Error('The install job finished without writing what it installed');
    return marker;
  }

  /**
   * A finished job: the install is ready, unless a ready install of the
   * same game already holds the same files (two servers asked differently
   * for the same thing, an update that found nothing new, a server's own
   * install that matches one already shared). Then that one is kept, and
   * serves what this one was made for; this one is removed. A file check
   * (`validate`) always keeps what it made: it replaces its source.
   */
  private async finish(row: InstallRow, marker: SharedInstallMarker, o: RunOptions): Promise<InstallRow> {
    const same = o.validate ? null : this.store.list().find((x) => x.id !== row.id && x.state === 'ready' && sameGame(x, row) && sameKey(x.key, marker.key));
    if (same) {
      const wanted = [...same.wanted];
      for (const w of row.wanted) if (!wanted.some((x) => sameWanted(x, w))) wanted.push(w);
      // What an update finds is current, even when an older update had replaced it.
      const kept = this.store.set(same.id, { wanted, ...(row.source === same.id ? {} : { supersededBy: null }) })!;
      this.store.set(row.id, { state: 'removing' });
      this.d.audit.log({ actor: o.by, serverId: o.serverId, action: 'install.ready', target: row.id, detail: { adapter: row.adapter, flavour: row.flavour, key: marker.key, sameAs: same.id } });
      await this.drop(row.id);
      return kept;
    }
    const ready = this.store.set(row.id, { state: 'ready', key: marker.key, marker, bytes: marker.bytes, files: marker.files, error: null, readyAt: nowIso() })!;
    this.d.audit.log({ actor: o.by, serverId: o.serverId, action: 'install.ready', target: row.id, detail: { adapter: row.adapter, flavour: row.flavour, key: marker.key, bytes: marker.bytes, files: marker.files } });
    return ready;
  }

  /** Removes an install nothing uses (its volume, then its row); one the orchestrator won't remove now stays `removing`, tried again at the panel's next start. */
  private async drop(id: string): Promise<void> {
    try {
      await this.d.orchestrator.removeInstall(id);
      this.store.delete(id);
    } catch {
      // Left `removing`: `resume` tries again.
    }
  }

  /**
   * An install made for a server that won't use it (a move off its own
   * install that failed): its volume and row go. Never one a server mounts:
   * the orchestrator refuses that.
   */
  async discard(id: string): Promise<void> {
    if (this.running.has(id)) await this.running.get(id)!.catch(() => undefined);
    await this.d.orchestrator.removeInstallJob(id).catch(() => undefined);
    this.store.set(id, { state: 'removing' });
    await this.drop(id);
  }

  /** An update replaced `id` with `by`: new servers get `by` from now on. */
  supersede(id: string, by: string): void {
    if (id !== by) this.store.set(id, { supersededBy: by });
  }

  /**
   * The owner removes an install no server uses (HST-09: only after they
   * confirm). Refused while its job runs (`install-busy`) or a server uses
   * or mounts it (`install-in-use`, naming them).
   */
  async remove(id: string, usedBy: readonly string[], by: Actor, ip: string | null): Promise<void> {
    const row = this.store.get(id);
    if (!row) throw new HttpError(404, 'install-not-found');
    if (row.state === 'installing' || this.running.has(id)) throw new HttpError(409, 'install-busy', `Install ${id} is being installed`);
    if (usedBy.length) throw new HttpError(409, 'install-in-use', `Install ${id} is used by ${usedBy.join(', ')}`, { servers: [...usedBy] });
    const before = row.state;
    this.store.set(id, { state: 'removing' });
    try {
      await this.d.orchestrator.removeInstall(id);
    } catch (e) {
      this.store.set(id, { state: before });
      const refusal = installRefusal(e);
      if (refusal) throw refusal;
      throw e;
    }
    this.store.delete(id);
    this.d.audit.log({ actor: by, ip, action: 'install.remove', target: id, detail: { adapter: row.adapter, flavour: row.flavour, key: row.key, bytes: row.bytes } });
  }

  /**
   * After the panel starts: installs being removed are removed, and installs
   * whose job a restart interrupted run again, with the launch of a server
   * that waits for each (`launchFor`); one nobody waits for any more fails,
   * and can be removed.
   */
  resume(launchFor: (row: InstallRow) => { launch: LaunchEnvelope; serverId: string } | null, by: Actor): void {
    for (const row of this.store.list()) {
      if (row.state === 'removing') {
        void this.drop(row.id);
        continue;
      }
      if (row.state !== 'installing' || this.running.has(row.id)) continue;
      // A move off a server's own install that a restart interrupted is made again at that server's next start: this half copy goes.
      if (row.source?.startsWith('server:')) {
        void this.discard(row.id);
        continue;
      }
      const who = launchFor(row);
      if (!who) {
        this.store.set(row.id, { state: 'failed', error: 'The panel restarted while it was being installed, and no server waits for it any more' });
        continue;
      }
      void this.run(row.id, who.launch, { by, serverId: who.serverId }).catch(() => undefined);
    }
  }
}
