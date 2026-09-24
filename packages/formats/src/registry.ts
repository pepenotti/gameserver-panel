/**
 * The format registry (PRD §10, CFG-07…09): one entry per config file format,
 * used by both the settings forms and the text editor so they can't drift
 * apart. M1 starts with `ini` (today's functions) and `text`; the other
 * formats are added as their adapters need them.
 */

import { buildIni, iniToRecord, parseIni, serializeIni, setIniValues, type IniDoc } from './ini';

/** A single setting value as forms and formats exchange it. */
export type Scalar = string | number | boolean;

export type FormatId = 'ini' | 'properties' | 'lua-data' | 'json' | 'json5' | 'yaml' | 'toml' | 'lines' | 'text';

/** Editor highlighting mode for a format. */
export type Highlight = 'properties' | 'lua' | 'yaml' | 'toml' | 'json' | 'plain';

export interface ParseIssue {
  /** 1-based. */
  line: number;
  col?: number;
  message: string;
}

export type ParseResult<D> = { ok: true; doc: D } | { ok: false; issues: ParseIssue[] };

export interface ConfigFormat<D = unknown> {
  id: FormatId;
  highlight: Highlight;
  /** Whether `edit` keeps comments and layout (principle 3, CFG-09). */
  preservesComments: boolean;
  parse(text: string): ParseResult<D>;
  /** Every setting as `key` (or dotted path) → value; what a form shows. */
  flatten(doc: D): Record<string, Scalar>;
  /** The text with `changes` applied surgically; `null` removes a key. Unknown keys and comments stay. */
  edit(text: string, changes: Record<string, Scalar | null>): string;
  /** A new file holding only `values` (first run, factory reset). */
  create?(values: Record<string, Scalar>): string;
}

const asText = (v: Scalar): string => (typeof v === 'string' ? v : String(v));

/** Removes every `key=` line and the comment lines directly above it. */
function removeIniKeys(text: string, keys: string[]): string {
  if (keys.length === 0) return text;
  const doc = parseIni(text);
  const drop = new Set<number>();
  for (const e of doc.entries) {
    if (!keys.includes(e.key)) continue;
    drop.add(e.line);
    for (let i = 1; i <= e.comments.length; i++) drop.add(e.line - i);
  }
  return serializeIni({ ...doc, lines: doc.lines.filter((_l, i) => !drop.has(i)) });
}

/** The PZ-style ini: `Key=Value` lines with `#` comments above them, no sections. */
export const iniFormat: ConfigFormat<IniDoc> = {
  id: 'ini',
  highlight: 'properties',
  preservesComments: true,
  // parseIni accepts any text: lines that are neither comments nor `Key=Value` are kept as they are.
  parse: (text) => ({ ok: true, doc: parseIni(text) }),
  flatten: (doc) => iniToRecord(doc),
  edit(text, changes) {
    const set: Record<string, string> = {};
    const remove: string[] = [];
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) remove.push(k);
      else set[k] = asText(v);
    }
    const kept = removeIniKeys(text, remove);
    return Object.keys(set).length ? setIniValues(kept, set) : kept;
  },
  create: (values) => buildIni(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, asText(v)]))),
};

/** Plain text: editable as a whole, no keys. */
export const textFormat: ConfigFormat<string> = {
  id: 'text',
  highlight: 'plain',
  preservesComments: true,
  parse: (text) => ({ ok: true, doc: text }),
  flatten: () => ({}),
  edit(text, changes) {
    const keys = Object.keys(changes);
    if (keys.length) throw new Error(`Plain text has no keys to change (${keys.join(', ')})`);
    return text;
  },
};

/** Formats by id. Only the ones implemented so far are present. */
export const CONFIG_FORMATS: { readonly [K in FormatId]?: ConfigFormat } = {
  ini: iniFormat,
  text: textFormat,
};
