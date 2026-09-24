import { describe, expect, it } from 'vitest';
import { parseIni } from '../src/ini';
import { parseLuaData } from '../src/lua-data';
import { checkOptionValue, iniOptions, mergeLanguages, sandboxOptions } from '../src/option-meta';
import { fixture } from './fixtures';

const iniMeta = mergeLanguages({
  en: iniOptions(parseIni(fixture('config/server.en.ini'))),
  es: iniOptions(parseIni(fixture('config/server.es.ini'))),
});
const sandboxMeta = mergeLanguages({
  en: sandboxOptions(parseLuaData(fixture('config/SandboxVars.en.lua')).table),
  es: sandboxOptions(parseLuaData(fixture('config/SandboxVars.es.lua')).table),
});
const byKey = (list: typeof iniMeta, key: string) => list.find((m) => m.key === key)!;

describe('ini option metadata', () => {
  it('merges English and Spanish descriptions by key', () => {
    expect(byKey(iniMeta, 'PVP')).toEqual({
      key: 'PVP',
      type: 'boolean',
      description: { en: 'Players can hurt and kill other players', es: 'Los jugadores pueden herir y matar a otros jugadores.' },
    });
  });

  it('reads ranges and defaults', () => {
    expect(byKey(iniMeta, 'SafetyToggleTimer')).toMatchObject({ type: 'integer', min: 0, max: 1000, default: '2' });
    expect(byKey(iniMeta, 'DefaultPort')).toMatchObject({ min: 0, max: 65535, default: '16261' });
    expect(byKey(iniMeta, 'VoiceMinDistance').type).toBe('decimal');
    expect(byKey(iniMeta, 'Map').type).toBe('string');
  });
});

describe('sandbox option metadata', () => {
  it('turns numbered comment lists into bilingual enums with a resolved default', () => {
    const zombies = byKey(sandboxMeta, 'Zombies');
    expect(zombies.type).toBe('enum');
    expect(zombies.default).toBe('4');
    expect(zombies.options![0]).toEqual({ value: 1, label: { en: 'Insane', es: 'Zombicidio' } });
    expect(zombies.options).toHaveLength(6);
  });

  it('covers nested options', () => {
    const speed = byKey(sandboxMeta, 'ZombieLore.Speed');
    expect(speed.type).toBe('enum');
    expect(speed.options!.map((o) => o.label.en)).toContain('Sprinters');
    expect(byKey(sandboxMeta, 'Map.AllowMiniMap').type).toBe('boolean');
  });

  it('keeps decimal ranges', () => {
    const glass = byKey(sandboxMeta, 'MultiplierConfig.Glassmaking');
    expect(glass).toMatchObject({ type: 'decimal', min: 0, max: 1000 });
  });
});

describe('checkOptionValue', () => {
  it('validates against type, range and choices', () => {
    const timer = byKey(iniMeta, 'SafetyToggleTimer');
    expect(checkOptionValue(timer, '5')).toBeNull();
    expect(checkOptionValue(timer, '5000')).toMatch(/at most 1000/);
    expect(checkOptionValue(timer, '1.5')).toMatch(/whole number/);
    expect(checkOptionValue(byKey(iniMeta, 'PVP'), 'yes')).toMatch(/true or false/);
    expect(checkOptionValue(byKey(sandboxMeta, 'Zombies'), '9')).toMatch(/allowed choices/);
    expect(checkOptionValue(byKey(iniMeta, 'PublicName'), 'a\nb')).toMatch(/single line/);
  });
});
