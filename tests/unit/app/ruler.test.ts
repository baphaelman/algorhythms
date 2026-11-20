import { describe, expect, it } from 'vitest';
import { beatPx, rulerLabel, rulerStep, tickTimes } from '../../../src/app/ruler';

describe('ruler', () => {
  it('picks the smallest step at least 64 px apart', () => {
    expect(rulerStep(1000)).toBe(0.1);
    expect(rulerStep(100)).toBe(1);
    expect(rulerStep(20)).toBe(5);
    expect(rulerStep(5)).toBe(15);
    expect(rulerStep(0.001)).toBe(1200);
  });

  it('lists ticks inside the window', () => {
    expect(tickTimes(3.2, 10, 5)).toEqual([5, 10]);
    expect(tickTimes(0, 10, 5)).toEqual([0, 5, 10]);
    expect(tickTimes(0.25, 0.5, 0.1)).toEqual([0.3, 0.4, 0.5, 0.6, 0.7]);
  });

  it('labels as m:ss, with tenths under a second', () => {
    expect(rulerLabel(0, 5)).toBe('0:00');
    expect(rulerLabel(65, 5)).toBe('1:05');
    expect(rulerLabel(125.3, 0.1)).toBe('2:05.3');
  });

  it('beat spacing only with a grid and when wide enough', () => {
    expect(beatPx(undefined, 100)).toBeNull();
    expect(beatPx(120, 100)).toBe(50);
    expect(beatPx(120, 4)).toBeNull();
  });
});
