// Reading the game's output (CON-01, PLY-01, SRV-07): every captured 26.3
// log, per loader.
import { describe, expect, it } from 'vitest';
import { classify } from '../src/runtime';
import { parseLogLine, parsePlayerList } from '../src/shared';
import { fixture, fixtureLines } from './helpers';

const LOADERS = ['vanilla', 'paper', 'fabric'] as const;

describe('log lines (CON-01)', () => {
  it('splits both header shapes and leaves header-less lines whole', () => {
    expect(parseLogLine('[19:32:53] [Server thread/INFO]: Done (4.945s)! For help, type "help"')).toEqual({ header: true, paper: false, thread: 'Server thread', level: 'INFO', message: 'Done (4.945s)! For help, type "help"' });
    expect(parseLogLine('[19:43:29 INFO]: Done (17.555s)! For help, type "help"')).toEqual({ header: true, paper: true, thread: null, level: 'INFO', message: 'Done (17.555s)! For help, type "help"' });
    expect(parseLogLine('[19:35:18] [RCON Client /192.0.2.1 #8/INFO]: Thread RCON Client /192.0.2.1 shutting down')).toMatchObject({ thread: 'RCON Client /192.0.2.1 #8', message: 'Thread RCON Client /192.0.2.1 shutting down' });
    expect(parseLogLine('\tat net.minecraft.server.MinecraftServer.runServer(MinecraftServer.java:774)')).toMatchObject({ header: false });
  });

  it.each(LOADERS)('%s: a boot is ready once, with RCON from the ready line on, and names its version', (loader) => {
    for (const file of ['first-boot.log', 'second-boot.log']) {
      const signals = fixtureLines(loader, 'logs', file).map(classify);
      const ready = signals.flatMap((s, i) => (s.ready ? [i] : []));
      expect(ready, file).toHaveLength(1);
      const channel = signals.findIndex((s, i) => i >= ready[0]! && s.channelReady);
      expect(channel, file).toBeGreaterThanOrEqual(ready[0]!);
      // Paper opens RCON just before its ready line, so the ready line carries both.
      if (loader === 'paper') expect(signals[ready[0]!]!.channelReady, file).toBe(true);
      else expect(channel, file).toBeGreaterThan(ready[0]!);
      expect(signals.filter((s) => s.fatal || s.blockingPrompt), file).toEqual([]);
    }
    const versions = fixtureLines(loader, 'logs', 'first-boot.log').flatMap((l) => classify(l).version ?? []);
    expect(versions).toEqual(['26.3']);
  });

  it('1.16.5, the oldest version offered (Q11), boots with the same lines on Java 17', () => {
    const signals = fixtureLines('..', '1.16.5', 'vanilla', 'logs', 'first-boot.log').map(classify);
    const ready = signals.flatMap((s, i) => (s.ready ? [i] : []));
    expect(ready).toHaveLength(1);
    expect(signals.findIndex((s) => s.channelReady)).toBeGreaterThan(ready[0]!);
    expect(signals.flatMap((s) => s.version ?? [])).toEqual(['1.16.5']);
    expect(signals.filter((s) => s.fatal || s.blockingPrompt)).toEqual([]);
  });

  it.each(LOADERS)('%s: joins and leaves (PLY-01)', (loader) => {
    const lines = fixtureLines(loader, 'logs', 'players.log');
    const joins = lines.flatMap((l) => classify(l).join ?? []);
    const leaves = lines.flatMap((l) => classify(l).leave ?? []);
    expect(joins).toEqual(lines.flatMap((l) => /System chat: (\S+) joined the game$/.exec(l)?.[1] ?? []));
    expect(leaves).toEqual(lines.flatMap((l) => /System chat: (\S+) left the game$/.exec(l)?.[1] ?? []));
    expect(joins.length).toBeGreaterThanOrEqual(4);
    expect(leaves.length).toBeGreaterThanOrEqual(3);
    expect(new Set(joins)).toEqual(new Set(['gspffAlice', 'gspffBob', 'gspffCarol', 'gspffDave']));
  });

  it('a chat line cannot pose as a join, a save or the ready line', () => {
    for (const line of [
      '[20:06:04] [Server thread/INFO]: <gspffAlice> gspffBob joined the game',
      '[20:06:04] [Server thread/INFO]: [Not Secure] <gspffAlice> Saved the game',
      '[20:06:04 INFO]: [Not Secure] [Server] Done (1.0s)! For help, type "help"',
      '[20:06:04] [Server thread/INFO]: * gspffAlice left the game',
    ]) {
      const s = classify(line);
      expect([s.join, s.leave, s.saved, s.ready], line).toEqual([undefined, undefined, undefined, undefined]);
    }
  });

  it('saves: console feedback and RCON feedback echoed to the log (BAK-02)', () => {
    expect(classify('[19:33:04] [Server thread/INFO]: System chat: Saved the game').saved).toBe(true);
    expect(classify('[19:43:40 INFO]: System chat: [Rcon: Saved the game]').saved).toBe(true);
    expect(classify('[19:33:04] [Server thread/INFO]: System chat: Saving the game (this may take a moment!)').saved).toBeUndefined();
    const console = fixtureLines('vanilla', 'logs', 'console-session.log');
    expect(console.filter((l) => classify(l).saved).length).toBeGreaterThan(0);
  });

  it('marks the measured failures fatal (SRV-07): a taken port, a crash, no EULA, the wrong Java, a bad jar, Fabric without its game jar', () => {
    const fatal = (file: [string, string]) => fixtureLines(file[0], 'logs', file[1]).filter((l) => classify(l).fatal);
    expect(fatal(['vanilla', 'port-in-use.log']).map((l) => classify(l).message)).toEqual(expect.arrayContaining(['**** FAILED TO BIND TO PORT!', 'Encountered an unexpected exception']));
    for (const loader of LOADERS) expect(fatal([loader, 'no-eula.log']).length, loader).toBeGreaterThan(0);
    expect(fatal(['vanilla', 'wrong-java-21.log']).length).toBeGreaterThan(0);
    expect(fatal(['vanilla', 'bad-jar.log'])).toHaveLength(1);
    expect(fatal(['vanilla', 'missing-jar.log'])).toHaveLength(1);
    expect(fatal(['fabric', 'installed-missing-game-jar.log']).length).toBeGreaterThan(0);
    // Stopping, and a server that runs without RCON, are not failures.
    for (const [loader, file] of [
      ['vanilla', 'stop.log'],
      ['paper', 'stop.log'],
      ['fabric', 'stop-with-player.log'],
      ['vanilla', 'rcon-no-password.log'],
      ['paper', 'sigterm.log'],
    ]) expect(fatal([loader!, file!]), `${loader} ${file}`).toEqual([]);
  });
});

describe('who is online (PLY-01)', () => {
  it('reads the `list` replies captured on every loader', () => {
    for (const loader of LOADERS) {
      const transcript = JSON.parse(fixture(loader, 'rcon', 'players-online.json')) as { dir: string; kind?: string; id: number; body?: string }[];
      const asked = new Set(transcript.filter((p) => p.dir === 'out' && p.body === 'list').map((p) => p.id));
      const replies = transcript.filter((p) => p.dir === 'in' && asked.has(p.id)).map((p) => p.body!);
      expect(replies.length, loader).toBeGreaterThan(1);
      for (const r of replies) {
        const list = parsePlayerList(r);
        expect(list, r).not.toBeNull();
        expect(list!.names.length, r).toBe(list!.count);
      }
    }
    expect(parsePlayerList('There are 2 of a max of 20 players online: gspffAlice, gspffBob')).toEqual({ count: 2, names: ['gspffAlice', 'gspffBob'] });
    expect(parsePlayerList('There are 0 of a max of 20 players online: ')).toEqual({ count: 0, names: [] });
    expect(parsePlayerList('Unknown or incomplete command. See below for errorlist<--[HERE]')).toBeNull();
    expect(parsePlayerList('')).toBeNull();
  });
});
