// Settings forms lay out what the adapter declares (CFG-01, CFG-10): its
// groups in order, "advanced" groups and options behind Advanced, and
// ungrouped options last. No game's keys or group ids in the web.
import { describe, expect, it } from 'vitest';
import type { OptionMeta } from '@gsp/formats';
import type { OptionGroup } from '../src/api/meta';
import { placement, sections, UNGROUPED, withUnknown } from '../src/pages/config/layout';

const opt = (key: string, over: Partial<OptionMeta> = {}): OptionMeta => ({ key, type: 'string', description: {}, ...over });
const GROUPS: OptionGroup[] = [
  { id: 'basics', label: { en: 'Basics', es: 'Básico' } },
  { id: 'world', label: { en: 'World', es: 'Mundo' } },
  { id: 'tuning', label: { en: 'Tuning', es: 'Ajuste fino' }, advanced: true },
];

describe('settings form layout', () => {
  it('places an option in its group, behind Advanced when the group or the option is rare', () => {
    expect(placement(opt('a', { group: 'basics' }), GROUPS)).toEqual({ group: 'basics', advanced: false });
    expect(placement(opt('b', { group: 'tuning' }), GROUPS)).toEqual({ group: 'tuning', advanced: true });
    expect(placement(opt('c', { group: 'world', advanced: true }), GROUPS)).toEqual({ group: 'world', advanced: true });
    // A group the adapter didn't declare, or none: ungrouped.
    expect(placement(opt('d', { group: 'nope' }), GROUPS)).toEqual({ group: UNGROUPED, advanced: false });
    expect(placement(opt('e'), [])).toEqual({ group: UNGROUPED, advanced: false });
  });

  it('lists the sections in the adapter’s order, ungrouped last, only those with options', () => {
    const metas = [opt('z'), opt('w1', { group: 'world' }), opt('b1', { group: 'basics' }), opt('t1', { group: 'tuning' }), opt('w2', { group: 'world', advanced: true })];
    expect(sections(metas, GROUPS)).toEqual({ common: ['basics', 'world', UNGROUPED], advanced: ['world', 'tuning'] });
    expect(sections([opt('a'), opt('b')], [])).toEqual({ common: [UNGROUPED], advanced: [] });
  });

  it('keeps settings the schema does not know, typed from their value, behind Advanced', () => {
    const all = withUnknown([opt('Known', { group: 'basics' }), opt('Absent')], { Known: 'x', Extra: 3, Flag: true });
    expect(all.map((m) => m.key)).toEqual(['Known', 'Extra', 'Flag']);
    expect(all[1]).toMatchObject({ type: 'decimal', advanced: true });
    expect(all[2]).toMatchObject({ type: 'boolean', advanced: true });
    expect(placement(all[1]!, GROUPS)).toEqual({ group: UNGROUPED, advanced: true });
  });
});
