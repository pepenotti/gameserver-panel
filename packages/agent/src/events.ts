import type { AgentEvent, SeqEvent } from '@gsp/shared';

type Listener = (e: SeqEvent) => void;
type LogEvent = Extract<AgentEvent, { type: 'log' }>;

/** At most how often a progress run's latest line goes out (CON-01); the last one of a run always does. */
export const PROGRESS_INTERVAL_MS = 250;

/** An open run of progress lines. */
interface Run {
  /** The seq of its first line: what its events carry as `run`. */
  readonly id: number;
  /** Its latest line, not sent yet (the run is being throttled). */
  pending: LogEvent | null;
  sentAt: number;
  timer: NodeJS.Timeout | null;
}

export interface EventHubOptions {
  /** `PROGRESS_INTERVAL_MS` unless a test says otherwise. */
  progressIntervalMs?: number;
}

/**
 * Sequenced event log with a bounded backlog. Subscribers that reconnect pass
 * the last seq they saw and get everything after it that is still buffered.
 * Log lines and everything else share one sequence so ordering is exact.
 *
 * A run of progress lines (CON-01) holds one place in it: its first line is
 * an ordinary event whose seq names the run (`run`), and each later line
 * replaces it, in the backlog and for subscribers, as a new event of the same
 * `run` (so a reconnecting subscriber gets the latest one after its seq).
 * Lines of a run go out at most every `progressIntervalMs`, the latest one
 * winning; anything else emitted sends a run's waiting line first.
 */
export class EventHub {
  private seq = 0;
  private readonly buffer: SeqEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly runs = new Map<string, Run>();
  private readonly intervalMs: number;

  constructor(
    private readonly capacity: number,
    o: EventHubOptions = {},
  ) {
    this.intervalMs = o.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  }

  emit(event: AgentEvent): SeqEvent {
    this.flushRuns();
    return this.push(event);
  }

  /**
   * One line of the progress run `key` (a runtime adapter's
   * `LineSignal.progress`): the run's first line, or the one that replaces
   * its latest (now, or once the interval since the last one has passed).
   */
  progress(key: string, event: LogEvent): void {
    const run = this.runs.get(key);
    if (!run) {
      this.flushRuns();
      const e = this.push({ ...event, run: this.seq + 1 });
      this.runs.set(key, { id: e.seq, pending: null, sentAt: Date.now(), timer: null });
      return;
    }
    const wait = run.sentAt + this.intervalMs - Date.now();
    if (wait <= 0) return this.replace(run, event);
    run.pending = event;
    if (!run.timer) {
      run.timer = setTimeout(() => {
        run.timer = null;
        if (run.pending) this.replace(run, run.pending);
      }, wait);
      run.timer.unref();
    }
  }

  /** Every open progress run ends (the game printed something else, or exited): their latest lines go out, and the next progress line starts a new run. */
  endRuns(): void {
    this.flushRuns();
    this.runs.clear();
  }

  /** Events with seq > `since`; `truncated` when some were already dropped. */
  since(since: number): { events: SeqEvent[]; truncated: boolean } {
    const first = this.buffer[0]?.seq ?? this.seq + 1;
    const events = this.buffer.filter((e) => e.seq > since);
    return { events, truncated: since > 0 && since < first - 1 };
  }

  get lastSeq(): number {
    return this.seq;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private push(event: AgentEvent): SeqEvent {
    const e: SeqEvent = { seq: ++this.seq, at: new Date().toISOString(), event };
    this.buffer.push(e);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // A broken subscriber must not break the agent.
      }
    }
    return e;
  }

  /** The run's latest line takes the place of its previous one: out of the backlog, and in at the end with a new seq. */
  private replace(run: Run, event: LogEvent): void {
    run.pending = null;
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const ev = this.buffer[i]!.event;
      if (ev.type === 'log' && ev.run === run.id) {
        this.buffer.splice(i, 1);
        break;
      }
    }
    run.sentAt = Date.now();
    this.push({ ...event, run: run.id });
  }

  /** Sends every run's waiting line, so nothing emitted after it overtakes it. */
  private flushRuns(): void {
    for (const run of this.runs.values()) if (run.pending) this.replace(run, run.pending);
  }
}
