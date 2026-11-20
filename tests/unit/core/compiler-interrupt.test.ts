/**
 * Interruption with carried velocity and the overshoot clamp (PLAN.md §7.5).
 */
import { describe, expect, it } from 'vitest';
import { CHECK_SAMPLES, buildMoveSegment, overshootScale } from '../../../src/core/interrupt';
import { EaseCode } from '../../../src/core/ease';
import { evalSegment, evalSegmentVelocity } from '../../../src/core/segment';

const FREE = { up: 1, down: 1 };

function overshoot(seg: ReturnType<typeof buildMoveSegment>): { up: number; down: number } {
  const hi = Math.max(seg.p0, seg.p1);
  const lo = Math.min(seg.p0, seg.p1);
  let up = 0;
  let down = 0;
  for (let i = 0; i < CHECK_SAMPLES; i++) {
    const t = seg.t0 + ((seg.t1 - seg.t0) * i) / (CHECK_SAMPLES - 1);
    const p = evalSegment(seg, t);
    up = Math.max(up, p - hi);
    down = Math.max(down, lo - p);
  }
  return { up, down };
}

describe('buildMoveSegment (§7.5)', () => {
  it('a holding voice gets a plain eased glide', () => {
    const s = buildMoveSegment({ p: 60, v: 0, mid: false }, 1, 2, 64, 'linear', FREE);
    expect(s.m0).toBeUndefined();
    expect(evalSegment(s, 2)).toBeCloseTo(62, 12);
  });

  it('m0 = v·d − Δ·e′(0) makes the join C¹ (smootherstep and linear)', () => {
    for (const ease of ['smootherstep', 'linear', 'expo', 'cosine'] as const) {
      const s = buildMoveSegment({ p: 60, v: 3, mid: true }, 0, 2, 62, ease, { up: 5, down: 5 });
      expect(evalSegment(s, 0)).toBe(60);
      expect(evalSegment(s, 2)).toBe(62);
      expect(evalSegmentVelocity(s, 0)).toBeCloseTo(3, 9);
      expect(s.clamped).toBeUndefined();
    }
  });

  it('handles p1 = p0: interrupted and sent back to its own pitch', () => {
    const s = buildMoveSegment({ p: 60, v: 2, mid: true }, 0, 1, 60, 'smootherstep', FREE);
    expect(s.m0).toBeCloseTo(2, 12);
    expect(evalSegment(s, 1 / 3)).toBeGreaterThan(60);
    expect(evalSegment(s, 1)).toBe(60);
  });

  it('clamps overshoot to L by bisection and flags the segment', () => {
    // Moving fast upwards, sent down: overshoots above the start.
    const free = buildMoveSegment({ p: 60, v: 20, mid: true }, 0, 2, 55, 'smootherstep', {
      up: 50,
      down: 50,
    });
    expect(overshoot(free).up).toBeGreaterThan(1);
    const s = buildMoveSegment({ p: 60, v: 20, mid: true }, 0, 2, 55, 'smootherstep', {
      up: 0.25,
      down: 1,
    });
    expect(s.clamped).toBe(true);
    const o = overshoot(s);
    expect(o.up).toBeLessThanOrEqual(0.25 + 1e-12);
    expect(o.up).toBeGreaterThan(0.24); // bisection finds the largest scale that fits
  });

  it('L = 0 allows no overshoot at all', () => {
    const s = buildMoveSegment({ p: 60, v: -6, mid: true }, 0, 1, 64, 'smootherstep', {
      up: 0,
      down: 0,
    });
    const o = overshoot(s);
    expect(o.up).toBeLessThanOrEqual(1e-12);
    expect(o.down).toBeLessThanOrEqual(1e-12);
  });

  it('a bézier overshoot of its own is not counted against L', () => {
    const back = { kind: 'bezier' as const, x1: 0.3, y1: 0, x2: 0.4, y2: 1.6 };
    expect(
      overshootScale(60, 64, EaseCode.Bezier, back, 0.5, { up: 0, down: 0 }),
    ).toBeLessThanOrEqual(1);
    const s = buildMoveSegment({ p: 60, v: 0, mid: true }, 0, 1, 64, back, { up: 0, down: 0 });
    expect(s.clamped).toBeUndefined();
  });

  it('crossScale tightens m0 further and flags the join', () => {
    const s = buildMoveSegment({ p: 60, v: 4, mid: true }, 0, 1, 62, 'smootherstep', FREE, 0.5);
    expect(s.clamped).toBe(true);
    expect(s.m0).toBeCloseTo(2, 12);
  });
});
