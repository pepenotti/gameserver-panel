export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/**
 * Line diff via LCS on the lines that differ (common prefix/suffix trimmed
 * first, which keeps config diffs — usually a few changed lines — cheap).
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  if (n * m > 4_000_000) {
    // Too big to align line by line: show it as replace-all.
    out.push(...midA.map((text) => ({ kind: 'del' as const, text })), ...midB.map((text) => ({ kind: 'add' as const, text })));
  } else {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = midA[i] === midB[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ kind: 'same', text: midA[i]! });
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: 'del', text: midA[i++]! });
      else out.push({ kind: 'add', text: midB[j++]! });
    }
    while (i < n) out.push({ kind: 'del', text: midA[i++]! });
    while (j < m) out.push({ kind: 'add', text: midB[j++]! });
  }
  out.push(...a.slice(endA).map((text) => ({ kind: 'same' as const, text })));
  return out;
}

/** Keep only changed lines plus `context` lines around them; gaps become null. */
export function withContext(lines: DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind !== 'same') for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  let gap = false;
  lines.forEach((l, i) => {
    if (keep[i]) {
      out.push(l);
      gap = false;
    } else if (!gap) {
      out.push(null);
      gap = true;
    }
  });
  return out;
}
