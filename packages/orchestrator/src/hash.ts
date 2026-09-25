import { createHash } from 'node:crypto';
import type { ServerSpec } from '@gsp/shared';

/**
 * JSON with every object's keys sorted (by UTF-16 code unit), keys whose
 * value is `undefined` dropped, arrays in order and no whitespace: the same
 * value always gives the same text.
 */
export function canonicalJson(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null';
  if (Array.isArray(x)) return `[${x.map((v: unknown) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** `ServerContainer.specHash`: sha256 (hex) of the spec's canonical JSON. */
export const specHash = (spec: ServerSpec) => sha256(canonicalJson(spec));
