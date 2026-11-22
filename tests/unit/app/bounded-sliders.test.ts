import { describe, expect, it } from 'vitest';
import {
  mergeCountBounds,
  sliderPlan,
  soundingBefore,
  splitCountBounds,
} from '../../../src/app/ui/inspector/fields';
import type { CompiledScore } from '../../../src/core/types';

describe('sliderPlan (bounded number fields)', () => {
  it('gives an unbounded field the box only', () => {
    expect(sliderPlan({ min: 0, max: Infinity, step: 0.1, integer: false })).toBeNull();
    expect(sliderPlan({ min: -Infinity, max: 5, step: 1, integer: true })).toBeNull();
  });

  it('honours an explicit slider range and `false`', () => {
    const p = sliderPlan({
      min: 0,
      max: 120,
      step: 0.1,
      integer: false,
      slider: { min: 0, max: 20 },
    });
    expect(p).toEqual({ min: 0, max: 20, step: 0.1, ticks: [], box: true });
    expect(sliderPlan({ min: 0, max: 1, step: 0.01, integer: false, slider: false })).toBeNull();
  });

  it('slides a small integer count without a text box, with ticks up to 16 values', () => {
    const p = sliderPlan({ min: 2, max: 8, step: 1, integer: true });
    expect(p).toEqual({ min: 2, max: 8, step: 1, ticks: [2, 3, 4, 5, 6, 7, 8], box: false });
    const big = sliderPlan({ min: 1, max: 32, step: 1, integer: true });
    expect(big?.box).toBe(false);
    expect(big?.ticks).toEqual([]);
  });

  it('keeps the box for wide integer ranges, and drops the slider for pitches', () => {
    expect(sliderPlan({ min: 0, max: 100, step: 1, integer: true })?.box).toBe(true);
    expect(sliderPlan({ min: 0, max: 127, step: 1, integer: true })).toBeNull();
  });

  it('keeps the box when the slider covers only part of the typed range', () => {
    const p = sliderPlan({ min: 0, max: 48, step: 1, integer: true, slider: { min: 0, max: 24 } });
    expect(p?.box).toBe(true);
  });

  it('slides a bounded continuous value with its box, up to 1000 steps', () => {
    expect(sliderPlan({ min: 0, max: 8, step: 0.05, integer: false })).toMatchObject({
      min: 0,
      max: 8,
      step: 0.05,
      box: true,
    });
    expect(sliderPlan({ min: 0, max: 1000, step: 0.1, integer: false })).toBeNull();
  });

  it('shows a fixed single-value count (a pool of one) without a box', () => {
    expect(sliderPlan({ min: 1, max: 1, step: 1, integer: true })).toMatchObject({ box: false });
  });
});

describe('count bounds', () => {
  it('split: from the lines sounding before it to the pool (births ≤ pool − sounding)', () => {
    expect(splitCountBounds(3, 8, 5)).toEqual({ min: 3, max: 8 });
    expect(splitCountBounds(0, 8, 4)).toEqual({ min: 1, max: 8 });
    // A full pool: nothing to slide.
    expect(splitCountBounds(8, 8, 8)).toEqual({ min: 8, max: 8 });
    // A stored count outside the live range widens it.
    expect(splitCountBounds(5, 8, 2)).toEqual({ min: 2, max: 8 });
    expect(splitCountBounds(2, 4, 6)).toEqual({ min: 2, max: 6 });
  });

  it('merge: 1 to the lines sounding before it', () => {
    expect(mergeCountBounds(6, 2)).toEqual({ min: 1, max: 6 });
    expect(mergeCountBounds(0, 1)).toEqual({ min: 1, max: 1 });
    expect(mergeCountBounds(3, 5)).toEqual({ min: 1, max: 5 });
  });

  it('counts the lines sounding just before a time, not those born at it', () => {
    const v = (index: number, born: number, died?: number) => ({
      index,
      lives: [{ born, died, fadeIn: 0 }],
    });
    const score = {
      voices: [v(0, 0), v(1, 0, 4), v(2, 5), v(3, 2, 5)],
    } as unknown as CompiledScore;
    expect(soundingBefore(score, 5)).toBe(2);
    expect(soundingBefore(score, 0)).toBe(0);
    expect(soundingBefore(score, 3)).toBe(3);
  });
});
