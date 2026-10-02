#!/usr/bin/env node
// Runs the gates (scripts/verify.sh --offline) inside a throwaway Linux
// container, for the tests that need what Windows lacks: real POSIX signals
// (a game that saves on SIGINT, SIGKILL escalation), Unix sockets, file modes
// and links. On Windows those tests skip; this is how they still run before a
// merge (NFR-07).
//
//   node scripts/verify-linux.mjs            the working tree as it is, staged or not
//   node scripts/verify-linux.mjs --image node:24-trixie
//
// What it does: copies every tracked and untracked-but-not-ignored file of this
// checkout (never node_modules, .env or other ignored files) into a fresh
// `node:24-trixie` container as the unprivileged `node` user, makes it a git
// repository (the privacy gate reads `git ls-files`), runs `npm ci` and then
// `bash scripts/verify.sh --offline`. The container is removed afterwards
// (`--rm`), is labelled `gsp.verify=linux`, publishes nothing and mounts the
// checkout read-only. The local private patterns (`.git/info/private-patterns`)
// stay on this machine, so the privacy gate there runs its generic checks only;
// the gate on this machine covers the rest.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No trailing separator: Docker reads `C:\repo\:/src` as a broken volume spec.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const imageAt = argv.indexOf('--image');
const image = imageAt >= 0 ? argv[imageAt + 1] : 'node:24-trixie';
if (!image || !/^[a-z0-9./_-]+:[A-Za-z0-9._-]+$/.test(image)) {
  console.error('verify-linux: --image needs a name:tag');
  process.exit(2);
}

const inside = [
  'set -euo pipefail',
  'mkdir -p /tmp/work',
  'git config --global --add safe.directory /src',
  // Tracked plus untracked files that aren't ignored: what the next commit would hold.
  'cd /src && git ls-files -z --cached --others --exclude-standard | tar --null --ignore-failed-read -T - -cf - | tar -xf - -C /tmp/work',
  'cd /tmp/work',
  'git init -q && git add -A && git -c user.email=verify@localhost -c user.name=verify commit -qm snapshot',
  'npm ci --no-audit --no-fund --loglevel=error',
  'bash scripts/verify.sh --offline',
].join('\n');

const args = [
  'run', '--rm',
  '--name', `gsp-verify-linux-${process.pid}`,
  '--label', 'gsp.verify=linux',
  '--user', 'node',
  '--memory', '6g',
  '--network', 'bridge',
  '-e', `VITEST_MAX_WORKERS=${process.env.VITEST_MAX_WORKERS ?? '3'}`,
  '-e', `TEST_TIME_SCALE=${process.env.TEST_TIME_SCALE ?? '2'}`,
  '-e', 'HOME=/home/node',
  '-v', `${root}:/src:ro`,
  image,
  'bash', '-c', inside,
];

console.log(`verify-linux: running the gates in ${image} (this takes a few minutes)`);
const r = spawnSync('docker', args, { stdio: 'inherit' });
if (r.error) {
  console.error(`verify-linux: could not run docker: ${r.error.message}`);
  process.exit(2);
}
process.exit(r.status ?? 1);
