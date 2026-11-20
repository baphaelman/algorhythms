import { describe, expect, it } from 'vitest';
import {
  STEP_CHOICES,
  arriveGlide,
  stepChips,
  targetMode,
  toggleStep,
} from '../../../src/app/ui/inspector/fields';

describe('walk step chips', () => {
  it('shows −3…+3 without 0, plus any other stored step', () => {
    expect(STEP_CHOICES).toEqual([-3, -2, -1, 1, 2, 3]);
    expect(stepChips([-1, 1])).toEqual([-3, -2, -1, 1, 2, 3]);
    expect(stepChips([5, -4, 1])).toEqual([-4, -3, -2, -1, 1, 2, 3, 5]);
  });

  it('toggles a step, sorted, and never empties the list', () => {
    expect(toggleStep([-2, -1, 1, 2], 3)).toEqual([-2, -1, 1, 2, 3]);
    expect(toggleStep([-2, -1, 1, 2], -3)).toEqual([-3, -2, -1, 1, 2]);
    expect(toggleStep([-2, -1, 1, 2], -1)).toEqual([-2, 1, 2]);
    expect(toggleStep([2], 2)).toBeNull();
  });
});

describe('voice target modes', () => {
  it('reads the mode of a selector (no top/bottom n)', () => {
    expect(targetMode(undefined)).toBe('all');
    expect(targetMode('all')).toBe('all');
    expect(targetMode({ voices: ['a'] })).toBe('pick');
    expect(targetMode({ rank: [0, 1] })).toBe('rank');
    expect(targetMode({ rank: [4, 7] })).toBe('rank');
  });
});

describe('arrive together', () => {
  it('drops the field at the default and keeps other glide fields', () => {
    expect(arriveGlide(undefined, undefined, false)).toEqual({ arrive: 'spread' });
    expect(arriveGlide({ arrive: 'spread' }, undefined, true)).toBeUndefined();
    expect(arriveGlide({ arrive: 'spread', length: 2 }, 'together', true)).toEqual({ length: 2 });
    // A piece whose default is spread needs an explicit 'together'.
    expect(arriveGlide(undefined, 'spread', true)).toEqual({ arrive: 'together' });
    expect(arriveGlide({ arrive: 'together' }, 'spread', false)).toBeUndefined();
  });
});
