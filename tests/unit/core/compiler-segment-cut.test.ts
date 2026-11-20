/**
 * Cut segments (M1 additive contract change, docs/build-log.md "M1b"): an interrupted glide keeps
 * its planned parametrisation, so the part that sounded is unchanged by the interruption.
 */
import { describe, expect, it } from 'vitest';
import { flatten, unflatten, SEG_CURVE_P1, SEG_CURVE_T1, SEG_STRIDE } from '../../../src/core/flat';
import {
  evalFlatSegment,
  evalFlatSegmentMotion,
  evalSegment,
  evalSegmentMotion,
  evalSegmentVelocity,
} from '../../../src/core/segment';
import type { CompiledScore, Segment } from '../../../src/core/types';

const planned: Segment = { t0: 1, t1: 5, p0: 50, p1: 62, ease: 'smootherstep', m0: 1.5 };
const ti = 2.7;
const cut: Segment = {
  ...planned,
  t1: ti,
  p1: evalSegment(planned, ti),
  curve: { t1: planned.t1, p1: planned.p1 },
};

describe('cut segments', () => {
  it('evaluate exactly like the planned glide before the cut', () => {
    for (let i = 0; i < 50; i++) {
      const t = 1 + ((ti - 1) * i) / 50;
      expect(evalSegment(cut, t)).toBe(evalSegment(planned, t));
      expect(evalSegmentVelocity(cut, t)).toBe(evalSegmentVelocity(planned, t));
      expect(evalSegmentMotion(cut, t)).toBe(evalSegmentMotion(planned, t));
    }
  });

  it('hold their cut pitch from t1 on and report the cut-time slope', () => {
    expect(evalSegment(cut, ti)).toBe(cut.p1);
    expect(evalSegment(cut, 99)).toBe(cut.p1);
    expect(evalSegmentVelocity(cut, 99)).toBe(evalSegmentVelocity(planned, ti));
    expect(evalSegmentMotion(cut, ti)).toBe(0);
  });

  it('round-trip through the flat layout and evaluate identically there', () => {
    const score: CompiledScore = {
      duration: 6,
      voices: [
        {
          id: 'v1',
          index: 0,
          lives: [{ born: 1, fadeIn: 0 }],
          segments: [cut, { t0: ti, t1: 6, p0: cut.p1, p1: 55, ease: 'linear' }],
          timbre: [{ t: 0, preset: 'sine', fade: 0 }],
          level: [],
          gain: 1,
          pan: 'auto',
          mute: false,
          solo: false,
          sends: {},
        },
      ],
      momentSpans: [],
      diagnostics: [],
      keys: [],
      referenceHz: 440,
      seed: 1,
    };
    const flat = flatten(score);
    const rec = flat.voices[0].segments;
    expect(rec[SEG_CURVE_T1]).toBe(5);
    expect(rec[SEG_CURVE_P1]).toBe(62);
    expect(rec[SEG_STRIDE + SEG_CURVE_T1]).toBe(6); // uncut: equals t1
    for (let i = 0; i <= 40; i++) {
      const t = 1 + (ti - 1) * (i / 40);
      expect(evalFlatSegment(rec, 0, t)).toBe(evalSegment(cut, t));
      expect(evalFlatSegmentMotion(rec, 0, t)).toBe(evalSegmentMotion(cut, t));
    }
    const back = unflatten(flat).voices[0].segments;
    expect(back[0].curve).toEqual({ t1: 5, p1: 62 });
    expect(back[1].curve).toBeUndefined();
  });

  it('motion is 0 on holds and sin(πx) on glides', () => {
    const hold: Segment = { t0: 0, t1: 3, p0: 60, p1: 60, ease: 'smootherstep' };
    expect(evalSegmentMotion(hold, 1)).toBe(0);
    const glide: Segment = { t0: 0, t1: 2, p0: 60, p1: 64, ease: 'linear' };
    expect(evalSegmentMotion(glide, 1)).toBeCloseTo(1, 12);
    expect(evalSegmentMotion(glide, 0.5)).toBeCloseTo(Math.SQRT1_2, 12);
    const back: Segment = { t0: 0, t1: 2, p0: 60, p1: 60, ease: 'linear', m0: 1 };
    expect(evalSegmentMotion(back, 1)).toBeGreaterThan(0.99);
  });
});
