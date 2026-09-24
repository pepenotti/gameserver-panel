import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LaunchParams } from '@pz/shared';

/** What the agent must remember across container restarts. */
export interface PersistedState {
  desired: 'running' | 'stopped';
  launch: LaunchParams | null;
  /** Generated once; only the agent ever speaks RCON. */
  rconPassword: string;
  gameVersion: string | null;
}

export class StateStore {
  private readonly file: string;
  private state: PersistedState;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'state.json');
    this.state = this.load();
  }

  private load(): PersistedState {
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PersistedState>;
      return {
        desired: s.desired === 'running' ? 'running' : 'stopped',
        launch: s.launch ?? null,
        rconPassword: s.rconPassword && s.rconPassword.length >= 24 ? s.rconPassword : randomBytes(24).toString('hex'),
        gameVersion: s.gameVersion ?? null,
      };
    } catch {
      const fresh: PersistedState = { desired: 'stopped', launch: null, rconPassword: randomBytes(24).toString('hex'), gameVersion: null };
      this.write(fresh);
      return fresh;
    }
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

  update(patch: Partial<PersistedState>): void {
    this.state = { ...this.state, ...patch };
    this.write(this.state);
  }
}
