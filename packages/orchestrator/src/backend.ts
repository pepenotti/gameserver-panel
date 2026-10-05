import type { ApplyOptions, DeleteResponse, HostInfo, HostUsage, InstallDeleteResponse, InstallInfo, InstallJobSpec, ServerContainer, ServerSpec, ServerStats } from '@gsp/shared';
import { conflict } from './errors';
import type { CopySource } from './installs';

/**
 * What the HTTP API drives, one method per route: Docker in production
 * (`DockerBackend`), local agent processes in the fake orchestrator of the
 * development loop. Specs arrive validated (`parseSpec`); ids match
 * `SERVER_ID_PATTERN`.
 */
export interface Backend {
  /** Resolves when the backend can work; throws `unavailable` otherwise. */
  ping(): Promise<void>;
  host(): Promise<HostInfo>;
  /** This stack's server containers (a stats sample of each that runs) and volumes (their disk use), never another stack's (HST-03). */
  usage(): Promise<HostUsage>;
  list(): Promise<ServerContainer[]>;
  /**
   * Create or recreate (volumes kept); never starts the container. A
   * container that matches the spec is recreated only for a newer runtime
   * image (not with `keepImage`), or when this release derives it
   * differently (not with `keepDerivation`, unless for a security fix).
   */
  apply(spec: ServerSpec, o?: ApplyOptions): Promise<ServerContainer>;
  start(id: string): Promise<ServerContainer>;
  stop(id: string, timeoutSec?: number): Promise<ServerContainer>;
  restart(id: string, timeoutSec?: number): Promise<ServerContainer>;
  stats(id: string): Promise<ServerStats>;
  remove(id: string, removeVolumes: boolean): Promise<DeleteResponse>;

  // Shared installs (HST-09, D12). Ids match `INSTALL_ID_PATTERN`; specs arrive validated (`parseInstallJobSpec`).
  /** This stack's installs, the servers mounting each and its job. */
  installs(): Promise<InstallInfo[]>;
  /**
   * Creates the install's volume when missing and its job (`src`: a copy
   * job from another install or a server's own install; null: an install
   * job), and starts it. The same spec again, while its job exists, answers
   * as it is; another one is `install-busy`.
   */
  putInstall(spec: InstallJobSpec, src: CopySource | null): Promise<InstallInfo>;
  /** The install's job, its network and HOME; never the install. */
  removeInstallJob(id: string): Promise<InstallDeleteResponse>;
  /** The install's volume; refused while a job exists or anything mounts it. */
  removeInstall(id: string): Promise<InstallDeleteResponse>;
  /**
   * A server's own install volume (`id` a server id), left over once the
   * server moved to a shared install (migration); refused while anything
   * mounts it (the server still runs from it). Its other volumes stay.
   */
  removeOwnInstall(id: string): Promise<InstallDeleteResponse>;
}

/** One change at a time per server: a second one while the first runs is a `conflict`. */
export class IdLocks {
  private readonly held = new Set<string>();

  async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.held.has(id)) throw conflict(`Server ${id} is being changed by another request`);
    this.held.add(id);
    try {
      return await fn();
    } finally {
      this.held.delete(id);
    }
  }
}

/** Runs callers one after the other (checks that must not race: ports, server count). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
