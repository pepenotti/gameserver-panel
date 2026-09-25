import { randomUUID } from 'node:crypto';
import { HttpError } from '../http/context';
import type { OpState, PanelBus } from './bus';

export class OpCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

export interface OpContext {
  readonly signal: AbortSignal;
  step(step: string, patch?: Partial<Pick<OpState, 'progress' | 'countdownEndsAt' | 'cancellable'>>): void;
  /** Sleep that ends early (throwing OpCancelled) when the op is cancelled. */
  sleep(ms: number): Promise<void>;
}

/**
 * Runs one heavy operation at a time on one server. Two people pressing
 * "restart" and "restore" at once must not interleave; the second gets a
 * 409 instead. Other servers have their own runner and aren't held up.
 */
export class OpRunner {
  private current: { state: OpState; abort: AbortController } | null = null;
  private lastState: OpState | null = null;

  constructor(
    private readonly bus: PanelBus,
    /** The server whose operations these are. */
    readonly serverId: string,
  ) {}

  get busy(): OpState | null {
    return this.current?.state ?? null;
  }

  /** The running operation, else the last one (how it ended), else null. */
  last(): OpState | null {
    return this.lastState;
  }

  /** Starts `fn` in the background and returns its initial state. */
  start(kind: OpState['kind'], startedBy: string | null, fn: (ctx: OpContext) => Promise<void>, opts: { cancellable?: boolean } = {}): OpState {
    const { state, done } = this.launch(kind, startedBy, fn, opts);
    // How it ended is in its state (and on the bus); nobody waits for it here.
    done.catch(() => undefined);
    return state;
  }

  /**
   * Runs `fn` as this server's operation, like `start`, and resolves with
   * what it returns once it has ended (rejects with its error): for callers
   * that need the result, such as the final backup before a server is
   * removed (SRV-04). Refuses (409 `busy`) while another one runs.
   */
  run<T>(kind: OpState['kind'], startedBy: string | null, fn: (ctx: OpContext) => Promise<T>, opts: { cancellable?: boolean } = {}): Promise<T> {
    return this.launch(kind, startedBy, fn, opts).done;
  }

  private launch<T>(kind: OpState['kind'], startedBy: string | null, fn: (ctx: OpContext) => Promise<T>, opts: { cancellable?: boolean }): { state: OpState; done: Promise<T> } {
    if (this.current) throw new HttpError(409, 'busy', undefined, { op: this.current.state });
    const abort = new AbortController();
    const state: OpState = {
      id: randomUUID(),
      kind,
      startedAt: new Date().toISOString(),
      startedBy,
      step: 'starting',
      countdownEndsAt: null,
      cancellable: opts.cancellable ?? false,
      progress: null,
      done: false,
      ok: null,
      error: null,
    };
    this.current = { state, abort };
    const publish = () => {
      this.lastState = { ...state };
      this.bus.emit({ type: 'op', serverId: this.serverId, op: { ...state } });
    };
    const ctx: OpContext = {
      signal: abort.signal,
      step: (step, patch = {}) => {
        state.step = step;
        Object.assign(state, patch);
        publish();
      },
      sleep: (ms) =>
        new Promise<void>((resolve, reject) => {
          if (abort.signal.aborted) return reject(new OpCancelled());
          const t = setTimeout(resolve, ms);
          abort.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(new OpCancelled());
            },
            { once: true },
          );
        }),
    };
    publish();
    const done = (async () => {
      try {
        const result = await fn(ctx);
        state.ok = true;
        state.step = 'done';
        return result;
      } catch (e) {
        state.ok = false;
        state.step = e instanceof OpCancelled ? 'cancelled' : 'failed';
        state.error = e instanceof OpCancelled ? null : (e as Error).message;
        throw e;
      } finally {
        state.done = true;
        state.countdownEndsAt = null;
        state.cancellable = false;
        this.current = null;
        publish();
      }
    })();
    return { state: { ...state }, done };
  }

  cancel(id: string): boolean {
    if (!this.current || this.current.state.id !== id || !this.current.state.cancellable) return false;
    this.current.abort.abort();
    return true;
  }

  /** Test helper: resolves when the current op finishes. */
  async idle(): Promise<void> {
    while (this.current) await new Promise((r) => setTimeout(r, 10));
  }
}
