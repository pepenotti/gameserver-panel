/**
 * Java `.properties` files (CFG-02, CFG-07, CFG-09), the way
 * `java.util.Properties.load` reads them: Minecraft's `server.properties`
 * is one.
 *
 *   - a line whose first non-blank character is `#` or `!` is a comment;
 *   - a key runs to the first unescaped `=`, `:` or blank; blanks, then one
 *     `=` or `:`, then blanks separate it from the value;
 *   - a line ending in an odd number of backslashes continues on the next
 *     one, whose leading blanks are dropped (comment lines never continue);
 *   - escapes: `\t \n \r \f`, `\uXXXX`, and a backslash before any other
 *     character is that character (`\:` `\=` `\#` `\\` …);
 *   - the last of repeated keys wins.
 *
 * Edits are surgical: a changed key keeps its own text and separator and
 * only its value is rewritten, escaped the way `Properties.store` escapes
 * (which is why a game's own file has `https\://…`); everything else stays
 * byte for byte, comments included.
 */

export interface PropertiesEntry {
  key: string;
  value: string;
  /** Index of the logical line's first physical line in `PropertiesDoc.lines`. */
  line: number;
  /** Physical lines the entry spans (continuations included). */
  span: number;
  /** Raw text of the key and its separator, kept when the value changes. */
  head: string;
  /** Column (1-based) where the value starts on the entry's first line. */
  valueCol: number;
}

export interface PropertiesDoc {
  lines: string[];
  eol: '\r\n' | '\n';
  finalNewline: boolean;
  entries: PropertiesEntry[];
}

export class PropertiesSyntaxError extends Error {
  constructor(
    readonly reason: string,
    /** 1-based. */
    readonly line: number,
    readonly col: number,
  ) {
    super(`${reason} (line ${line}, column ${col})`);
  }
}

const BLANK = /[ \t\f]/;
const isBlank = (c: string | undefined) => c !== undefined && BLANK.test(c);

/** Whether a physical line continues on the next one: an odd number of trailing backslashes. */
function continues(line: string): boolean {
  let n = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) n++;
  return n % 2 === 1;
}

/**
 * Decodes escapes of a key or value. `at` maps an index of `raw` to the
 * line and column shown when a `\u` escape is malformed.
 */
function unescape(raw: string, at: (i: number) => { line: number; col: number }): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = raw[++i];
    if (n === undefined) break;
    if (n === 'u') {
      const hex = raw.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        const p = at(i - 1);
        throw new PropertiesSyntaxError('Malformed \\uXXXX escape: four hex digits must follow \\u', p.line, p.col);
      }
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += n === 't' ? '\t' : n === 'n' ? '\n' : n === 'r' ? '\r' : n === 'f' ? '\f' : n;
  }
  return out;
}

export function parseProperties(text: string): PropertiesDoc {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = /\r?\n$/.test(text) || text.endsWith('\r');
  const body = finalNewline ? text.replace(/(\r\n|\r|\n)$/, '') : text;
  const lines = body === '' ? [] : body.split(/\r\n|\r|\n/);
  const entries: PropertiesEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const first = i === 0 && lines[0]!.charCodeAt(0) === 0xfeff ? lines[0]!.slice(1) : lines[i]!;
    const bom = first !== lines[i] ? 1 : 0;
    let start = 0;
    while (isBlank(first[start])) start++;
    if (start === first.length || first[start] === '#' || first[start] === '!') continue;

    // The logical line: its physical lines joined, each continuation's leading blanks dropped.
    // `origin` maps each character of it back to a line and column, for issues.
    let logical = first.slice(start);
    const origin: { line: number; col: number }[] = [...logical].map((_c, k) => ({ line: i + 1, col: bom + start + k + 1 }));
    let span = 1;
    while (continues(logical) && i + span < lines.length) {
      logical = logical.slice(0, -1);
      origin.pop();
      const next = lines[i + span]!;
      let s = 0;
      while (isBlank(next[s])) s++;
      for (let k = s; k < next.length; k++) origin.push({ line: i + span + 1, col: k + 1 });
      logical += next.slice(s);
      span++;
    }
    if (continues(logical)) {
      // A backslash on the file's last line continues into nothing.
      logical = logical.slice(0, -1);
      origin.pop();
    }
    const at = (k: number) => origin[k] ?? { line: i + 1, col: 1 };

    // Key: up to the first unescaped '=', ':' or blank.
    let k = 0;
    while (k < logical.length) {
      const c = logical[k]!;
      if (c === '\\') {
        k += 2;
        continue;
      }
      if (c === '=' || c === ':' || isBlank(c)) break;
      k++;
    }
    const rawKey = logical.slice(0, Math.min(k, logical.length));
    let v = k;
    while (isBlank(logical[v])) v++;
    if (logical[v] === '=' || logical[v] === ':') v++;
    while (isBlank(logical[v])) v++;
    const key = unescape(rawKey, at);
    const value = unescape(logical.slice(v), (x) => at(v + x));
    // The key and separator as written, kept when the value changes (rebuilt when they span lines);
    // a key written without a separator gets one.
    const before = origin[v - 1];
    let head = before && before.line === i + 1 ? lines[i]!.slice(0, before.col) : `${lines[i]!.slice(0, bom + start)}${escapeKey(key)}=`;
    if (!/[=: \t\f]$/.test(head)) head += '=';
    const valueCol = origin[v]?.line === i + 1 ? origin[v]!.col : head.length + 1;
    entries.push({ key, value, line: i, span, head, valueCol });
    i += span - 1;
  }
  return { lines, eol, finalNewline, entries };
}

export function serializeProperties(doc: PropertiesDoc): string {
  return doc.lines.join(doc.eol) + (doc.finalNewline ? doc.eol : '');
}

/** Last occurrence wins, as `Properties.load` overwrites. */
export function propertiesToRecord(doc: PropertiesDoc): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of doc.entries) out[e.key] = e.value;
  return out;
}

function escapeChar(c: string, key: boolean, first: boolean): string {
  switch (c) {
    case '\\':
      return '\\\\';
    case '\t':
      return '\\t';
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\f':
      return '\\f';
    case '=':
    case ':':
    case '#':
    case '!':
      return `\\${c}`;
    case ' ':
      return key || first ? '\\ ' : ' ';
  }
  const code = c.charCodeAt(0);
  // Outside printable ASCII: \uXXXX, which a reader decodes whatever charset it reads the file in.
  return code < 0x20 || code > 0x7e ? `\\u${code.toString(16).toUpperCase().padStart(4, '0')}` : c;
}

/** A key as `Properties.store` writes it. */
export function escapeKey(key: string): string {
  let out = '';
  for (let i = 0; i < key.length; i++) out += escapeChar(key[i]!, true, i === 0);
  return out;
}

/** A value as `Properties.store` writes it (a leading blank escaped, `:` `=` `#` `!` too). */
export function escapeValue(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) out += escapeChar(value[i]!, false, i === 0);
  return out;
}

/**
 * Returns the text with `changes` applied: every occurrence of an existing
 * key gets the new value (so a duplicate can't silently win), keeping its
 * key text and separator; a new key is appended; `null` removes a key's
 * line(s). The EOL style and the final newline are kept.
 */
export function editProperties(text: string, changes: Record<string, string | null>): string {
  const doc = parseProperties(text);
  const lines: (string | null)[] = [...doc.lines];
  const append: string[] = [];
  for (const [key, value] of Object.entries(changes)) {
    if (key === '') throw new Error('A properties key cannot be empty');
    const hits = doc.entries.filter((e) => e.key === key);
    for (const e of hits) {
      lines[e.line] = value === null ? null : `${e.head}${escapeValue(value)}`;
      for (let k = 1; k < e.span; k++) lines[e.line + k] = null;
    }
    if (hits.length === 0 && value !== null) append.push(`${escapeKey(key)}=${escapeValue(value)}`);
  }
  const kept = lines.filter((l): l is string => l !== null);
  return serializeProperties({ ...doc, lines: [...kept, ...append], finalNewline: doc.finalNewline || (kept.length === 0 && append.length > 0) });
}

/** A new file holding only `values`, one `key=value` line each. */
export function buildProperties(values: Record<string, string>, eol: '\r\n' | '\n' = '\n'): string {
  return Object.entries(values)
    .map(([k, v]) => `${escapeKey(k)}=${escapeValue(v)}${eol}`)
    .join('');
}
