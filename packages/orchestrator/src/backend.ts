import type { ApplyOptions, DeleteResponse, HostInfo, ServerContainer, ServerSpec, ServerStats } from '@gsp/shared';
import { conflict } from './errors';

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
