/**
 * Unison lock (docs/build-log.md, "Unison lock"; PLAN.md §8.4). Voices that converge on one pitch
 * lock into one steady tone at the level of the same voices spread out (incoherent), and part with
 * unrelated phases. Revision 8 removed `wobble` (the beating kind); the lock still serves glides that
 * meet or cross and the 0.1 s hand-over of a merge.
 *
 * Bands (levels relative to one voice alone, or to the incoherent sum of the voices rendered one
 * at a time; deterministic id sets):
 * - a held unison of N = 2…32 averages within [0.85, 1.1] over 9 s, and its 50 ms envelope varies
 *   by under 1 % (coefficient of variation);
 * - converge, hold and diverge: every 0.25 s window within [0.5, 1.6] of the incoherent sum, and
 *   the approach and split steady at 50 ms (CV ≤ 0.1 / 0.15 / 0.2 for N = 2 / 8 / 32);
 * - only glides into or out of a unison are warped; crossings, passing glides and intervals of a
 *   semitone sound as with no lock (≤ 1 dB, ≤ 1 cent); a merging glide bends by ≤ 65 cents;
 * - merge: every 0.25 s window within [0.7, 1.3]; the survivor bends by under 8 cents;
 * - a seek into a held unison: level within ±3 % of straight playback, and no click.
 */

import { describe, expect, it } from 'vitest';
import { DRY_MIX, makeScore, unisonScore, type VoiceSpec } from '../../src/audio/fixtures/scores';
import { renderOffline } from '../../src/audio/offline';
import { flatten } from '../../src/core/flat';
import { evalFlatSegment, SEG_STRIDE, SEG_T0 } from '../../src/core/segment';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { computeUnisonWarps, lastAtOrBefore, VoiceData } from '../../src/dsp/voice';
import { clickScore, Driver, RATE, render, stereoRms } from './helpers';

const HOLD_FROM = 3;
const HOLD_TO = 12;

/** N voices fanned 2 semitones apart, gliding into a unison at 0.5–2.5 s (and out at `splitAt`). */
function unisonSpecs(n: number, prefix: string, pitch = 57, splitAt?: number): VoiceSpec[] {
  return Array.from({ length: n }, (_, i) => {
    const start = pitch + (i - (n - 1) / 2) * 2;
    return {
      id: `${prefix}${i}`,
      start,
      moves:
        splitAt === undefined
          ? [{ at: 0.5, to: pitch, len: 2 }]
          : [
              { at: 0.5, to: pitch, len: 2 },
              { at: splitAt, to: start, len: 2 },
            ],
      timbre: 'sine',
    };
  });
}

/** RMS of 50 ms windows over [from, to) seconds: its coefficient of variation. */
function envelopeCv(out: { left: Float32Array; right: Float32Array }, from: number, to: number) {
  const w: number[] = [];
  for (let t = from; t + 0.05 <= to + 1e-9; t += 0.05) w.push(stereoRms(out, t, t + 0.05));
  const mean = w.reduce((a, b) => a + b, 0) / w.length;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) * (b - mean), 0) / w.length);
  return sd / mean;
}

const single = stereoRms(
  render(makeScore(unisonSpecs(1, 'ref'), 13), DRY_MIX, 13),
  HOLD_FROM,
  HOLD_TO,
);

describe('held unison', () => {
  it.each([2, 4, 8, 16, 32])(
    '%i converged voices: one steady tone at the incoherent level',
    (n) => {
      const report: string[] = [];
      for (let trial = 0; trial < 3; trial++) {
        const out = render(makeScore(unisonSpecs(n, `u${trial}-`), 13, trial + 1), DRY_MIX, 13);
        const whole = stereoRms(out, HOLD_FROM, HOLD_TO) / single;
        const cv = envelopeCv(out, HOLD_FROM, HOLD_TO);
        report.push(`${whole.toFixed(3)}/${cv.toFixed(4)}`);
        expect(whole, `trial ${trial}: hold average`).toBeGreaterThanOrEqual(0.85);
        expect(whole, `trial ${trial}: hold average`).toBeLessThanOrEqual(1.1);
        expect(cv, `trial ${trial}: envelope variation`).toBeLessThan(0.01);
      }
      console.info(`unison N=${n} (hold avg × one voice / envelope CV): ${report.join(' ')}`);
    },
    60_000,
  );
});

/**
 * 50 ms windows of the mix ÷ the incoherent sum over [from, to): lowest, highest and coefficient of
 * variation. `alone` are the voices rendered one at a time (g_n = 1).
 */
function steadiness(
  out: { left: Float32Array; right: Float32Array },
  alone: { left: Float32Array; right: Float32Array }[],
  from: number,
  to: number,
) {
  const r: number[] = [];
  for (let t = from; t + 0.05 <= to + 1e-9; t += 0.05) {
    let p = 0;
    for (const a of alone) p += stereoRms(a, t, t + 0.05) ** 2;
    r.push(stereoRms(out, t, t + 0.05) / Math.sqrt(p / alone.length));
  }
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const cv = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length) / mean;
  return { low: Math.min(...r), high: Math.max(...r), cv };
}

describe('converge, hold, diverge', () => {
  // Approach 0.5–2.5 s and split 7–9 s (2 s smootherstep glides, voices 2 semitones apart). The
  // 50 ms bands: steady approach and parting (docs/build-log.md, "Unison lock: steady approach and
  // parting"); before it, the approach and split varied with CV 0.08–0.21 and dipped to −7…−13 dB.
  const CV_MAX: Record<number, number> = { 2: 0.1, 8: 0.15, 32: 0.2 };
  it.each([2, 8, 32])(
    '%i voices stay within [0.5, 1.6] of the incoherent sum at pitches 45, 57, 69, and steady at 50 ms',
    (n) => {
      const END = 11;
      const report: string[] = [];
      const fine: string[] = [];
      for (const pitch of [45, 57, 69]) {
        const specs = unisonSpecs(n, `s${pitch}-`, pitch, 7);
        const out = render(makeScore(specs, END, pitch), DRY_MIX, END);
        // Each voice alone (g_n = 1), so the incoherent power of the group is Σ P_i / N.
        const alone = specs.map((s) => render(makeScore([s], END, pitch), DRY_MIX, END));
        let low = Infinity;
        let high = 0;
        for (let t = 0.25; t + 0.25 <= END - 0.25; t += 0.25) {
          let p = 0;
          for (const a of alone) p += stereoRms(a, t, t + 0.25) ** 2;
          const ratio = stereoRms(out, t, t + 0.25) / Math.sqrt(p / n);
          low = Math.min(low, ratio);
          high = Math.max(high, ratio);
        }
        report.push(`${pitch}: ${low.toFixed(2)}–${high.toFixed(2)}`);
        expect(low, `pitch ${pitch}`).toBeGreaterThanOrEqual(0.5);
        expect(high, `pitch ${pitch}`).toBeLessThanOrEqual(1.6);
        for (const [what, from, to] of [
          ['approach', 0.5, 3],
          ['split', 7, 9.5],
        ] as const) {
          const s = steadiness(out, alone, from, to);
          fine.push(
            `${pitch} ${what} ${s.low.toFixed(2)}–${s.high.toFixed(2)} cv ${s.cv.toFixed(3)}`,
          );
          expect(s.cv, `pitch ${pitch} ${what}: 50 ms CV`).toBeLessThanOrEqual(CV_MAX[n]);
          expect(s.low, `pitch ${pitch} ${what}: lowest 50 ms`).toBeGreaterThanOrEqual(0.45);
          expect(s.high, `pitch ${pitch} ${what}: highest 50 ms`).toBeLessThanOrEqual(1.45);
        }
      }
      console.info(
        `converge/hold/diverge N=${n} (0.25 s windows ÷ incoherent): ${report.join(', ')}; ` +
          `50 ms: ${fine.join(', ')}`,
      );
    },
    120_000,
  );
});

/** Merge: voices b and d glide onto a and c at 2–3.5 s and fade out by 5.5 s. */
function mergeSpecs(p: string): VoiceSpec[] {
  return [
    { id: `${p}a`, start: 50 },
    { id: `${p}b`, start: 53, moves: [{ at: 2, to: 50, len: 1.5 }], died: 5.5, fadeOut: 2 },
    { id: `${p}c`, start: 57 },
    { id: `${p}d`, start: 62, moves: [{ at: 2, to: 57, len: 1.5 }], died: 5.5, fadeOut: 2 },
  ];
}

/** Frequency (Hz) from upward zero crossings (linearly interpolated) within [from, to) seconds. */
function zeroCrossingHz(x: Float32Array, from: number, to: number): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = Math.floor(from * RATE) + 1; i < Math.floor(to * RATE); i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
      if (first < 0) first = t;
      else count++;
      last = t;
    }
  }
  return (count * RATE) / (last - first);
}

describe('merge', () => {
  it('voices merging into survivors never cancel them', () => {
    let low = Infinity;
    let high = 0;
    for (let trial = 0; trial < 12; trial++) {
      const out = render(makeScore(mergeSpecs(`m${trial}-`), 10, trial + 1), DRY_MIX, 10);
      for (let t = 0.5; t + 0.25 <= 9.5; t += 0.25) {
        const v = stereoRms(out, t, t + 0.25) / single;
        low = Math.min(low, v);
        high = Math.max(high, v);
      }
    }
    console.info(
      `merge: 0.25 s windows between ${low.toFixed(2)} and ${high.toFixed(2)} × one voice`,
    );
    expect(low).toBeGreaterThanOrEqual(0.7);
    expect(high).toBeLessThanOrEqual(1.3);
  });

  it('a held survivor keeps its pitch while a voice merges into it', () => {
    let worst = 0;
    for (let trial = 0; trial < 4; trial++) {
      const input = { score: makeScore(mergeSpecs(`b${trial}-`), 10, trial + 1), mix: DRY_MIX };
      const frames = Math.ceil((10 * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
      const gain = new Float32Array(frames).fill(1);
      for (const survivor of [0, 2]) {
        const stem = renderOffline({ ...input, sampleRate: RATE }, frames, {
          kind: 'voice',
          index: survivor,
          replayGain: gain,
        }).left;
        const ref = zeroCrossingHz(stem, 0.5, 1.9);
        for (let t = 1.9; t + 0.1 <= 9.5; t += 0.05) {
          const cents = 1200 * Math.log2(zeroCrossingHz(stem, t, t + 0.1) / ref);
          worst = Math.max(worst, Math.abs(cents));
        }
      }
    }
    console.info(`merge survivor: largest bend ${worst.toFixed(2)} cents`);
    expect(worst).toBeLessThan(8);
  });
});

describe('seek into a held unison', () => {
  it.each([2, 8, 32])('%i voices: same level as straight playback, no click', (n) => {
    const score = unisonScore(n);
    const straight = render(score, DRY_MIX, 12);
    const threshold =
      2 * Math.max(clickScore(straight.left, 480).ratio, clickScore(straight.right, 480).ratio);
    const s = new Driver(score, DRY_MIX);
    s.graph.play(0);
    s.run(6);
    const at = s.frames / RATE;
    s.graph.seek(8);
    s.run(1.5);
    const out = s.out();
    const ratio = stereoRms(out, at + 0.2, at + 1.2) / stereoRms(straight, 8.2, 9.2);
    const from = Math.floor((at - 0.03) * RATE);
    const to = Math.floor((at + 0.06) * RATE);
    const click = Math.max(
      clickScore(out.left, from, to).ratio,
      clickScore(out.right, from, to).ratio,
    );
    console.info(
      `seek into unison N=${n}: level ${ratio.toFixed(4)} × straight, click ${click.toFixed(3)} (threshold ${threshold.toFixed(3)})`,
    );
    expect(Math.abs(ratio - 1)).toBeLessThanOrEqual(0.03);
    expect(click).toBeLessThanOrEqual(threshold);
  });
});

describe('unison warp and capture', () => {
  /** Warp anchors found for a set of voice specs (NaN-free entries only). */
  function anchors(specs: VoiceSpec[], end: number): string[] {
    const flat = flatten(makeScore(specs, end));
    const data = flat.voices.map((fv, i) =>
      VoiceData.fromFlat(fv, flat.voiceParams, i, new Int32Array(flat.timbreNames.length)),
    );
    computeUnisonWarps(data, 440);
    const out: string[] = [];
    data.forEach((d, v) => {
      for (let i = 0; i < d.nSeg; i++) {
        if (d.warpInA[i] === d.warpInA[i]) out.push(`${v}:${i} in ${d.warpInA[i]}`);
        if (d.warpOutA[i] === d.warpOutA[i]) out.push(`${v}:${i} out ${d.warpOutA[i]}`);
      }
    });
    return out;
  }

  it('warps only glides that arrive at or leave a unison', () => {
    // Merge onto a held voice, then leave it again.
    expect(
      anchors(
        [
          { start: 57 },
          {
            start: 60,
            moves: [
              { at: 1, to: 57, len: 1 },
              { at: 4, to: 60, len: 1 },
            ],
          },
        ],
        6,
      ),
    ).toEqual(['1:1 in 57', '1:3 out 57']);
    // Two voices converging on one pitch together.
    expect(
      anchors(
        [
          { start: 55, moves: [{ at: 1, to: 57, len: 2 }] },
          { start: 59, moves: [{ at: 1, to: 57, len: 2 }] },
        ],
        5,
      ),
    ).toEqual(['0:1 in 57', '1:1 in 57']);
    // A crossing, a glide passing a held voice, a semitone and a 30-cent interval: none.
    for (const specs of [
      [
        { start: 50, moves: [{ at: 1, to: 62, len: 1 }] },
        { start: 62, moves: [{ at: 1, to: 50, len: 1 }] },
      ],
      [{ start: 57 }, { start: 52, moves: [{ at: 1, to: 62, len: 1 }] }],
      [
        { start: 55, moves: [{ at: 1, to: 57, len: 2 }] },
        { start: 60, moves: [{ at: 1, to: 58, len: 2 }] },
      ],
      [{ start: 57 }, { start: 59, moves: [{ at: 1, to: 57.3, len: 2 }] }],
    ] as VoiceSpec[][])
      expect(anchors(specs, 5)).toEqual([]);
  });

  it('crossings, passing glides and distinct intervals sound as with no lock at all', () => {
    // The reference renders the same score with the lock off.
    const cases: Record<string, VoiceSpec[]> = {
      crossing: [
        { start: 50, moves: [{ at: 1, to: 62, len: 1 }] },
        { start: 62, moves: [{ at: 1, to: 50, len: 1 }] },
      ],
      passing: [{ start: 57 }, { start: 52, moves: [{ at: 1, to: 62, len: 1 }] }],
      semitone: [{ start: 57 }, { start: 58 }],
      'semitone glides': [
        { start: 55, moves: [{ at: 1, to: 57, len: 2 }] },
        { start: 60, moves: [{ at: 1, to: 58, len: 2 }] },
      ],
    };
    const END = 5;
    const frames = Math.ceil((END * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
    const gain = new Float32Array(frames).fill(1);
    const report: string[] = [];
    for (const [name, specs] of Object.entries(cases)) {
      const score = (t: string) =>
        makeScore(
          specs.map((s, i) => ({ ...s, id: `x${i}`, timbre: t })),
          END,
          5,
        );
      const a = { score: score('sine'), mix: DRY_MIX, sampleRate: RATE };
      const b = { score: score('sine'), mix: DRY_MIX, sampleRate: RATE, unlocked: true };
      const ma = renderOffline(a, frames);
      const mb = renderOffline(b, frames);
      let level = 0;
      for (let t = 0.5; t + 0.05 <= END - 0.5; t += 0.05) {
        const db = Math.abs(
          20 * Math.log10(stereoRms(ma, t, t + 0.05) / stereoRms(mb, t, t + 0.05)),
        );
        level = Math.max(level, db);
      }
      let bend = 0;
      for (let v = 0; v < specs.length; v++) {
        const part = { kind: 'voice', index: v, replayGain: gain } as const;
        const sa = renderOffline(a, frames, part).left;
        const sb = renderOffline(b, frames, part).left;
        for (let t = 0.5; t + 0.03 <= END - 0.5; t += 0.01) {
          const c =
            1200 * Math.log2(zeroCrossingHz(sa, t, t + 0.03) / zeroCrossingHz(sb, t, t + 0.03));
          bend = Math.max(bend, Math.abs(c));
        }
      }
      report.push(`${name} ${level.toFixed(2)} dB / ${bend.toFixed(2)} cents`);
      // A glide passing a held voice meets the plain (20-cent) lock for a moment: well under 1 dB.
      expect(level, `${name}: level difference (dB)`).toBeLessThanOrEqual(1);
      expect(bend, `${name}: pitch difference (cents)`).toBeLessThanOrEqual(1);
    }
    console.info(`vs no lock (largest 50 ms level / pitch difference): ${report.join(', ')}`);
  }, 60_000);

  it('bends a merging glide only near its end, and the voices hold their written pitch', () => {
    const specs: VoiceSpec[] = [
      { id: 'held', start: 57 },
      { id: 'merging', start: 60, moves: [{ at: 1, to: 57, len: 1.5 }] },
    ];
    const END = 5;
    const score = makeScore(specs, END, 3);
    const frames = Math.ceil((END * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
    const gain = new Float32Array(frames).fill(1);
    const flat = flatten(score);
    let glide = 0;
    let hold = 0;
    for (let v = 0; v < 2; v++) {
      const stem = renderOffline({ score, mix: DRY_MIX, sampleRate: RATE }, frames, {
        kind: 'voice',
        index: v,
        replayGain: gain,
      }).left;
      const segs = flat.voices[v].segments;
      for (let t = 0.5; t + 0.03 <= END - 0.5; t += 0.01) {
        let hz = 0;
        for (let k = 0; k < 8; k++) {
          const tk = t + (0.03 * (k + 0.5)) / 8;
          const si = lastAtOrBefore(segs, segs.length / SEG_STRIDE, SEG_STRIDE, SEG_T0, tk);
          hz += 440 * 2 ** ((evalFlatSegment(segs, Math.max(0, si) * SEG_STRIDE, tk) - 69) / 12);
        }
        const c = Math.abs(1200 * Math.log2(zeroCrossingHz(stem, t, t + 0.03) / (hz / 8)));
        if (t > 1 && t < 2.6) glide = Math.max(glide, c);
        else hold = Math.max(hold, c);
      }
    }
    console.info(
      `merge: largest deviation from the written pitch ${glide.toFixed(1)} cents in the glide, ` +
        `${hold.toFixed(1)} cents elsewhere (detune included)`,
    );
    expect(glide).toBeLessThanOrEqual(65);
    expect(hold).toBeLessThanOrEqual(6);
  });
});
