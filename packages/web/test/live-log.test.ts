// CON-01: the console keeps a run of progress lines as one line, updated in place.
import { describe, expect, it } from 'vitest';
import { mergeLogs, type LogLine } from '../src/lib/logs';

const line = (seq: number, text: string, run?: number): LogLine => ({ seq, at: '', stream: 'out', line: text, ...(run !== undefined ? { run } : {}) });
const texts = (ls: LogLine[]) => ls.map((l) => l.line);

describe('the live log in the console (CON-01)', () => {
  it("replaces a progress run's line with its latest, where it is shown", () => {
    let logs = mergeLogs([], [line(1, 'Starting'), line(2, 'gen 1%', 2)], 100);
    // Several updates in one frame, then an ordinary line.
    logs = mergeLogs(logs, [line(3, 'gen 2%', 2), line(4, 'gen 3%', 2), line(5, 'Server started')], 100);
    expect(texts(logs)).toEqual(['Starting', 'gen 3%', 'Server started']);
    expect(logs[1]).toMatchObject({ seq: 4, run: 2 });
    logs = mergeLogs(logs, [line(6, 'gen 100%', 2)], 100);
    expect(texts(logs)).toEqual(['Starting', 'gen 100%', 'Server started']);
  });

  it('puts a run first seen late (the page opened after it began) in its place', () => {
    const logs = mergeLogs([line(1, 'Starting'), line(3, 'agent says')], [line(9, 'gen 90%', 2)], 100);
    expect(texts(logs)).toEqual(['Starting', 'gen 90%', 'agent says']);
  });

  it('keeps the newest lines', () => {
    const logs = mergeLogs(
      [],
      Array.from({ length: 10 }, (_, i) => line(i + 1, `l${i + 1}`)),
      4,
    );
    expect(texts(logs)).toEqual(['l7', 'l8', 'l9', 'l10']);
  });
});
