/**
 * PZ server ini (`Server/<name>.ini`).
 *
 * Measured on 42.20.4 (docs/verification-log.md): `# comment` lines directly
 * above `Key=Value`, blank lines between entries, CRLF on Windows / LF on
 * Linux, and no final newline. The server rewrites the whole file on start,
 * `changeoption` and `reloadoptions`, dropping unknown keys — so edits here are
 * surgical (replace one line's value) and everything else is left as found.
 */

const KEY_LINE = /^([A-Za-z0-9_]+)=(.*)$/;
const KEY_NAME = /^[A-Za-z0-9_]+$/;

export interface IniEntry {
  key: string;
  value: string;
  /** Comment lines directly above the key, without the leading `#`. */
  comments: string[];
  /** Index into `IniDoc.lines`. */
  line: number;
}

export interface IniDoc {
  lines: string[];
  eol: '\r\n' | '\n';
  finalNewline: boolean;
  entries: IniEntry[];
}

export function parseIni(text: string): IniDoc {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = text.endsWith('\n');
  const body = finalNewline ? text.replace(/\r?\n$/, '') : text;
  const lines = body === '' ? [] : body.split(/\r?\n/);
  const entries: IniEntry[] = [];
  let pending: string[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith('#')) {
      pending.push(line.slice(1).trim());
      return;
    }
    const m = KEY_LINE.exec(line);
    if (m) entries.push({ key: m[1]!, value: m[2]!, comments: pending, line: i });
    pending = [];
  });
  return { lines, eol, finalNewline, entries };
}

export function serializeIni(doc: IniDoc): string {
  return doc.lines.join(doc.eol) + (doc.finalNewline ? doc.eol : '');
}

/** Last occurrence wins, matching how a key=value reader overwrites. */
export function iniToRecord(doc: IniDoc): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of doc.entries) out[e.key] = e.value;
  return out;
}

export function getIniValue(doc: IniDoc, key: string): string | undefined {
  for (let i = doc.entries.length - 1; i >= 0; i--) if (doc.entries[i]!.key === key) return doc.entries[i]!.value;
  return undefined;
}

export class IniValueError extends Error {}

export function assertIniKey(key: string): void {
  if (!KEY_NAME.test(key)) throw new IniValueError(`Invalid ini key: ${JSON.stringify(key)}`);
}

/** A value may contain anything except line breaks (which would inject new keys). */
export function assertIniValue(key: string, value: string): void {
  if (/[\r\n\0]/.test(value)) throw new IniValueError(`Value for ${key} contains a line break`);
}

/**
 * Returns the text with `changes` applied: existing keys are edited in place
 * (every occurrence, so a duplicate can't silently win), new keys are appended
 * with a blank line before them. EOL style and final-newline are preserved.
 */
export function setIniValues(text: string, changes: Record<string, string>): string {
  const doc = parseIni(text);
  const lines = [...doc.lines];
  for (const [key, value] of Object.entries(changes)) {
    assertIniKey(key);
    assertIniValue(key, value);
    const hits = doc.entries.filter((e) => e.key === key);
    if (hits.length > 0) {
      for (const e of hits) lines[e.line] = `${key}=${value}`;
    } else {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
      lines.push(`${key}=${value}`);
    }
  }
  return serializeIni({ ...doc, lines });
}

/** Build a minimal ini from scratch (first run, factory reset). PZ fills in the rest with defaults. */
export function buildIni(values: Record<string, string>, eol: '\r\n' | '\n' = '\n'): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    assertIniKey(key);
    assertIniValue(key, value);
    lines.push(`${key}=${value}`);
  }
  return lines.join(eol) + eol;
}

export interface OptionCommentMeta {
  description?: string;
  min?: number;
  max?: number;
  /** Numeric default as text, or an enum default's label. */
  default?: string;
}

// English: "… Min: 0 Max: 1000 Default: 2" (ini and sandbox) or "Default = Normal" (sandbox enums).
// Spanish: "… Mínimo=0 Máximo=1000 Por defecto=2" and "Por defecto=Normal".
const RANGE_PATTERNS = [
  /\s*Min: (-?[\d.]+) Max: (-?[\d.]+) Default: (\S+)\s*$/,
  /\s*Mínimo=(-?[\d.]+) Máximo=(-?[\d.]+) Por defecto=(\S+)\s*$/,
];
const DEFAULT_PATTERNS = [/\s*Default ?[=:] ?(.+?)\s*$/, /\s*Por defecto ?= ?(.+?)\s*$/];

/** Pull min/max/default out of the comment PZ writes above an option. */
export function parseOptionComment(comment: string): OptionCommentMeta {
  let text = comment.trim();
  const meta: OptionCommentMeta = {};
  for (const re of RANGE_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      meta.min = Number(m[1]);
      meta.max = Number(m[2]);
      meta.default = m[3]!;
      text = text.slice(0, m.index);
      break;
    }
  }
  if (meta.default === undefined) {
    for (const re of DEFAULT_PATTERNS) {
      const m = re.exec(text);
      if (m) {
        meta.default = m[1]!;
        text = text.slice(0, m.index);
        break;
      }
    }
  }
  text = text.trim();
  if (text) meta.description = text;
  return meta;
}
