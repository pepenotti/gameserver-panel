import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SeqEvent } from '@gsp/shared';
import { EventHub } from '../src/events';

const log = (line: string) => ({ type: 'log' as const, stream: 'out' as const, line });
/** The buffered log lines, as `seq run line`. */
const lines = (hub: EventHub, since = 0) => hub.since(since).events.flatMap((e) => (e.event.type === 'log' ? [`${e.seq} ${e.event.run ?? '-'} ${e.event.line}`] : []));

afterEach(() => {
  vi.useRealTimers();
});

describe('progress runs in the live log (CON-01)', () => {
  it('keeps a run of progress lines as its latest line, in the place of its first', () => {
    const hub = new EventHub(100, { progressIntervalMs: 0 });
    const seen: SeqEvent[] = [];
    hub.subscribe((e) => seen.push(e));
    hub.emit(log('Creating world'));
    for (let i = 1; i <= 5; i++) hub.progress('gen', log(`gen ${i}%`));
    // One line in the backlog: the latest, under the seq of the run's first line as its `run`.
    expect(lines(hub)).toEqual(['1 - Creating world', '6 2 gen 5%']);
    // Subscribers got each line as an update of the same run, in order.
    expect(seen.map((e) => (e.event.type === 'log' ? `${e.seq} ${e.event.run ?? '-'} ${e.event.line}` : ''))).toEqual(['1 - Creating world', '2 2 gen 1%', '3 2 gen 2%', '4 2 gen 3%', '5 2 gen 4%', '6 2 gen 5%']);
    expect(hub.lastSeq).toBe(6);
  });

  it('ends runs when told (the game printed something else): the next line of the key starts a new run', () => {
    const hub = new EventHub(100, { progressIntervalMs: 0 });
    hub.progress('save', log('Saving 10%'));
    hub.progress('save', log('Saving 100%'));
    hub.endRuns();
    hub.emit(log('Saved'));
    hub.progress('save', log('Saving 50%'));
    expect(lines(hub)).toEqual(['2 1 Saving 100%', '3 - Saved', '4 4 Saving 50%']);
  });

  it('lets runs of several keys go on side by side, each as one line', () => {
    const hub = new EventHub(100, { progressIntervalMs: 0 });
    for (let i = 0; i < 4; i++) {
      hub.progress('gen', log(`gen ${i}`));
      hub.progress('reset', log(`reset ${i}`));
    }
    expect(lines(hub)).toEqual(['7 1 gen 3', '8 2 reset 3']);
  });

  it('sends a run at most every interval, the latest line winning, and never lets anything overtake it', () => {
    vi.useFakeTimers();
    const hub = new EventHub(100, { progressIntervalMs: 250 });
    const seen: string[] = [];
    hub.subscribe((e) => seen.push(e.event.type === 'log' ? e.event.line : e.event.type));
    for (let i = 1; i <= 100; i++) hub.progress('gen', log(`gen ${i}`));
    // The first goes out at once; the rest wait for the interval.
    expect(seen).toEqual(['gen 1']);
    vi.advanceTimersByTime(250);
    expect(seen).toEqual(['gen 1', 'gen 100']);
    for (let i = 101; i <= 150; i++) hub.progress('gen', log(`gen ${i}`));
    // Anything else emitted sends the waiting line first.
    hub.emit({ type: 'players', count: 0, names: [] });
    expect(seen).toEqual(['gen 1', 'gen 100', 'gen 150', 'players']);
    hub.progress('gen', log('gen 151'));
    hub.endRuns();
    expect(seen.at(-1)).toBe('gen 151');
    vi.advanceTimersByTime(1000);
    expect(seen).toHaveLength(5);
    expect(lines(hub)).toEqual(['5 1 gen 151']);
  });

  it('gives a subscriber that comes back the latest line of a run it saw start, as an update of that run', () => {
    const hub = new EventHub(100, { progressIntervalMs: 0 });
    hub.emit(log('boot'));
    hub.progress('gen', log('gen 1'));
    const seenUpTo = hub.lastSeq;
    for (let i = 2; i <= 9; i++) hub.progress('gen', log(`gen ${i}`));
    const back = hub.since(seenUpTo);
    expect(back.truncated).toBe(false);
    expect(back.events.map((e) => e.event)).toEqual([{ type: 'log', stream: 'out', line: 'gen 9', run: 2 }]);
    // A new subscriber gets it too, in the run's place.
    expect(lines(hub)).toEqual(['1 - boot', '10 2 gen 9']);
  });

  it("keeps what came before a first boot's 30 000 progress lines in a 5 000-event backlog", () => {
    const hub = new EventHub(5000, { progressIntervalMs: 0 });
    hub.emit({ type: 'log', stream: 'agent', line: 'Starting: the game' });
    for (let i = 0; i < 30_000; i++) hub.progress('gen', log(`gen ${i}`));
    hub.endRuns();
    hub.emit(log('Server started'));
    expect(lines(hub).map((l) => l.replace(/^\d+ \S+ /, ''))).toEqual(['Starting: the game', 'gen 29999', 'Server started']);
    expect(hub.since(0).truncated).toBe(false);
  });
});
