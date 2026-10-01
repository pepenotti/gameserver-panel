// Which files a running backup of Valheim takes (BAK-02, the hotCopySelect
// hook), on the save layout measured on 1.0.16 (fixtures/valheim/1.0.16/tree
// and docs/verification/valheim-1.0.16.md "Saving and backups"): the
// newest complete set of each world, at every moment of a save.
import { describe, expect, it } from 'vitest';
import { newestCompleteSaves } from '../src/runtime';
import { fixture } from './helpers';

const LISTS = ['adminlist.txt', 'bannedlist.txt', 'permittedlist.txt'];
const set = (n: number, world = 'vh') => [`00_00__0_${n}.chunk`, `_main.${n}.chunks`, `_main.${n}.db2`, `_main.${n}.fwl2`, `_main.${n}.ok`].map((f) => `worlds_local/${world}/${f}`);
const pick = (files: string[]) => newestCompleteSaves([...LISTS, ...files].sort());

/**
 * The world folder at each step of the measured save of set 2 over set 1
 * (tree/save-file-events.txt): the files there after each event, in order.
 */
function measuredSave(): { event: string; files: string[] }[] {
  const now = new Set(set(1, 'gspffworld'));
  const out: { event: string; files: string[] }[] = [];
  for (const line of fixture('tree', 'save-file-events.txt').split('\n')) {
    const m = /\[fs\] (rename|change) \/data\/(worlds_local\/\S+)(?: size=\d+| \(gone\))/.exec(line);
    if (!m) continue;
    if (line.endsWith('(gone)')) now.delete(m[2]!);
    else now.add(m[2]!);
    out.push({ event: line.trim(), files: [...now].sort() });
    // The first save's events only (the file holds the stop's save too): they end with set 1's last file gone.
    if (/00_00__0_1\.chunk \(gone\)/.test(line)) break;
  }
  return out;
}

describe('the newest complete save set of each world (BAK-02)', () => {
  it('a quiet world: its one set and the lists', () => {
    expect(pick(set(7))).toEqual([...LISTS, ...set(7)].sort());
  });

  it('at every step of the measured save, exactly one complete set: the old one until the new one has its marker', () => {
    const steps = measuredSave();
    expect(steps.length).toBeGreaterThanOrEqual(10);
    let sawNew = false;
    for (const { event, files } of steps) {
      const picked = pick(files).filter((f) => f.startsWith('worlds_local/'));
      const complete = files.includes('worlds_local/gspffworld/_main.2.ok') ? 2 : 1;
      if (complete === 2) sawNew = true;
      expect(picked, event).toEqual(set(complete, 'gspffworld').sort());
    }
    expect(sawNew).toBe(true);
  });

  it('leaves out a newer set without its marker, leftovers of an older one, and folders inside a world', () => {
    const files = [...set(4), ...set(5).filter((f) => !f.endsWith('.ok')), 'worlds_local/vh/_main.3.fwl2', 'worlds_local/vh/old/_main.1.db2'];
    expect(pick(files)).toEqual([...LISTS, ...set(4)].sort());
  });

  it("never calls a set complete without its database and header, whatever its marker says", () => {
    const torn = set(6).filter((f) => !f.endsWith('.db2'));
    expect(pick([...set(5), ...torn])).toEqual([...LISTS, ...set(5)].sort());
  });

  it('takes, for each chunk, its newest file of the set or before it (should an unchanged chunk keep an older number)', () => {
    const files = [...set(9), 'worlds_local/vh/01_00__0_7.chunk', 'worlds_local/vh/01_00__0_3.chunk', 'worlds_local/vh/01_00__0_10.chunk'];
    expect(pick(files)).toEqual([...LISTS, ...set(9), 'worlds_local/vh/01_00__0_7.chunk'].sort());
  });

  it("a new world before its first save: its name and seed (_main.0.fwl2, measured), nothing else", () => {
    expect(pick(['worlds_local/vh/_main.0.fwl2'])).toEqual([...LISTS, 'worlds_local/vh/_main.0.fwl2'].sort());
    // Its first save half written: the header of set 0 is still the world's.
    expect(pick(['worlds_local/vh/_main.0.fwl2', 'worlds_local/vh/00_00__0_1.chunk', 'worlds_local/vh/_main.1.chunks'])).toEqual([...LISTS, 'worlds_local/vh/_main.0.fwl2'].sort());
    expect(pick([])).toEqual(LISTS);
  });

  it('works per world, and keeps every file outside the worlds', () => {
    const files = [...set(2, 'a'), ...set(3, 'b'), ...set(4, 'b').slice(0, 2), 'worlds_local/loose.txt'];
    expect(pick(files)).toEqual([...LISTS, ...set(2, 'a'), ...set(3, 'b'), 'worlds_local/loose.txt'].sort());
  });
});
