// Builds a .env from .env.example: every empty secret gets a fresh random
// value, values already present are kept, overrides win. Pure apart from the
// random secrets. Used by scripts/init-env.mjs and scripts/worktree-env.mjs.
import { randomBytes } from 'node:crypto';

/** @type {Record<string, () => string>} */
export const SECRETS = {
  ORCH_TOKEN: () => randomBytes(32).toString('hex'),
  PANEL_OWNER_PASSWORD: () => randomBytes(12).toString('base64url'),
};

const LINE = /^([A-Z0-9_]+)=(.*)$/;

/**
 * @param {string} example   contents of .env.example
 * @param {string} current   contents of the existing .env ('' for none)
 * @param {{ overrides?: Record<string, string>; extrasComment?: string }} [opts]
 *   overrides replace values; the ones .env.example doesn't have are appended
 *   under `extrasComment`.
 * @returns {{ text: string; generated: string[] }}
 */
export function fillEnv(example, current, opts = {}) {
  /** @type {Map<string, string>} */
  const have = new Map();
  for (const line of current.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) have.set(m[1] ?? '', m[2] ?? '');
  }
  /** @type {string[]} */
  const generated = [];
  const pending = new Map(Object.entries(opts.overrides ?? {}));
  const out = example.split(/\r?\n/).map((line) => {
    const m = LINE.exec(line);
    if (!m) return line;
    const [, key = '', dflt = ''] = m;
    if (pending.has(key)) {
      const v = pending.get(key);
      pending.delete(key);
      return `${key}=${v}`;
    }
    if (have.has(key)) return `${key}=${have.get(key)}`;
    const make = SECRETS[key];
    if (dflt === '' && make) {
      generated.push(key);
      return `${key}=${make()}`;
    }
    return line;
  });
  const trailingNewline = out.at(-1) === '';
  if (trailingNewline) out.pop();
  // Keep keys the user added that the example doesn't know.
  for (const [k, v] of have) if (!pending.has(k) && !out.some((l) => l.startsWith(`${k}=`))) out.push(`${k}=${v}`);
  if (pending.size) {
    if (opts.extrasComment) out.push('', `# ${opts.extrasComment}`);
    for (const [k, v] of pending) out.push(`${k}=${v}`);
  }
  if (trailingNewline) out.push('');
  return { text: out.join('\n'), generated };
}
