/**
 * Option metadata (type, range, default, enum labels, description) that the
 * settings forms are built from. Adapters derive it per language (Project
 * Zomboid from the comments in its own files) and merge the languages here.
 */

export type Lang = 'en' | 'es';
export type OptionType = 'boolean' | 'integer' | 'decimal' | 'string' | 'enum';
export type Localized = Partial<Record<Lang, string>>;

export interface OptionMeta {
  /** Ini key, or dotted sandbox path (`ZombieLore.Speed`). */
  key: string;
  type: OptionType;
  min?: number;
  max?: number;
  /** Default value as the file writes it (enum defaults resolved to their number). */
  default?: string;
  options?: { value: number; label: Localized }[];
  description: Localized;
}

/** One language's metadata for an option, before `mergeLanguages`. */
export interface OneLang {
  key: string;
  type: OptionType;
  min?: number;
  max?: number;
  default?: string;
  options?: { value: number; label: string }[];
  description?: string;
}

/** Merge per-language metadata; structure (type, range, enum values) comes from the first list. */
export function mergeLanguages(byLang: Partial<Record<Lang, OneLang[]>>): OptionMeta[] {
  const langs = Object.keys(byLang) as Lang[];
  const base = byLang[langs[0]!] ?? [];
  const index = Object.fromEntries(langs.map((l) => [l, new Map((byLang[l] ?? []).map((o) => [o.key, o]))])) as Record<Lang, Map<string, OneLang>>;
  return base.map((o) => {
    const description: Localized = {};
    for (const l of langs) {
      const d = index[l].get(o.key)?.description;
      if (d) description[l] = d;
    }
    const meta: OptionMeta = { key: o.key, type: o.type, description };
    if (o.min !== undefined) meta.min = o.min;
    if (o.max !== undefined) meta.max = o.max;
    if (o.default !== undefined) meta.default = o.default;
    if (o.options) {
      meta.options = o.options.map((opt) => {
        const label: Localized = {};
        for (const l of langs) {
          const other = index[l].get(o.key)?.options?.find((x) => x.value === opt.value);
          if (other) label[l] = other.label;
        }
        return { value: opt.value, label };
      });
    }
    return meta;
  });
}

/** Validate a proposed value against its metadata; returns an error message or null. */
export function checkOptionValue(meta: Pick<OptionMeta, 'type' | 'min' | 'max' | 'options'>, value: string): string | null {
  switch (meta.type) {
    case 'boolean':
      return value === 'true' || value === 'false' ? null : 'must be true or false';
    case 'integer':
    case 'enum':
    case 'decimal': {
      const re = meta.type === 'decimal' ? /^-?\d+(\.\d+)?$/ : /^-?\d+$/;
      if (!re.test(value)) return meta.type === 'decimal' ? 'must be a number' : 'must be a whole number';
      const n = Number(value);
      if (meta.type === 'enum' && meta.options && !meta.options.some((o) => o.value === n)) return 'is not one of the allowed choices';
      if (meta.min !== undefined && n < meta.min) return `must be at least ${meta.min}`;
      if (meta.max !== undefined && n > meta.max) return `must be at most ${meta.max}`;
      return null;
    }
    case 'string':
      return /[\r\n\0]/.test(value) ? 'must be a single line' : null;
  }
}
