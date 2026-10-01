import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ControlHandle, LineSignal } from '@gsp/adapter-api';

const AVORION = fileURLToPath(new URL('../../../fixtures/avorion/2.5.13/', import.meta.url));

/** Avorion's launch params as the panel sends them for a server whose game name is `gal`. */
export const avorionLaunch = () => ({ name: 'gal', branch: 'public', updateOnStart: false, memoryMb: 2048, serverName: 'Gal test', maxPlayers: 8, listed: false, saveInterval: 300 });

/** A file of the Avorion 2.5.13 captures. */
export function fixture(...parts: string[]): string {
  return readFileSync(`${AVORION}${parts.join('/')}`, 'utf8');
}

/**
 * A captured log as the agent reads it: the harness's own lines (`# argv`,
 * `# cwd`) and what it typed (`> `) left out, stderr lines without their
 * `[stderr] ` mark.
 */
export function fixtureLines(...parts: string[]): string[] {
  return fixture(...parts)
    .split(/\r?\n/)
    .filter((l) => l !== '' && !l.startsWith('# ') && !l.startsWith('> '))
    .map((l) => l.replace(/^\[stderr\] /, ''));
}

/**
 * A running game as an adapter drives it, scripted: each line written to
 * stdin is recorded, and `answer` says what the game prints back (each
 * printed line goes through `classify` and reaches waiters as the agent's
 * GameRun would).
 */
export function scriptedGame(classify: (line: string) => LineSignal, answer: (line: string) => string[] = () => [], o: { ready?: boolean } = {}) {
  const written: string[] = [];
  const signals: NodeJS.Signals[] = [];
  const waiters = new Set<{ re: RegExp; resolve: (m: RegExpExecArray | null) => void }>();
  const collectors = new Set<{ lines: string[]; done: (lines: readonly string[]) => boolean; resolve: (l: string[] | null) => void }>();
  const timers = new Set<NodeJS.Timeout>();
  const print = (raw: string) => {
    const message = classify(raw).message;
    for (const w of [...waiters]) {
      const m = w.re.exec(message);
      if (m) {
        waiters.delete(w);
        w.resolve(m);
      }
    }
    for (const c of [...collectors]) {
      c.lines.push(message);
      if (c.done(c.lines)) {
        collectors.delete(c);
        c.resolve(c.lines);
      }
    }
  };
  const ctl: ControlHandle = {
    ready: o.ready ?? true,
    command: async (cmd) => {
      written.push(cmd);
      queueMicrotask(() => answer(cmd).forEach(print));
      return null;
    },
    stdin: (line) => {
      written.push(line);
      // The game answers a moment later, as a real one does.
      const t = setTimeout(() => {
        timers.delete(t);
        answer(line).forEach(print);
      }, 5);
      timers.add(t);
      return true;
    },
    signal: (sig) => void signals.push(sig),
    waitForLine: (re, timeoutMs) =>
      new Promise((resolve) => {
        const w = { re, resolve };
        waiters.add(w);
        const t = setTimeout(() => {
          timers.delete(t);
          if (waiters.delete(w)) resolve(null);
        }, timeoutMs);
        timers.add(t);
      }),
    waitForLines: (until, timeoutMs) =>
      new Promise((resolve) => {
        const done = typeof until === 'function' ? until : (lines: readonly string[]) => until.test(lines[lines.length - 1] ?? '');
        const c = { lines: [] as string[], done, resolve };
        collectors.add(c);
        const t = setTimeout(() => {
          timers.delete(t);
          if (collectors.delete(c)) resolve(null);
        }, timeoutMs);
        timers.add(t);
      }),
  };
  return {
    ctl,
    written,
    signals,
    /** The game prints a line of its own. */
    print,
    close: () => {
      for (const t of timers) clearTimeout(t);
    },
  };
}
