/** Property tests for core/ease.ts and core/segment.ts (fast-check). */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EaseCode, ease, easeCodeOf, easeSlope0 } from '../../src/core/ease';
import { evalSegment, evalSegmentVelocity } from '../../src/core/segment';
import type { EaseRef, Segment } from '../../src/core/types';

const unit = fc.double({ min: 0, max: 1, noNaN: true });
const standardCode = fc.constantFrom(
  EaseCode.Smootherstep,
  EaseCode.Smoothstep,
  EaseCode.Cosine,
  EaseCode.Linear,
  EaseCode.Expo,
);
const MONOTONE_SLACK = 4 * Number.EPSILON;
const pitch = fc.double({ min: 20, max: 110, noNaN: true });
const namedEase = fc.constantFrom<EaseRef>(
  'smootherstep',
  'smoothstep',
  'cosine',
  'linear',
  'expo',
);
const bezierEase = fc
  .record({
    x1: unit,
    y1: fc.double({ min: -1, max: 2, noNaN: true }),
    x2: unit,
    y2: fc.double({ min: -1, max: 2, noNaN: true }),
  })
  .map((b): EaseRef => ({ kind: 'bezier', ...b }));

describe('ease properties', () => {
  it('standard eases stay in [0, 1] and are monotone', () => {
    fc.assert(
      fc.property(standardCode, unit, unit, (code, a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const elo = ease(code, lo);
        const ehi = ease(code, hi);
        expect(elo).toBeGreaterThanOrEqual(0);
        expect(ehi).toBeLessThanOrEqual(1);
        // Monotone up to float noise: a few ulps of 1 (cosine and smoothstep round by 1 ulp).
        expect(elo - ehi).toBeLessThanOrEqual(MONOTONE_SLACK);
      }),
    );
  });

  it('a bézier with 0 ≤ y1 ≤ y2 ≤ 1 is monotone with exact endpoints', () => {
    fc.assert(
      fc.property(unit, unit, unit, unit, unit, unit, (x1, x2, ya, yb, a, b) => {
        const bz = { x1, x2, y1: Math.min(ya, yb), y2: Math.max(ya, yb) };
        expect(ease(EaseCode.Bezier, 0, bz)).toBe(0);
        expect(ease(EaseCode.Bezier, 1, bz)).toBe(1);
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(ease(EaseCode.Bezier, lo, bz)).toBeLessThanOrEqual(
          ease(EaseCode.Bezier, hi, bz) + 1e-9,
        );
      }),
    );
  });
});

describe('segment properties (§7.5)', () => {
  const segment = fc.record({
    t0: fc.double({ min: 0, max: 100, noNaN: true }),
    d: fc.double({ min: 0.01, max: 20, noNaN: true }),
    p0: pitch,
    p1: pitch,
    ease: fc.oneof(namedEase, bezierEase),
    m0: fc.double({ min: -5, max: 5, noNaN: true }),
  });

  it('endpoints are exact for any ease and any m0', () => {
    fc.assert(
      fc.property(segment, ({ t0, d, p0, p1, ease: e, m0 }) => {
        const seg: Segment = { t0, t1: t0 + d, p0, p1, ease: e, m0 };
        expect(evalSegment(seg, seg.t0)).toBe(p0);
        expect(evalSegment(seg, seg.t1)).toBe(p1);
      }),
    );
  });

  it('an interruption with m0 = v·d − (p1 − p0)·e′(0) continues the velocity (C¹ join)', () => {
    fc.assert(
      fc.property(
        segment,
        unit.filter((u) => u > 0.05 && u < 0.95),
        namedEase,
        pitch,
        fc.double({ min: 0.1, max: 10, noNaN: true }),
        ({ t0, d, p0, p1, ease: e }, u, nextEase, target, d2) => {
          const first: Segment = { t0, t1: t0 + d, p0, p1, ease: e };
          const ti = t0 + u * d;
          const pi = evalSegment(first, ti);
          const vi = evalSegmentVelocity(first, ti);
          const m0 = vi * d2 - (target - pi) * easeSlope0(easeCodeOf(nextEase));
          const next: Segment = { t0: ti, t1: ti + d2, p0: pi, p1: target, ease: nextEase, m0 };
          expect(evalSegment(next, ti)).toBe(pi);
          expect(evalSegmentVelocity(next, ti)).toBeCloseTo(vi, 6);
        },
      ),
    );
  });
});
