import { describe, expect, it } from 'vitest';
import { diffLines, withContext } from '../src/diff';

describe('diffLines', () => {
  it('marks changed lines and keeps the rest', () => {
    expect(diffLines('A=1\nB=2\nC=3', 'A=1\nB=5\nC=3\nD=4')).toEqual([
      { kind: 'same', text: 'A=1' },
      { kind: 'del', text: 'B=2' },
      { kind: 'add', text: 'B=5' },
      { kind: 'same', text: 'C=3' },
      { kind: 'add', text: 'D=4' },
    ]);
  });

  it('treats CRLF and LF alike', () => {
    expect(diffLines('A=1\r\nB=2', 'A=1\nB=2').every((l) => l.kind === 'same')).toBe(true);
  });
});

describe('withContext', () => {
  it('keeps changes plus context and collapses the gaps', () => {
    const before = Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n');
    const after = before.replace('L10', 'X');
    const out = withContext(diffLines(before, after), 1);
    expect(out).toEqual([null, { kind: 'same', text: 'L9' }, { kind: 'del', text: 'L10' }, { kind: 'add', text: 'X' }, { kind: 'same', text: 'L11' }, null]);
  });
});
