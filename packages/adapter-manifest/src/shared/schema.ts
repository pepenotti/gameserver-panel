/**
 * A JSON Schema (draft 2020-12) checker for the subset `manifest.schema.json`
 * uses, so the manifests need no validator library. A schema that uses a
 * keyword this checker doesn't know is refused outright (it would otherwise
 * pass manifests it was meant to stop).
 *
 * Supported: `type` (one or a list), `enum`, `const`, `properties`,
 * `required`, `additionalProperties` (false or a schema), `items`,
 * `minItems`, `maxItems`, `uniqueItems`, `minLength`, `maxLength` (in code
 * points), `pattern` (unicode), `minimum`, `maximum`, `oneOf`, `anyOf`,
 * `allOf`, `$ref` to `#/…` in the same document, and `format: "regex"`
 * (a JavaScript regular expression without flags). Annotations (`$schema`,
 * `$id`, `$defs`, `title`, `description`, `$comment`) are ignored.
 */

export type JsonSchema = boolean | { [keyword: string]: unknown };

/** One thing wrong with a value: where (`ports[0].id`), and what. */
export interface SchemaIssue {
  path: string;
  message: string;
}

const KNOWN = new Set([
  '$schema',
  '$id',
  '$defs',
  '$comment',
  '$ref',
  'title',
  'description',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'oneOf',
  'anyOf',
  'allOf',
  'format',
]);

/** A schema this checker can't apply faithfully. */
export class SchemaError extends Error {}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function typeOf(x: unknown): string {
  if (x === null) return 'null';
  if (Array.isArray(x)) return 'array';
  if (typeof x === 'number') return Number.isInteger(x) ? 'integer' : 'number';
  return typeof x;
}

function hasType(x: unknown, t: string): boolean {
  const actual = typeOf(x);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

/** JSON equality, as `enum`, `const` and `uniqueItems` compare. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

const at = (path: string, key: string | number) => (typeof key === 'number' ? `${path}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`);
const shown = (x: unknown) => JSON.stringify(x);

/** Whether `source` is a JavaScript regular expression (no flags). */
export function compiles(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/** Every issue of `value` against `schema`; empty when it conforms. Throws `SchemaError` for a schema it can't apply. */
export function checkSchema(schema: JsonSchema, value: unknown): SchemaIssue[] {
  const root = schema;
  const patterns = new Map<string, RegExp>();
  const regex = (p: string) => {
    let re = patterns.get(p);
    if (!re) {
      try {
        re = new RegExp(p, 'u');
      } catch (e) {
        throw new SchemaError(`Invalid pattern in the schema: ${p} (${(e as Error).message})`);
      }
      patterns.set(p, re);
    }
    return re;
  };
  const resolve = (ref: string): JsonSchema => {
    if (!ref.startsWith('#')) throw new SchemaError(`Only references inside the schema are supported: ${ref}`);
    let cur: unknown = root;
    for (const raw of ref.slice(1).split('/').filter((s) => s !== '')) {
      const part = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      if (!isObject(cur) || !Object.hasOwn(cur, part)) throw new SchemaError(`Unresolved reference ${ref}`);
      cur = cur[part];
    }
    if (typeof cur !== 'boolean' && !isObject(cur)) throw new SchemaError(`Reference ${ref} is not a schema`);
    return cur as JsonSchema;
  };

  const check = (s: JsonSchema, v: unknown, path: string, out: SchemaIssue[]): void => {
    if (s === true) return;
    if (s === false) {
      out.push({ path, message: 'is not allowed' });
      return;
    }
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new SchemaError(`Unsupported schema keyword ${k} at ${path || '(root)'}`);
    const issue = (message: string) => out.push({ path, message });

    if (typeof s.$ref === 'string') check(resolve(s.$ref), v, path, out);
    if (s.type !== undefined) {
      const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
      if (!types.some((t) => hasType(v, t))) {
        issue(`must be ${types.join(' or ')}, not ${typeOf(v)}`);
        return;
      }
    }
    if (Array.isArray(s.enum) && !s.enum.some((x) => jsonEqual(x, v))) issue(`must be one of ${s.enum.map(shown).join(', ')}`);
    if (Object.hasOwn(s, 'const') && !jsonEqual(s.const, v)) issue(`must be ${shown(s.const)}`);

    if (typeof v === 'string') {
      const length = [...v].length;
      if (typeof s.minLength === 'number' && length < s.minLength) issue(`must have at least ${s.minLength} characters`);
      if (typeof s.maxLength === 'number' && length > s.maxLength) issue(`must have at most ${s.maxLength} characters`);
      if (typeof s.pattern === 'string' && !regex(s.pattern).test(v)) issue(`must match ${s.pattern}`);
      if (s.format !== undefined) {
        if (s.format !== 'regex') throw new SchemaError(`Unsupported format ${String(s.format)} at ${path || '(root)'}`);
        if (!compiles(v)) issue('must be a valid regular expression');
      }
    }
    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && v < s.minimum) issue(`must be at least ${s.minimum}`);
      if (typeof s.maximum === 'number' && v > s.maximum) issue(`must be at most ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === 'number' && v.length < s.minItems) issue(`must have at least ${s.minItems} items`);
      if (typeof s.maxItems === 'number' && v.length > s.maxItems) issue(`must have at most ${s.maxItems} items`);
      if (s.uniqueItems === true) {
        for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) if (jsonEqual(v[i], v[j])) issue(`has ${shown(v[j])} twice`);
      }
      if (s.items !== undefined) v.forEach((x, i) => check(s.items as JsonSchema, x, at(path, i), out));
    }
    if (isObject(v)) {
      const props = isObject(s.properties) ? (s.properties as Record<string, JsonSchema>) : {};
      if (Array.isArray(s.required)) for (const k of s.required as string[]) if (!Object.hasOwn(v, k)) out.push({ path: at(path, k), message: 'is required' });
      for (const [k, x] of Object.entries(v)) {
        if (Object.hasOwn(props, k)) check(props[k]!, x, at(path, k), out);
        else if (s.additionalProperties === false) out.push({ path: at(path, k), message: 'is not a known field' });
        else if (s.additionalProperties !== undefined && s.additionalProperties !== true) check(s.additionalProperties as JsonSchema, x, at(path, k), out);
      }
    }
    if (Array.isArray(s.allOf)) for (const sub of s.allOf as JsonSchema[]) check(sub, v, path, out);
    for (const key of ['oneOf', 'anyOf'] as const) {
      if (!Array.isArray(s[key])) continue;
      const results = (s[key] as JsonSchema[]).map((sub) => {
        const r: SchemaIssue[] = [];
        check(sub, v, path, r);
        return r;
      });
      const matching = results.filter((r) => r.length === 0).length;
      if (key === 'oneOf' && matching > 1) issue('matches more than one of its allowed shapes');
      if (matching === 0) {
        // The shape it comes closest to says best what is wrong: the one it fits at this level (its problems lie
        // deeper), then the one with the fewest problems.
        const here = (r: SchemaIssue[]) => r.filter((i) => i.path === path).length;
        const best = results.reduce((a, b) => (here(b) < here(a) || (here(b) === here(a) && b.length < a.length) ? b : a));
        if (best.length) out.push(...best);
        else issue('matches none of its allowed shapes');
      }
    }
  };

  const out: SchemaIssue[] = [];
  check(schema, value, '', out);
  return out;
}
