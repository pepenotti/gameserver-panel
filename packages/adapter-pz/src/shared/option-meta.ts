/**
 * Option metadata read from the comments PZ writes into the ini and
 * SandboxVars.lua. Comments are in the server's locale, so the English and
 * Spanish files are parsed separately and merged by key with
 * `mergeLanguages` (@gsp/formats): both have the same keys in the same order.
 */

import { flattenScalars, type IniDoc, type LuaTable, type OneLang, type OptionType } from '@gsp/formats';
import { parseOptionComment } from './option-comment';

function inferType(value: string): OptionType {
  if (value === 'true' || value === 'false') return 'boolean';
  if (/^-?\d+$/.test(value)) return 'integer';
  if (/^-?\d+\.\d+$/.test(value)) return 'decimal';
  return 'string';
}

export function iniOptions(doc: IniDoc): OneLang[] {
  return doc.entries.map((e) => {
    const meta = parseOptionComment(e.comments.join(' '));
    return { key: e.key, type: inferType(e.value), ...meta };
  });
}

const ENUM_LINE = /^(-?\d+) = (.+)$/;

export function sandboxOptions(table: LuaTable): OneLang[] {
  return flattenScalars(table).map(({ path, value, comments }) => {
    const options: { value: number; label: string }[] = [];
    const desc: string[] = [];
    for (const c of comments) {
      const m = ENUM_LINE.exec(c);
      if (m) options.push({ value: Number(m[1]), label: m[2]!.trim() });
      else desc.push(c);
    }
    const meta = parseOptionComment(desc.join(' '));
    let type: OptionType =
      value.type === 'boolean' ? 'boolean' : value.type === 'string' ? 'string' : value.type === 'number' ? (/[.eE]/.test(value.raw) ? 'decimal' : 'integer') : 'string';
    let def = meta.default;
    if (options.length > 0 && type === 'integer') {
      type = 'enum';
      const hit = def === undefined ? undefined : options.find((o) => o.label === def);
      def = hit ? String(hit.value) : undefined;
    }
    return { key: path, type, ...meta, default: def, ...(options.length ? { options } : {}) };
  });
}
