// Driving a running server (SRV-03, NFR-04, BAK-02, PLY-01) through a
// scripted ControlHandle that answers like the captures: every flavour is
// controlled on stdin.
import { describe, expect, it } from 'vitest';
import type { ControlHandle } from '@gsp/adapter-api';
import { terrariaRuntimeAdapter as tr } from '../src/runtime';
import { parseTerrariaLaunch } from '../src/shared';
import { testCtx } from './helpers';

interface Scripted extends ControlHandle {
  stdinLines: string[];
}

/** `replies[line]`: the lines the console prints after that stdin line (as `LineSignal.message`s would reach waiters). */
function handle(o: { replies?: Record<string, string[]>; multiLine?: boolean; stdinClosed?: boolean } = {}): Scripted {
  const waiters: { re: RegExp; resolve: (m: RegExpExecArray | null) => void }[] = [];
  const collectors: { lines: string[]; done: (l: readonly string[]) => boolean; resolve: (l: string[] | null) => void }[] = [];
  const emit = (raw: string) => {
    const message = tr.classify(raw).message;
    for (const w of [...waiters]) {
      const m = w.re.exec(message);
      if (m) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
    for (const c of [...collectors]) {
      c.lines.push(message);
      if (c.done(c.lines)) {
        collectors.splice(collectors.indexOf(c), 1);
        c.resolve(c.lines);
      }
    }
  };
  const h: Scripted = {
    stdinLines: [],
    ready: true,
    command: async () => null,
    stdin(line) {
      if (o.stdinClosed) return false;
      h.stdinLines.push(line);
      setTimeout(() => (o.replies?.[line] ?? []).forEach(emit), 5);
      return true;
    },
    signal: () => undefined,
    waitForLine(re, timeoutMs) {
      return new Promise((resolve) => {
        const w = { re, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs).unref();
      });
    },
  };
  if (o.multiLine !== false) {
    h.waitForLines = (until, timeoutMs) =>
      new Promise((resolve) => {
        const done = typeof until === 'function' ? until : (l: readonly string[]) => until.test(l.at(-1) ?? '');
        const c = { lines: [] as string[], done, resolve };
        collectors.push(c);
        setTimeout(() => {
          const i = collectors.indexOf(c);
          if (i >= 0) collectors.splice(i, 1);
          resolve(null);
        }, timeoutMs).unref();
      });
  }
  return h;
}

describe('stop (SRV-03, NFR-04)', () => {
  it('types exit, which saves and stops every flavour (SIGTERM does not save on vanilla and TShock)', async () => {
    const h = handle();
    await tr.stop(h, { budgetMs: 1000 });
    expect(h.stdinLines).toEqual(['exit']);
    // While the world still loads the line waits for it; with the console gone the agent's signals take over.
    await expect(tr.stop(handle({ stdinClosed: true }), { budgetMs: 1000 })).resolves.toBeUndefined();
  });
});

describe('save and hot copy (BAK-02)', () => {
  it('saves and returns once the world file is complete', async () => {
    const vanilla = handle({ replies: { save: ['Saving world data: 20%', 'Validating world save: 97%', ': Backing up world file'] } });
    await tr.save!(vanilla, { budgetMs: 1000 });
    expect(vanilla.stdinLines).toEqual(['save']);
    await tr.save!(handle({ replies: { save: [': Saving world data: 20%', 'Saving modded world data'] } }), { budgetMs: 1000 });
    await expect(tr.save!(handle({ replies: { save: ['Invalid command.'] } }), { budgetMs: 100 })).rejects.toThrow(/did not report that it finished saving/);
    await expect(tr.save!(handle({ stdinClosed: true }), { budgetMs: 100 })).rejects.toThrow(/console/);
  });

  it("saves before a copy (there is no save-off), and snapshots TShock's database through SQLite", async () => {
    const h = handle({ replies: { save: ['Backing up world file'] } });
    await tr.hotCopy!.before(h);
    await tr.hotCopy!.after(h);
    expect(h.stdinLines).toEqual(['save']);
    expect(tr.hotCopy!.sqlite).toEqual(['tshock/tshock.sqlite']);
  });
});

describe('who is online (PLY-01)', () => {
  const vanilla = parseTerrariaLaunch({ flavour: 'vanilla', world: 'w', worldSize: 1, maxPlayers: 8, memoryMb: 2048 });

  it('asks the console with playing, and reads the lines of its reply', async () => {
    const h = handle({ replies: { playing: ['gspffalice (192.0.2.1:60688)', '192.0.2.1:5 is connecting...', 'bob (192.0.2.1:2)', '2 players connected.'] } });
    const ctx = testCtx();
    try {
      expect(await tr.listPlayers!(h, ctx, vanilla)).toEqual({ count: 2, names: ['gspffalice', 'bob'] });
    } finally {
      ctx.cleanup();
    }
    expect(h.stdinLines).toEqual(['playing']);
    expect(await tr.listPlayers!(handle({ replies: { playing: [': No players connected.'] } }))).toEqual({ count: 0, names: [] });
    // TShock's console answers its own way (the agent asks TShock over REST, quietly; see rest.test.ts).
    expect(await tr.listPlayers!(handle({ replies: { playing: ['Server executed: /playing.', 'Online Players (1/8)', 'gspffbob'] } }))).toEqual({ count: 1, names: ['gspffbob'] });
  });

  it('gives the count alone to an agent that cannot collect several lines, and fails when nothing answers', async () => {
    expect(await tr.listPlayers!(handle({ multiLine: false, replies: { playing: ['a (192.0.2.1:1)', 'b (192.0.2.1:2)', '2 players connected.'] } }))).toEqual({ count: 2, names: [] });
    await expect(tr.listPlayers!(handle({ replies: {} }))).rejects.toThrow(/did not answer playing/);
  }, 30_000);
});
