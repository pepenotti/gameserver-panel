/**
 * Placeholders in a manifest's templates (see `types.ts`): which a template
 * holds, where each kind may be used, and filling them in.
 */
import type { Template } from './types';

export type PlaceholderKind = 'installDir' | 'dataDir' | 'name' | 'port' | 'setting' | 'secret' | 'arg';

export interface Placeholder {
  kind: PlaceholderKind;
  /** The port, setting or secret it names. */
  id?: string;
}

const KINDS_WITH_ID = new Set<string>(['port', 'setting', 'secret']);
const KINDS_PLAIN = new Set<string>(['installDir', 'dataDir', 'name', 'arg']);
const PLACEHOLDER = /\{([A-Za-z]+)(?::([A-Za-z0-9]+))?\}/g;

/**
 * The placeholders of `t`, in order; throws on a brace that opens none, or
 * one of an unknown kind (a template can't hold a literal brace).
 */
export function placeholders(t: Template): Placeholder[] {
  const out: Placeholder[] = [];
  const rest = t.replace(PLACEHOLDER, (whole, kind: string, id: string | undefined) => {
    if (id === undefined ? !KINDS_PLAIN.has(kind) : !KINDS_WITH_ID.has(kind)) throw new Error(`unknown placeholder ${whole}`);
    out.push(id === undefined ? { kind: kind as PlaceholderKind } : { kind: kind as PlaceholderKind, id });
    return '';
  });
  if (/[{}]/.test(rest)) throw new Error(`a brace that is no placeholder in ${JSON.stringify(t)}`);
  return out;
}

/** `t` with each placeholder replaced by what `value` gives for it. */
export function fill(t: Template, value: (p: Placeholder) => string): string {
  return t.replace(PLACEHOLDER, (_whole, kind: string, id: string | undefined) => value(id === undefined ? { kind: kind as PlaceholderKind } : { kind: kind as PlaceholderKind, id }));
}

/** A data-root path once `{name}` is filled in: relative, `/`-separated, never climbing out. */
export function safeRelative(rel: string): boolean {
  return rel !== '' && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel) && !rel.includes('\\') && !rel.split('/').some((s) => s === '' || s === '.' || s === '..') && !/[\0\r\n]/.test(rel);
}
