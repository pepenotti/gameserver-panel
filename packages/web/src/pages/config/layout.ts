// How a settings form lays out its options (CFG-10), from what the adapter
// declares: its groups for the schema (`GET config/meta` `groups`, in order),
// each option's `group`, and "advanced" flags on groups and on options.
// Pure: no React, so tests can import it.
import type { OptionMeta } from '@gsp/formats';
import type { OptionGroup } from '../../api/meta';

/** Options in no group the adapter declares (and settings in the file its schema doesn't know). */
export const UNGROUPED = '__ungrouped';

export interface Placement {
  group: string;
  /** Behind "Advanced": the option, or its whole group, is a rare setting. */
  advanced: boolean;
}

export function placement(m: OptionMeta, groups: readonly OptionGroup[]): Placement {
  const g = m.group === undefined ? undefined : groups.find((x) => x.id === m.group);
  return { group: g ? g.id : UNGROUPED, advanced: m.advanced === true || g?.advanced === true };
}

/** The form's sections, each in the adapter's order with the ungrouped options last; only groups that have options. */
export function sections(metas: readonly OptionMeta[], groups: readonly OptionGroup[]): { common: string[]; advanced: string[] } {
  const order = [...groups.map((g) => g.id), UNGROUPED];
  const common = new Set<string>();
  const advanced = new Set<string>();
  for (const m of metas) {
    const p = placement(m, groups);
    (p.advanced ? advanced : common).add(p.group);
  }
  return { common: order.filter((g) => common.has(g)), advanced: order.filter((g) => advanced.has(g)) };
}

/**
 * Settings the file has but the schema doesn't describe still get a text
 * box, typed from their value, in no group and behind "Advanced" (whoever
 * set them knows what they are).
 */
export function withUnknown(metas: readonly OptionMeta[], values: Readonly<Record<string, unknown>>): OptionMeta[] {
  const known = new Set(metas.map((m) => m.key));
  const extra: OptionMeta[] = Object.keys(values)
    .filter((k) => !known.has(k))
    .map((k) => ({ key: k, type: typeof values[k] === 'boolean' ? 'boolean' : typeof values[k] === 'number' ? 'decimal' : 'string', description: {}, advanced: true }));
  return [...metas.filter((m) => m.key in values), ...extra];
}
