import type { AgentEvent, SeqEvent } from '@pz/shared';

type Listener = (e: SeqEvent) => void;

/**
 * Sequenced event log with a bounded backlog. Subscribers that reconnect pass
 * the last seq they saw and get everything after it that is still buffered.
 * Log lines and everything else share one sequence so ordering is exact.
 */
export class EventHub {
  private seq = 0;
  private readonly buffer: SeqEvent[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(private readonly capacity: number) {}

  emit(event: AgentEvent): SeqEvent {
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
}
