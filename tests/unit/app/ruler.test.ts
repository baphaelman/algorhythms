import { describe, expect, it } from 'vitest';
import { barGrid } from '../../../src/render';
import {
  LOOP_MIN,
  clampLoop,
  dragLoopEdge,
  loopEdgeAt,
  loopFromDrag,
  loopTime,
  rulerLabel,
  rulerStep,
  tickTimes,
} from '../../../src/app/ruler';

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

  it('bar grid: defaults 60 bpm 4/4, beats hidden when dense, bars thinned by powers of 2', () => {
    expect(barGrid(undefined, undefined, 100)).toEqual({ beat: 1, bar: 4 });
    expect(barGrid(120, 3, 100)).toEqual({ beat: 0.5, bar: 1.5 });
    expect(barGrid(120, 4, 10).beat).toBe(0); // 5 px beats
    expect(barGrid(120, 4, 10).bar).toBe(4); // 20 px bars → every 2nd
    expect(barGrid(60, 4, 1).bar).toBe(32);
    expect(barGrid(-5, 0.5, 100)).toEqual({ beat: 1, bar: 4 });
    // every: no thinning at any zoom; the default is unchanged.
    expect(barGrid(120, 4, 10, true)).toEqual({ beat: 0.5, bar: 2 });
    expect(barGrid(60, 4, 1, true)).toEqual({ beat: 1, bar: 4 });
    expect(barGrid(60, 1, 1, true)).toEqual({ beat: 0, bar: 1 });
    expect(barGrid(120, 4, 10, false)).toEqual(barGrid(120, 4, 10));
  });
});

describe('loop region math', () => {
  it('a drag spans its two ends in either direction, clamped to the piece', () => {
    expect(loopFromDrag(3, 7, 60)).toEqual({ start: 3, end: 7 });
    expect(loopFromDrag(7, 3, 60)).toEqual({ start: 3, end: 7 });
    expect(loopFromDrag(-2, 5, 60)).toEqual({ start: 0, end: 5 });
    expect(loopFromDrag(50, 80, 60)).toEqual({ start: 50, end: 60 });
  });

  it('a drag shorter than the minimum is no region', () => {
    expect(loopFromDrag(3, 3 + LOOP_MIN / 2, 60)).toBeNull();
    expect(loopFromDrag(3, 3 + LOOP_MIN, 60)).toEqual({ start: 3, end: 3 + LOOP_MIN });
    expect(loopFromDrag(70, 80, 60)).toBeNull();
  });

  it('dragging an edge keeps the minimum length and the piece bounds', () => {
    const r = { start: 10, end: 20 };
    expect(dragLoopEdge(r, 'start', 12, 60)).toEqual({ start: 12, end: 20 });
    expect(dragLoopEdge(r, 'start', 25, 60)).toEqual({ start: 20 - LOOP_MIN, end: 20 });
    expect(dragLoopEdge(r, 'start', -5, 60)).toEqual({ start: 0, end: 20 });
    expect(dragLoopEdge(r, 'end', 30, 60)).toEqual({ start: 10, end: 30 });
    expect(dragLoopEdge(r, 'end', 2, 60)).toEqual({ start: 10, end: 10 + LOOP_MIN });
    expect(dragLoopEdge(r, 'end', 99, 60)).toEqual({ start: 10, end: 60 });
  });

  it('clamps a stored region to the piece; drops one that no longer fits', () => {
    expect(clampLoop({ start: 10, end: 20 }, 60)).toEqual({ start: 10, end: 20 });
    expect(clampLoop({ start: 50, end: 80 }, 60)).toEqual({ start: 50, end: 60 });
    expect(clampLoop({ start: 70, end: 80 }, 60)).toBeNull();
    expect(clampLoop({ start: 20, end: 10 }, 60)).toBeNull();
    expect(clampLoop({ start: NaN, end: 10 }, 60)).toBeNull();
    expect(clampLoop(undefined, 60)).toBeNull();
  });

  it('finds the edge under the pointer within the tolerance', () => {
    const r = { start: 10, end: 20 };
    // 10 px per second, 6 px tolerance.
    expect(loopEdgeAt(r, 10.5, 10, 6)).toBe('start');
    expect(loopEdgeAt(r, 19.6, 10, 6)).toBe('end');
    expect(loopEdgeAt(r, 15, 10, 6)).toBeNull();
    expect(loopEdgeAt(r, 9, 10, 6)).toBeNull();
    expect(loopEdgeAt(null, 10, 10, 6)).toBeNull();
    // Edges closer than the tolerance: the nearer one wins.
    expect(loopEdgeAt({ start: 10, end: 10.5 }, 10.4, 10, 6)).toBe('end');
  });

  it('rounds loop drag times: to the grid with one, else (or with Alt) to the millisecond', () => {
    expect(loopTime(1.9999999, undefined, false)).toBe(2);
    expect(loopTime(3.14159, undefined, false)).toBe(3.142);
    expect(loopTime(-1, undefined, false)).toBe(0);
    // 90 bpm: beats of 2/3 s, kept to 1 µs.
    expect(loopTime(1.9, 90, false)).toBe(2);
    expect(loopTime(1.5, 90, false)).toBe(1.333333);
    // Alt: free placement, still to the millisecond.
    expect(loopTime(1.9004321, 90, true)).toBe(1.9);
    expect(loopTime(1.9999999, 120, true)).toBe(2);
  });
});
