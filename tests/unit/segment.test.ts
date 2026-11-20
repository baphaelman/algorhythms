import { describe, expect, it } from 'vitest';
import { EaseCode, ease } from '../../src/core/ease';
import { flatten } from '../../src/core/flat';
import {
  SEG_STRIDE,
  evalFlatSegment,
  evalSegment,
  evalSegmentVelocity,
} from '../../src/core/segment';
import type { CompiledScore, Segment } from '../../src/core/types';

describe('evalSegment', () => {
  const glide: Segment = { t0: 2, t1: 5, p0: 57, p1: 64, ease: 'smootherstep' };

  it('follows p0 + (p1 − p0)·e(x) without m0', () => {
    for (let i = 0; i <= 30; i++) {
      const t = 2 + (3 * i) / 30;
      const x = (t - 2) / 3;
      expect(evalSegment(glide, t)).toBeCloseTo(57 + 7 * ease(EaseCode.Smootherstep, x), 12);
    }
  });

  it('clamps outside [t0, t1]', () => {
    expect(evalSegment(glide, 0)).toBe(57);
    expect(evalSegment(glide, 99)).toBe(64);
  });

  it('a hold is exactly constant', () => {
    const hold: Segment = { t0: 0, t1: 10, p0: 60.25, p1: 60.25, ease: 'cosine' };
    for (let i = 0; i <= 100; i++) expect(evalSegment(hold, i / 10)).toBe(60.25);
  });

  it('adds m0·(x³ − 2x² + x)', () => {
    const seg: Segment = { ...glide, ease: 'linear', m0: 2 };
    const x = 0.25;
    const t = 2 + 3 * x;
    expect(evalSegment(seg, t)).toBeCloseTo(57 + 7 * x + 2 * (x ** 3 - 2 * x ** 2 + x), 12);
  });

  it('represents p1 = p0 with carried velocity (§7.5)', () => {
    const back: Segment = { t0: 0, t1: 1, p0: 60, p1: 60, ease: 'smootherstep', m0: 1.5 };
    expect(evalSegment(back, 0)).toBe(60);
    expect(evalSegment(back, 1)).toBe(60);
    expect(evalSegment(back, 1 / 3)).toBeGreaterThan(60);
    expect(evalSegmentVelocity(back, 0)).toBeCloseTo(1.5, 12);
  });

  it('a zero-length segment is a step at t0', () => {
    const step: Segment = { t0: 1, t1: 1, p0: 50, p1: 52, ease: 'linear' };
    expect(evalSegment(step, 0.999)).toBe(50);
    expect(evalSegment(step, 1)).toBe(52);
  });

  it('velocity matches central differences, including béziers and m0', () => {
    const segs: Segment[] = [
      glide,
      { ...glide, ease: 'expo', m0: -1 },
      { ...glide, ease: { kind: 'bezier', x1: 0.68, y1: -0.55, x2: 0.265, y2: 1.55 }, m0: 0.5 },
    ];
    const h = 1e-6;
    for (const s of segs) {
      for (let i = 1; i < 50; i++) {
        const t = 2 + (3 * i) / 50;
        const fd = (evalSegment(s, t + h) - evalSegment(s, t - h)) / (2 * h);
        expect(evalSegmentVelocity(s, t)).toBeCloseTo(fd, 4);
      }
    }
  });
});

describe('evalFlatSegment', () => {
  it('agrees exactly with evalSegment', () => {
    const segments: Segment[] = [
      { t0: 0, t1: 1, p0: 60, p1: 60, ease: 'smootherstep' },
      { t0: 1, t1: 4, p0: 60, p1: 67, ease: 'cosine', m0: 0.3, clamped: true },
      {
        t0: 4,
        t1: 6,
        p0: 67,
        p1: 55,
        ease: { kind: 'bezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
      },
      { t0: 6, t1: 9, p0: 55, p1: 58.5, ease: 'expo' },
    ];
    const score: CompiledScore = {
      duration: 9,
      voices: [
        {
          id: 'v1',
          index: 0,
          lives: [{ born: 0, died: 9, fadeIn: 0, fadeOut: 1 }],
          segments,
          timbre: [{ t: 0, preset: 'sine', fade: 0 }],
          level: [],
          gain: 1,
          pan: 'auto',
          mute: false,
          solo: false,
          sends: {},
        },
      ],
      walkSteps: [],
      momentSpans: [],
      diagnostics: [],
      keys: [],
      referenceHz: 440,
      seed: 1,
    };
    const flat = flatten(score).voices[0].segments;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      for (let k = -2; k <= 52; k++) {
        const t = s.t0 + ((s.t1 - s.t0) * k) / 50;
        expect(evalFlatSegment(flat, i * SEG_STRIDE, t)).toBe(evalSegment(s, t));
      }
    }
  });
});
