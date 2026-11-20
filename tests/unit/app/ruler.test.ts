import { describe, expect, it } from 'vitest';
import {
  LOOP_MIN,
  beatPx,
  clampLoop,
  dragLoopEdge,
  loopEdgeAt,
  loopFromDrag,
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

  it('beat spacing only with a grid and when wide enough', () => {
    expect(beatPx(undefined, 100)).toBeNull();
    expect(beatPx(120, 100)).toBe(50);
    expect(beatPx(120, 4)).toBeNull();
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
});
