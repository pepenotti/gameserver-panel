// CON-01: the progress lines Terraria prints while it generates, loads and
// saves a world (about 30 000 for a small world's first boot) are marked as
// runs, so the agent's live log shows each run as its latest line; nothing
// else is marked. Checked against the captures of the three flavours, with
// the progress lines the fixtures left out put back.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/runtime';
import { TR_PROGRESS } from '../src/runtime/progress';
import { FIXTURES, fixture } from './helpers';

/**
 * A captured log as the game printed it: each `# … n more progress lines like
 * these …` note becomes n more copies of the line before it; what was typed
 * (`> `) and the fixture's other notes are left out.
 */
function expanded(...p: string[]): string[] {
  const out: string[] = [];
  const lines = fixture(...p).split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const l of lines) {
    const m = /^# … (\d+) more progress lines like these/.exec(l);
    if (m) {
      const prev = out.at(-1)!;
      for (let i = 0; i < Number(m[1]); i++) out.push(prev);
    } else if (!l.startsWith('# ') && !l.startsWith('> ')) out.push(l);
  }
  return out;
}

/** How many lines the live log keeps of `lines`: runs of progress lines of a key count once until a non-blank line that isn't progress. */
function shownCount(lines: string[]): number {
  const open = new Set<string>();
  let n = 0;
  for (const l of lines) {
    const s = classify(l);
    if (s.progress) {
      if (!open.has(s.progress.key)) n++;
      open.add(s.progress.key);
      continue;
    }
    if (s.message.trim() !== '') open.clear();
    n++;
  }
  return n;
}

const logs = ['vanilla', 'tshock', 'tmodloader'].flatMap((f) => readdirSync(path.join(FIXTURES, f, 'logs')).map((file) => [f, 'logs', file]));

describe("Terraria's progress lines (CON-01)", () => {
  it.each([
    // 30 095 lines shown as 14, and 20 083 as 52.
    ['vanilla', 'first-boot-small.log', 30_000, 20],
    ['tmodloader', 'first-boot.log', 20_000, 60],
  ] as const)("%s: a first boot's world generation is a few runs instead of thousands of lines", (flavour, file, atLeast, atMost) => {
    const lines = expanded(flavour, 'logs', file);
    const progress = lines.filter((l) => classify(l).progress);
    expect(progress.length).toBeGreaterThan(atLeast);
    expect(shownCount(lines)).toBeLessThan(atMost);
    // What must stay in the log is never progress.
    for (const l of lines.filter((x) => /^(?:Creating world - Seed|Terraria Server v|Listening on port|: Server started)/.test(x))) expect(classify(l).progress, l).toBeUndefined();
  });

  it('names each kind of step as its own run', () => {
    expect(classify('48.2% - Adding water bodies - 25.0%').progress).toEqual({ key: 'world-generation' });
    expect(classify('0.0% -  - 0.0%').progress).toEqual({ key: 'world-generation' });
    expect(classify('0,4% - Añadiendo arena - 0,0%').progress).toEqual({ key: 'world-generation' });
    expect(classify('100.0% - Finalizing world - 0.0%').progress).toEqual({ key: 'world-generation' });
    expect(classify('Resetting game objects 75%').progress).toEqual({ key: 'resetting' });
    expect(classify('Loading world data: 13%').progress).toEqual({ key: 'loading' });
    expect(classify('Settling liquids 50%').progress).toEqual({ key: 'settling' });
    expect(classify('Creating underworld 12%').progress).toEqual({ key: 'underworld' });
    // After the prompt printed without a newline, as a save typed on the console answers.
    expect(classify(': Saving world data: 20%').progress).toEqual({ key: 'saving' });
    expect(classify('Validating world save: 97%').progress).toEqual({ key: 'validating' });
    expect(new Set(TR_PROGRESS.map((p) => p.key)).size).toBe(TR_PROGRESS.length);
  });

  it('marks nothing else: every line of every capture that is progress is a step with a percentage, and means nothing more', () => {
    for (const p of logs) {
      for (const l of expanded(...p)) {
        const s = classify(l);
        if (!s.progress) continue;
        expect(s.message, `${p.join('/')}: ${l}`).toMatch(/\d%$/);
        const { message: _m, progress: _p, ...rest } = s;
        expect(rest, `${p.join('/')}: ${l}`).toEqual({});
      }
    }
    for (const l of ['Server started', 'Backing up world file', 'Saving modded world data', ': No players connected.', '2 players connected.', 'Saving before exit...', 'Saving world data:', 'Generating world terrain', 'Creating world - Seed: 1, Width: 4200, Height: 1200, Evil: -1, Difficulty: 0', '<gspffbob> 50% - done - 100%', 'gspffbob has joined.']) {
      expect(classify(l).progress, l).toBeUndefined();
    }
  });
});
