#!/usr/bin/env node
// Prepares this worktree for slot N (0-9) so several worktrees, and a live
// stack, can share one machine: writes .env (fresh secrets from .env.example
// plus the slot's project name, image tag, 127.0.0.1-only ports and limits)
// and .env.dev (the dev loop's ports). Both files are gitignored.
//
//   node scripts/worktree-env.mjs --slot 1 [--force]
//
// Refuses when a port of the slot's block (30000 + 100*N … +99) can't be
// bound on 127.0.0.1, when Windows reserves part of the block
// (netsh … excludedportrange), or when .env belongs to anything but this
// slot (unless --force).
import { execFileSync } from 'node:child_process';
import dgram from 'node:dgram';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillEnv } from './lib/env-template.mjs';
import { blockPorts, parseSlot, portBlock } from './lib/ports.mjs';
import { devEnvText, envConflict, overlapping, parseExcludedRanges, projectName, slotGamePorts, slotOverrides } from './lib/worktree.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const i = argv.indexOf('--slot');
let slot;
try {
  slot = parseSlot(i >= 0 ? argv[i + 1] : undefined);
} catch (e) {
  console.error(`worktree-env: ${/** @type {Error} */ (e).message}\nusage: node scripts/worktree-env.mjs --slot N [--force]`);
  process.exit(2);
}
const block = portBlock(slot);
const [first, last] = block.range;

/** @type {string[]} */
const problems = [];

const envPath = path.join(root, '.env');
if (existsSync(envPath) && !force) {
  const why = envConflict(readFileSync(envPath, 'utf8'), slot);
  if (why) problems.push(`${why}; pass --force to replace it`);
}

if (process.platform === 'win32') {
  for (const protocol of ['tcp', 'udp']) {
    try {
      const out = execFileSync('netsh', ['interface', 'ipv4', 'show', 'excludedportrange', `protocol=${protocol}`], { encoding: 'utf8' });
      for (const [a, b] of overlapping(parseExcludedRanges(out), first, last)) problems.push(`Windows reserves ${protocol.toUpperCase()} ports ${a}-${b}, inside the block ${first}-${last}; pick another slot`);
    } catch (e) {
      problems.push(`could not read Windows' excluded ${protocol} port ranges: ${/** @type {Error} */ (e).message}`);
    }
  }
}

const bindTcp = (/** @type {number} */ port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(/** @type {NodeJS.ErrnoException} */ (e).code ?? 'error'));
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(null)));
  });
const bindUdp = (/** @type {number} */ port) =>
  new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', (e) => {
      s.close();
      resolve(/** @type {NodeJS.ErrnoException} */ (e).code ?? 'error');
    });
    s.bind({ port, address: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(null)));
  });

/** @type {string[]} */
const busy = [];
for (const port of blockPorts(slot)) {
  const [tcp, udp] = await Promise.all([bindTcp(port), bindUdp(port)]);
  if (tcp) busy.push(`${port}/tcp (${tcp})`);
  if (udp) busy.push(`${port}/udp (${udp})`);
}
if (busy.length) problems.push(`ports of the block ${first}-${last} are in use: ${busy.slice(0, 10).join(', ')}${busy.length > 10 ? ` and ${busy.length - 10} more` : ''} (stop this slot's dev loop or stack first, or pick another slot)`);

if (problems.length) {
  console.error(`worktree-env: not writing slot ${slot}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const example = readFileSync(path.join(root, '.env.example'), 'utf8');
const { text } = fillEnv(example, '', { overrides: slotOverrides(slot), extrasComment: `Worktree slot ${slot} (scripts/worktree-env.mjs)` });
writeFileSync(envPath, text, { mode: 0o600 });
writeFileSync(path.join(root, '.env.dev'), devEnvText(slot));

console.log(`Slot ${slot}: ports ${first}-${last}, Compose project ${projectName(slot)}.
  .env      fresh secrets; stack HTTPS on 127.0.0.1:${block.stackHttps}, game servers on 127.0.0.1:${slotGamePorts(slot)} (fake images allowed)
  .env.dev  dev loop: web ${block.devWeb}, panel ${block.devPanel}, agent ${block.devAgents[0]}, fake RCON ${block.fakeControl(0)}, fake orchestrator's servers on ${slotGamePorts(slot)}
Next: node scripts/dev.mjs   (Docker only through node scripts/stack.mjs)`);
