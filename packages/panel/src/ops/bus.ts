import type { Permission } from '@pz/shared';

/** A long-running panel operation (restart with countdown, update, backup, restore, reset). */
export interface OpState {
  id: string;
  kind: 'start' | 'restart' | 'stop' | 'update' | 'backup' | 'restore' | 'reset' | 'mods';
  startedAt: string;
  startedBy: string | null;
  /** Machine-readable step; the UI translates it. */
  step: string;
  /** When a countdown is running: the moment the action happens. */
  countdownEndsAt: string | null;
  cancellable: boolean;
  progress: number | null;
  done: boolean;
  ok: boolean | null;
  error: string | null;
}

export type PanelEvent = { type: 'op'; op: OpState } | { type: 'notice'; kind: string; message: string; permission: Permission };

type Listener = (e: PanelEvent) => void;

/** Panel-side events for the websocket (agent events come from the agent feed). */
export class PanelBus {
  private readonly listeners = new Set<Listener>();
  private lastOp: OpState | null = null;

  emit(e: PanelEvent): void {
    if (e.type === 'op') this.lastOp = e.op;
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // ignore listener failures
      }
    }
  }

  currentOp(): OpState | null {
    return this.lastOp;
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
