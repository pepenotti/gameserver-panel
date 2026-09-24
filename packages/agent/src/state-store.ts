import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Launch params as the panel last set them, for one adapter (validated by it when read). */
export interface StoredLaunch {
  adapter: string;
  params: unknown;
}

/** Name of the control channel's secret in `PersistedState.secrets` (`RuntimeState.controlSecret`). */
export const CONTROL_SECRET = 'control';

/** What the agent must remember across container restarts. */
export interface PersistedState {
  desired: 'running' | 'stopped';
  launch: StoredLaunch | null;
  /** Secrets the agent generated, by name; generated once, only the agent uses them. */
  secrets: Record<string, string>;
  gameVersion: string | null;
}

const MIN_SECRET = 24;

function freshSecret(): string {
  return randomBytes(24).toString('hex');
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export class StateStore {
  private readonly file: string;
  private state: PersistedState;

  /**
   * `adapter` is the agent's adapter id: a launch stored before the agent ran
   * adapters (bare params) belongs to it.
   */
  constructor(
    dir: string,
    private readonly o: { adapter: string },
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'state.json');
    this.state = this.load();
  }

  private load(): PersistedState {
    let raw: Record<string, unknown>;
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      raw = isObject(v) ? v : {};
    } catch {
      const fresh: PersistedState = { desired: 'stopped', launch: null, secrets: { [CONTROL_SECRET]: freshSecret() }, gameVersion: null };
      this.write(fresh);
      return fresh;
    }
    let migrated = false;
    const secrets: Record<string, string> = {};
    if (isObject(raw.secrets)) for (const [k, v] of Object.entries(raw.secrets)) if (typeof v === 'string' && v.length >= MIN_SECRET) secrets[k] = v;
    // Before M1 the only secret was the RCON password, in its own field.
    if ('rconPassword' in raw) {
      migrated = true;
      if (!secrets[CONTROL_SECRET] && typeof raw.rconPassword === 'string' && raw.rconPassword.length >= MIN_SECRET) secrets[CONTROL_SECRET] = raw.rconPassword;
    }
    if (!secrets[CONTROL_SECRET]) {
      secrets[CONTROL_SECRET] = freshSecret();
      migrated = true;
    }
    let launch: StoredLaunch | null = null;
    if (isObject(raw.launch)) {
      if (typeof raw.launch.adapter === 'string' && 'params' in raw.launch) launch = { adapter: raw.launch.adapter, params: raw.launch.params };
      else {
        // Bare launch params from before the agent ran adapters.
        launch = { adapter: this.o.adapter, params: raw.launch };
        migrated = true;
      }
    }
    const state: PersistedState = {
      desired: raw.desired === 'running' ? 'running' : 'stopped',
      launch,
      secrets,
      gameVersion: typeof raw.gameVersion === 'string' ? raw.gameVersion : null,
    };
    if (migrated) this.write(state);
    return state;
  }

  private write(s: PersistedState): void {
    // Atomic replace: a crash mid-write must not lose the launch params.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get(): Readonly<PersistedState> {
    return this.state;
  }

  /** The control channel's secret (`RuntimeState.controlSecret`). */
  get controlSecret(): string {
    return this.state.secrets[CONTROL_SECRET]!;
  }

  update(patch: Partial<PersistedState>): void {
    this.state = { ...this.state, ...patch };
    this.write(this.state);
  }
}
