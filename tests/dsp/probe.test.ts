/**
 * `VoiceData.probe` writes out the life weight, evalFlatSegment and warpOffset for TurboFan's
 * inlining budget (docs/build-log.md, "No-GC lock flake"). It must give bit-identical results to
 * the functions it replaces, so the sound is unchanged.
 */

import { describe, expect, it } from 'vitest';
import { lockStressScore, unisonChordScore } from '../../src/audio/fixtures/scores';
import { flatten } from '../../src/core/flat';
import {
  evalFlatSegment,
  LIFE_BORN,
  LIFE_DIED,
  LIFE_FADE_IN,
  LIFE_FADE_OUT,
  LIFE_STRIDE,
  SEG_STRIDE,
  SEG_T0,
} from '../../src/core/segment';
import { MIN_LIFE_FADE } from '../../src/dsp/constants';
import { computeUnisonWarps, lastAtOrBefore, VoiceData, warpOffset } from '../../src/dsp/voice';

const RATE = 48000;

const smootherstep = (x: number): number => x * x * x * (x * (x * 6 - 15) + 10);

/** The life weight as probe computed it before (the former `lifeWeight`). */
function lifeWeight(L: Float64Array, o: number, t: number): number {
  const born = L[o + LIFE_BORN];
  const died = L[o + LIFE_DIED];
  if (t >= died || t < born) return 0;
  let w = 1;
  const u = (t - born) / Math.max(L[o + LIFE_FADE_IN], MIN_LIFE_FADE);
  if (u < 1) w = smootherstep(u);
  const v = (died - t) / Math.max(L[o + LIFE_FADE_OUT], MIN_LIFE_FADE);
  if (v < 1) w *= smootherstep(v);
  return w;
}

describe('VoiceData.probe', () => {
  it('matches lifeWeight, evalFlatSegment and warpOffset bit for bit', () => {
    let warped = 0;
    let fading = 0;
    for (const score of [lockStressScore(12, 80, 17), unisonChordScore('sine')]) {
      const flat = flatten(score);
      const data = flat.voices.map((fv, i) =>
        VoiceData.fromFlat(fv, flat.voiceParams, i, new Int32Array(flat.timbreNames.length)),
      );
      computeUnisonWarps(data, 440);
      const end = Math.ceil(flat.duration * RATE) + RATE;
      for (const d of data) {
        // A prime step, so the frames land everywhere in segments and life fades.
        for (let frame = 0; frame < end; frame += 997) {
          d.probe(frame, RATE);
          const t = frame / RATE;
          const li = lastAtOrBefore(d.lives, d.nLife, LIFE_STRIDE, LIFE_BORN, t);
          const life = li < 0 ? 0 : lifeWeight(d.lives, li * LIFE_STRIDE, t);
          expect(Object.is(d.probeLife, life)).toBe(true);
          if (life > 0 && life < 1) fading++;
          if (d.nSeg === 0) continue;
          const si = Math.max(0, lastAtOrBefore(d.segs, d.nSeg, SEG_STRIDE, SEG_T0, t));
          const p = evalFlatSegment(d.segs, si * SEG_STRIDE, t);
          const wIn = warpOffset(p, d.warpInA[si], d.warpInC[si]);
          const wOut = warpOffset(p, d.warpOutA[si], d.warpOutC[si]);
          if (wIn !== 0 || wOut !== 0) warped++;
          expect(Object.is(d.probePitch, p + wIn + wOut)).toBe(true);
        }
      }
    }
    // The fixtures exercise both written-out branches.
    expect(warped).toBeGreaterThan(0);
    expect(fading).toBeGreaterThan(0);
  });
});
