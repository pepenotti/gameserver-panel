/**
 * YAML config files (CFG-02, CFG-07, CFG-09), read with the `yaml` package's
 * Document API (YAML 1.2, the core schema): Paper's and most plugins'
 * configs are YAML.
 *
 * Edits keep the file as it was written: a changed value has only its own
 * text replaced (its comment, quoting and the rest of the file stay byte
 * for byte), a removed key takes only its own lines, and a new key goes
 * after the last key of its map, at that map's indentation. What that can't
 * do cleanly (a block `|` value, a key inside a `{ … }` flow map, a map's
 * only key) goes through the Document API instead, which keeps every
 * comment but may re-indent the file.
 */
import { Document, isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument, stringify, type Node, type Pair, type YAMLMap } from 'yaml';

export type YamlScalar = string | number | boolean;

export interface YamlDoc {
  doc: Document.Parsed;
  src: string;
  lines: LineCounter;
}

export interface YamlIssue {
  /** 1-based. */
  line: number;
  col?: number;
  message: string;
}

export type YamlParse = { ok: true; doc: YamlDoc } | { ok: false; issues: YamlIssue[] };

const OPTIONS = { uniqueKeys: true, prettyErrors: true } as const;

export function parseYamlDoc(src: string): YamlParse {
  const lines = new LineCounter();
  const doc = parseDocument(src, { ...OPTIONS, lineCounter: lines, keepSourceTokens: false });
  if (doc.errors.length === 0) return { ok: true, doc: { doc, src, lines } };
  return {
    ok: false,
    issues: doc.errors.map((e) => {
      const at = e.linePos?.[0] ?? lines.linePos(e.pos[0]);
      // The message ends with a position and a code excerpt: the editor shows those itself.
      return { line: at.line, col: at.col, message: e.message.split('\n')[0]!.replace(/ at line \d+, column \d+:?$/, '') };
    }),
  };
}

function mustParse(src: string): YamlDoc {
  const r = parseYamlDoc(src);
  if (!r.ok) throw new Error(`The YAML does not parse: ${r.issues[0]!.message} (line ${r.issues[0]!.line})`);
  return r.doc;
}

const keyText = (k: unknown): string | null => (isScalar(k) ? String(k.value) : null);

/** The pair of `map` whose key is `key` (YAML keys are unique). */
function pairOf(map: YAMLMap, key: string): Pair<unknown, unknown> | undefined {
  return (map.items as Pair<unknown, unknown>[]).find((p) => keyText(p.key) === key);
}

function resolved(doc: Document.Parsed, n: unknown): unknown {
  return isAlias(n) ? n.resolve(doc) : n;
}

/** Every scalar inside nested maps as `a.b` → value. Lists, nulls and keys containing "." are left to the text editor. */
export function flattenYaml(y: YamlDoc): Record<string, YamlScalar> {
  const out: Record<string, YamlScalar> = {};
  const walk = (map: YAMLMap, prefix: string) => {
    for (const p of map.items as Pair<unknown, unknown>[]) {
      const k = keyText(p.key);
      if (k === null || k === '' || k.includes('.')) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      const v = resolved(y.doc, p.value);
      if (isMap(v)) walk(v, path);
      else if (isScalar(v) && (typeof v.value === 'string' || typeof v.value === 'number' || typeof v.value === 'boolean')) out[path] = v.value;
    }
  };
  if (isMap(y.doc.contents)) walk(y.doc.contents, '');
  return out;
}

/** Where a dotted path's value is: the pair holding it and the map that holds the pair. */
function find(y: YamlDoc, path: string[]): { pair: Pair<unknown, unknown>; map: YAMLMap } | undefined {
  let cur: unknown = y.doc.contents;
  for (let i = 0; i < path.length; i++) {
    if (!isMap(cur)) return undefined;
    const pair = pairOf(cur, path[i]!);
    if (!pair) return undefined;
    if (i === path.length - 1) return { pair, map: cur };
    cur = resolved(y.doc, pair.value);
  }
  return undefined;
}

export function locateYaml(y: YamlDoc, key: string): { line: number; col: number } | null {
  const hit = find(y, key.split('.'));
  if (!hit) return null;
  const n = (hit.pair.value ?? hit.pair.key) as Node;
  return n.range ? y.lines.linePos(n.range[0]) : null;
}

// ----------------------------------------------------------------- editing

/** The value `next` in the type the current value has (a number stays a number…). */
function typed(path: string, current: unknown, next: YamlScalar): YamlScalar {
  if (typeof current === 'number') {
    const n = typeof next === 'number' ? next : typeof next === 'string' && next.trim() !== '' ? Number(next) : NaN;
    if (!Number.isFinite(n)) throw new Error(`${path} expects a number`);
    return n;
  }
  if (typeof current === 'boolean') {
    const b = next === 'true' ? true : next === 'false' ? false : next;
    if (typeof b !== 'boolean') throw new Error(`${path} expects true or false`);
    return b;
  }
  if (typeof current === 'string') return String(next);
  if (typeof next === 'number' && !Number.isFinite(next)) throw new Error(`Not a finite number: ${next}`);
  return next;
}

/** One-line YAML for a scalar: quoted as the old value was, or as YAML needs. */
function literal(v: YamlScalar, style?: string, flow = false): string {
  if (typeof v !== 'string') return String(v);
  const oneLine = !/[\n\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
  if (style === 'QUOTE_SINGLE' && oneLine) return `'${v.replace(/'/g, "''")}'`;
  if (style === 'QUOTE_DOUBLE' || flow || !oneLine) return JSON.stringify(v);
  const plain = stringify(v, { lineWidth: 0 }).replace(/\n$/, '');
  return plain.includes('\n') ? JSON.stringify(v) : plain;
}

/** A map key as YAML: plain when that reads back as the same string, else quoted. */
function keyLiteral(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) && !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(k) ? k : JSON.stringify(k);
}

const eolOf = (src: string) => (src.includes('\r\n') ? '\r\n' : '\n');

/** Offset just after the line that `offset - 1` is on (after its newline), or the end of the text. */
function afterLine(src: string, offset: number): number {
  let e = offset;
  if (src[e - 1] === '\n') e--;
  const nl = src.indexOf('\n', e);
  return nl < 0 ? src.length : nl + 1;
}

function lineStart(src: string, offset: number): number {
  return src.lastIndexOf('\n', offset - 1) + 1;
}

/** Whether `next` reads back with `path` holding `want`. */
function holds(src: string, path: string[], want: YamlScalar): boolean {
  const r = parseYamlDoc(src);
  if (!r.ok) return false;
  const v = r.doc.doc.getIn(path);
  return v === want;
}

function viaDocument(src: string, apply: (d: Document.Parsed) => void): string {
  const y = mustParse(src);
  apply(y.doc);
  return y.doc.toString({ lineWidth: 0 });
}

/** Replace, or add, the scalar at `path`. */
function setOne(src: string, path: string[], next: YamlScalar): string {
  const y = mustParse(src);
  const dotted = path.join('.');
  const hit = find(y, path);
  if (hit) {
    const node = hit.pair.value;
    const target = resolved(y.doc, node);
    if (isMap(target) || isSeq(target)) throw new Error(`${dotted} is ${isMap(target) ? 'a map' : 'a list'}, not a single value`);
    const want = typed(dotted, isScalar(target) ? target.value : null, next);
    const n = node as Node | null;
    const style = isScalar(node) ? node.type : undefined;
    if (n?.range && style !== 'BLOCK_LITERAL' && style !== 'BLOCK_FOLDED') {
      const [start, end] = n.range;
      // An empty value (`key:`) has no text of its own: the literal goes after the colon.
      const text = (start === end ? ' ' : '') + literal(want, style, !!hit.map.flow);
      const out = src.slice(0, start) + text + src.slice(end);
      if (holds(out, path, want)) return out;
    }
    return viaDocument(src, (d) => d.setIn(path, want));
  }
  if (typeof next === 'number' && !Number.isFinite(next)) throw new Error(`Not a finite number: ${next}`);

  // A new key: in the deepest map on the path that exists.
  let map: unknown = y.doc.contents;
  let i = 0;
  for (; i < path.length - 1; i++) {
    if (!isMap(map)) break;
    const p = pairOf(map, path[i]!);
    if (!p) break;
    map = resolved(y.doc, p.value);
  }
  if (map !== null && !isMap(map)) throw new Error(`${path.slice(0, i).join('.') || 'The file'} is not a map`);
  const eol = eolOf(src);
  const lastItem = map ? (map.items.at(-1) as Pair<Node | null, Node | null> | undefined) : undefined;
  // Where the map's keys start and where its last value ends (a block map of plain keys has both).
  const firstKeyAt = map ? (map.items[0] as Pair<Node | null, unknown> | undefined)?.key?.range?.[0] : undefined;
  const lastEnd = lastItem ? (lastItem.value?.range?.[1] ?? lastItem.key?.range?.[1]) : undefined;
  if (map === null || (!map.flow && firstKeyAt !== undefined && lastEnd !== undefined)) {
    let at: number;
    let indent: string;
    if (map === null) {
      // An empty document: the key goes at the end.
      at = src.length;
      indent = '';
    } else {
      indent = ' '.repeat(y.lines.linePos(firstKeyAt!).col - 1);
      at = afterLine(src, lastEnd!);
    }
    const lines: string[] = [];
    for (let j = i; j < path.length - 1; j++) lines.push(`${indent}${'  '.repeat(j - i)}${keyLiteral(path[j]!)}:`);
    lines.push(`${indent}${'  '.repeat(path.length - 1 - i)}${keyLiteral(path.at(-1)!)}: ${literal(next)}`);
    const lead = at > 0 && src[at - 1] !== '\n' ? eol : '';
    const out = src.slice(0, at) + lead + lines.join(eol) + eol + src.slice(at);
    if (holds(out, path, next)) return out;
  }
  return viaDocument(src, (d) => d.setIn(path, next));
}

/** Remove the key at `path` with its value's lines. */
function removeOne(src: string, path: string[]): string {
  const y = mustParse(src);
  const hit = find(y, path);
  if (!hit) return src;
  const { pair, map } = hit;
  const key = pair.key as Node;
  const value = pair.value as Node | null;
  const onlyNested = map.items.length === 1 && map !== y.doc.contents;
  if (!map.flow && !onlyNested && key.range) {
    const from = lineStart(src, key.range[0]);
    if (src.slice(from, key.range[0]).trim() === '') {
      const end = value?.range?.[2] ?? key.range[2];
      const out = src.slice(0, from) + src.slice(afterLine(src, end));
      const r = parseYamlDoc(out);
      if (r.ok && r.doc.doc.getIn(path) === undefined) return out;
    }
  }
  return viaDocument(src, (d) => d.deleteIn(path));
}

/**
 * Edits by dotted path: a value is replaced in place (keeping its type), a
 * new key is added to its map (creating maps on the way), `null` removes a
 * key. Comments always survive.
 */
export function editYaml(src: string, changes: Record<string, YamlScalar | null>): string {
  let out = src;
  for (const [key, v] of Object.entries(changes)) {
    const path = key.split('.');
    if (path.some((p) => p === '')) throw new Error(`Invalid key ${JSON.stringify(key)}`);
    out = v === null ? removeOne(out, path) : setOne(out, path, v);
  }
  return out;
}

/** A new file holding `values` (dotted paths become nested maps). */
export function buildYaml(values: Record<string, YamlScalar>): string {
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
  return new Document(root).toString({ lineWidth: 0 });
}
