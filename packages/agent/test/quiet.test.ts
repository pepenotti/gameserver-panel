// PLY-01: the agent's own console queries (its player polls) stay out of the
// live log, while what people send still shows. Stdin replies carry no tag,
// so these tests drive the races that matter through GameRun: a person's
// command while a poll waits for its reply, and a poll right after a
// person's command whose reply takes a while.
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ControlHandle, LineSignal } from '@gsp/adapter-api';
import { GameRun } from '../src/game';
import { TIME_SCALE } from './helpers';

const GAME = fileURLToPath(new URL('./console-game.mjs', import.meta.url));
const WAIT = 5_000 * TIME_SCALE;

let run: GameRun | null = null;
afterEach(async () => {
  run?.proc.signal('SIGKILL');
  await run?.exited;
  run = null;
});

interface Game {
  run: GameRun;
  /** Lines people see (`onShow`), in order. */
  shown: string[];
  /** Every line the game printed, in the order it was read. */
  read: string[];
  loud: ControlHandle;
  quiet: ControlHandle;
}

async function start(o: { slowMs?: number; quietAfterLoudMs?: number } = {}): Promise<Game> {
  const shown: string[] = [];
  const read: string[] = [];
  run = new GameRun({
    command: { argv: [process.execPath, GAME], cwd: os.tmpdir(), env: { SLOW_MS: String(o.slowMs ?? 0) } },
    env: process.env,
    classify: (line): LineSignal => {
      const j = /^(.+) has joined\.$/.exec(line);
      return j ? { message: line, join: j[1]! } : { message: line };
    },
    channel: { kind: 'stdin' },
    onLine: (raw) => read.push(raw),
    onShow: (raw) => shown.push(raw),
    quietAfterLoudMs: o.quietAfterLoudMs ?? 0,
  });
  const loud = run.handle();
  expect(await loud.waitForLine(/^up$/, WAIT)).not.toBeNull();
  return { run, shown, read, loud, quiet: run.handle(undefined, { quiet: true }) };
}

/** A player poll as an adapter writes it: wait for the reply first, then ask. */
function poll(ctl: ControlHandle, cmd = 'playing', timeoutMs = WAIT): Promise<string[] | null> {
  const reply = ctl.waitForLines!((lines) => lines.some((l) => /players? connected\.$/.test(l)), timeoutMs);
  if (!ctl.stdin(cmd)) throw new Error('Could not write');
  return reply;
}

/** Until the game printed a line matching `re` (read, shown or not). */
async function printed(g: Game, re: RegExp): Promise<void> {
  const end = Date.now() + WAIT;
  while (!g.read.some((l) => re.test(l))) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${re}; read: ${g.read.join(' | ')}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Something people send, and until it shows: whatever was held before it has been dealt with. */
async function marker(g: Game, text: string): Promise<void> {
  await g.run.command(`say ${text}`, 'stdin');
  const end = Date.now() + WAIT;
  while (!g.shown.includes(`<Server> ${text}`)) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${text}; shown: ${g.shown.join(' | ')}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("the agent's own console queries stay out of the live log (PLY-01)", () => {
  it("keeps a quiet poll's reply out of what people see, and gives it to the adapter; the same query from people shows", async () => {
    const g = await start();
    expect(await poll(g.quiet)).toEqual(['No players connected.']);
    await g.run.command('join alice', 'stdin');
    await printed(g, /^alice has joined\.$/);
    expect(await poll(g.quiet)).toEqual(['alice (192.0.2.1:50000)', '1 players connected.']);
    // A person asking the same shows the reply.
    expect(await poll(g.loud)).toEqual(['alice (192.0.2.1:50000)', '1 players connected.']);
    await marker(g, 'end');
    expect(g.shown).toEqual(['up', 'alice has joined.', 'alice (192.0.2.1:50000)', '1 players connected.', '<Server> end']);
    // Every line was read all the same (readiness, fatal lines and player counts still see them).
    expect(g.read.filter((l) => l === 'No players connected.')).toHaveLength(1);
  });

  it("holds a person's command sent while a poll waits for its reply until the reply is complete, and shows the person's reply", async () => {
    const g = await start({ slowMs: 100 * TIME_SCALE });
    await g.run.command('join alice', 'stdin');
    await g.run.command('join bob', 'stdin');
    await printed(g, /^bob has joined\.$/);
    const polled = poll(g.quiet);
    // The poll's reply has begun (read, not shown) when the person sends something.
    await printed(g, /^alice \(/);
    expect(await g.run.command('say hello', 'stdin')).toBeNull();
    expect(await polled).toEqual(['alice (192.0.2.1:50000)', 'bob (192.0.2.1:50001)', '2 players connected.']);
    await marker(g, 'end');
    // The game got the person's line only after the poll's reply was complete, so nothing of theirs was in it.
    expect(g.read.slice(g.read.indexOf('alice (192.0.2.1:50000)'))).toEqual(['alice (192.0.2.1:50000)', 'bob (192.0.2.1:50001)', '2 players connected.', '<Server> hello', '<Server> end']);
    expect(g.shown).toEqual(['up', 'alice has joined.', 'bob has joined.', '<Server> hello', '<Server> end']);
  });

  it("waits after a person's command before polling, so a reply that takes a while is never read as the poll's", async () => {
    // The race without the wait: the person's late reply lands inside the poll's reply, and is lost.
    const racy = await start({ slowMs: 300 * TIME_SCALE, quietAfterLoudMs: 0 });
    await racy.run.command('later hello', 'stdin');
    expect(await poll(racy.quiet)).toEqual(['hello', 'No players connected.']);
    await marker(racy, 'end');
    expect(racy.shown).toEqual(['up', '<Server> end']);
    racy.run.proc.signal('SIGKILL');
    await racy.run.exited;

    // With it: the poll is written once the person's reply had its time, and theirs shows.
    const g = await start({ slowMs: 300 * TIME_SCALE, quietAfterLoudMs: 600 * TIME_SCALE });
    await g.run.command('later hello', 'stdin');
    expect(await poll(g.quiet)).toEqual(['hello', 'No players connected.']);
    await marker(g, 'end');
    expect(g.shown).toEqual(['up', 'hello', '<Server> end']);
  });

  it('still shows a line that means something (a player joining) inside a poll\'s reply', async () => {
    const g = await start({ slowMs: 50 * TIME_SCALE });
    expect(await poll(g.quiet, 'playing-join zed')).toEqual(['zed has joined.', 'No players connected.']);
    await marker(g, 'end');
    expect(g.shown).toEqual(['up', 'zed has joined.', '<Server> end']);
  });

  it('shows everything a poll held when its reply never completed (the game did not answer as expected)', async () => {
    const g = await start();
    await g.run.command('mute', 'stdin');
    expect(await poll(g.quiet, 'playing', 400 * TIME_SCALE)).toBeNull();
    await marker(g, 'end');
    expect(g.shown).toEqual(['up', 'The server is busy', '<Server> end']);
  });

  it("lets people's lines through at once when the agent ends the poll (a stop), and when the game exits mid-reply", async () => {
    const g = await start({ slowMs: 300 * TIME_SCALE });
    const polled = poll(g.quiet);
    await new Promise((r) => setTimeout(r, 50));
    expect(await g.run.command('say now', 'stdin')).toBeNull();
    // Held behind the poll…
    await new Promise((r) => setTimeout(r, 100));
    expect(g.read).not.toContain('<Server> now');
    // …until the agent ends it (a stop): written then, and the poll no longer owns what comes after, so all of it shows.
    g.run.endQuiet();
    expect(await polled).toEqual(['No players connected.']);
    await printed(g, /^<Server> now$/);
    await marker(g, 'end');
    expect(g.shown).toEqual(['up', 'No players connected.', '<Server> now', '<Server> end']);

    const second = poll(g.quiet);
    await new Promise((r) => setTimeout(r, 50));
    g.run.proc.signal('SIGKILL');
    expect(await second).toBeNull();
    await g.run.exited;
    expect(g.run.handle(undefined, { quiet: true }).stdin('playing')).toBe(false);
  });

  it("writes a quiet line nobody waits a reply for as it is (nothing to keep out of the log)", async () => {
    const g = await start();
    expect(g.quiet.stdin('say plain')).toBe(true);
    await marker(g, 'end');
    expect(g.shown).toEqual(['up', '<Server> plain', '<Server> end']);
  });
});
