/**
 * A data-only reader/editor for Lua settings files a game keeps next to its
 * ini (world options, spawn tables) and the game's own presets.
 *
 * The game *executes* these files with access to its Java API, so accepting
 * raw text from the panel would be remote code execution. Only these shapes
 * are accepted:
 *
 *   Name = <table>
 *   return <table>
 *   function Name() return <table> end
 *
 * where a table holds only nested tables, strings, numbers, booleans and nil.
 * Anything else (calls, operators, identifiers as values, `require`) is
 * rejected with a position.
 */

export class LuaDataError extends Error {
  /** The message without the position, for editors that show the position themselves. */
  readonly reason: string;

  constructor(
    message: string,
    readonly offset: number,
    readonly lineNumber: number,
  ) {
    super(`${message} (line ${lineNumber})`);
    this.reason = message;
  }
}

export type LuaScalar =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number; raw: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'nil' };

export interface LuaTable {
  type: 'table';
  fields: LuaField[];
  /** Offset of `{`. */
  start: number;
  /** Offset just after `}`. */
  end: number;
}

export type LuaValue = LuaScalar | LuaTable;

export interface LuaField {
  /** Named key (`Key = …` or `["Key"] = …`), or null for a positional entry. */
  key: string | null;
  value: LuaValue;
  /** `--` comment lines directly above this field, without the dashes. */
  comments: string[];
  /** Offsets of the value's source text. */
  valueStart: number;
  valueEnd: number;
  /** Offset of the field's first token (its key, or the value for a positional entry). */
  start: number;
  /** Offset just after the field's `,` or `;`, or `valueEnd` when it has none. */
  end: number;
  /** 1-based line of the value. */
  line: number;
}

export interface LuaDataFile {
  form: 'assign' | 'return' | 'function';
  /** Variable or function name for the `assign` / `function` forms. */
  name?: string;
  table: LuaTable;
}

type Tok =
  | { t: 'name'; v: string; s: number; e: number }
  | { t: 'string'; v: string; s: number; e: number }
  | { t: 'number'; v: number; raw: string; s: number; e: number }
  | { t: 'sym'; v: string; s: number; e: number }
  | { t: 'eof'; s: number; e: number };

interface Comment {
  text: string;
  /** Line number the comment is on (1-based). */
  line: number;
}

const NUMBER = /0[xX][0-9a-fA-F]+|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;

const KEYWORDS_OK = new Set(['true', 'false', 'nil', 'return', 'function', 'end']);

/** 1-based line numbers for offsets, via binary search over line starts. */
class Lines {
  private readonly starts: number[] = [0];

  constructor(src: string) {
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) this.starts.push(i + 1);
  }

  at(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** True when only whitespace precedes `offset` on its line. */
  ownLine(src: string, offset: number): boolean {
    const start = this.starts[this.at(offset) - 1]!;
    return src.slice(start, offset).trim() === '';
  }
}

function tokenize(src: string, lines: Lines): { toks: Tok[]; comments: Comment[] } {
  const toks: Tok[] = [];
  const comments: Comment[] = [];
  let i = 0;
  const err = (msg: string, at = i): never => {
    throw new LuaDataError(msg, at, lines.at(at));
  };

  const longBracket = (at: number): { level: number; len: number } | null => {
    // [[ or [=*[
    if (src[at] !== '[') return null;
    let j = at + 1;
    let level = 0;
    while (src[j] === '=') {
      level++;
      j++;
    }
    return src[j] === '[' ? { level, len: j - at + 1 } : null;
  };
  const readLong = (at: number, level: number, open: number): { text: string; end: number } => {
    const close = `]${'='.repeat(level)}]`;
    const endIdx = src.indexOf(close, at + open);
    if (endIdx < 0) err('Unclosed long bracket', at);
    let text = src.slice(at + open, endIdx);
    if (text.startsWith('\r\n')) text = text.slice(2);
    else if (text.startsWith('\n')) text = text.slice(1);
    return { text, end: endIdx + close.length };
  };

  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '-' && src[i + 1] === '-') {
      // Trailing comments (after code on the same line) never describe the next field.
      const own = lines.ownLine(src, i);
      const lb = longBracket(i + 2);
      if (lb) {
        const { text, end } = readLong(i + 2, lb.level, lb.len);
        const rawStart = i + 2 + lb.len;
        const skipped = src.startsWith('\r\n', rawStart) || src[rawStart] === '\n' ? 1 : 0;
        const firstLine = lines.at(rawStart) + skipped;
        if (own) text.split(/\r?\n/).forEach((l, k) => comments.push({ text: l.trim(), line: firstLine + k }));
        i = end;
      } else {
        let j = src.indexOf('\n', i);
        if (j < 0) j = src.length;
        if (own) comments.push({ text: src.slice(i + 2, j).replace(/\r$/, '').trim(), line: lines.at(i) });
        i = j;
      }
      continue;
    }
    const s = i;
    if (/[A-Za-z_]/.test(c)) {
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      toks.push({ t: 'name', v: src.slice(s, i), s, e: i });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src);
      if (!m) err('Bad number');
      const raw = m![0];
      i += raw.length;
      toks.push({ t: 'number', v: Number(raw), raw, s, e: i });
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      let out = '';
      for (;;) {
        if (i >= src.length) err('Unclosed string', s);
        const ch = src[i]!;
        if (ch === c) {
          i++;
          break;
        }
        if (ch === '\n') err('Line break inside a string', i);
        if (ch !== '\\') {
          out += ch;
          i++;
          continue;
        }
        const n = src[i + 1] ?? '';
        i += 2;
        const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };
        if (n in simple) out += simple[n];
        else if (n === 'x') {
          const hex = src.slice(i, i + 2);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) err('Bad \\x escape', i);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2;
        } else if (/[0-9]/.test(n)) {
          let digits = n;
          while (digits.length < 3 && /[0-9]/.test(src[i] ?? '')) digits += src[i++];
          out += String.fromCharCode(Number(digits));
        } else if (n === 'z') {
          while (/\s/.test(src[i] ?? '')) i++;
        } else if (n === 'u' && src[i] === '{') {
          const close = src.indexOf('}', i);
          out += String.fromCodePoint(parseInt(src.slice(i + 1, close), 16));
          i = close + 1;
        } else err(`Unknown escape \\${n}`, i - 2);
      }
      toks.push({ t: 'string', v: out, s, e: i });
      continue;
    }
    if (c === '[') {
      const lb = longBracket(i);
      if (lb) {
        const { text, end } = readLong(i, lb.level, lb.len);
        i = end;
        toks.push({ t: 'string', v: text, s, e: i });
        continue;
      }
    }
    if ('{}[]=,;()-'.includes(c)) {
      toks.push({ t: 'sym', v: c, s, e: i + 1 });
      i++;
      continue;
    }
    err(`Unexpected character ${JSON.stringify(c)}`);
  }
  toks.push({ t: 'eof', s: src.length, e: src.length });
  return { toks, comments };
}

class Parser {
  private p = 0;
  private commentIdx = 0;

  constructor(
    private readonly src: string,
    private readonly lines: Lines,
    private readonly toks: Tok[],
    private readonly comments: Comment[],
  ) {}

  private peek(o = 0): Tok {
    return this.toks[Math.min(this.p + o, this.toks.length - 1)]!;
  }

  private next(): Tok {
    return this.toks[this.p++]!;
  }

  private fail(msg: string, tok = this.peek()): never {
    throw new LuaDataError(msg, tok.s, this.lines.at(tok.s));
  }

  private expectSym(v: string): Tok {
    const t = this.next();
    if (t.t !== 'sym' || t.v !== v) this.fail(`Expected "${v}"`, t);
    return t;
  }

  private expectName(v?: string): string {
    const t = this.next();
    if (t.t !== 'name' || (v !== undefined && t.v !== v)) this.fail(v ? `Expected "${v}"` : 'Expected a name', t);
    return t.v;
  }

  /** Comments that end before `offset` and are directly above it (no blank line between). */
  private takeComments(offset: number): string[] {
    const fieldLine = this.lines.at(offset);
    const out: Comment[] = [];
    while (this.commentIdx < this.comments.length) {
      const c = this.comments[this.commentIdx]!;
      if (c.line >= fieldLine) break;
      out.push(c);
      this.commentIdx++;
    }
    // Keep only the contiguous block ending on the line above the field.
    const block: string[] = [];
    let expect = fieldLine - 1;
    for (let k = out.length - 1; k >= 0; k--) {
      if (out[k]!.line !== expect) break;
      block.unshift(out[k]!.text);
      expect--;
    }
    return block;
  }

  parseFile(): LuaDataFile {
    const t = this.peek();
    let result: LuaDataFile;
    if (t.t === 'name' && t.v === 'return') {
      this.next();
      result = { form: 'return', table: this.parseTable() };
    } else if (t.t === 'name' && t.v === 'function') {
      this.next();
      const name = this.expectName();
      this.expectSym('(');
      this.expectSym(')');
      this.expectName('return');
      const table = this.parseTable();
      this.expectName('end');
      result = { form: 'function', name, table };
    } else if (t.t === 'name' && !KEYWORDS_OK.has(t.v)) {
      const name = this.expectName();
      this.expectSym('=');
      result = { form: 'assign', name, table: this.parseTable() };
    } else {
      this.fail('Expected "Name = {", "return {" or "function Name() return {"');
    }
    const rest = this.peek();
    if (rest.t !== 'eof') this.fail('Only one table is allowed; found more code after it', rest);
    return result;
  }

  private parseValue(): LuaValue {
    const t = this.peek();
    if (t.t === 'sym' && t.v === '{') return this.parseTable();
    if (t.t === 'sym' && t.v === '-') {
      this.next();
      const n = this.next();
      if (n.t !== 'number') this.fail('Expected a number after "-"', n);
      return { type: 'number', value: -n.v, raw: `-${n.raw}` };
    }
    this.next();
    if (t.t === 'string') return { type: 'string', value: t.v };
    if (t.t === 'number') return { type: 'number', value: t.v, raw: t.raw };
    if (t.t === 'name' && t.v === 'true') return { type: 'boolean', value: true };
    if (t.t === 'name' && t.v === 'false') return { type: 'boolean', value: false };
    if (t.t === 'name' && t.v === 'nil') return { type: 'nil' };
    return this.fail(t.t === 'name' ? `"${t.v}" is not a plain value (only tables, strings, numbers, booleans)` : 'Expected a value', t);
  }

  private parseTable(): LuaTable {
    const open = this.expectSym('{');
    const fields: LuaField[] = [];
    for (;;) {
      const t = this.peek();
      if (t.t === 'sym' && t.v === '}') break;
      const comments = this.takeComments(t.s);
      let key: string | null = null;
      const after = this.peek(1);
      if (t.t === 'name' && after.t === 'sym' && after.v === '=') {
        key = t.v;
        this.next();
        this.next();
      } else if (t.t === 'sym' && t.v === '[') {
        this.next();
        const k = this.next();
        if (k.t !== 'string' && k.t !== 'number') this.fail('Only string or number keys are allowed in [ ]', k);
        key = String(k.v);
        this.expectSym(']');
        this.expectSym('=');
      }
      const valueStart = this.peek().s;
      const value = this.parseValue();
      const valueEnd = value.type === 'table' ? value.end : this.toks[this.p - 1]!.e;
      const field: LuaField = { key, value, comments, valueStart, valueEnd, start: t.s, end: valueEnd, line: this.lines.at(valueStart) };
      fields.push(field);
      const sep = this.peek();
      if (sep.t === 'sym' && (sep.v === ',' || sep.v === ';')) {
        this.next();
        field.end = sep.e;
        continue;
      }
      if (sep.t === 'sym' && sep.v === '}') break;
      this.fail('Expected "," or "}"', sep);
    }
    // Comments after the last field belong to nobody; skip past them.
    const close = this.expectSym('}');
    while (this.commentIdx < this.comments.length && this.lines.at(close.s) >= this.comments[this.commentIdx]!.line) this.commentIdx++;
    return { type: 'table', fields, start: open.s, end: close.e };
  }
}

export function parseLuaData(src: string): LuaDataFile {
  const lines = new Lines(src);
  const { toks, comments } = tokenize(src, lines);
  return new Parser(src, lines, toks, comments).parseFile();
}

/** Throws a LuaDataError if `src` is not a data-only file. */
export function validateLuaData(src: string): void {
  parseLuaData(src);
}

export function getField(table: LuaTable, key: string): LuaField | undefined {
  for (let i = table.fields.length - 1; i >= 0; i--) if (table.fields[i]!.key === key) return table.fields[i];
  return undefined;
}

/** Resolve a dotted path (`ZombieLore.Speed`) to its field. */
export function getPath(table: LuaTable, path: string): LuaField | undefined {
  const parts = path.split('.');
  let cur: LuaTable = table;
  for (let i = 0; i < parts.length; i++) {
    const f = getField(cur, parts[i]!);
    if (!f) return undefined;
    if (i === parts.length - 1) return f;
    if (f.value.type !== 'table') return undefined;
    cur = f.value;
  }
  return undefined;
}

export interface FlatScalar {
  path: string;
  value: LuaScalar;
  comments: string[];
}

/** Every named scalar in document order, nested tables as dotted paths. */
export function flattenScalars(table: LuaTable, prefix = ''): FlatScalar[] {
  const out: FlatScalar[] = [];
  for (const f of table.fields) {
    if (f.key === null) continue;
    const path = prefix ? `${prefix}.${f.key}` : f.key;
    if (f.value.type === 'table') out.push(...flattenScalars(f.value, path));
    else out.push({ path, value: f.value, comments: f.comments });
  }
  return out;
}

export function scalarToJs(v: LuaScalar): string | number | boolean | null {
  return v.type === 'nil' ? null : v.value;
}

export function luaString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 32 || code === 127) out += `\\${code.toString().padStart(3, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Format a number for Lua, keeping the "1.0" style when the original had a decimal point. */
export function luaNumber(n: number, like?: string): string {
  if (!Number.isFinite(n)) throw new Error(`Not a finite number: ${n}`);
  const s = String(n);
  if (like !== undefined && /[.eE]/.test(like) && Number.isInteger(n) && !/[eE]/.test(s)) return `${s}.0`;
  return s;
}

export type LuaEdit = string | number | boolean;

/** A scalar as Lua source. */
export function luaLiteral(v: LuaEdit): string {
  if (typeof v === 'string') return luaString(v);
  if (typeof v === 'number') return luaNumber(v);
  return String(v);
}

const LUA_KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);

/** A table key as Lua source: `Name`, or `["any text"]`. */
export function luaKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !LUA_KEYWORDS.has(key) ? key : `[${luaString(key)}]`;
}

/**
 * Apply scalar edits by dotted path, replacing only each value's source text,
 * so comments and layout survive. The value keeps its original Lua type: a
 * string option stays a string, a number must be a finite number, and so on.
 * Unknown paths throw (the game would drop them anyway).
 */
export function setLuaValues(src: string, edits: Record<string, LuaEdit>): string {
  const file = parseLuaData(src);
  const replacements: { start: number; end: number; text: string }[] = [];
  for (const [path, next] of Object.entries(edits)) {
    const field = getPath(file.table, path);
    if (!field) throw new Error(`Unknown option ${path}`);
    const cur = field.value;
    let text: string;
    if (cur.type === 'string') {
      if (typeof next !== 'string') throw new Error(`${path} expects text`);
      text = luaString(next);
    } else if (cur.type === 'number') {
      const n = typeof next === 'number' ? next : typeof next === 'string' && next.trim() !== '' ? Number(next) : NaN;
      if (!Number.isFinite(n)) throw new Error(`${path} expects a number`);
      text = luaNumber(n, cur.raw);
    } else if (cur.type === 'boolean') {
      const b = next === 'true' ? true : next === 'false' ? false : next;
      if (typeof b !== 'boolean') throw new Error(`${path} expects true or false`);
      text = String(b);
    } else if (cur.type === 'nil') {
      text = luaLiteral(next);
    } else {
      throw new Error(`${path} is a table, not a single value`);
    }
    replacements.push({ start: field.valueStart, end: field.valueEnd, text });
  }
  replacements.sort((a, b) => b.start - a.start);
  let out = src;
  for (const r of replacements) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  validateLuaData(out);
  return out;
}

/** Leading whitespace of the line `offset` is on. */
function indentAt(src: string, offset: number): string {
  const lineStart = src.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(src.slice(lineStart))![0];
}

/** End of the line `offset` is on (before its `\r\n` or `\n`). */
function lineEndAt(src: string, offset: number): number {
  const nl = src.indexOf('\n', offset);
  if (nl < 0) return src.length;
  return src[nl - 1] === '\r' ? nl - 1 : nl;
}

/** A trailing `--` comment that ends on its own line (not a `--[[` block). */
const isLineComment = (rest: string) => rest.startsWith('--') && !/^--\[=*\[/.test(rest);

/** Add `key = <valueText>,` as the table's last field, following its layout. */
function insertField(src: string, table: LuaTable, key: string, valueText: string): string {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const entry = `${luaKey(key)} = ${valueText},`;
  const last = table.fields.at(-1);
  if (!last) {
    const open = table.start + 1;
    const close = table.end - 1;
    const base = indentAt(src, table.start);
    if (src.slice(open, close).trim() === '') return `${src.slice(0, open)}${eol}${base}    ${entry}${eol}${base}${src.slice(close)}`;
    // Only comments inside: the entry goes on its own line before the closing brace.
    const closeLineStart = src.lastIndexOf('\n', close - 1) + 1;
    if (src.slice(closeLineStart, close).trim() === '') return `${src.slice(0, closeLineStart)}${base}    ${entry}${eol}${src.slice(closeLineStart)}`;
    return `${src.slice(0, close)} ${entry} ${src.slice(close)}`;
  }
  let out = src;
  let at = last.end;
  if (last.end === last.valueEnd) {
    out = `${out.slice(0, last.valueEnd)},${out.slice(last.valueEnd)}`;
    at = last.valueEnd + 1;
  }
  const lineEnd = lineEndAt(out, at);
  const rest = out.slice(at, lineEnd).trim();
  if (rest === '' || isLineComment(rest)) return `${out.slice(0, lineEnd)}${eol}${indentAt(out, last.start)}${entry}${out.slice(lineEnd)}`;
  // A one-line table: stay on that line.
  return `${out.slice(0, at)} ${entry}${out.slice(at)}`;
}

/** Add a scalar at a dotted path that doesn't exist yet, creating the tables on the way. */
function insertPath(src: string, path: string, value: LuaEdit): string {
  const parts = path.split('.');
  let table = parseLuaData(src).table;
  let i = 0;
  for (; i < parts.length - 1; i++) {
    const f = getField(table, parts[i]!);
    if (!f) break;
    if (f.value.type !== 'table') throw new Error(`${parts.slice(0, i + 1).join('.')} is not a table`);
    table = f.value;
  }
  let valueText = luaLiteral(value);
  for (let j = parts.length - 1; j > i; j--) valueText = `{ ${luaKey(parts[j]!)} = ${valueText} }`;
  return insertField(src, table, parts[i]!, valueText);
}

/** Remove the field at a dotted path, with its own line(s) and the comment lines directly above it. */
function removePath(src: string, path: string): string {
  const f = getPath(parseLuaData(src).table, path);
  if (!f) return src;
  let from = f.start;
  let to = f.end;
  const lineStart = src.lastIndexOf('\n', from - 1) + 1;
  const lineEnd = lineEndAt(src, to);
  const rest = src.slice(to, lineEnd).trim();
  if (src.slice(lineStart, from).trim() === '' && (rest === '' || isLineComment(rest))) {
    from = lineStart;
    const nl = src.indexOf('\n', to);
    to = nl < 0 ? src.length : nl + 1;
    for (let k = 0; k < f.comments.length && from > 0; k++) from = src.lastIndexOf('\n', from - 2) + 1;
  } else {
    while (src[to] === ' ' || src[to] === '\t') to++;
  }
  return src.slice(0, from) + src.slice(to);
}

/**
 * Edits by dotted path that keep comments and layout: existing scalars are
 * replaced in place (keeping their type, as `setLuaValues`), new paths are
 * added as the last field of their table, and `null` removes a field with
 * the comments above it. The result is checked to still be data-only.
 */
export function editLuaData(src: string, changes: Record<string, LuaEdit | null>): string {
  const table = parseLuaData(src).table;
  const sets: Record<string, LuaEdit> = {};
  const rest: [string, LuaEdit | null][] = [];
  for (const [path, v] of Object.entries(changes)) {
    const f = getPath(table, path);
    if (v !== null && f) {
      if (f.value.type === 'table') throw new Error(`${path} is a table, not a single value`);
      sets[path] = v;
    } else rest.push([path, v]);
  }
  let out = Object.keys(sets).length ? setLuaValues(src, sets) : src;
  for (const [path, v] of rest) out = v === null ? removePath(out, path) : insertPath(out, path, v);
  if (rest.length) validateLuaData(out);
  return out;
}
