/**
 * Line lists (CFG-02, CFG-07, CFG-09): one entry per line, `#` comment lines
 * and blank lines skipped, surrounding blanks not part of an entry. Admin,
 * ban and allow lists some games keep look like this. As settings, a list
 * is a set: every entry is a key whose value is `true`; setting a key to
 * `true` adds the entry, `null` (or `false`) removes it.
 *
 * Edits keep every other line as it is, comments included; a new entry
 * goes at the end.
 */

export interface LinesEntry {
  value: string;
  /** Index into `LinesDoc.lines`. */
  line: number;
}

export interface LinesDoc {
  lines: string[];
  eol: '\r\n' | '\n';
  finalNewline: boolean;
  entries: LinesEntry[];
}

export function parseLines(text: string): LinesDoc {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = text.endsWith('\n');
  const body = finalNewline ? text.replace(/\r?\n$/, '') : text;
  const lines = body === '' ? [] : body.split(/\r?\n/);
  const entries: LinesEntry[] = [];
  lines.forEach((raw, i) => {
    const t = (i === 0 && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim();
    if (t === '' || t.startsWith('#')) return;
    entries.push({ value: t, line: i });
  });
  return { lines, eol, finalNewline, entries };
}

export function serializeLines(doc: LinesDoc): string {
  return doc.lines.join(doc.eol) + (doc.finalNewline ? doc.eol : '');
}

/** An entry as it can be written: one line, not blank, not a comment, no surrounding blanks. */
export function assertLineEntry(entry: string): void {
  if (/[\r\n\0]/.test(entry)) throw new Error(`An entry can't contain a line break: ${JSON.stringify(entry)}`);
  if (entry.trim() !== entry || entry === '') throw new Error(`An entry can't be empty or start or end with blanks: ${JSON.stringify(entry)}`);
  if (entry.startsWith('#')) throw new Error(`An entry can't start with "#" (that is a comment): ${JSON.stringify(entry)}`);
}

/**
 * Adds (`true`) and removes (`null` or `false`) entries. Every line holding
 * a removed entry goes; an added one that is there already is left alone.
 */
export function editLines(text: string, changes: Record<string, boolean | null>): string {
  const doc = parseLines(text);
  const lines = [...doc.lines];
  const drop = new Set<number>();
  const present = new Set(doc.entries.map((e) => e.value));
  for (const [entry, want] of Object.entries(changes)) {
    assertLineEntry(entry);
    if (want === true) {
      if (!present.has(entry)) {
        lines.push(entry);
        present.add(entry);
      }
    } else {
      for (const e of doc.entries) if (e.value === entry) drop.add(e.line);
      present.delete(entry);
    }
  }
  const kept = lines.filter((_l, i) => !drop.has(i));
  return serializeLines({ ...doc, lines: kept, finalNewline: doc.finalNewline || (doc.lines.length === 0 && kept.length > 0) });
}

/** A new list holding `entries`, one per line. */
export function buildLines(entries: string[], eol: '\r\n' | '\n' = '\n'): string {
  for (const e of entries) assertLineEntry(e);
  return entries.map((e) => `${e}${eol}`).join('');
}
