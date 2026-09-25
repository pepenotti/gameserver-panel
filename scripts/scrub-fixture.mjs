#!/usr/bin/env node
// Scrubs output captured from a real game server before it becomes a
// fixture (NFR-09, D5): fixtures are tracked files, and tracked files never
// name a real person, host, IP or path. Fact-finding runs this on every
// capture, then reads the result before committing it.
//
//   node scripts/scrub-fixture.mjs <file|folder> [--out PATH] [--names a,b,…]
//        [--keep-ip a.b.c.d,…] [--host-root PATH]… [--patterns FILE] [--force]
//
// Writes scrubbed copies (a file to <name>.scrubbed<.ext>, a folder to
// <folder>-scrubbed/, or to --out) and replaces, the same way in every file
// of one run:
//   - every match of the local, untracked <git common dir>/info/private-patterns
//     (one case-insensitive regex per line, as check-private reads it; or
//     --patterns FILE)                                    → <private>
//   - Steam64 ids                                         → 76561198000000001, …002, … (stable per id)
//   - IPv4 addresses                                      → 192.0.2.1, …, then 198.51.100.x, 203.0.113.x
//     (RFC 5737; stable per address; loopback, 0.0.0.0, masks and version-looking numbers stay;
//      --keep-ip keeps more)
//   - the player names given with --names                 → Player1, Player2, … (in that order)
//   - values after keys that hold secrets (password, token, secret, api key, webhook…),
//     in key=value, key: value, JSON and --flag value forms → <redacted>
//   - home folders (C:\Users\<name>, /home/<name>, /Users/<name>), Docker volume folders,
//     and every --host-root                               → /data
// File and folder names get the same treatment. Binary files and symbolic
// links are skipped (and listed). It prints what it replaced, by rule and
// count, never the text it found.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePatternList } from './lib/privacy.mjs';

/**
 * @typedef {{ patterns?: RegExp[]; names?: string[]; keepIps?: string[]; hostRoots?: string[] }} ScrubOptions
 * @typedef {{ scrub(text: string): string; counts: Record<string, number> }} Scrubber
 */

/** Words that make a key's value a secret. */
const SECRET_KEY = String.raw`(?:pass(?:word|wd|phrase)?|pwd|token|secret|api[-_.]?key|auth[-_.]?key|private[-_.]?key|webhook)`;

/** RFC 5737 documentation ranges, in the order addresses are handed out. */
const DOC_NETS = ['192.0.2', '198.51.100', '203.0.113'];

/** Service accounts inside containers, not people (as scripts/lib/privacy.mjs). */
const SERVICE_USERS = new Set(['node', 'pz', 'steam']);

const escapeRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An IPv4 address that says nothing about anyone: loopback, "any", masks and
 * broadcasts, and the documentation ranges themselves.
 * @param {number[]} o
 */
function neutralIp(o) {
  const s = o.join('.');
  return o[0] === 127 || s === '0.0.0.0' || o[0] === 255 || DOC_NETS.some((n) => s.startsWith(`${n}.`));
}

/**
 * A scrubber whose replacements stay the same across every text it scrubs
 * (one run over a capture), with counts by rule.
 * @param {ScrubOptions} [o]
 * @returns {Scrubber}
 */
export function createScrubber(o = {}) {
  /** @type {Record<string, number>} */
  const counts = {};
  const hit = (/** @type {string} */ rule) => (counts[rule] = (counts[rule] ?? 0) + 1);
  /** @type {Map<string, string>} */
  const ips = new Map();
  /** @type {Map<string, string>} */
  const steamIds = new Map();
  const keepIps = new Set(o.keepIps ?? []);
  const names = (o.names ?? []).map((n) => n.trim()).filter(Boolean);
  const nameOf = new Map(names.map((n, i) => [n.toLowerCase(), `Player${i + 1}`]));
  // Longest first, so a name containing another is replaced whole.
  const nameRe = names.length ? new RegExp(`(?<![A-Za-z0-9_])(?:${[...names].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![A-Za-z0-9_])`, 'gi') : null;
  const roots = [...new Set(o.hostRoots ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
  const rootRe = roots.length ? new RegExp(roots.flatMap((r) => [escapeRe(r), escapeRe(r.replace(/\\/g, '/'))]).join('|'), 'g') : null;
  const patterns = (o.patterns ?? []).map((re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`));

  /** The rest of a path after a replaced prefix, with forward slashes. */
  const rest = (/** @type {string | undefined} */ tail) => (tail ?? '').replace(/\\/g, '/');

  /** @param {string} text */
  function hostPaths(text) {
    let out = text;
    if (rootRe) out = out.replace(rootRe, () => (hit('host-path'), '/data'));
    // C:\Users\<name>…, C:/Users/<name>…
    out = out.replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/\s"'`<>|:*?]+((?:[\\/]{1,2}[^\\/\s"'`<>|:*?]+)*)/gi, (_m, tail) => (hit('host-path'), `/data${rest(tail)}`));
    // /home/<name>, /Users/<name>, /c/Users/<name>, /mnt/c/Users/<name>
    out = out.replace(/(?<![\w.:~-])(?:\/(?:mnt\/)?[a-z])?\/(?:home|Users)\/([^/\s"'`<>|:*?]+)((?:\/[^/\s"'`<>|:*?]+)*)/g, (m, user, tail) => {
      if (SERVICE_USERS.has(user)) return m;
      hit('host-path');
      return `/data${tail}`;
    });
    // Docker's own volume folders on the host.
    out = out.replace(/\/var\/lib\/docker\/volumes\/[^/\s"'`]+\/_data/g, () => (hit('host-path'), '/data'));
    return out;
  }

  /** @param {string} text */
  function ipv4(text) {
    return text.replace(/(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w]|\.\d)/g, (m, a, b, c, d, offset, whole) => {
      const octets = [a, b, c, d].map(Number);
      if (octets.some((x) => x > 255) || neutralIp(octets) || keepIps.has(m)) return m;
      // A version rather than an address ("version 1.4.4.9", "v1.2.3.4" is already excluded above).
      if (/(?:version|ver\.?|build|release)\s*[:=]?\s*$/i.test(String(whole).slice(Math.max(0, offset - 16), offset))) return m;
      let fake = ips.get(m);
      if (!fake) {
        const n = ips.size;
        const net = DOC_NETS[Math.floor(n / 254)];
        if (!net) throw new Error('More than 762 distinct IPv4 addresses: split the capture');
        fake = `${net}.${(n % 254) + 1}`;
        ips.set(m, fake);
      }
      hit('ipv4');
      return fake;
    });
  }

  /** @param {string} text */
  function steam64(text) {
    return text.replace(/(?<!\d)7656119\d{10}(?!\d)/g, (m) => {
      let fake = steamIds.get(m);
      if (!fake) {
        fake = `76561198${String(steamIds.size + 1).padStart(9, '0')}`;
        steamIds.set(m, fake);
      }
      hit('steam64');
      return fake;
    });
  }

  /** @param {string} text */
  function playerNames(text) {
    if (!nameRe) return text;
    return text.replace(nameRe, (m) => (hit('name'), nameOf.get(m.toLowerCase()) ?? m));
  }

  /** @param {string} value a value as written, maybe quoted */
  function redactValue(value) {
    const v = value.trim();
    if (v === '' || v === '""' || v === "''" || /<redacted>/.test(v)) return value;
    hit('secret');
    const q = /^(["'])(.*)\1$/.exec(v);
    return q ? `${q[1]}<redacted>${q[1]}` : '<redacted>';
  }

  /** @param {string} text */
  function secrets(text) {
    let out = text;
    // JSON: "rconPassword": "…"
    out = out.replace(new RegExp(String.raw`("[^"\n]*${SECRET_KEY}[^"\n]*"\s*:\s*)"((?:[^"\\\n]|\\.)*)"`, 'gi'), (m, key, value) => (value === '' ? m : (hit('secret'), `${key}"<redacted>"`)));
    // Command lines: -adminpassword value, --token=value
    out = out.replace(new RegExp(String.raw`((?<![\w-])-{1,2}[\w-]*${SECRET_KEY}[\w-]*(?:=|[ \t]+))("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s]*)`, 'gi'), (_m, flag, value) => `${flag}${redactValue(value)}`);
    // key=value, key = value, key: value (ini, properties, YAML, TOML), up to a trailing comment.
    out = out.replace(new RegExp(String.raw`^([ \t]*[\w.\-]*${SECRET_KEY}[\w.\-]*[ \t]*[=:][ \t]*)(?![ \t"])(.*?)([ \t]+#.*)?$`, 'gim'), (m, key, value, comment) => (value === '' ? m : `${key}${redactValue(value)}${comment ?? ''}`));
    // TOML and YAML with a quoted value.
    out = out.replace(new RegExp(String.raw`^([ \t]*[\w.\-]*${SECRET_KEY}[\w.\-]*[ \t]*[=:][ \t]*)"((?:[^"\\\n]|\\.)*)"`, 'gim'), (m, key, value) => (value === '' || value === '<redacted>' ? m : (hit('secret'), `${key}"<redacted>"`)));
    // Bearer tokens and Discord webhook links.
    out = out.replace(/(\bBearer[ \t]+)[\w.~+/-]+=*/g, (_m, b) => (hit('secret'), `${b}<redacted>`));
    out = out.replace(/(https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/)[\w/-]+/gi, (_m, b) => (hit('secret'), `${b}<redacted>`));
    return out;
  }

  /** @param {string} text */
  function privatePatterns(text) {
    let out = text;
    for (const re of patterns) {
      re.lastIndex = 0;
      out = out.replace(re, (m) => (m === '' ? m : (hit('private-pattern'), '<private>')));
    }
    return out;
  }

  return {
    counts,
    scrub(text) {
      return privatePatterns(secrets(playerNames(steam64(ipv4(hostPaths(text))))));
    },
  };
}

/** Whether a file's start looks binary (a NUL byte). */
function isBinary(/** @type {Buffer} */ buf) {
  return buf.subarray(0, 8192).includes(0);
}

/**
 * Scrubbed copies of `input` (a file or a folder) at `out`. Symbolic links
 * are never followed; binary files are skipped.
 * @param {string} input
 * @param {string} out
 * @param {Scrubber} scrubber
 * @returns {{ written: string[]; skipped: { path: string; why: string }[] }}
 */
export function scrubTree(input, out, scrubber) {
  /** @type {string[]} */
  const written = [];
  /** @type {{ path: string; why: string }[]} */
  const skipped = [];
  const visit = (/** @type {string} */ from, /** @type {string} */ to, /** @type {string} */ rel) => {
    const st = lstatSync(from);
    if (st.isSymbolicLink()) return skipped.push({ path: rel, why: 'symbolic link' });
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(from).sort()) {
        const clean = scrubber.scrub(name);
        visit(path.join(from, name), path.join(to, clean), rel ? `${rel}/${clean}` : clean);
      }
      return;
    }
    if (!st.isFile()) return skipped.push({ path: rel, why: 'not a file' });
    const buf = readFileSync(from);
    if (isBinary(buf)) return skipped.push({ path: rel, why: 'binary' });
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, scrubber.scrub(buf.toString('utf8')));
    written.push(rel || path.basename(to));
  };
  visit(input, out, '');
  return { written, skipped };
}

/** Where the scrubbed copy of `input` goes when --out isn't given. */
export function defaultOut(/** @type {string} */ input, /** @type {boolean} */ isDir) {
  if (isDir) return `${input.replace(/[\\/]+$/, '')}-scrubbed`;
  const ext = path.extname(input);
  return `${input.slice(0, input.length - ext.length)}.scrubbed${ext}`;
}

function usage(/** @type {string} */ msg) {
  if (msg) console.error(`scrub-fixture: ${msg}`);
  console.error('usage: scrub-fixture.mjs <file|folder> [--out PATH] [--names a,b] [--keep-ip a.b.c.d,…] [--host-root PATH]… [--patterns FILE] [--force]');
  process.exit(2);
}

/** @param {string[]} argv */
export function main(argv) {
  /** @type {{ input?: string; out?: string; names: string[]; keepIps: string[]; hostRoots: string[]; patterns?: string; force: boolean }} */
  const o = { names: [], keepIps: [], hostRoots: [], force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i] ?? usage(`${a} needs a value`);
    const list = () => String(value()).split(',').map((s) => s.trim()).filter(Boolean);
    if (a === '--out') o.out = value();
    else if (a === '--names') o.names.push(...list());
    else if (a === '--keep-ip') o.keepIps.push(...list());
    else if (a === '--host-root') o.hostRoots.push(value());
    else if (a === '--patterns') o.patterns = value();
    else if (a === '--force') o.force = true;
    else if (a === '--help' || a === '-h') usage('');
    else if (a?.startsWith('-')) usage(`unknown option ${a}`);
    else if (o.input) usage('give one file or folder');
    else o.input = a;
  }
  if (!o.input) usage('give a file or folder to scrub');
  const input = path.resolve(o.input);
  if (!existsSync(input)) usage(`${o.input} does not exist`);
  const isDir = lstatSync(input).isDirectory();
  const out = path.resolve(o.out ?? defaultOut(input, isDir));
  const relToInput = path.relative(input, out);
  if (out === input || (isDir && !relToInput.startsWith('..') && !path.isAbsolute(relToInput))) usage('--out must be outside what is scrubbed');
  if (existsSync(out) && !o.force) usage(`${o.out ?? out} exists; add --force to write into it`);

  let patternFile = o.patterns ? path.resolve(o.patterns) : null;
  if (!patternFile) {
    try {
      const root = fileURLToPath(new URL('..', import.meta.url));
      const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
      patternFile = path.join(common, 'info', 'private-patterns');
    } catch {
      patternFile = null;
    }
  }
  const { patterns, invalid } = patternFile && existsSync(patternFile) ? parsePatternList(readFileSync(patternFile, 'utf8')) : { patterns: [], invalid: [] };
  if (invalid.length) usage(`invalid regex in the pattern list: #${invalid.join(', #')}`);

  const scrubber = createScrubber({ patterns: patterns.map((p) => p.re), names: o.names, keepIps: o.keepIps, hostRoots: o.hostRoots });
  const { written, skipped } = scrubTree(input, out, scrubber);
  console.log(`scrub-fixture: ${written.length} file(s) written to ${path.relative(process.cwd(), out) || '.'} (${patterns.length} local pattern(s))`);
  for (const [rule, n] of Object.entries(scrubber.counts).sort()) console.log(`  ${rule}: ${n} replaced`);
  for (const s of skipped) console.log(`  skipped (${s.why}): ${s.path}`);
  console.log('Read the copies before committing them: the rules catch the usual, not everything.');
  return { written, skipped, counts: scrubber.counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
