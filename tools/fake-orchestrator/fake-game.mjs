#!/usr/bin/env node
// The fake game of a server, picked by its adapter, for the fake orchestrator
// and the fake runtime images (docker/steam, target fake):
//
//   GAME_ADAPTER=pz node fake-game.mjs server   [args…]   runs ../fake-pz/server.mjs   [args…]
//   GAME_ADAPTER=pz node fake-game.mjs steamcmd [args…]   runs ../fake-pz/steamcmd.mjs [args…]
//
// The agent passes its environment (without its token) to both, so
// GAME_ADAPTER is always there.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [kind = ''] = process.argv.splice(2, 1);
const adapter = process.env.GAME_ADAPTER ?? '';
if (!/^(server|steamcmd)$/.test(kind) || !/^[a-z][a-z0-9-]{0,39}$/.test(adapter)) {
  console.error('usage: GAME_ADAPTER=<adapter> fake-game.mjs server|steamcmd [args…]');
  process.exit(2);
}
const target = new URL(`../fake-${adapter}/${kind}.mjs`, import.meta.url);
if (!existsSync(target)) {
  console.error(`fake-game: there is no fake ${kind} for the ${adapter} adapter`);
  process.exit(2);
}
// The fake reads its own arguments from process.argv.slice(2), as if started directly.
process.argv[1] = fileURLToPath(target);
await import(target.href);
