import { describe, expect, it } from 'vitest';
import {
  checkCompat,
  compareVersions,
  formatModsLine,
  formatWorkshopItems,
  parseModInfo,
  parseModsLine,
  parseWorkshopItems,
  parseWorkshopRef,
  selectVersionFolder,
} from '../src/modinfo';
import { fixture } from './fixtures';

const folders = (rel: string) => fixture(`workshop/${rel}/.folders`).trim().split('\n');

describe('parseModInfo on real B42 mods', () => {
  it('reads require (backslashes, trailing comma) and incompatible lists', () => {
    const srj = parseModInfo(fixture('workshop/2503622437/mods/Skill Recovery Journal/42.20.1/mod.info'));
    expect(srj).toMatchObject({
      id: 'SkillRecoveryJournal',
      name: 'Skill Recovery Journal',
      author: 'Chuckleberry Finn',
      versionMin: '42.20.2',
      require: ['ChuckleberryFinnAlertSystem', 'errorMagnifier'],
      incompatible: ['BurdSurvivalJournals', 'JeevesJournals', 'SkillRecoveryJournalRoyPatch'],
    });
    expect(srj.description.split('\n')[0]).toMatch(/^Craft a journal/);
  });

  it('reads minimal and B41-only files', () => {
    expect(parseModInfo(fixture('workshop/2725378876/mods/TheyKnew/mod.info'))).toMatchObject({ id: 'TheyKnew', require: [], versionMin: undefined });
    expect(parseModInfo(fixture('workshop/2544353492/mods/P4HasBeenRead/42/mod.info'))).toMatchObject({ id: 'P4HasBeenRead', modVersion: '2.14.1' });
  });

  it('refuses a file without an id', () => {
    expect(() => parseModInfo('name=Nothing\n')).toThrow(/no id/);
  });
});

describe('version folders', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('42.20.4', '42.20.1')).toBe(1);
    expect(compareVersions('42.9', '42.13')).toBe(-1);
    expect(compareVersions('42', '42.0.0')).toBe(0);
  });

  it('picks the newest folder the game can load', () => {
    expect(selectVersionFolder(folders('2503622437/mods/Skill Recovery Journal'), '42.20.4')).toBe('42.20.1');
    expect(selectVersionFolder(folders('2503622437/mods/Skill Recovery Journal'), '42.19.2')).toBe('42.19');
    expect(selectVersionFolder(folders('2544353492/mods/P4HasBeenRead'), '42.20.4')).toBe('42.15');
    expect(selectVersionFolder(folders('2946364542/mods/Search Containers'), '42.20.4')).toBe('42.0');
    expect(selectVersionFolder(folders('2725378876/mods/TheyKnew'), '42.20.4')).toBeNull();
  });

  it('flags mods that will not load on this build', () => {
    expect(checkCompat(folders('2725378876/mods/TheyKnew'), '42.20.4')).toEqual({ folder: null, compatible: false, reason: 'no-b42-folder' });
    expect(checkCompat(['42.21'], '42.20.4')).toMatchObject({ compatible: false, reason: 'needs-newer-game' });
    expect(checkCompat(['42.19', '42.20.1', 'common'], '42.20.1', { versionMin: '42.20.2' })).toMatchObject({ compatible: false, reason: 'needs-newer-game' });
    expect(checkCompat(['42.19', '42.20.1', 'common'], '42.20.4', { versionMin: '42.20.2' })).toEqual({ folder: '42.20.1', compatible: true });
  });
});

describe('ini mod lines', () => {
  it('writes B42 Mods= with a backslash per id and reads both styles', () => {
    expect(formatModsLine(['SkillRecoveryJournal', '\\TheyKnew'])).toBe('\\SkillRecoveryJournal;\\TheyKnew');
    expect(parseModsLine('\\A;\\B')).toEqual(['A', 'B']);
    expect(parseModsLine('SearchContainers;TheyKnew;P4HasBeenRead;SkillRecoveryJournal')).toHaveLength(4);
    expect(parseModsLine('')).toEqual([]);
  });

  it('keeps WorkshopItems numeric', () => {
    expect(parseWorkshopItems('2946364542;2725378876;;junk')).toEqual(['2946364542', '2725378876']);
    expect(() => formatWorkshopItems(['12;34'])).toThrow();
  });

  it('accepts workshop ids and steamcommunity URLs only', () => {
    expect(parseWorkshopRef('2503622437')).toBe('2503622437');
    expect(parseWorkshopRef('https://steamcommunity.com/sharedfiles/filedetails/?id=2503622437')).toBe('2503622437');
    expect(parseWorkshopRef('https://evil.example/?id=2503622437')).toBeNull();
    expect(parseWorkshopRef('not a mod')).toBeNull();
  });
});
