// A game with nothing but a console, for the live-log tests (CON-01, PLY-01).
// It prints `REPLAY_FILE`'s lines when given (a captured boot), else `up`,
// then answers on stdin:
//   playing          one line per player, then `No players connected.` or `<n> players connected.`
//                    (each line `SLOW_MS` after the one before, when set)
//   playing-join <x> the same, with `<x> has joined.` printed in the middle of it
//   join <x>         `<x> has joined.`, and <x> is online from then on
//   say <text>       `<Server> <text>`
//   later <text>     `<text>`, 150 ms later (a reply that takes a while)
//   mute             `playing` answers `The server is busy` from then on
//   exit | quit      `Saving before exit...` (exit only), then exit 0
//   anything else    `echo: <line>`
// `PROMPT=1` puts the console prompt `: ` in front of each reply's first line, as some games do.
import { readFileSync } from 'node:fs';
import readline from 'node:readline';

const slow = Number(process.env.SLOW_MS || 0);
const prompt = process.env.PROMPT === '1' ? ': ' : '';
const players = [];
let muted = false;

const out = (line) => process.stdout.write(`${line}\n`);

/** A reply of several lines, the first one after the prompt. */
function reply(lines) {
  lines.forEach((line, i) => {
    const text = (i === 0 ? prompt : '') + line;
    if (slow) setTimeout(() => out(text), slow * (i + 1));
    else out(text);
  });
}

if (process.env.REPLAY_FILE) process.stdout.write(readFileSync(process.env.REPLAY_FILE, 'utf8'));
else out('up');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [cmd, ...rest] = line.split(' ');
  const arg = rest.join(' ');
  switch (cmd) {
    case 'quit':
      process.exit(0);
      break;
    case 'exit':
      out('Saving before exit...');
      setTimeout(() => process.exit(0), 20);
      break;
    case 'playing':
    case 'playing-join': {
      if (muted) return reply(['The server is busy']);
      const lines = players.map((p, i) => `${p} (192.0.2.1:${50000 + i})`);
      lines.push(players.length === 0 ? 'No players connected.' : `${players.length} players connected.`);
      if (cmd === 'playing-join') lines.splice(lines.length - 1, 0, `${arg} has joined.`);
      return reply(lines);
    }
    case 'join':
      players.push(arg);
      return reply([`${arg} has joined.`]);
    case 'say':
      return reply([`<Server> ${arg}`]);
    case 'later':
      setTimeout(() => out(arg), 150);
      return;
    case 'mute':
      muted = true;
      return;
    default:
      return reply([`echo: ${line}`]);
  }
});
