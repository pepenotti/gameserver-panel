// Pure helpers for scripts/check-private.mjs (NFR-09): find home paths,
// personal e-mail addresses and locally listed private strings in text.
// Hits carry a location and a rule name, never the matched text, so the
// report itself can't leak what it found.

/** Placeholder user names docs may use in home paths. */
const PLACEHOLDER_USERS = new Set(['you', 'yourname', 'your-name', 'your_name', 'user', 'username', 'name', 'me', 'alice', 'bob', 'example', 'public', 'default', 'shared']);
/** Service accounts inside game and panel containers, not people. */
const SERVICE_USERS = new Set(['node', 'pz', 'steam']);

const isPlaceholder = (/** @type {string} */ name) => {
  const n = name.toLowerCase();
  return PLACEHOLDER_USERS.has(n) || /^[$%{<]/.test(n) || /^\.\.?$/.test(n);
};

const ALLOWED_MAIL_DOMAINS = /(^|\.)(example\.(com|org|net)|[a-z0-9-]+\.example|example)$/i;

/**
 * @typedef {{ line: number; col: number; rule: string }} Hit
 * @typedef {{ index: number; re: RegExp }} PrivatePattern
 */

/** @type {{ rule: string; re: RegExp; allow: (m: RegExpExecArray) => boolean }[]} */
export const GENERIC_RULES = [
  {
    // X:\Users\<name> and X:/Users/<name>
    rule: 'home-path',
    re: /(?<![A-Za-z0-9])[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}([^\\/\s"'`<>|:*?,;()[\]]+)/gi,
    allow: (m) => isPlaceholder(m[1] ?? ''),
  },
  {
    // /Users/<name> (macOS), /c/Users/<name> (Git Bash, WSL-style), /home/<name>
    rule: 'home-path',
    re: /(?<![\w.:~-])(?:\/(?:mnt\/)?[a-z])?\/(Users|home)\/([^\\/\s"'`<>|:*?,;()[\]]+)/g,
    allow: (m) => isPlaceholder(m[2] ?? '') || (m[1] === 'home' && SERVICE_USERS.has(m[2] ?? '')),
  },
  {
    rule: 'email',
    re: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g,
    allow: (m) => ALLOWED_MAIL_DOMAINS.test(m[1] ?? '') || /no-?reply/i.test(m[0]),
  },
];

/**
 * Parses the local pattern list: one case-insensitive regex per line, '#'
 * comments and blank lines skipped. Indexes count the pattern lines from 1.
 * @param {string} text
 * @returns {{ patterns: PrivatePattern[]; invalid: number[] }}
 */
export function parsePatternList(text) {
  /** @type {PrivatePattern[]} */
  const patterns = [];
  /** @type {number[]} */
  const invalid = [];
  let index = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    index++;
    try {
      patterns.push({ index, re: new RegExp(line, 'i') });
    } catch {
      invalid.push(index);
    }
  }
  return { patterns, invalid };
}

/**
 * Scans one line; columns are 1-based.
 * @param {string} line
 * @param {PrivatePattern[]} patterns
 * @returns {{ col: number; rule: string }[]}
 */
export function scanLine(line, patterns) {
  /** @type {{ col: number; rule: string }[]} */
  const hits = [];
  for (const { rule, re, allow } of GENERIC_RULES) {
    re.lastIndex = 0;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      if (!allow(m)) hits.push({ col: m.index + 1, rule });
      if (m[0] === '') re.lastIndex++;
    }
  }
  for (const { index, re } of patterns) {
    const m = re.exec(line);
    if (m) hits.push({ col: m.index + 1, rule: `private pattern #${index}` });
  }
  return hits;
}

/**
 * @param {string} text
 * @param {PrivatePattern[]} patterns
 * @returns {Hit[]}
 */
export function scanText(text, patterns) {
  /** @type {Hit[]} */
  const hits = [];
  text.split(/\r?\n/).forEach((l, i) => {
    for (const h of scanLine(l, patterns)) hits.push({ line: i + 1, ...h });
  });
  return hits;
}

const SCISSORS = /^# -+ >8 -+$/;

/**
 * The part of a commit message git keeps: '#' comment lines dropped and
 * everything below a `commit -v` scissors line ignored. Line numbers of the
 * kept lines are preserved.
 * @param {string} text
 * @returns {{ line: number; text: string }[]}
 */
export function messageLines(text) {
  /** @type {{ line: number; text: string }[]} */
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (SCISSORS.test(l)) break;
    if (l.startsWith('#')) continue;
    out.push({ line: i + 1, text: l });
  }
  return out;
}

/**
 * Added lines of a `git log -p --unified=0 --format=%x01%H` stream, with the
 * commit, path and new line number of each.
 * @param {string} patch
 * @returns {{ commit: string; path: string; line: number; text: string }[]}
 */
export function addedLines(patch) {
  /** @type {{ commit: string; path: string; line: number; text: string }[]} */
  const out = [];
  let commit = '';
  let file = '';
  let inHeader = false;
  let next = 0;
  for (const l of patch.split('\n')) {
    if (l.startsWith('\x01')) {
      commit = l.slice(1).trim();
      inHeader = false;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      inHeader = true;
      file = '';
      continue;
    }
    if (inHeader) {
      if (l.startsWith('+++ ')) file = l === '+++ /dev/null' ? '' : l.slice(4).replace(/^b\//, '');
      else if (l.startsWith('@@')) inHeader = false;
      if (inHeader) continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (l.startsWith('+')) out.push({ commit, path: file, line: next++, text: l.slice(1).replace(/\r$/, '') });
    else if (l.startsWith(' ')) next++;
  }
  return out;
}
