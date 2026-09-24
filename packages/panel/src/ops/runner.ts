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
 * Runs one heavy operation at a time. Two people pressing "restart" and
 * "restore" at once must not interleave; the second gets a 409 instead.
 */
export class OpRunner {
  private current: { state: OpState; abort: AbortController } | null = null;

  constructor(private readonly bus: PanelBus) {}

  get busy(): OpState | null {
    return this.current?.state ?? null;
  }

  /** Starts `fn` in the background and returns its initial state. */
  start(kind: OpState['kind'], startedBy: string | null, fn: (ctx: OpContext) => Promise<void>, opts: { cancellable?: boolean } = {}): OpState {
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
    const publish = () => this.bus.emit({ type: 'op', op: { ...state } });
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
    void (async () => {
      try {
        await fn(ctx);
        state.ok = true;
        state.step = 'done';
      } catch (e) {
        state.ok = false;
        state.step = e instanceof OpCancelled ? 'cancelled' : 'failed';
        state.error = e instanceof OpCancelled ? null : (e as Error).message;
      } finally {
        state.done = true;
        state.countdownEndsAt = null;
        state.cancellable = false;
        this.current = null;
        publish();
      }
    })();
    return { ...state };
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
