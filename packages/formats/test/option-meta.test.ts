// What settings forms check a value against (CFG-01): types, ranges and
// choices, which are numbers for some files and words for others.
import { describe, expect, it } from 'vitest';
import { checkOptionValue, type OptionMeta } from '../src/option-meta';

const numbers: Pick<OptionMeta, 'type' | 'options'> = { type: 'enum', options: [1, 2, 3].map((value) => ({ value, label: { en: String(value) } })) };
const words: Pick<OptionMeta, 'type' | 'options'> = { type: 'enum', options: ['peaceful', 'easy'].map((value) => ({ value, label: { en: value } })) };

describe('checkOptionValue (CFG-01)', () => {
  it('takes number choices as whole numbers, as before', () => {
    expect(checkOptionValue(numbers, '2')).toBeNull();
    expect(checkOptionValue(numbers, '4')).toBe('is not one of the allowed choices');
    expect(checkOptionValue(numbers, 'two')).toBe('must be a whole number');
  });

  it('takes word choices exactly as written', () => {
    expect(checkOptionValue(words, 'easy')).toBeNull();
    expect(checkOptionValue(words, 'Easy')).toBe('is not one of the allowed choices');
    expect(checkOptionValue(words, '1')).toBe('is not one of the allowed choices');
    expect(checkOptionValue(words, '')).toBe('is not one of the allowed choices');
  });

  it('checks ranges and single lines', () => {
    expect(checkOptionValue({ type: 'integer', min: 0, max: 10 }, '11')).toBe('must be at most 10');
    expect(checkOptionValue({ type: 'boolean' }, 'yes')).toBe('must be true or false');
    expect(checkOptionValue({ type: 'string' }, 'a\nb')).toBe('must be a single line');
  });
});
