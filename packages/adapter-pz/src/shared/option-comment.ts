/**
 * The comments PZ writes above each option in the server ini and
 * SandboxVars.lua, in the server's locale (English or Spanish).
 */

export interface OptionCommentMeta {
  description?: string;
  min?: number;
  max?: number;
  /** Numeric default as text, or an enum default's label. */
  default?: string;
}

// English: "… Min: 0 Max: 1000 Default: 2" (ini and sandbox) or "Default = Normal" (sandbox enums).
// Spanish: "… Mínimo=0 Máximo=1000 Por defecto=2" and "Por defecto=Normal".
const RANGE_PATTERNS = [
  /\s*Min: (-?[\d.]+) Max: (-?[\d.]+) Default: (\S+)\s*$/,
  /\s*Mínimo=(-?[\d.]+) Máximo=(-?[\d.]+) Por defecto=(\S+)\s*$/,
];
const DEFAULT_PATTERNS = [/\s*Default ?[=:] ?(.+?)\s*$/, /\s*Por defecto ?= ?(.+?)\s*$/];

/** Pull min/max/default out of the comment PZ writes above an option. */
export function parseOptionComment(comment: string): OptionCommentMeta {
  let text = comment.trim();
  const meta: OptionCommentMeta = {};
  for (const re of RANGE_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      meta.min = Number(m[1]);
      meta.max = Number(m[2]);
      meta.default = m[3]!;
      text = text.slice(0, m.index);
      break;
    }
  }
  if (meta.default === undefined) {
    for (const re of DEFAULT_PATTERNS) {
      const m = re.exec(text);
      if (m) {
        meta.default = m[1]!;
        text = text.slice(0, m.index);
        break;
      }
    }
  }
  text = text.trim();
  if (text) meta.description = text;
  return meta;
}
