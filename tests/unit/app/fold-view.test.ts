/** The Upside down and Wider/Closer inspector's view (PLAN.md M13; app/editor/fold-view.ts). */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { defaultGlide } from '../../../src/core/defaults';
import type { Moment, Piece, SpreadMoment } from '../../../src/core/types';
import {
  ONE_POINT,
  axisOf,
  crossPatch,
  crossesAtOnePoint,
  crossingOf,
  foldView,
  spreadLanding,
} from '../../../src/app/editor/fold-view';
import { relativeShapeOf, setRelative } from '../../../src/app/editor/rows';
import { piece as base } from '../core/compiler-fixtures';

const fold = (extra: Partial<SpreadMoment> = {}): SpreadMoment => ({
  id: 'fold01',
  type: 'spread',
  at: 4,
  factor: -1,
  around: 'mean',
  snap: 'scale',
  glide: { length: 4 },
  ...extra,
});

/** Am7 (E4 G4 A4 C5) in C major, then `m`. */
function piece(m: Moment): Piece {
  const p = base({ pool: 4, start: [64, 67, 69, 72], key: { tonic: 'C', scale: 'major' } });
  p.end = { at: 30, fade: 2 };
  p.defaults.glide = { ...p.defaults.glide, stagger: 0.6, jitter: 0.2 };
  p.moments = [...p.moments, m];
  return p;
}

describe('where a fold lands', () => {
  it('offers the middle, the axis that keeps C major and the one a whole step up', () => {
    const m = fold();
    const p = piece(m);
    const v = foldView(p, compile(p), m)!;
    expect(v.dests).toEqual([64, 67, 69, 72]);
    expect(v.current).toBe('middle');
    const [middle, keep, lift] = v.options;
    expect(middle).toMatchObject({ id: 'middle', axis: 68, key: { tonic: 'C', scale: 'major' } });
    // About G♯4 the Am7 comes back as itself; about A4 it is Bm7 in D major (snapped by semitone).
    expect(keep).toMatchObject({ id: 'keep', axis: 68, chord: 'Am7/E' });
    expect(keep.key).toEqual({ tonic: 'C', scale: 'major' });
    expect(lift).toMatchObject({ id: 'lift', axis: 69, chord: 'Bm7/F♯' });
    expect(lift.patch).toEqual({ around: 69, snap: 'chromatic' });
    expect(lift.key).toEqual({ tonic: 'D', scale: 'major' });
  });

  it('the current axis reads the live score; another is compiled with it', () => {
    const m = fold({ around: 69, snap: 'chromatic' });
    const p = piece(m);
    const v = foldView(p, compile(p), m)!;
    expect(v.current).toBe('lift');
    expect(v.options[2].chord).toBe(spreadLanding(p, m, {}));
  });

  it('widths other than 1 name the chord only (no key)', () => {
    const m = fold({ factor: -2, around: 68, snap: 'none' });
    const p = piece(m);
    const v = foldView(p, compile(p), m)!;
    expect(v.options.every((o) => o.key === null)).toBe(true);
    expect(v.options[1].chord).not.toBe('');
  });
});

describe('when the crossing falls; Cross at one point', () => {
  it('with stagger and jitter the lines cross at different times; switched on, at one instant', () => {
    const loose = fold({ around: 68 });
    const p = piece(loose);
    const c = crossingOf(compile(p), loose, 68)!;
    expect(c.lines).toBe(4);
    expect(c.last - c.first).toBeGreaterThan(ONE_POINT);
    expect(crossesAtOnePoint(loose, p.defaults.glide)).toBe(false);

    const tight = { ...loose, ...crossPatch(loose, p.defaults.glide, true) } as SpreadMoment;
    expect(crossesAtOnePoint(tight, p.defaults.glide)).toBe(true);
    const q = piece(tight);
    const d = crossingOf(compile(q), tight, 68)!;
    expect(d.lines).toBe(4);
    expect(d.last - d.first).toBeLessThanOrEqual(ONE_POINT);
    // Halfway through the 4 s glide for a symmetric curve.
    expect(d.first).toBeCloseTo(6, 1);

    const off = { ...tight, ...crossPatch(tight, q.defaults.glide, false) } as SpreadMoment;
    expect(off.glide).toEqual({ length: 4 });
  });

  it('a burst through one point (width 2): the crossing comes a third of the way', () => {
    const m = fold({ factor: -2, around: 68, snap: 'none', glide: { length: 4, ease: 'linear' } });
    const tight = { ...m, ...crossPatch(m, defaultGlide(), true) } as SpreadMoment;
    const p = piece(tight);
    const c = crossingOf(compile(p), tight, axisOf(tight, [64, 67, 69, 72]))!;
    expect(c.last - c.first).toBeLessThanOrEqual(ONE_POINT);
    expect(c.first).toBeCloseTo(4 + 4 / 3, 2);
  });

  it('drops per-line arrival times, keeps per-line pitches', () => {
    const m = fold({
      overrides: [
        { voice: 0, end: 2 },
        { voice: 1, pitch: 60, end: 3 },
      ],
    });
    expect(crossPatch(m, defaultGlide(), true).overrides).toEqual([{ voice: 1, pitch: 60 }]);
  });
});

describe('Upside down with a width', () => {
  it('factor −w is upside down ×w; −1 stays plain', () => {
    expect(relativeShapeOf(fold())).toEqual({ kind: 'upside-down' });
    expect(relativeShapeOf(fold({ factor: -2 }))).toEqual({ kind: 'upside-down', width: 2 });
    expect(setRelative(fold(), { kind: 'upside-down', width: 1.5 })).toMatchObject({
      factor: -1.5,
    });
  });
});
