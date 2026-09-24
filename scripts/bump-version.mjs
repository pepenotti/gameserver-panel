#!/usr/bin/env node
// Bumps VERSION (SemVer) — the one version for the whole repo. Refuses to run
// on a dirty tree so the bump always lands in the same commit as its change.
//
//   node scripts/bump-version.mjs patch|minor|major [--allow-dirty]
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const kind = process.argv[2];
if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error('usage: bump-version.mjs patch|minor|major [--allow-dirty]');
  process.exit(2);
}
if (!process.argv.includes('--allow-dirty')) {
  const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
  if (dirty) {
    console.error('Working tree is dirty; commit or pass --allow-dirty.');
    process.exit(1);
  }
}
const [major, minor, patch] = readFileSync('VERSION', 'utf8').trim().split('.').map(Number);
const next =
  kind === 'major' ? `${major + 1}.0.0` : kind === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
writeFileSync('VERSION', `${next}\n`);
console.log(next);
