/**
 * The format registry (PRD §10, CFG-07…09): one entry per config file format,
 * used by both the settings forms and the text editor so they can't drift
 * apart. Formats without an implementation yet (`properties`, `yaml`, …) are
 * still editable as plain text with their highlighting (`formatFor`).
 */

import { buildIni, iniToRecord, parseIni, serializeIni, setIniValues, type IniDoc } from './ini';
import { buildJson, editJson, flattenJson, getJsonMember, JsonSyntaxError, lineColAt, parseJson, type JsonDoc } from './json';
import { editLuaData, flattenScalars, getPath, LuaDataError, parseLuaData, type LuaDataFile } from './lua-data';

/** A single setting value as forms and formats exchange it. */
export type Scalar = string | number | boolean;

export type FormatId = 'ini' | 'properties' | 'lua-data' | 'json' | 'json5' | 'yaml' | 'toml' | 'lines' | 'text';

/** Editor highlighting mode for a format. */
export type Highlight = 'properties' | 'lua' | 'yaml' | 'toml' | 'json' | 'plain';

export interface ParseIssue {
  /** 1-based. */
  line: number;
  /** 1-based. */
  col?: number;
  message: string;
}

export type ParseResult<D> = { ok: true; doc: D } | { ok: false; issues: ParseIssue[] };

/** The shape a file the game executes must have (`ConfigFileDecl.dataOnly`, CFG-02). */
export interface DataShape {
  form: 'assign' | 'function';
  name: string;
}

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
  /** Where a key's value is, for issues shown next to it. */
  locate?(doc: D, key: string): { line: number; col?: number } | null;
  /** Null when the parsed file has the shape a game-executed file must have. */
  checkShape?(doc: D, shape: DataShape): ParseIssue | null;
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

/**
 * `Key=Value` lines with `#` (or `;`) comments. PZ's ini has no sections, but
 * other games' do, so `[Section]` lines are accepted too. A line that is none
 * of these is an issue: the game would skip it silently.
 */
export const iniFormat: ConfigFormat<IniDoc> = {
  id: 'ini',
  highlight: 'properties',
  preservesComments: true,
  parse(text) {
    const doc = parseIni(text);
    const issues: ParseIssue[] = [];
    doc.lines.forEach((line, i) => {
      const t = (i === 0 && line.charCodeAt(0) === 0xfeff ? line.slice(1) : line).trim();
      if (t === '' || t.startsWith('#') || t.startsWith(';') || /^\[[^\]]*\]$/.test(t) || t.includes('=')) return;
      issues.push({ line: i + 1, col: 1, message: 'Expected "Key=Value", a "#" comment or an empty line' });
    });
    return issues.length ? { ok: false, issues } : { ok: true, doc };
  },
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
  locate(doc, key) {
    const e = doc.entries.findLast((x) => x.key === key);
    return e ? { line: e.line + 1, col: key.length + 2 } : null;
  },
};

/** Column (1-based) of an offset on its line. */
function colAt(src: string, offset: number): number {
  return offset - (src.lastIndexOf('\n', offset - 1) + 1) + 1;
}

/** Lua that must be plain data (the game executes it): `Name = {…}`, `return {…}` or `function Name() return {…} end`. */
export const luaDataFormat: ConfigFormat<LuaDataFile> = {
  id: 'lua-data',
  highlight: 'lua',
  preservesComments: true,
  parse(text) {
    try {
      return { ok: true, doc: parseLuaData(text) };
    } catch (e) {
      if (e instanceof LuaDataError) return { ok: false, issues: [{ line: e.lineNumber, col: colAt(text, e.offset), message: e.reason }] };
      throw e;
    }
  },
  flatten(doc) {
    const out: Record<string, Scalar> = {};
    for (const s of flattenScalars(doc.table)) if (s.value.type !== 'nil') out[s.path] = s.value.value;
    return out;
  },
  edit: (text, changes) => editLuaData(text, changes),
  locate(doc, key) {
    const f = getPath(doc.table, key);
    return f ? { line: f.line } : null;
  },
  checkShape(doc, shape) {
    if (doc.form === shape.form && doc.name === shape.name) return null;
    const expected = shape.form === 'assign' ? `${shape.name} = { … }` : `function ${shape.name}() return { … } end`;
    return { line: 1, col: 1, message: `This file must have the form: ${expected}` };
  },
};

/** Strict JSON; edits keep the layout (JSON has no comments). */
export const jsonFormat: ConfigFormat<JsonDoc> = {
  id: 'json',
  highlight: 'json',
  preservesComments: true,
  parse(text) {
    try {
      return { ok: true, doc: parseJson(text) };
    } catch (e) {
      if (e instanceof JsonSyntaxError) return { ok: false, issues: [{ line: e.line, col: e.col, message: e.reason }] };
      throw e;
    }
  },
  flatten: (doc) => flattenJson(doc.root),
  edit: (text, changes) => editJson(text, changes),
  create: (values) => buildJson(values),
  locate(doc, key) {
    const hit = getJsonMember(doc.root, key);
    return hit ? lineColAt(doc.src, hit.member.value.start) : null;
  },
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
  'lua-data': luaDataFormat,
  json: jsonFormat,
  text: textFormat,
};

/** Highlighting for every format id, implemented or not. */
export const FORMAT_HIGHLIGHT: Readonly<Record<FormatId, Highlight>> = {
  ini: 'properties',
  properties: 'properties',
  'lua-data': 'lua',
  json: 'json',
  json5: 'json',
  yaml: 'yaml',
  toml: 'toml',
  lines: 'plain',
  text: 'plain',
};

const EXTENSION_FORMATS: Readonly<Record<string, FormatId>> = {
  ini: 'ini',
  json: 'json',
  json5: 'json5',
  lua: 'lua-data',
  properties: 'properties',
  cfg: 'properties',
  conf: 'properties',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
};

/** The format a file name suggests (`.ini`, `.json`, `.yml`, …); plain text otherwise. */
export function formatIdForName(name: string): FormatId {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return (ext && EXTENSION_FORMATS[ext]) || 'text';
}

const plainCache = new Map<Highlight, ConfigFormat>();

/**
 * The format of a declared file (`ConfigFileDecl.format`) or of a file name.
 * A format not implemented yet is plain text with that format's highlighting,
 * so the file is still editable (principle 2: never a ceiling).
 */
export function formatFor(x: { format: FormatId } | string): ConfigFormat {
  const id = typeof x === 'string' ? formatIdForName(x) : x.format;
  const f = CONFIG_FORMATS[id];
  if (f) return f;
  const highlight = FORMAT_HIGHLIGHT[id];
  let plain = plainCache.get(highlight);
  if (!plain) {
    plain = { ...(textFormat as ConfigFormat), highlight };
    plainCache.set(highlight, plain);
  }
  return plain;
}
