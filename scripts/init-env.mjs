#!/usr/bin/env node
// Creates or completes .env from .env.example: every empty secret gets a
// fresh random value; values already in .env are never touched.
//
//   node scripts/init-env.mjs
//
// For a development worktree use scripts/worktree-env.mjs instead.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fillEnv } from './lib/env-template.mjs';

const example = readFileSync('.env.example', 'utf8');
const current = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const { text, generated } = fillEnv(example, current);

writeFileSync('.env', text, { mode: 0o600 });
console.log(generated.length ? `.env written; generated ${generated.join(', ')}` : '.env is complete; nothing generated');
if (generated.includes('PANEL_OWNER_PASSWORD')) console.log('Your first panel login password is PANEL_OWNER_PASSWORD in .env (you must change it at first login).');
