import { describe, expect, it, vi } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { piece as pieceOf } from '../core/compiler-fixtures';
import { newPiece } from '../../../src/core/defaults';
import { withOpening } from '../opened-piece';
import type { CompiledVoice, Glide, Moment, Piece } from '../../../src/core/types';
import {
  dragDt,
  endDragDelta,
  endDragPatch,
  endDragSpan,
  estimateSpan,
  landsAtMarker,
  gridStep,
  laneItems,
  levelCurve,
  momentText,
  nudgeDt,
  itemBoxPx,
  stackRows,
  revealPan,
  snapTime,
  SPLIT_MIN_LANE,
  SPLIT_MIN_SCORE,
  clampLanePx,
  curveAt,
  laneLayout,
  laneMaxPx,
  laneRowOf,
  levelBoxPx,
  pinBoxPx,
  revealScroll,
  splitLanePx,
  type LaneItem,
} from '../../../src/app/editor/lane';
import { loadLaneSplit, saveLaneSplit } from '../../../src/app/lane-split';
import { wheelIntent, type WheelLike } from '../../../src/app/wheel';

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
    const base = withOpening(newPiece({ seed: 1, poolSize: 4 }));
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
    land: false,
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

describe('dense lanes: rows by kind', () => {
  const it_ = (
    id: string,
    type: LaneItem['type'],
    at: number,
    end = at,
    text: string = type,
  ): LaneItem => ({
    id,
    type,
    text,
    at,
    start: at,
    end,
    muted: false,
    endEdit: 'glide',
    land: false,
  });

  it('laneRowOf: level → Level, pin → Pins, the rest → Moments/Transitions', () => {
    expect(laneRowOf('level')).toBe('level');
    expect(laneRowOf('pin')).toBe('pins');
    for (const t of ['chord', 'unison', 'split', 'merge', 'walk', 'note', 'key', 'shift'] as const)
      expect(laneRowOf(t)).toBe('main');
  });

  it('laneLayout stacks each row on its own: labels on Moments, spans on Pins, markers on Level', () => {
    const items = [
      it_('c1', 'chord', 0),
      it_('p1', 'pin', 0.5, 1.0),
      it_('l1', 'level', 0.5, 3),
      it_('c2', 'chord', 1),
      it_('p2', 'pin', 0.9, 1.2),
      it_('l2', 'level', 2, 4),
      it_('l3', 'level', 2),
      it_('p3', 'pin', 1.2, 1.5),
    ];
    const L = laneLayout(items, 10);
    expect(L.lane).toEqual(['main', 'pins', 'level', 'main', 'pins', 'level', 'level', 'pins']);
    // Chords: labels overlap (1 s = 10 px) → two sub-rows.
    expect([L.rows[0], L.rows[3]]).toEqual([0, 1]);
    // Pins: p2 overlaps p1's span; p3 starts where p1 ends → back on sub-row 0.
    expect([L.rows[1], L.rows[4], L.rows[7]]).toEqual([0, 1, 0]);
    // Level: l1's ramp (to 3 s) doesn't stack l2; l2 and l3 share a time → two sub-rows.
    expect([L.rows[2], L.rows[5], L.rows[6]]).toEqual([0, 0, 1]);
    expect(L.count).toEqual({ main: 2, pins: 2, level: 2, effects: 0 });
    expect(laneLayout([it_('c', 'chord', 0)], 10).count).toEqual({
      main: 1,
      pins: 0,
      level: 0,
      effects: 0,
    });
  });

  it('pinBoxPx is the span; levelBoxPx is the marker alone', () => {
    expect(pinBoxPx(it_('p', 'pin', 2, 3), 10)).toEqual([20, 30]);
    expect(pinBoxPx(it_('p', 'pin', 2), 10)).toEqual([20, 21]);
    const [a, b] = levelBoxPx(it_('l', 'level', 2, 9), 10);
    expect(a).toBeLessThan(20);
    expect(b).toBeGreaterThan(20);
    expect(b - a).toBeLessThan(16);
  });

  it('curveAt interpolates, takes the value after a step, and holds past the ends', () => {
    const c = [
      { t: 0, v: 1 },
      { t: 2, v: 0.5 },
      { t: 4, v: 0.5 },
      { t: 4, v: 0 },
      { t: 6, v: 0 },
    ];
    expect(curveAt(c, 1)).toBeCloseTo(0.75);
    expect(curveAt(c, 4)).toBe(0);
    expect(curveAt(c, 3)).toBe(0.5);
    expect(curveAt(c, 9)).toBe(0);
    expect(curveAt(c, -1)).toBe(1);
    expect(curveAt([], 1)).toBe(1);
  });
});

describe('dense lanes: the divider', () => {
  it('splitLanePx: null is the default cap; a share is clamped to the limits', () => {
    expect(splitLanePx(null, 341, 30, 10)).toBe(laneMaxPx(341, 30, 10));
    expect(splitLanePx(0.3, 600, 30, 10)).toBe(180);
    // The score keeps 25 %: at most 600·0.75 − 30 − 10 = 410.
    expect(splitLanePx(0.95, 600, 30, 10)).toBe(410);
    expect(clampLanePx(1e6, 600, 30, 10)).toBe(410);
    expect(600 - 30 - 10 - clampLanePx(1e6, 600, 30, 10)).toBeGreaterThanOrEqual(
      SPLIT_MIN_SCORE * 600,
    );
    // The lanes keep at least one row.
    expect(splitLanePx(0.01, 600, 30, 10)).toBe(SPLIT_MIN_LANE);
    expect(clampLanePx(-50, 600, 30, 10)).toBe(SPLIT_MIN_LANE);
    // Never taller than the content; a tiny content is its own minimum.
    expect(clampLanePx(300, 600, 30, 10, 200)).toBe(200);
    expect(clampLanePx(10, 600, 30, 10, 30)).toBe(30);
    expect(splitLanePx(Number.NaN, 341, 30, 10)).toBe(laneMaxPx(341, 30, 10));
  });

  it('the split is remembered in localStorage; a failing or bad store reads as default', () => {
    const store = new Map<string, string>();
    const ls = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    vi.stubGlobal('localStorage', ls);
    try {
      expect(loadLaneSplit()).toBeNull();
      saveLaneSplit(0.333333);
      expect(loadLaneSplit()).toBeCloseTo(0.3333, 4);
      saveLaneSplit(null);
      expect(loadLaneSplit()).toBeNull();
      store.set('algorhythms.laneSplit', 'junk');
      expect(loadLaneSplit()).toBeNull();
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
        removeItem: () => {
          throw new Error('blocked');
        },
      });
      expect(loadLaneSplit()).toBeNull();
      expect(() => saveLaneSplit(0.4)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('dense lanes: the cap and scrolling into view', () => {
  it('laneMaxPx leaves the score 55 % of the timeline after the ruler and gap', () => {
    // 341 px timeline (Kite Day at 1024×768): 45 % = 153.45, minus ruler 30 and gap 10.
    expect(laneMaxPx(341, 30, 10)).toBe(113);
    const H = 600;
    const lane = laneMaxPx(H, 30, 10);
    expect(H - 30 - 10 - lane).toBeGreaterThanOrEqual(0.55 * H);
    // Never below the floor; unmeasured falls back to it.
    expect(laneMaxPx(100, 30, 10)).toBe(60);
    expect(laneMaxPx(0, 30, 10)).toBe(60);
    expect(laneMaxPx(1000, 30, 10, 0.5, 0)).toBe(460);
  });

  it('revealScroll keeps the scroll when visible, else brings the range in with a margin', () => {
    expect(revealScroll(50, 8, 40, 100)).toBe(40);
    expect(revealScroll(20, 8, 40, 100)).toBe(16);
    expect(revealScroll(2, 8, 40, 100)).toBe(0);
    // Below: its bottom lands margin px above the view's bottom.
    expect(revealScroll(150, 8, 40, 100)).toBe(62);
    // Taller than the view: its top wins.
    expect(revealScroll(150, 200, 40, 100)).toBe(146);
  });
});

describe('wheelIntent (score and lane rows)', () => {
  const w = (o: Partial<WheelLike>): WheelLike => ({
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...o,
  });

  it('zooms with Ctrl/Cmd/Alt, pans sideways or with Shift, leaves a plain wheel alone', () => {
    expect(wheelIntent(w({ deltaY: 10, ctrlKey: true }))).toEqual({
      kind: 'zoom',
      factor: Math.exp(0.1),
    });
    expect(wheelIntent(w({ deltaY: -10, metaKey: true })).kind).toBe('zoom');
    expect(wheelIntent(w({ deltaX: 30, deltaY: 5 }))).toEqual({ kind: 'pan', px: 30 });
    expect(wheelIntent(w({ deltaY: 40, shiftKey: true }))).toEqual({ kind: 'pan', px: 40 });
    expect(wheelIntent(w({ deltaY: 3, shiftKey: true, deltaMode: 1 }))).toEqual({
      kind: 'pan',
      px: 48,
    });
    expect(wheelIntent(w({ deltaY: 40 }))).toEqual({ kind: 'none' });
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

describe('land at the marker (revision 9)', () => {
  const landG: Glide = { ...G, land: true };

  it('estimateSpan: a landing moment ends at `at`, starting at length + stagger before it', () => {
    const m = chord('a', 10);
    expect(estimateSpan(m, G)).toEqual([10, 12.5]);
    expect(estimateSpan(m, landG)).toEqual([7.5, 10]);
    // The moment's own glide overrides the default either way.
    expect(estimateSpan(chord('b', 10, { glide: { land: true } }), G)).toEqual([7.5, 10]);
    expect(estimateSpan(chord('c', 10, { glide: { land: false } }), landG)).toEqual([10, 12.5]);
  });

  it('estimateSpan clamps the lead-in at 0, as the compiler does', () => {
    const [start, end] = estimateSpan(chord('a', 1), landG);
    expect(start).toBe(0);
    expect(end).toBe(1);
  });

  it('the lane bar is the compiled span, and the estimate matches it (lead-in, clamped or not)', () => {
    for (const at of [0.8, 5, 12]) {
      const p = pieceOf({
        start: [48, 55, 60, 64],
        glide: { length: 2, jitter: 0, stagger: 0, land: true },
        moments: [
          {
            id: 'c',
            type: 'chord',
            at,
            notes: { kind: 'chord', symbol: 'Dm9' },
            voicing: 'even',
            assign: 'ordered',
          } as never,
        ],
      });
      const score = compile(p);
      const it = laneItems(p, score.momentSpans, undefined, score.harmony, score.voices).find(
        (x) => x.id === 'c',
      )!;
      const [es, ee] = estimateSpan(
        p.moments.find((m) => m.id === 'c')!,
        p.defaults.glide,
      );
      expect(it.land).toBe(true);
      expect(it.end).toBeCloseTo(at, 6);
      expect(it.start).toBeCloseTo(es, 6);
      expect(ee).toBe(at);
    }
  });

  it('walks, levels and keys never land', () => {
    const walk = { id: 'w', type: 'walk', at: 4, until: 8, grid: 1 } as unknown as Moment;
    expect(landsAtMarker(walk, landG)).toBe(false);
    expect(estimateSpan(walk, landG)).toEqual([4, 8]);
    expect(landsAtMarker(chord('a', 1), landG)).toBe(true);
    expect(landsAtMarker(chord('a', 1), G)).toBe(false);
  });

  it('laneItems: the compiled span is kept (it ends at `at`); stale and muted items estimate', () => {
    const p = pieceOf({});
    p.defaults.glide = { ...p.defaults.glide, length: 2, stagger: 0, jitter: 0, land: true };
    p.moments = [chord('a', 10), chord('b', 20, { muted: true })];
    const spans = [{ id: 'a', start: 8, end: 10 }];
    const items = laneItems(p, spans, new Map([['a', 10]]));
    expect(items[0]).toMatchObject({ at: 10, start: 8, end: 10, land: true });
    // Muted: estimated from the glide, still ending at the marker.
    expect(items[1]).toMatchObject({ at: 20, start: 18, end: 20, land: true });
    // Stale (the moment moved since the compile): the estimate lands at the new time.
    const stale = laneItems(p, spans, new Map([['a', 9]]));
    expect(stale[0]).toMatchObject({ at: 10, start: 8, end: 10 });
  });

  it('endDragSpan: a landing bar keeps its end and grows to the left', () => {
    const it = { at: 10, start: 8, end: 10, land: true };
    expect(endDragSpan(it, -1)).toEqual({ start: 7, end: 10 });
    expect(endDragSpan(it, 0.5)).toEqual({ start: 8.5, end: 10 });
    // Never longer than negative: dragging past the marker leaves an empty bar.
    expect(endDragSpan(it, 5)).toEqual({ start: 10, end: 10 });
    expect(endDragDelta(it, -1)).toBe(1);
    expect(endDragDelta(it, 0.5)).toBe(-0.5);
  });

  it('endDragSpan: a plain bar keeps its start and its end follows', () => {
    const it = { at: 10, start: 10, end: 12, land: false };
    expect(endDragSpan(it, 1)).toEqual({ start: 10, end: 13 });
    expect(endDragSpan(it, -5)).toEqual({ start: 10, end: 10 });
    expect(endDragDelta(it, 1)).toBe(1);
  });

  it('a landing end drag edits the same glide length as the preview shows', () => {
    const m = chord('a', 10, { glide: { land: true } });
    const raw = -1;
    const patch = endDragPatch(m, G, endDragDelta({ land: true }, raw), false);
    expect(patch).toEqual({ glide: { land: true, length: 3 } });
  });

  it('LaneItem.land is set from the effective glide', () => {
    const p = pieceOf({});
    p.moments = [chord('a', 4), chord('b', 8, { glide: { land: true } })];
    const items = laneItems(p, []);
    expect(items.map((i) => i.land)).toEqual([false, true]);
  });
});
