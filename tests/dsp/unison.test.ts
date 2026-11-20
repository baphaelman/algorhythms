/**
 * Unison lock (docs/build-log.md, "Unison lock"; PLAN.md §8.4). Voices that converge on one pitch
 * lock into one steady tone at the level of the same voices spread out (incoherent), and part with
 * unrelated phases; a `wobble` timbre keeps the old beating.
 *
 * Bands (levels relative to one voice alone, or to the incoherent sum of the voices rendered one
 * at a time; deterministic id sets):
 * - a held unison of N = 2…32 averages within [0.85, 1.1] over 9 s, and its 50 ms envelope varies
 *   by under 1 % (coefficient of variation);
 * - converge, hold and diverge: every 0.25 s window within [0.5, 1.6] of the incoherent sum;
 * - merge: every 0.25 s window within [0.7, 1.3]; the survivor bends by under 8 cents;
 * - a seek into a held unison: level within ±3 % of straight playback, and no click;
 * - `wobble` voices keep beating (envelope variation > 0.2).
 */

import { describe, expect, it } from 'vitest';
import { DRY_MIX, makeScore, unisonScore, type VoiceSpec } from '../../src/audio/fixtures/scores';
import { renderOffline } from '../../src/audio/offline';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
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

  it('wobble voices keep beating', () => {
    const out = render(unisonScore(8, { timbre: 'wobble' }), DRY_MIX, 12);
    const cv = envelopeCv(out, HOLD_FROM, 11.5);
    console.info(`wobble-8 envelope CV ${cv.toFixed(3)}`);
    expect(cv).toBeGreaterThan(0.2);
  });
});

describe('converge, hold, diverge', () => {
  it.each([2, 8, 32])(
    '%i voices stay within [0.5, 1.6] of the incoherent sum at pitches 45, 57, 69',
    (n) => {
      const END = 11;
      const report: string[] = [];
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
      }
      console.info(
        `converge/hold/diverge N=${n} (0.25 s windows ÷ incoherent): ${report.join(', ')}`,
      );
    },
    60_000,
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
