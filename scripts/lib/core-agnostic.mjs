// Pure helpers for the "core is game-agnostic" check (NFR-08): what a game
// leaks into code without importing its adapter (app ids, file names,
// console commands), and imports of adapter packages. The core's own test is
// scripts/core-agnostic.test.ts; other packages (the web) can reuse these.

/**
 * Tokens only Project Zomboid code has any business with: its Steam app ids,
 * its name, its sandbox file, two console commands and its vanilla map.
 * Matched case-sensitively; words anywhere (`ProjectZomboid`,
 * `x_SandboxVars.lua`), numbers only when no other digit touches them.
 */
export const GAME_TOKENS = ['380870', '108600', 'Zomboid', 'SandboxVars', 'servermsg', 'reloadoptions', 'Muldraugh'];

/**
 * @typedef {{ line: number; token: string }} TokenHit
 * @typedef {{ line: number; specifier: string }} ImportHit
 */

const TOKEN_RE = new RegExp(GAME_TOKENS.map((t) => (/^\d+$/.test(t) ? `(?<!\\d)${t}(?!\\d)` : t)).join('|'), 'g');

/**
 * Every game token in `text`, with its line.
 * @param {string} text
 * @returns {TokenHit[]}
 */
export function findGameTokens(text) {
  /** @type {TokenHit[]} */
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(TOKEN_RE)) hits.push({ line: i + 1, token: m[0] });
  }
  return hits;
}

/** A module specifier that names a game adapter: `@gsp/adapters…` or `@gsp/adapter-<game>…`, or a relative path into one. */
const ADAPTER_SPECIFIER = /^(?:@gsp\/(?:adapters|adapter-(?!api(?:\/|$))[^/]+)(?:\/.*)?|(?:\.\.\/)+(?:adapters|adapter-(?!api(?:\/|$))[^/]+)(?:\/.*)?)$/;

/** `import … from '…'`, `export … from '…'`, `import('…')`, `require('…')`. */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\r\n]+)\1/g;

/**
 * Imports of game adapter packages in `text`, with their line.
 * @param {string} text
 * @returns {ImportHit[]}
 */
export function findAdapterImports(text) {
  /** @type {ImportHit[]} */
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(SPECIFIER_RE)) if (ADAPTER_SPECIFIER.test(m[2])) hits.push({ line: i + 1, specifier: m[2] });
  }
  return hits;
}
