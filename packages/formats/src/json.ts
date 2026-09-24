/**
 * Strict JSON (RFC 8259) with source positions, for config files other games
 * and their plugins keep (CFG-07, CFG-09). `JSON.parse` would do for reading,
 * but the text editor needs the line and column of a mistake, and form edits
 * must replace one value without reformatting the rest of the file.
 */

export class JsonSyntaxError extends Error {
  constructor(
    readonly reason: string,
    readonly offset: number,
    readonly line: number,
    readonly col: number,
  ) {
    super(`${reason} (line ${line}, column ${col})`);
  }
}

interface Span {
  /** Offset of the value's first character. */
  start: number;
  /** Offset just after the value. */
  end: number;
}

export type JsonNode =
  | (Span & { type: 'object'; members: JsonMember[] })
  | (Span & { type: 'array'; items: JsonNode[] })
  | (Span & { type: 'string'; value: string })
  | (Span & { type: 'number'; value: number; raw: string })
  | (Span & { type: 'boolean'; value: boolean })
  | (Span & { type: 'null' });

export interface JsonMember {
  key: string;
  /** Offset of the key's opening quote. */
  keyStart: number;
  value: JsonNode;
}

export interface JsonDoc {
  root: JsonNode;
  src: string;
}

export type JsonScalar = string | number | boolean;

/** 1-based line and column of an offset. */
export function lineColAt(src: string, offset: number): { line: number; col: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: offset - lineStart + 1 };
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

class Parser {
  private i = 0;

  constructor(private readonly src: string) {
    // A byte-order mark is not JSON, but editors add one; it is kept in the text.
    if (src.charCodeAt(0) === 0xfeff) this.i = 1;
  }

  private fail(reason: string, at = this.i): never {
    const { line, col } = lineColAt(this.src, at);
    throw new JsonSyntaxError(reason, at, line, col);
  }

  private ws(): void {
    for (;;) {
      const c = this.src[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.i++;
      else return;
    }
  }

  parseDocument(): JsonNode {
    this.ws();
    if (this.i >= this.src.length) this.fail('The file is empty; expected a JSON value');
    const root = this.value();
    this.ws();
    if (this.i < this.src.length) this.fail('Unexpected text after the JSON value');
    return root;
  }

  private value(): JsonNode {
    const c = this.src[this.i];
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"') {
      const start = this.i;
      const value = this.string();
      return { type: 'string', value, start, end: this.i };
    }
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
      NUMBER.lastIndex = this.i;
      const m = NUMBER.exec(this.src);
      if (!m) this.fail('Invalid number');
      const start = this.i;
      this.i += m![0].length;
      return { type: 'number', value: Number(m![0]), raw: m![0], start, end: this.i };
    }
    for (const [word, node] of [
      ['true', { type: 'boolean', value: true }],
      ['false', { type: 'boolean', value: false }],
      ['null', { type: 'null' }],
    ] as const) {
      if (this.src.startsWith(word, this.i)) {
        const start = this.i;
        this.i += word.length;
        return { ...node, start, end: this.i } as JsonNode;
      }
    }
    if (c === undefined) this.fail('Unexpected end of the file');
    return this.fail(`Unexpected character ${JSON.stringify(c)}`);
  }

  private string(): string {
    const start = this.i;
    this.i++;
    let out = '';
    for (;;) {
      if (this.i >= this.src.length) this.fail('Unclosed string', start);
      const ch = this.src[this.i]!;
      if (ch === '"') {
        this.i++;
        return out;
      }
      if (ch.charCodeAt(0) < 0x20) this.fail('Line break or control character inside a string');
      if (ch !== '\\') {
        out += ch;
        this.i++;
        continue;
      }
      const n = this.src[this.i + 1] ?? '';
      if (n === 'u') {
        const hex = this.src.slice(this.i + 2, this.i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('Bad \\u escape');
        out += String.fromCharCode(parseInt(hex, 16));
        this.i += 6;
      } else if (n in ESCAPES) {
        out += ESCAPES[n];
        this.i += 2;
      } else this.fail(`Unknown escape \\${n}`);
    }
  }

  private object(): JsonNode {
    const start = this.i;
    this.i++;
    const members: JsonMember[] = [];
    this.ws();
    if (this.src[this.i] === '}') {
      this.i++;
      return { type: 'object', members, start, end: this.i };
    }
    for (;;) {
      this.ws();
      if (this.src[this.i] !== '"') this.fail(this.src[this.i] === '}' ? 'Trailing comma before "}"' : 'Expected a property name in double quotes');
      const keyStart = this.i;
      const key = this.string();
      this.ws();
      if (this.src[this.i] !== ':') this.fail('Expected ":" after the property name');
      this.i++;
      this.ws();
      members.push({ key, keyStart, value: this.value() });
      this.ws();
      const c = this.src[this.i];
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === '}') {
        this.i++;
        return { type: 'object', members, start, end: this.i };
      }
      this.fail('Expected "," or "}"');
    }
  }

  private array(): JsonNode {
    const start = this.i;
    this.i++;
    const items: JsonNode[] = [];
    this.ws();
    if (this.src[this.i] === ']') {
      this.i++;
      return { type: 'array', items, start, end: this.i };
    }
    for (;;) {
      this.ws();
      if (this.src[this.i] === ']') this.fail('Trailing comma before "]"');
      items.push(this.value());
      this.ws();
      const c = this.src[this.i];
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === ']') {
        this.i++;
        return { type: 'array', items, start, end: this.i };
      }
      this.fail('Expected "," or "]"');
    }
  }
}

export function parseJson(src: string): JsonDoc {
  return { root: new Parser(src).parseDocument(), src };
}

/** The member at a dotted path (last one wins, like `JSON.parse`), with the object holding it. */
export function getJsonMember(root: JsonNode, path: string): { member: JsonMember; parent: JsonNode & { type: 'object' } } | undefined {
  let cur: JsonNode = root;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (cur.type !== 'object') return undefined;
    const member: JsonMember | undefined = cur.members.findLast((m) => m.key === parts[i]);
    if (!member) return undefined;
    if (i === parts.length - 1) return { member, parent: cur };
    cur = member.value;
  }
  return undefined;
}

/** Every scalar inside nested objects as `a.b` → value. Arrays, nulls and keys containing "." are left to the text editor. */
export function flattenJson(root: JsonNode, prefix = ''): Record<string, JsonScalar> {
  const out: Record<string, JsonScalar> = {};
  if (root.type !== 'object') return out;
  for (const m of root.members) {
    if (m.key.includes('.') || m.key === '') continue;
    const path = prefix ? `${prefix}.${m.key}` : m.key;
    const v = m.value;
    if (v.type === 'object') Object.assign(out, flattenJson(v, path));
    else if (v.type === 'string' || v.type === 'number' || v.type === 'boolean') out[path] = v.value;
  }
  return out;
}

/** The value `next` as JSON of the type the current value has (a number stays a number, …). */
function typedLiteral(path: string, cur: JsonNode, next: JsonScalar): string {
  switch (cur.type) {
    case 'string':
      return JSON.stringify(String(next));
    case 'number': {
      const n = typeof next === 'number' ? next : typeof next === 'string' && next.trim() !== '' ? Number(next) : NaN;
      if (!Number.isFinite(n)) throw new Error(`${path} expects a number`);
      return JSON.stringify(n);
    }
    case 'boolean': {
      const b = next === 'true' ? true : next === 'false' ? false : next;
      if (typeof b !== 'boolean') throw new Error(`${path} expects true or false`);
      return String(b);
    }
    case 'null':
      return JSON.stringify(next);
    default:
      throw new Error(`${path} is ${cur.type === 'object' ? 'an object' : 'a list'}, not a single value`);
  }
}

function jsonLiteral(v: JsonScalar): string {
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`Not a finite number: ${v}`);
  return JSON.stringify(v);
}

function indentAt(src: string, offset: number): string {
  const lineStart = src.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(src.slice(lineStart))![0];
}

function insertMember(src: string, obj: JsonNode & { type: 'object' }, key: string, valueText: string): string {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const entry = `${JSON.stringify(key)}: ${valueText}`;
  const multiline = src.slice(obj.start, obj.end).includes('\n');
  const last = obj.members.at(-1);
  if (!last) {
    const base = indentAt(src, obj.start);
    const inner = multiline ? `${eol}${base}  ${entry}${eol}${base}` : ` ${entry} `;
    return src.slice(0, obj.start + 1) + inner + src.slice(obj.end - 1);
  }
  const sep = multiline ? `,${eol}${indentAt(src, last.keyStart)}` : ', ';
  return src.slice(0, last.value.end) + sep + entry + src.slice(last.value.end);
}

function removeMember(src: string, obj: JsonNode & { type: 'object' }, member: JsonMember): string {
  const idx = obj.members.indexOf(member);
  if (obj.members.length === 1) return src.slice(0, obj.start + 1) + src.slice(obj.end - 1);
  if (idx === obj.members.length - 1) return src.slice(0, obj.members[idx - 1]!.value.end) + src.slice(member.value.end);
  const next = obj.members[idx + 1]!;
  const lineStart = (at: number) => {
    const s = src.lastIndexOf('\n', at - 1) + 1;
    return src.slice(s, at).trim() === '' ? s : at;
  };
  return src.slice(0, lineStart(member.keyStart)) + src.slice(lineStart(next.keyStart));
}

/**
 * Edits by dotted path that keep the file's layout: a value is replaced in
 * place (keeping its JSON type), a new key is added as the last member of its
 * object (creating objects on the way), and `null` removes a member.
 */
export function editJson(src: string, changes: Record<string, JsonScalar | null>): string {
  let out = src;
  for (const [path, next] of Object.entries(changes)) {
    const doc = parseJson(out);
    const hit = getJsonMember(doc.root, path);
    if (next === null) {
      if (hit) out = removeMember(out, hit.parent, hit.member);
      continue;
    }
    if (hit) {
      const v = hit.member.value;
      out = out.slice(0, v.start) + typedLiteral(path, v, next) + out.slice(v.end);
      continue;
    }
    const parts = path.split('.');
    let obj = doc.root;
    let i = 0;
    for (; i < parts.length - 1; i++) {
      if (obj.type !== 'object') break;
      const m = obj.members.findLast((x) => x.key === parts[i]);
      if (!m) break;
      obj = m.value;
    }
    if (obj.type !== 'object') throw new Error(`${parts.slice(0, i).join('.') || 'The file'} is not an object`);
    let valueText = jsonLiteral(next);
    for (let j = parts.length - 1; j > i; j--) valueText = `{ ${JSON.stringify(parts[j])}: ${valueText} }`;
    out = insertMember(out, obj, parts[i]!, valueText);
  }
  return out;
}

/** A new file holding `values` (dotted paths become nested objects), two-space indented. */
export function buildJson(values: Record<string, JsonScalar>): string {
  const root: Record<string, unknown> = {};
  for (const [path, v] of Object.entries(values)) {
    const parts = path.split('.');
    let cur = root;
    for (const p of parts.slice(0, -1)) {
      if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
      cur = cur[p] as Record<string, unknown>;
    }
    cur[parts.at(-1)!] = v;
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}
