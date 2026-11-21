import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import type { CompiledVoice, Glide, Moment, Piece } from '../../../src/core/types';
import {
  dragDt,
  endDragPatch,
  estimateSpan,
  gridStep,
  laneItems,
  levelCurve,
  momentText,
  nudgeDt,
  itemBoxPx,
  stackRows,
  revealPan,
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

  it('an opening from silence is a point: its label alone, no sub-row taken from later moments', () => {
    const base = newPiece({ seed: 1, poolSize: 4 });
    const piece: Piece = {
      ...base,
      defaults: { glide: { ...G, length: 4, stagger: 0.5 } },
      moments: [...base.moments, chord('b', 3)],
    };
    const opening = piece.moments[0];
    expect([opening.type, opening.at]).toEqual(['chord', 0]);
    const score = compile(piece);
    const items = laneItems(piece, score.momentSpans, undefined, score.harmony, score.voices);
    expect([items[0].start, items[0].end]).toEqual([0, 0]);
    expect(items[1].end).toBeGreaterThan(3);
    // At 40 px/s the opening's label ends near 2 s; its estimated glide (4.5 s) would not.
    const pps = 40;
    expect(itemBoxPx(items[0], pps)[1]).toBeLessThan(3 * pps);
    expect(stackRows(items, pps)).toEqual({ rows: [0, 0], count: 1 });
    // Without the compiled lines (or muted) it falls back to the glide estimate, as before.
    const noLines = laneItems(piece, score.momentSpans, undefined, score.harmony);
    expect(noLines[0].end).toBe(4.5);
    expect(stackRows(noLines, pps).count).toBe(2);
    // Labels that really overlap still stack.
    expect(stackRows(items, 10).count).toBe(2);
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

describe('stackRows (revision 7)', () => {
  const item = (id: string, at: number, end = at, text = 'chord'): LaneItem => ({
    id,
    type: 'chord',
    text,
    at,
    start: at,
    end,
    muted: false,
    endEdit: 'glide',
  });

  it('puts overlapping items on new sub-rows, without a cap, and reuses freed ones', () => {
    // At 10 px/s a 5-letter label needs ~53 px, i.e. 5.3 s.
    const items = [item('a', 0), item('b', 1), item('c', 2), item('d', 20), item('e', 2.5)];
    expect(stackRows(items, 10)).toEqual({ rows: [0, 1, 2, 0, 3], count: 4 });
  });

  it('stacks overlapping spans even when the labels are short', () => {
    const items = [item('a', 0, 100, 'x'), item('b', 30, 31, 'y'), item('c', 200, 201, 'z')];
    expect(stackRows(items, 10)).toEqual({ rows: [0, 1, 0], count: 2 });
  });

  it('stacks moments at the same time in input order (stable)', () => {
    const items = [item('a', 5), item('b', 5), item('c', 5)];
    expect(stackRows(items, 10).rows).toEqual([0, 1, 2]);
    expect(stackRows([...items].reverse(), 10).rows).toEqual([0, 1, 2]);
  });

  it('is one sub-row when nothing overlaps; zero items use none', () => {
    const items = [item('a', 0, 4), item('b', 10, 14), item('c', 20, 24)];
    expect(stackRows(items, 10)).toEqual({ rows: [0, 0, 0], count: 1 });
    expect(stackRows([], 10)).toEqual({ rows: [], count: 0 });
  });

  it('no two items on one sub-row overlap', () => {
    const items = Array.from({ length: 40 }, (_, i) =>
      item(`m${i}`, (i * 7919) % 97, ((i * 7919) % 97) + (i % 5) * 3),
    );
    const pps = 12;
    const { rows } = stackRows(items, pps);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (rows[i] !== rows[j]) continue;
        const [a0, a1] = itemBoxPx(items[i], pps);
        const [b0, b1] = itemBoxPx(items[j], pps);
        expect(a1 <= b0 || b1 <= a0).toBe(true);
      }
    }
  });
});

describe('names and the level curve', () => {
  it('momentText: label, chord name, level %, key name, type', () => {
    expect(momentText(chord('a', 0), 'Am7')).toBe('Am7');
    expect(momentText(chord('a', 0, { label: 'lift' }), 'Am7')).toBe('lift');
    expect(momentText(chord('a', 0))).toBe('chord');
    expect(momentText({ id: 'l', type: 'level', at: 0, gain: 0.554, over: 1 } as Moment)).toBe(
      'level 55%',
    );
    expect(
      momentText({
        id: 'k',
        type: 'key',
        at: 0,
        key: { tonic: 'A', scale: 'dorian' },
      } as unknown as Moment),
    ).toBe('A dorian');
    expect(momentText({ id: 'u', type: 'unison', at: 0 } as unknown as Moment)).toBe('unison');
  });

  const voice = (lives: [number, number?][], level: CompiledVoice['level']): CompiledVoice =>
    ({ lives: lives.map(([born, died]) => ({ born, died, fadeIn: 0 })), level }) as CompiledVoice;

  it('levelCurve: mean over live voices, ramps linear, steps doubled', () => {
    const curve = levelCurve({
      duration: 10,
      voices: [
        voice([[0]], [{ t: 2, gain: 0.5, over: 2 }]),
        voice([[0, 6]], []),
        voice([], [{ t: 0, gain: 0, over: 0 }]), // never sounds: ignored
      ],
    });
    const at = (t: number): number => {
      const i = curve.findIndex((p) => p.t > t);
      const [a, b] = [curve[i - 1], curve[i]];
      return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
    };
    expect(curve[0]).toEqual({ t: 0, v: 1 });
    expect(at(3)).toBeCloseTo((0.75 + 1) / 2, 9);
    expect(at(5)).toBeCloseTo(0.75, 9);
    // Voice 2 dies at 6: the mean steps to voice 1's 0.5.
    expect(curve.filter((p) => p.t === 6).map((p) => p.v)).toEqual([0.75, 0.5]);
    expect(curve.at(-1)).toEqual({ t: 10, v: 0.5 });
  });

  it('levelCurve: a ramp interrupted by the next change starts the next from where it got to', () => {
    const curve = levelCurve({
      duration: 4,
      voices: [
        voice(
          [[0]],
          [
            { t: 0, gain: 0, over: 2 },
            { t: 1, gain: 1, over: 0 },
          ],
        ),
      ],
    });
    expect(curve.find((p) => p.t === 1 && p.v !== 1)?.v).toBeCloseTo(0.5, 9);
    expect(curve.at(-1)?.v).toBe(1);
  });
});

describe('revealPan', () => {
  it('pans just enough to bring a point inside the margins', () => {
    expect(revealPan(300, 1000, 100, 48)).toBe(0);
    expect(revealPan(-152, 1000, 100, 48)).toBeCloseTo(-2);
    expect(revealPan(1152, 1000, 100, 48)).toBeCloseTo(2);
    expect(revealPan(48, 1000, 100, 48)).toBe(0);
  });

  it('caps the margin at half the width and is 0 without geometry', () => {
    expect(revealPan(-10, 40, 10, 48)).toBeCloseTo(-3);
    expect(revealPan(-10, 0, 10, 48)).toBe(0);
    expect(revealPan(-10, 1000, 0, 48)).toBe(0);
  });
});
