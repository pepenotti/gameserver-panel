import type { Permission } from '@gsp/shared';

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

/**
 * Panel-side events for the websocket (agent events come from each server's
 * feed). Every event names its server; a notice without one is about the
 * host. `permission` is checked on that server (or on the host). `access`:
 * what a user may see changed (their grants, scope or role), or with
 * `userId` null, for everyone (a server was created, removed or renamed):
 * open websockets re-check at once instead of on their next periodic check.
 */
export type PanelEvent =
  | { type: 'op'; serverId: string; op: OpState }
  | { type: 'notice'; serverId: string | null; kind: string; message: string; permission: Permission }
  | { type: 'access'; userId: number | null };

type Listener = (e: PanelEvent) => void;

/** One bus for the whole panel: the websocket filters it per client and server. */
export class PanelBus {
  private readonly listeners = new Set<Listener>();

  emit(e: PanelEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // ignore listener failures
      }
    }
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
