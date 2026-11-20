import { describe, expect, it } from 'vitest';
import { newPiece } from '../../../src/core/defaults';
import type { Glide, Moment, Piece } from '../../../src/core/types';
import {
  dragDt,
  endDragPatch,
  estimateSpan,
  gridStep,
  laneItems,
  nudgeDt,
  packRows,
  snapTime,
  type LaneItem,
} from '../../../src/app/editor/lane';

const G: Glide = { length: 2, jitter: 0, stagger: 0.5, order: 'random', ease: 'smoothstep' };

const chord = (id: string, at: number, extra: Partial<Moment> = {}): Moment =>
  ({
    id,
    type: 'chord',
    at,
    notes: { kind: 'degrees', degrees: [0, 2, 4] },
    voicing: 'even',
    assign: 'ordered',
    ...extra,
  }) as Moment;

describe('grid and snapping', () => {
  it('gridStep: 60/bpm, null without a grid', () => {
    expect(gridStep(120)).toBe(0.5);
    expect(gridStep(undefined)).toBeNull();
    expect(gridStep(0)).toBeNull();
  });

  it('snapTime rounds to the nearest line, never below 0', () => {
    expect(snapTime(1.26, 0.5)).toBe(1.5);
    expect(snapTime(1.24, 0.5)).toBe(1);
    expect(snapTime(-0.4, 0.5)).toBe(0);
    expect(snapTime(1.234, null)).toBe(1.234);
  });

  it('dragDt lands the moment on the grid unless snapping is off', () => {
    expect(dragDt(1.1, 0.3, 0.5, true)).toBeCloseTo(0.4, 9); // → 1.5
    expect(dragDt(1.1, 0.3, 0.5, false)).toBeCloseTo(0.3, 9);
    expect(dragDt(1.1, 0.3, null, true)).toBeCloseTo(0.3, 9);
    expect(dragDt(1, -5, 0.5, true)).toBe(-1);
  });

  it('nudgeDt steps to the next grid line, or 0.1 s without a grid', () => {
    expect(nudgeDt(1, 1, 0.5)).toBe(0.5);
    expect(nudgeDt(1, -1, 0.5)).toBe(-0.5);
    expect(nudgeDt(1.2, 1, 0.5)).toBeCloseTo(0.3, 9); // off-grid → next line
    expect(nudgeDt(1.2, -1, 0.5)).toBeCloseTo(-0.2, 9);
    expect(nudgeDt(1.2, 1, null)).toBeCloseTo(0.1, 9);
    expect(nudgeDt(0.05, -1, null)).toBe(-0.05);
    expect(nudgeDt(0, -1, 0.5)).toBe(0);
  });
});

describe('spans and end drags', () => {
  it('estimateSpan: glide stagger + length; walk until; level over; key a point', () => {
    expect(estimateSpan(chord('a', 3), G)).toEqual([3, 5.5]);
    expect(estimateSpan(chord('a', 3, { glide: { length: 1, stagger: 0 } }), G)).toEqual([3, 4]);
    const walk = {
      id: 'w',
      type: 'walk',
      at: 2,
      until: 10,
      grid: 1,
      density: 0.5,
      steps: [1],
      stepGlide: 0.3,
    } as Moment;
    expect(estimateSpan(walk, G)).toEqual([2, 10]);
    expect(
      estimateSpan({ id: 'l', type: 'level', at: 1, gain: 0.5, over: 2 } as Moment, G),
    ).toEqual([1, 3]);
    expect(
      estimateSpan(
        { id: 'k', type: 'key', at: 4, key: { tonic: 0, scale: 'major' } } as unknown as Moment,
        G,
      ),
    ).toEqual([4, 4]);
  });

  it('laneItems uses compiled spans unless stale or muted, and labels', () => {
    const piece: Piece = {
      ...newPiece({ seed: 1, poolSize: 4 }),
      defaults: { glide: G },
      moments: [chord('a', 1), chord('b', 4, { label: 'lift', muted: true })],
    };
    const spans = [
      { id: 'a', start: 1.2, end: 3.9 },
      { id: 'b', start: 4, end: 9 },
    ];
    const items = laneItems(piece, spans);
    expect(items.map((i) => [i.id, i.text, i.start, i.end, i.muted])).toEqual([
      ['a', 'chord', 1, 3.9, false],
      ['b', 'lift', 4, 6.5, true],
    ]);
    // 'a' moved since the score was compiled: estimate instead.
    const stale = laneItems(piece, spans, new Map([['a', 0.5]]));
    expect([stale[0].start, stale[0].end]).toEqual([1, 3.5]);
    // An empty compiled span (nothing moved): the intended glide.
    const empty = laneItems(piece, [{ id: 'a', start: 1, end: 1 }]);
    expect([empty[0].start, empty[0].end]).toEqual([1, 3.5]);
  });

  it('endDragPatch edits glide length, stagger (shift), until, over', () => {
    expect(endDragPatch(chord('a', 0, { glide: { ease: 'linear' } }), G, 1, false)).toEqual({
      glide: { ease: 'linear', length: 3 },
    });
    expect(endDragPatch(chord('a', 0), G, -1, true)).toEqual({ glide: { stagger: 0 } });
    expect(endDragPatch(chord('a', 0), G, -5, false)).toEqual({ glide: { length: 0 } });
    expect(endDragPatch(chord('a', 0), G, 0, false)).toBeNull();
    const walk = {
      id: 'w',
      type: 'walk',
      at: 2,
      until: 10,
      grid: 1,
      density: 0.5,
      steps: [1],
      stepGlide: 0.3,
    } as Moment;
    expect(endDragPatch(walk, G, 2, false)).toEqual({ until: 12 });
    expect(endDragPatch(walk, G, -20, false)).toEqual({ until: 3 });
    const level = { id: 'l', type: 'level', at: 1, gain: 0.5, over: 2 } as Moment;
    expect(endDragPatch(level, G, -3, false)).toEqual({ over: 0 });
    const key = {
      id: 'k',
      type: 'key',
      at: 4,
      key: { tonic: 0, scale: 'major' },
    } as unknown as Moment;
    expect(endDragPatch(key, G, 1, false)).toBeNull();
  });
});

describe('packRows', () => {
  const item = (id: string, at: number, end = at): LaneItem => ({
    id,
    type: 'chord',
    text: 'chord',
    at,
    start: at,
    end,
    muted: false,
    endEdit: 'glide',
  });

  it('puts overlapping items on separate rows and reuses freed rows', () => {
    // At 10 px/s a 5-letter label needs ~53 px, i.e. 5.3 s.
    const items = [item('a', 0), item('b', 1), item('c', 2), item('d', 20), item('e', 2.5)];
    expect(packRows(items, 10, 3)).toEqual([0, 1, 2, 0, 0]);
  });

  it('long bars reserve their row', () => {
    const items = [item('a', 0, 100), item('b', 30)];
    expect(packRows(items, 10, 3)).toEqual([0, 1]);
    expect(packRows(items, 10, 1)).toEqual([0, 0]);
  });
});
