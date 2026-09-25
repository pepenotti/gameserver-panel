/**
 * The format registry (PRD §10, CFG-07…09): one entry per config file format,
 * used by both the settings forms and the text editor so they can't drift
 * apart. Files whose name suggests no format are plain text; some of those
 * still get a highlighting (`formatFor`).
 */

import { buildIni, iniToRecord, parseIni, serializeIni, setIniValues, type IniDoc } from './ini';
import { buildJson, editJson, editJson5, flattenJson, getJsonMember, JsonSyntaxError, lineColAt, parseJson, parseJson5, type JsonDoc } from './json';
import { buildLines, editLines, parseLines, type LinesDoc } from './lines';
import { editLuaData, flattenScalars, getPath, LuaDataError, parseLuaData, type LuaDataFile } from './lua-data';
import { buildProperties, editProperties, parseProperties, propertiesToRecord, PropertiesSyntaxError, type PropertiesDoc } from './properties';
import { buildToml, editToml, flattenToml, locateToml, parseTomlDoc, type TomlDoc } from './toml';
import { buildYaml, editYaml, flattenYaml, locateYaml, parseYamlDoc, type YamlDoc } from './yaml';

/** A single setting value as forms and formats exchange it. */
export type Scalar = string | number | boolean;

export type FormatId = 'ini' | 'properties' | 'lua-data' | 'json' | 'json5' | 'yaml' | 'toml' | 'lines' | 'text';

/** Editor highlighting mode for a format (`json5`: the JavaScript mode, which knows comments and bare keys). */
export type Highlight = 'properties' | 'lua' | 'yaml' | 'toml' | 'json' | 'json5' | 'plain';

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

/** JSON5 (comments, bare keys, single quotes, trailing commas): checked by the `json5` package; edits keep comments and layout as for JSON. */
export const json5Format: ConfigFormat<JsonDoc> = {
  id: 'json5',
  highlight: 'json5',
  preservesComments: true,
  parse(text) {
    try {
      return { ok: true, doc: parseJson5(text) };
    } catch (e) {
      if (e instanceof JsonSyntaxError) return { ok: false, issues: [{ line: e.line, col: e.col, message: e.reason }] };
      throw e;
    }
  },
  flatten: (doc) => flattenJson(doc.root),
  edit: (text, changes) => editJson5(text, changes),
  create: (values) => buildJson(values),
  locate(doc, key) {
    const hit = getJsonMember(doc.root, key);
    return hit ? lineColAt(doc.src, hit.member.value.start) : null;
  },
};

/** Java properties (`server.properties`): values are text; edits rewrite only the changed values, escaped as Java writes them. */
export const propertiesFormat: ConfigFormat<PropertiesDoc> = {
  id: 'properties',
  highlight: 'properties',
  preservesComments: true,
  parse(text) {
    try {
      return { ok: true, doc: parseProperties(text) };
    } catch (e) {
      if (e instanceof PropertiesSyntaxError) return { ok: false, issues: [{ line: e.line, col: e.col, message: e.reason }] };
      throw e;
    }
  },
  flatten: (doc) => propertiesToRecord(doc),
  edit(text, changes) {
    return editProperties(text, Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v === null ? null : asText(v)])));
  },
  create: (values) => buildProperties(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, asText(v)]))),
  locate(doc, key) {
    const e = doc.entries.findLast((x) => x.key === key);
    return e ? { line: e.line + 1, col: e.valueCol } : null;
  },
};

/** YAML through the `yaml` package's Document API: comments always survive; see `editYaml` for when the layout may not. */
export const yamlFormat: ConfigFormat<YamlDoc> = {
  id: 'yaml',
  highlight: 'yaml',
  preservesComments: true,
  parse: (text) => parseYamlDoc(text),
  flatten: (doc) => flattenYaml(doc),
  edit: (text, changes) => editYaml(text, changes),
  create: (values) => buildYaml(values),
  locate: (doc, key) => locateYaml(doc, key),
};

/** TOML checked by `smol-toml`; edits are surgical (see `editToml`), and refused inside inline tables and lists. */
export const tomlFormat: ConfigFormat<TomlDoc> = {
  id: 'toml',
  highlight: 'toml',
  preservesComments: true,
  parse: (text) => parseTomlDoc(text),
  flatten: (doc) => flattenToml(doc),
  edit: (text, changes) => editToml(text, changes),
  create: (values) => buildToml(values),
  locate: (doc, key) => locateToml(doc, key),
};

/** One entry per line, `#` comments: a set whose entries are keys with the value `true` (`null` or `false` removes one). */
export const linesFormat: ConfigFormat<LinesDoc> = {
  id: 'lines',
  highlight: 'plain',
  preservesComments: true,
  parse: (text) => ({ ok: true, doc: parseLines(text) }),
  flatten: (doc) => Object.fromEntries(doc.entries.map((e) => [e.value, true])),
  edit(text, changes) {
    const set: Record<string, boolean | null> = {};
    for (const [k, v] of Object.entries(changes)) {
      if (v !== null && typeof v !== 'boolean') throw new Error(`A list entry is added with true and removed with null (${k})`);
      set[k] = v;
    }
    return editLines(text, set);
  },
  create: (values) => buildLines(Object.keys(values).filter((k) => values[k] === true)),
  locate(doc, key) {
    const e = doc.entries.find((x) => x.value === key);
    return e ? { line: e.line + 1 } : null;
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

/** Formats by id: every `FormatId`. */
export const CONFIG_FORMATS: { readonly [K in FormatId]: ConfigFormat } = {
  ini: iniFormat,
  properties: propertiesFormat,
  'lua-data': luaDataFormat,
  json: jsonFormat,
  json5: json5Format,
  yaml: yamlFormat,
  toml: tomlFormat,
  lines: linesFormat,
  text: textFormat,
};

/** Highlighting for every format id. */
export const FORMAT_HIGHLIGHT: Readonly<Record<FormatId, Highlight>> = {
  ini: 'properties',
  properties: 'properties',
  'lua-data': 'lua',
  json: 'json',
  json5: 'json5',
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
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
};

/**
 * Names that suggest a highlighting but no format: `.cfg` and `.conf` files
 * are all kinds of things (key=value, console commands, sections), so they
 * are edited as text, only coloured like properties.
 */
const EXTENSION_HIGHLIGHT: Readonly<Record<string, Highlight>> = {
  cfg: 'properties',
  conf: 'properties',
};

const extensionOf = (name: string) => /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();

/** The format a file name suggests (`.ini`, `.json`, `.yml`, …); plain text otherwise. */
export function formatIdForName(name: string): FormatId {
  const ext = extensionOf(name);
  return (ext && EXTENSION_FORMATS[ext]) || 'text';
}

const plainCache = new Map<Highlight, ConfigFormat>();

/** Plain text, highlighted as `highlight`. */
function plainText(highlight: Highlight): ConfigFormat {
  if (highlight === 'plain') return textFormat as ConfigFormat;
  let plain = plainCache.get(highlight);
  if (!plain) {
    plain = { ...(textFormat as ConfigFormat), highlight };
    plainCache.set(highlight, plain);
  }
  return plain;
}

/**
 * The format of a declared file (`ConfigFileDecl.format`) or of a file name.
 * A name that suggests no format is plain text (principle 2: never a
 * ceiling), with a highlighting when its extension suggests one.
 */
export function formatFor(x: { format: FormatId } | string): ConfigFormat {
  if (typeof x !== 'string') return CONFIG_FORMATS[x.format];
  const id = formatIdForName(x);
  if (id !== 'text') return CONFIG_FORMATS[id];
  const ext = extensionOf(x);
  return plainText((ext && EXTENSION_HIGHLIGHT[ext]) || 'plain');
}
