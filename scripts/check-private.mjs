#!/usr/bin/env node
// Privacy gate (NFR-09): the repository names no real person, host, IP or
// local path. Looks for home paths, personal e-mail addresses and every
// regex in the local, untracked pattern list.
//
//   node scripts/check-private.mjs                  tracked files (paths and contents)
//   node scripts/check-private.mjs --range A..B     messages and added lines of the commits in A..B
//   node scripts/check-private.mjs --message FILE   one commit message (used by .githooks/commit-msg)
//   --patterns FILE                                 use FILE instead of the local pattern list
//
// The pattern list lives at <git common dir>/info/private-patterns: one
// case-insensitive regex per line, '#' for comments. A missing file means
// only the generic checks run. Hits print where and which rule or pattern
// number, never the pattern or the matched text.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addedLines, messageLines, parsePatternList, scanLine, scanText } from './lib/privacy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (/** @type {string[]} */ args) =>
  execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function usage(msg) {
  if (msg) console.error(`check-private: ${msg}`);
  console.error('usage: check-private.mjs [--range A..B | --message FILE] [--patterns FILE]');
  process.exit(2);
}

const argv = process.argv.slice(2);
/** @type {{ range?: string; message?: string; patterns?: string }} */
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = () => argv[++i] ?? usage(`${a} needs a value`);
  if (a === '--range') opts.range = value();
  else if (a === '--message') opts.message = value();
  else if (a === '--patterns') opts.patterns = value();
  else if (a === '--help' || a === '-h') usage();
  else usage(`unknown argument ${a}`);
}
if (opts.range && opts.message) usage('--range and --message are exclusive');

function patternFile() {
  if (opts.patterns) return path.resolve(opts.patterns);
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  return path.join(common, 'info', 'private-patterns');
}

const file = patternFile();
const { patterns, invalid } = existsSync(file) ? parsePatternList(readFileSync(file, 'utf8')) : { patterns: [], invalid: [] };
if (invalid.length) {
  console.error(`check-private: invalid regex in the local pattern list: #${invalid.join(', #')}`);
  process.exit(2);
}

/** @type {string[]} */
const report = [];
const hit = (/** @type {string} */ where, /** @type {{ col: number; rule: string }} */ h) => report.push(`${where}:${h.col}: ${h.rule}`);

let scanned;
if (opts.message) {
  const text = readFileSync(path.resolve(opts.message), 'utf8');
  for (const { line, text: l } of messageLines(text)) for (const h of scanLine(l, patterns)) hit(`commit message:${line}`, h);
  scanned = 'commit message';
} else if (opts.range) {
  if (!/^[\w./^~@{}-]*\.\.\.?[\w./^~@{}-]*$/.test(opts.range)) usage(`not a commit range: ${opts.range}`);
  const log = git(['log', '--format=%x01%H%n%B%x02', opts.range]);
  let commits = 0;
  for (const chunk of log.split('\x02')) {
    const m = /^\s*\x01([0-9a-f]+)\n([\s\S]*)$/.exec(chunk);
    if (!m) continue;
    commits++;
    const sha = (m[1] ?? '').slice(0, 10);
    for (const h of scanText(m[2] ?? '', patterns)) hit(`${sha} message:${h.line}`, h);
  }
  const patch = git(['log', '-p', '--no-color', '--no-ext-diff', '--no-renames', '--unified=0', '--format=%x01%H', opts.range]);
  const seenPaths = new Set();
  for (const a of addedLines(patch)) {
    const sha = a.commit.slice(0, 10);
    if (!seenPaths.has(`${sha}:${a.path}`)) {
      seenPaths.add(`${sha}:${a.path}`);
      for (const h of scanLine(a.path, patterns)) hit(`${sha} path ${a.path}`, h);
    }
    for (const h of scanLine(a.text, patterns)) hit(`${sha} ${a.path}:${a.line}`, h);
  }
  scanned = `${commits} commit(s) in ${opts.range}`;
} else {
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  for (const f of files) {
    for (const h of scanLine(f, patterns)) hit(`${f} (path)`, h);
    const abs = path.join(root, f);
    if (!existsSync(abs)) continue; // deleted in the working tree
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    for (const h of scanText(buf.toString('utf8'), patterns)) hit(`${f}:${h.line}`, h);
  }
  scanned = `${files.length} tracked files`;
}

const source = existsSync(file) ? `${patterns.length} local pattern(s)` : 'no local pattern list';
if (report.length) {
  for (const r of report) console.error(r);
  console.error(`\ncheck-private: ${report.length} hit(s) in ${scanned} (${source}). Replace them with placeholders (see CONTRIBUTING.md).`);
  process.exit(1);
}
console.log(`check-private: clean (${scanned}, generic checks + ${source})`);
