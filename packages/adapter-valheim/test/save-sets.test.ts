// Which files a running backup of Valheim takes (BAK-02, the hotCopySelect
// hook), on the save layout measured on 1.0.16 (fixtures/valheim/1.0.16/tree,
// docs/verification/valheim-1.0.16.md): the newest complete save set of each
// world with the chunk files it uses, at every moment of a save; chunk files
// whose version followed the save number (the fact-finding) or stayed behind
// when nothing changed (the adapter check).
import { describe, expect, it } from 'vitest';
import { newestCompleteSaves, type WrittenAt } from '../src/runtime';
import { fixture } from './helpers';

const LISTS = ['adminlist.txt', 'bannedlist.txt', 'permittedlist.txt'];
const W = (world: string, name: string) => `worlds_local/${world}/${name}`;
const main = (n: number, world = 'vh') => ['chunks', 'db2', 'fwl2', 'ok'].map((x) => W(world, `_main.${n}.${x}`));
const chunk = (v: number, world = 'vh') => W(world, `00_00__0_${v}.chunk`);
/** A set whose chunk's version is its save number, as in the fact-finding. */
const set = (n: number, world = 'vh') => [chunk(n, world), ...main(n, world)];

/** Files written in the order given, one millisecond apart. */
function written(...files: string[]): { files: string[]; at: WrittenAt } {
  const times = new Map(files.map((f, i) => [f, i]));
  return { files: [...LISTS, ...files].sort(), at: (f) => times.get(f) ?? null };
}
const pick = (w: { files: string[]; at: WrittenAt }) => newestCompleteSaves(w.files, w.at);

/**
 * The world folder at each step of the measured save of set 2 over set 1
 * (tree/save-file-events.txt): the files there after each event, and when each was last written.
 */
function measuredSave(): { event: string; files: string[]; at: WrittenAt }[] {
  const times = new Map(set(1, 'gspffworld').map((f) => [f, 0]));
  const out: { event: string; files: string[]; at: WrittenAt }[] = [];
  for (const line of fixture('tree', 'save-file-events.txt').split('\n')) {
    const m = /^\[\+([\d.]+)\] \[fs\] (?:rename|change) \/data\/(worlds_local\/\S+)(?: size=\d+| \(gone\))/.exec(line);
    if (!m) continue;
    if (line.endsWith('(gone)')) times.delete(m[2]!);
    else times.set(m[2]!, Number(m[1]));
    const now = new Map(times);
    out.push({ event: line.trim(), files: [...LISTS, ...now.keys()].sort(), at: (f) => now.get(f) ?? null });
    // The first save's events only (the file holds the stop's save too): they end with set 1's last file gone.
    if (/00_00__0_1\.chunk \(gone\)/.test(line)) break;
  }
  return out;
}

describe('the newest complete save set of each world, with the chunk files it uses (BAK-02)', () => {
  it('a quiet world: its one set and the lists', () => {
    expect(pick(written(...set(7)))).toEqual([...LISTS, ...set(7)].sort());
  });

  it('at every step of the measured save, exactly one complete set: the old one until the new one has its marker', () => {
    const steps = measuredSave();
    expect(steps.length).toBeGreaterThanOrEqual(10);
    let sawNew = false;
    for (const { event, files, at } of steps) {
      const picked = newestCompleteSaves(files, at).filter((f) => f.startsWith('worlds_local/'));
      const complete = files.includes(W('gspffworld', '_main.2.ok')) ? 2 : 1;
      if (complete === 2) sawNew = true;
      expect(picked, event).toEqual(set(complete, 'gspffworld').sort());
    }
    expect(sawNew).toBe(true);
  });

  it('takes every set the adapter check left, with the chunk file it uses (tree/adapter-check-sets.txt)', () => {
    const sections = fixture('tree', 'adapter-check-sets.txt')
      .split(/^## /m)
      .slice(1)
      .map((s) => {
        const [title, ...rest] = s.trim().split('\n');
        return { title: title!, files: rest.filter((l) => !l.startsWith('= ')).map((l) => W('gsp-vh-check', l.split(' ')[0]!)), index: rest.find((l) => l.startsWith('= '))?.split(' ')[2] };
      });
    // The chunk version each set used: it went up only with a save that changed the chunk.
    expect(sections.map((s) => [/save (\d+)/.exec(s.title)![1], /_(\d+)\.chunk$/.exec(s.files.find((f) => f.endsWith('.chunk'))!)![1]].join(':'))).toEqual(['1:1', '3:1', '4:1', '5:2', '6:2', '1:1', '2:2', '3:2', '4:2', '5:3', '6:3']);
    for (const s of sections) {
      // The chunk file was written before the set's other files.
      const w = written(...s.files.filter((f) => f.endsWith('.chunk')), ...s.files.filter((f) => !f.endsWith('.chunk')));
      expect(pick(w), s.title).toEqual([...LISTS, ...s.files].sort());
      // The set's index names the chunk's version at bytes 13-16 (one-chunk worlds; how it names several chunks wasn't measured).
      if (s.index) expect(Buffer.from(s.index, 'hex').readUInt32LE(13), s.title).toBe(Number(/_(\d+)\.chunk$/.exec(s.files.find((f) => f.endsWith('.chunk'))!)![1]));
    }
  });

  it('a chunk nothing changed keeps its older file, as the adapter check found (sets 2 to 4 used 00_00__0_1.chunk, set 5 version 2)', () => {
    // What the world folder held after each stop of the adapter check.
    expect(pick(written(chunk(1), ...main(3)))).toEqual([...LISTS, chunk(1), ...main(3)].sort());
    expect(pick(written(chunk(2), ...main(6)))).toEqual([...LISTS, chunk(2), ...main(6)].sort());
  });

  it('leaves out a chunk a save in progress is writing, though its version is below the set number', () => {
    // Set 4 uses chunk version 1; save 5 has just written version 2 of it, nothing else yet.
    expect(pick(written(chunk(1), ...main(4), chunk(2)))).toEqual([...LISTS, chunk(1), ...main(4)].sort());
    // And with its index too.
    expect(pick(written(chunk(1), ...main(4), chunk(2), W('vh', '_main.5.chunks')))).toEqual([...LISTS, chunk(1), ...main(4)].sort());
  });

  it("takes the new set's chunk, not the old one the game is still deleting", () => {
    // Save 5 complete with chunk version 2; set 4's files gone but its chunk (version 1) not yet.
    expect(pick(written(chunk(1), chunk(2), ...main(5)))).toEqual([...LISTS, chunk(2), ...main(5)].sort());
  });

  it('leaves out a newer set without its marker, leftovers of an older one, and folders inside a world', () => {
    const w = written(...set(4), ...set(5).filter((f) => !f.endsWith('.ok')), W('vh', '_main.3.fwl2'), W('vh', 'old/_main.1.db2'));
    expect(pick(w)).toEqual([...LISTS, ...set(4)].sort());
  });

  it('never calls a set complete without its database and header, whatever its marker says', () => {
    expect(pick(written(...set(5), ...set(6).filter((f) => !f.endsWith('.db2'))))).toEqual([...LISTS, ...set(5)].sort());
  });

  it('a new world before its first save: its name and seed (_main.0.fwl2, measured), nothing else', () => {
    expect(pick(written(W('vh', '_main.0.fwl2')))).toEqual([...LISTS, W('vh', '_main.0.fwl2')].sort());
    // Its first save half written: the header of set 0 is still the world's.
    expect(pick(written(W('vh', '_main.0.fwl2'), chunk(1), W('vh', '_main.1.chunks')))).toEqual([...LISTS, W('vh', '_main.0.fwl2')].sort());
    expect(pick(written())).toEqual(LISTS);
  });

  it('offers a file whose time it can\'t tell (gone since the listing): the agent notices and asks again', () => {
    const w = written(...set(3));
    expect(newestCompleteSaves(w.files, (f) => (f === chunk(3) ? null : w.at(f)))).toEqual([...LISTS, ...set(3)].sort());
    expect(newestCompleteSaves(w.files, () => null)).toEqual([...LISTS, ...set(3)].sort());
  });

  it('works per world, and keeps every file outside the worlds', () => {
    const w = written(...set(2, 'a'), ...set(3, 'b'), ...set(4, 'b').slice(0, 2), 'worlds_local/loose.txt');
    expect(pick(w)).toEqual([...LISTS, ...set(2, 'a'), ...set(3, 'b'), 'worlds_local/loose.txt'].sort());
  });
});
