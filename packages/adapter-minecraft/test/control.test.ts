// Driving a running server (BAK-02, PLY-01, SRV-03, NFR-04) through a
// scripted ControlHandle that answers like the captures.
import { describe, expect, it } from 'vitest';
import type { CommandVia, ControlHandle } from '@gsp/adapter-api';
import { minecraftRuntimeAdapter as mc } from '../src/runtime';

interface Scripted extends ControlHandle {
  sent: string[];
  stdinLines: string[];
  /** A log line's message, delivered to `waitForLine` waiters. */
  emit(message: string): void;
}

/**
 * `replies[cmd]`: the RCON reply, `null` to fail the channel (the handle then
 * falls back to the console unless `via` is 'channel'), or `'stdin'` to answer
 * as a console command does (null, and log lines instead).
 */
function handle(o: { ready?: boolean; replies?: Record<string, string | null | 'stdin'>; logs?: Record<string, string[]> } = {}): Scripted {
  const waiters: { re: RegExp; resolve: (m: RegExpExecArray | null) => void }[] = [];
  const h: Scripted = {
    sent: [],
    stdinLines: [],
    ready: o.ready ?? true,
    emit(message) {
      for (const w of [...waiters]) {
        const m = w.re.exec(message);
        if (m) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    },
    async command(cmd: string, via?: CommandVia) {
      h.sent.push(via ? `${via}:${cmd}` : cmd);
      const r = o.replies?.[cmd];
      if (r === undefined) throw new Error(`unexpected command ${cmd}`);
      if (r === null) {
        if (via === 'channel') throw new Error('RCON connection closed');
        h.stdinLines.push(cmd);
        setTimeout(() => (o.logs?.[cmd] ?? []).forEach((l) => h.emit(l)), 5);
        return null;
      }
      if (r === 'stdin') {
        setTimeout(() => (o.logs?.[cmd] ?? []).forEach((l) => h.emit(l)), 5);
        return null;
      }
      return r;
    },
    stdin(line) {
      h.stdinLines.push(line);
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
  return h;
}

const FLUSHED = 'Saving the game (this may take a moment!)Saved the game';

describe('save (BAK-02)', () => {
  it('flushes over RCON and returns once the reply says the world is saved', async () => {
    const h = handle({ replies: { 'save-all flush': FLUSHED } });
    await mc.save!(h, { budgetMs: 1000 });
    expect(h.sent).toEqual(['save-all flush']);
    // Paper keeps the reply's newline.
    await mc.save!(handle({ replies: { 'save-all flush': 'Saving the game (this may take a moment!)\nSaved the game' } }), { budgetMs: 1000 });
  });

  it('refuses a reply that is not a finished save', async () => {
    await expect(mc.save!(handle({ replies: { 'save-all flush': 'Unknown or incomplete command. See below for error' } }), { budgetMs: 1000 })).rejects.toThrow(/did not confirm the save/);
  });

  it('on the console, waits for the "Saved the game" line', async () => {
    const h = handle({ replies: { 'save-all flush': 'stdin' }, logs: { 'save-all flush': ['System chat: Saving the game (this may take a moment!)', 'System chat: Saved the game'] } });
    await mc.save!(h, { budgetMs: 1000 });
    await expect(mc.save!(handle({ replies: { 'save-all flush': 'stdin' } }), { budgetMs: 100 })).rejects.toThrow(/did not report that it finished saving/);
  });
});

describe('hot copy (BAK-02)', () => {
  it('turns saving off and flushes before the copy, and turns saving on after it', async () => {
    const h = handle({ replies: { 'save-off': 'Automatic saving is now disabled', 'save-all flush': FLUSHED, 'save-on': 'Automatic saving is now enabled' } });
    await mc.hotCopy!.before(h);
    expect(h.sent).toEqual(['save-off', 'save-all flush']);
    await mc.hotCopy!.after(h);
    expect(h.sent).toEqual(['save-off', 'save-all flush', 'save-on']);
    expect(mc.hotCopy!.sqlite).toBeUndefined();
  });

  it('takes "already" replies as done, and fails when the game does not confirm', async () => {
    const already = handle({ replies: { 'save-off': 'Saving is already turned off', 'save-all flush': FLUSHED, 'save-on': 'Saving is already turned on' } });
    await mc.hotCopy!.before(already);
    await mc.hotCopy!.after(already);
    await expect(mc.hotCopy!.before(handle({ replies: { 'save-off': 'Unknown or incomplete command. See below for error' } }))).rejects.toThrow(/answered .* to save-off/);
    // On the console, the log line confirms it (26.3 prefixes console feedback with "System chat: ").
    const console = handle({ replies: { 'save-off': 'stdin', 'save-all flush': 'stdin', 'save-on': 'stdin' }, logs: { 'save-off': ['System chat: Automatic saving is now disabled'], 'save-all flush': ['System chat: Saved the game'], 'save-on': ['System chat: Automatic saving is now enabled'] } });
    await mc.hotCopy!.before(console);
    await mc.hotCopy!.after(console);
  });
});

describe('stop (SRV-03, NFR-04)', () => {
  it('sends stop over RCON once the server is up', async () => {
    const h = handle({ replies: { stop: 'Stopping the server' } });
    await mc.stop(h, { budgetMs: 1000 });
    expect(h.sent).toEqual(['channel:stop']);
    expect(h.stdinLines).toEqual([]);
  });

  it('falls back to the console when RCON fails, and uses it while the server is still starting', async () => {
    const down = handle({ replies: { stop: null } });
    await mc.stop(down, { budgetMs: 1000 });
    expect(down.stdinLines).toEqual(['stop']);
    const starting = handle({ ready: false });
    await mc.stop(starting, { budgetMs: 1000 });
    expect(starting.sent).toEqual([]);
    expect(starting.stdinLines).toEqual(['stop']);
  });
});

describe('who is online (PLY-01)', () => {
  it('asks over RCON with list', async () => {
    const h = handle({ replies: { list: 'There are 1 of a max of 20 players online: gspffAlice' } });
    expect(await mc.listPlayers!(h)).toEqual({ count: 1, names: ['gspffAlice'] });
    expect(h.sent).toEqual(['channel:list']);
    expect(await mc.listPlayers!(handle({ replies: { list: 'Something else' } }))).toBeNull();
  });
});
