#!/usr/bin/env node
// Creates or completes .env from .env.example: every empty secret gets a
// fresh random value; values already in .env are never touched.
//
//   node scripts/init-env.mjs
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const SECRETS = {
  AGENT_TOKEN: () => randomBytes(32).toString('hex'),
  PZ_ADMIN_PASSWORD: () => randomBytes(18).toString('base64url'),
  PANEL_OWNER_PASSWORD: () => randomBytes(12).toString('base64url'),
};

const example = readFileSync('.env.example', 'utf8');
const current = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const have = new Map();
for (const line of current.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m) have.set(m[1], m[2]);
}

const generated = [];
const out = example.split(/\r?\n/).map((line) => {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!m) return line;
  const [, key, dflt] = m;
  if (have.has(key)) return `${key}=${have.get(key)}`;
  if (dflt === '' && SECRETS[key]) {
    generated.push(key);
    return `${key}=${SECRETS[key]()}`;
  }
  return line;
});
// Keep keys the user added that the example doesn't know.
for (const [k, v] of have) if (!out.some((l) => l.startsWith(`${k}=`))) out.push(`${k}=${v}`);

writeFileSync('.env', out.join('\n'), { mode: 0o600 });
console.log(generated.length ? `.env written; generated ${generated.join(', ')}` : '.env is complete; nothing generated');
if (generated.includes('PANEL_OWNER_PASSWORD')) console.log('Your first panel login password is PANEL_OWNER_PASSWORD in .env (you must change it at first login).');
