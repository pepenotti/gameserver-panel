/**
 * TOML config files (CFG-02, CFG-07, CFG-09): Fabric, Forge and NeoForge
 * mods keep theirs in TOML. `smol-toml` reads and validates them; it can't
 * write a file back with its comments, so edits here are surgical, on a
 * scan of the file's statements:
 *
 *   - a changed value has only its own text replaced; its comment, the
 *     other lines and the order stay as they were;
 *   - a new key goes after the last key of its table (`[table]`), as a
 *     dotted key under the nearest table that exists, or in a new table at
 *     the end of the file;
 *   - a removed key takes only its own line(s).
 *
 * Values inside inline tables (`{ … }`), lists and arrays of tables
 * (`[[…]]`) are left to the text editor: forms don't show them, and an edit
 * that names one is refused rather than done by rewriting the file.
 */
import { parse, TomlDate, TomlError } from 'smol-toml';
import { lineColAt } from './json';

export type TomlScalar = string | number | boolean;

export interface TomlDoc {
  /** What the file holds, as `smol-toml` reads it (integers beyond 2^53 as bigint). */
  value: Record<string, unknown>;
  src: string;
}

export interface TomlIssue {
  line: number;
  col?: number;
  message: string;
}

export type TomlParse = { ok: true; doc: TomlDoc } | { ok: false; issues: TomlIssue[] };

export function parseTomlDoc(src: string): TomlParse {
  try {
    return { ok: true, doc: { value: parse(src, { integersAsBigInt: 'asNeeded' }) as Record<string, unknown>, src } };
  } catch (e) {
    if (!(e instanceof TomlError)) throw e;
    const message = e.message.split('\n')[0]!.replace(/^Invalid TOML document: /, '');
    return { ok: false, issues: [{ line: e.line, col: e.column, message: message.charAt(0).toUpperCase() + message.slice(1) }] };
  }
}

function mustParse(src: string): TomlDoc {
  const r = parseTomlDoc(src);
  if (!r.ok) throw new Error(`The TOML does not parse: ${r.issues[0]!.message} (line ${r.issues[0]!.line})`);
  return r.doc;
}

const isTable = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

function scalarOf(v: unknown): TomlScalar | undefined {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return String(v);
  if (v instanceof TomlDate) return v.toISOString();
  return undefined;
}

/** Every scalar inside nested tables as `a.b` → value. Lists, arrays of tables and keys containing "." are left to the text editor. */
export function flattenToml(doc: TomlDoc): Record<string, TomlScalar> {
  const out: Record<string, TomlScalar> = {};
  const walk = (t: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(t)) {
      if (k === '' || k.includes('.')) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      if (isTable(v)) walk(v, path);
      else {
        const s = scalarOf(v);
        if (s !== undefined) out[path] = s;
      }
    }
  };
  walk(doc.value, '');
  return out;
}

function getAt(root: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = root;
  for (const p of path) {
    if (!isTable(cur) || !Object.hasOwn(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
}

// ------------------------------------------------------------------ scanning

/** A `key = value` statement outside inline tables, lists and arrays of tables. */
interface Statement {
  path: string[];
  /** Offset of the statement's line. */
  lineStart: number;
  valueStart: number;
  valueEnd: number;
  /** Offset just after the statement's line (its comment and newline). */
  lineEnd: number;
  kind: 'basic' | 'literal' | 'multiline' | 'array' | 'inline' | 'bare';
}

interface TableHeader {
  path: string[];
  array: boolean;
  lineStart: number;
  /** Offset just after the header's line, or after its last statement. */
  end: number;
}

interface Scan {
  statements: Statement[];
  tables: TableHeader[];
  /** Offset after the last statement before the first header (0 when there is none). */
  rootEnd: number;
  /** Offset of the first header's line (the text's length when there is none). */
  firstHeader: number;
}

const BARE_KEY = /[A-Za-z0-9_-]/;

const ESCAPES: Readonly<Record<string, string>> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };

/** The text of a basic string's body (a quoted key), escapes decoded. */
function decodeBasic(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|[\s\S])/g, (_m, e: string) => (e.length > 1 ? String.fromCodePoint(parseInt(e.slice(1), 16)) : (ESCAPES[e] ?? e)));
}

/**
 * The statements and table headers of a valid TOML text. It only has to
 * find boundaries: `smol-toml` has already said the text is valid, and
 * reads every value.
 */
function scan(src: string): Scan {
  let i = 0;
  const n = src.length;
  const statements: Statement[] = [];
  const tables: TableHeader[] = [];
  let table: string[] = [];
  let inArrayTable = false;
  let current: TableHeader | null = null;
  let rootEnd = 0;

  const skipBlanks = () => {
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
  };
  const skipLine = () => {
    const nl = src.indexOf('\n', i);
    i = nl < 0 ? n : nl + 1;
  };
  const basic = (): string => {
    const start = ++i;
    while (i < n && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
    return decodeBasic(src.slice(start, i++));
  };
  const literal = (): string => {
    const start = ++i;
    while (i < n && src[i] !== "'") i++;
    return src.slice(start, i++);
  };
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipBlanks();
      if (src[i] === '"') parts.push(basic());
      else if (src[i] === "'") parts.push(literal());
      else {
        const s = i;
        while (i < n && BARE_KEY.test(src[i]!)) i++;
        parts.push(src.slice(s, i));
      }
      skipBlanks();
      if (src[i] !== '.') return parts;
      i++;
    }
  };
  /** Skips a string of any kind at `i`. */
  const skipString = () => {
    const q = src[i]!;
    if (src.startsWith(q.repeat(3), i)) {
      i += 3;
      for (;;) {
        if (i >= n) return;
        if (q === '"' && src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src.startsWith(q.repeat(3), i)) {
          i += 3;
          // Up to two more quotes belong to the string.
          while (src[i] === q && i < n) i++;
          return;
        }
        i++;
      }
    }
    i++;
    while (i < n && src[i] !== q) i += q === '"' && src[i] === '\\' ? 2 : 1;
    i++;
  };
  /** Skips a list or inline table at `i`, with what nests inside. */
  const skipNested = () => {
    let depth = 0;
    while (i < n) {
      const c = src[i]!;
      if (c === '"' || c === "'") {
        skipString();
        continue;
      }
      if (c === '#') {
        skipLine();
        continue;
      }
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0) {
          i++;
          return;
        }
      }
      i++;
    }
  };

  while (i < n) {
    // A new statement: blanks, empty lines and comment lines first.
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '#') {
      skipLine();
      continue;
    }
    const lineStart = src.lastIndexOf('\n', i - 1) + 1;
    if (c === '[') {
      const array = src[i + 1] === '[';
      i += array ? 2 : 1;
      table = key();
      i += array ? 2 : 1;
      skipLine();
      inArrayTable = array;
      current = { path: table, array, lineStart, end: i };
      tables.push(current);
      continue;
    }
    const k = key();
    i++; // '='
    skipBlanks();
    const valueStart = i;
    let kind: Statement['kind'];
    const v = src[i];
    if (v === '"' || v === "'") {
      kind = src.startsWith(v.repeat(3), i) ? 'multiline' : v === '"' ? 'basic' : 'literal';
      skipString();
    } else if (v === '[' || v === '{') {
      kind = v === '[' ? 'array' : 'inline';
      skipNested();
    } else {
      kind = 'bare';
      while (i < n && !/[\s#,\]}]/.test(src[i]!)) i++;
      // A date and a time may be separated by one space.
      if (src[i] === ' ' && /^\d{4}-\d{2}-\d{2}$/.test(src.slice(valueStart, i)) && /^\d{2}:/.test(src.slice(i + 1, i + 4))) {
        i++;
        while (i < n && !/[\s#,\]}]/.test(src[i]!)) i++;
      }
    }
    const valueEnd = i;
    skipLine();
    if (!inArrayTable) statements.push({ path: [...table, ...k], lineStart, valueStart, valueEnd, lineEnd: i, kind });
    if (current) current.end = i;
    else rootEnd = i;
  }
  return { statements, tables, rootEnd, firstHeader: tables[0]?.lineStart ?? n };
}

// ------------------------------------------------------------------- editing

const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/** A TOML basic string. */
function basicString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

function keyLiteral(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : basicString(k);
}

/** A number as TOML: an integer stays one (TOML tells them apart), a float keeps a point. */
function numberLiteral(path: string, integer: boolean, next: TomlScalar): string {
  const n = typeof next === 'number' ? next : typeof next === 'string' && next.trim() !== '' ? Number(next) : NaN;
  if (!Number.isFinite(n)) throw new Error(`${path} expects a number`);
  if (integer) {
    if (!Number.isInteger(n)) throw new Error(`${path} expects a whole number`);
    return String(n);
  }
  const s = String(n);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

/** Whether a number's source text is a float (`1.5`, `1e3`, `inf`, `nan`) rather than an integer (`15`, `0x0f`). */
const floatText = (text: string) => !/^[+-]?0[xob]/i.test(text) && /[.eEin]/.test(text);

/** The value `next` as TOML, in the type and quoting the current value has. */
function literalFor(path: string, current: unknown, st: Statement | null, src: string, next: TomlScalar): string {
  if (typeof current === 'bigint') return numberLiteral(path, true, next);
  if (typeof current === 'number') return numberLiteral(path, !(st && floatText(src.slice(st.valueStart, st.valueEnd))), next);
  if (typeof current === 'boolean') {
    const b = next === 'true' ? true : next === 'false' ? false : next;
    if (typeof b !== 'boolean') throw new Error(`${path} expects true or false`);
    return String(b);
  }
  if (current instanceof TomlDate) {
    const text = String(next).trim();
    const probe = parseTomlDoc(`v = ${text}`);
    if (!probe.ok || !(probe.doc.value.v instanceof TomlDate)) throw new Error(`${path} expects a date or time (e.g. 1979-05-27T07:32:00Z)`);
    return text;
  }
  if (typeof current === 'string') {
    const s = String(next);
    return st?.kind === 'literal' && !s.includes("'") && !CONTROL.test(s) ? `'${s}'` : basicString(s);
  }
  // A new key: by the value's own type.
  if (typeof next === 'number') {
    if (!Number.isFinite(next)) throw new Error(`Not a finite number: ${next}`);
    return String(next);
  }
  return typeof next === 'boolean' ? String(next) : basicString(next);
}

const eolOf = (src: string) => (src.includes('\r\n') ? '\r\n' : '\n');

function insertAt(src: string, at: number, text: string): string {
  const eol = eolOf(src);
  const lead = at > 0 && src[at - 1] !== '\n' ? eol : '';
  return src.slice(0, at) + lead + text + eol + src.slice(at);
}

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function unreachable(path: string): Error {
  return new Error(`${path} is inside an inline table or a list: change it in the text editor`);
}

function setOne(src: string, path: string[], next: TomlScalar): string {
  const doc = mustParse(src);
  const dotted = path.join('.');
  const s = scan(src);
  const current = getAt(doc.value, path);
  let out: string;
  if (current !== undefined) {
    if (isTable(current) || Array.isArray(current)) throw new Error(`${dotted} is ${Array.isArray(current) ? 'a list' : 'a table'}, not a single value`);
    const st = s.statements.find((x) => samePath(x.path, path));
    if (!st) throw unreachable(dotted);
    out = src.slice(0, st.valueStart) + literalFor(dotted, current, st, src, next) + src.slice(st.valueEnd);
  } else {
    // Where the new key goes: the nearest table on its path that has a header, else the root.
    for (let k = 1; k < path.length; k++) {
      const up = getAt(doc.value, path.slice(0, k));
      if (up !== undefined && !isTable(up)) throw new Error(`${path.slice(0, k).join('.')} is not a table`);
    }
    const parent = path.slice(0, -1);
    const text = (rest: string[]) => `${rest.map(keyLiteral).join('.')} = ${literalFor(dotted, undefined, null, src, next)}`;
    let host: TableHeader | null = null;
    for (let k = parent.length; k >= 1 && !host; k--) host = s.tables.find((t) => !t.array && samePath(t.path, parent.slice(0, k))) ?? null;
    if (host) out = insertAt(src, host.end, text(path.slice(host.path.length)));
    else if (parent.length > 0 && getAt(doc.value, parent) === undefined && s.tables.length > 0) {
      // A table nobody has named yet: a new section at the end.
      const eol = eolOf(src);
      out = insertAt(src, src.length, `${src.endsWith(eol + eol) || src === '' ? '' : eol}[${parent.map(keyLiteral).join('.')}]${eol}${text([path.at(-1)!])}`);
    } else out = insertAt(src, s.rootEnd > 0 ? s.rootEnd : s.firstHeader, text(path));
  }
  const check = parseTomlDoc(out);
  if (!check.ok) throw new Error(`Could not set ${dotted} without breaking the file (${check.issues[0]!.message}); change it in the text editor`);
  return out;
}

function removeOne(src: string, path: string[]): string {
  const doc = mustParse(src);
  const dotted = path.join('.');
  const current = getAt(doc.value, path);
  if (current === undefined) return src;
  const st = scan(src).statements.find((x) => samePath(x.path, path));
  if (!st) throw new Error(`${dotted} ${isTable(current) ? 'is a table' : 'is inside an inline table or a list'}: remove it in the text editor`);
  return src.slice(0, st.lineStart) + src.slice(st.lineEnd);
}

/**
 * Edits by dotted path that keep comments and layout: a value is replaced
 * in place (keeping its type), a new key is added to its table (creating
 * one when needed), `null` removes a key's line.
 */
export function editToml(src: string, changes: Record<string, TomlScalar | null>): string {
  let out = src;
  for (const [key, v] of Object.entries(changes)) {
    const path = key.split('.');
    if (path.some((p) => p === '')) throw new Error(`Invalid key ${JSON.stringify(key)}`);
    out = v === null ? removeOne(out, path) : setOne(out, path, v);
  }
  return out;
}

export function locateToml(doc: TomlDoc, key: string): { line: number; col: number } | null {
  const st = scan(doc.src).statements.find((x) => samePath(x.path, key.split('.')));
  return st ? lineColAt(doc.src, st.valueStart) : null;
}

/** A new file holding `values`: top-level keys first, then one table per dotted prefix. */
export function buildToml(values: Record<string, TomlScalar>): string {
  const groups = new Map<string, [string, TomlScalar][]>();
  for (const [path, v] of Object.entries(values)) {
    const parts = path.split('.');
    const table = parts.slice(0, -1).map(keyLiteral).join('.');
    groups.set(table, [...(groups.get(table) ?? []), [parts.at(-1)!, v]]);
  }
  const out: string[] = [];
  const root = groups.get('') ?? [];
  for (const [k, v] of root) out.push(`${keyLiteral(k)} = ${literalFor(k, undefined, null, '', v)}`);
  for (const [table, entries] of groups) {
    if (table === '') continue;
    if (out.length) out.push('');
    out.push(`[${table}]`);
    for (const [k, v] of entries) out.push(`${keyLiteral(k)} = ${literalFor(k, undefined, null, '', v)}`);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}
