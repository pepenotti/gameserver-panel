/** A line of a server's live log as the console shows it. */
export interface LogLine {
  seq: number;
  at: string;
  stream: 'out' | 'err' | 'agent';
  line: string;
  /** A run of progress lines (CON-01): the seq of the run's first line; a later line of the run takes this one's place. */
  run?: number;
}

/** Where a line goes: a progress line where its run's first line was, any other by its own seq. */
const placeOf = (l: LogLine) => l.run ?? l.seq;

/**
 * New lines into the console's lines (CON-01), the newest `max` kept: a
 * progress run's latest line replaces the run's line where it is shown; a
 * run first seen late goes in its place; anything else goes last.
 */
export function mergeLogs(lines: readonly LogLine[], add: readonly LogLine[], max: number): LogLine[] {
  const out = [...lines];
  for (const l of add) {
    if (l.run === undefined) {
      out.push(l);
      continue;
    }
    let i = out.length - 1;
    while (i >= 0 && out[i]!.run !== l.run) i--;
    if (i >= 0) {
      out[i] = l;
      continue;
    }
    let at = out.length;
    while (at > 0 && placeOf(out[at - 1]!) > l.run) at--;
    out.splice(at, 0, l);
  }
  return out.slice(-max);
}
