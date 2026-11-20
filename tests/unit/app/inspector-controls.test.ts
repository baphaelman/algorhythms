import { describe, expect, it } from 'vitest';
import {
  STEP_CHOICES,
  rankCount,
  rankSelector,
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
  it('reads the mode of a selector', () => {
    expect(targetMode(undefined, 8)).toBe('all');
    expect(targetMode('all', 8)).toBe('all');
    expect(targetMode({ voices: ['a'] }, 8)).toBe('pick');
    expect(targetMode({ rank: [0, 1] }, 8)).toBe('bottom');
    expect(targetMode({ rank: [4, 7] }, 8)).toBe('top');
    expect(targetMode({ rank: [2, 3] }, 8)).toBe('range');
  });

  it('builds top and bottom n rank selectors that read back', () => {
    const bottom = rankSelector('bottom', 2, 6, 8);
    expect(bottom).toEqual({ rank: [0, 1] });
    expect(rankCount(bottom.rank, 'bottom', 6)).toBe(2);
    const top = rankSelector('top', 3, 6, 8);
    expect(top).toEqual({ rank: [3, 7] });
    expect(targetMode(top, 8)).toBe('top');
    expect(rankCount(top.rank, 'top', 6)).toBe(3);
    // n is rounded and at least 1; a top n beyond the active count starts at rank 0.
    expect(rankSelector('bottom', 0, 6, 8)).toEqual({ rank: [0, 0] });
    expect(rankSelector('top', 9, 6, 8)).toEqual({ rank: [0, 7] });
  });
});
