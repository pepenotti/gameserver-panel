import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelSpec, LineSignal } from '@gsp/adapter-api';
import { GameRun } from '../src/game';
import { freePort, TIME_SCALE } from './helpers';

// A game in one line of JavaScript: prints "up", echoes stdin as "echo: <line>", exits on "quit".
const ECHO = `process.stdout.write('up\\n');require('readline').createInterface({input:process.stdin}).on('line',(l)=>{if(l==='quit')process.exit(0);process.stdout.write('echo: '+l+'\\n');});`;

let run: GameRun | null = null;
afterEach(async () => {
  run?.proc.signal('SIGKILL');
  await run?.exited;
  run = null;
});

function start(channel: ChannelSpec = { kind: 'none' }) {
  const signals: LineSignal[] = [];
  run = new GameRun({
    command: { argv: [process.execPath, '-e', ECHO], cwd: os.tmpdir() },
    env: process.env,
    classify: (line) => ({ message: line.replace(/^echo: /, ''), ready: line === 'up' || undefined }),
    channel,
    onLine: (_raw, _stream, s) => signals.push(s),
  });
  return { run, signals };
}

describe('GameRun', () => {
  it('matches waitForLine against classified messages, and sends commands to stdin without a channel', async () => {
    const { run, signals } = start();
    const ctl = run.handle();
    expect(await ctl.waitForLine(/^up$/, 5_000 * TIME_SCALE)).not.toBeNull();
    expect(signals[0]).toMatchObject({ message: 'up', ready: true });
    const hello = ctl.waitForLine(/^hel+o$/, 5_000 * TIME_SCALE);
    expect(await ctl.command('hello')).toBeNull();
    expect((await hello)?.[0]).toBe('hello');
    await expect(ctl.command('x', 'channel')).rejects.toThrow(/no control channel/);
    await expect(ctl.command('a\nb')).rejects.toThrow(/single line/);
    expect(await ctl.waitForLine(/never/, 50)).toBeNull();
  });

  it('keeps channel commands for when the agent calls it ready', async () => {
    // Nothing listens on this port: a ready run would fail over to stdin.
    const { run } = start({ kind: 'rcon', port: await freePort(), password: 'p'.repeat(24) });
    const ctl = run.handle();
    expect(ctl.ready).toBe(false);
    await expect(ctl.command('x', 'channel')).rejects.toThrow(/not ready/);
    expect(await ctl.command('x')).toBeNull();

    const failures: string[] = [];
    run.ready = true;
    const logged = run.handle((e) => failures.push(e.message));
    expect(logged.ready).toBe(true);
    await expect(logged.command('x', 'channel')).rejects.toThrow();
    expect(await logged.command('y')).toBeNull();
    expect(failures).toHaveLength(2);
  });

  it('collects a console reply spread over several lines until it is complete (PLY-01)', async () => {
    const { run } = start();
    const ctl = run.handle();
    await ctl.waitForLine(/^up$/, 5_000 * TIME_SCALE);
    // Until a line matches…
    const reply = ctl.waitForLines!(/^\d+ players? connected\.$/, 5_000 * TIME_SCALE);
    for (const l of ['alice (192.0.2.1:1)', 'bob (192.0.2.1:2)', '2 players connected.', 'later']) ctl.stdin(l);
    expect(await reply).toEqual(['alice (192.0.2.1:1)', 'bob (192.0.2.1:2)', '2 players connected.']);
    await ctl.waitForLine(/^later$/, 5_000 * TIME_SCALE);
    // …or until a test of every line so far says so (a header, then the line after it).
    const two = ctl.waitForLines!((lines) => lines.length >= 2 && lines[lines.length - 2] === 'Online Players (1/8)', 5_000 * TIME_SCALE);
    for (const l of ['Server executed: /playing.', 'Online Players (1/8)', 'alice']) ctl.stdin(l);
    expect(await two).toEqual(['Server executed: /playing.', 'Online Players (1/8)', 'alice']);
    expect(await ctl.waitForLines!(/never/, 50)).toBeNull();
  });

  it('wakes every waiter when the game exits', async () => {
    const { run } = start();
    const ctl = run.handle();
    await ctl.waitForLine(/^up$/, 5_000 * TIME_SCALE);
    const pending = ctl.waitForLine(/never/, 60_000);
    const collecting = ctl.waitForLines!(/never/, 60_000);
    expect(ctl.stdin('quit')).toBe(true);
    expect(await pending).toBeNull();
    expect(await collecting).toBeNull();
    expect(await run.exited).toMatchObject({ code: 0 });
    expect(ctl.ready).toBe(false);
    expect(await ctl.waitForLine(/x/, 60_000)).toBeNull();
    expect(await ctl.waitForLines!(/x/, 60_000)).toBeNull();
  });
});
