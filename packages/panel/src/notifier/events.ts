import type { AgentFeed } from '../http/deps';
import type { PanelBus } from '../ops/bus';
import type { PlayersService } from '../players/service';
import type { DiscordNotifier, NotifyEvent } from './discord';

const OP_EVENT: Record<string, NotifyEvent | undefined> = {
  backup: 'backup',
  update: 'update',
  restore: 'restore',
  reset: 'reset',
  mods: 'mods',
};

/** Who did it, language-neutral: a name, or a clock for scheduled jobs. */
function actorLabel(by: string | null): string {
  return by && by !== 'scheduler' ? `👤 ${by}` : '🕒 auto';
}

/** Route live events to Discord. Returns an unsubscribe function. */
export function wireNotifications(d: { feed: AgentFeed; players: PlayersService; bus: PanelBus; notifier: DiscordNotifier }): () => void {
  let last: string | null = null;
  const offFeed = d.feed.onEvent((e) => {
    const ev = e.event;
    if (ev.type === 'state') {
      const s = ev.status.state;
      if (s === last) return;
      // The first state we see is the current one, not a change.
      if (last !== null) {
        if (s === 'running') d.notifier.notify('serverUp');
        else if (s === 'stopped' && (last === 'running' || last === 'stopping')) d.notifier.notify('serverDown', { reason: ev.status.lastExit?.expected === false ? 'crash' : '' });
      }
      last = s;
    } else if (ev.type === 'alert') {
      d.notifier.notify('crash', { message: ev.message });
    }
  });
  const offPlayers = d.players.onPresence((p) => d.notifier.notify(p.kind === 'join' ? 'playerJoin' : 'playerLeave', { name: p.username }));
  const offBus = d.bus.on((e) => {
    if (e.type !== 'op' || !e.op.done) return;
    const event = OP_EVENT[e.op.kind];
    if (!event || e.op.step === 'cancelled') return;
    const detail = [actorLabel(e.op.startedBy), e.op.error ?? ''].filter(Boolean).join(' — ');
    d.notifier.notify(event, { ok: String(e.op.ok === true), detail });
  });
  return () => {
    offFeed();
    offPlayers();
    offBus();
  };
}
