/**
 * Arrivals stay clean (M4.5-32; PLAN.md G1, §8.4). When a glide ends on its new pitch the
 * articulation envelope strikes. Its attack must not tick: on main, glass's 4 ms linear attack
 * splattered up to 10× the held chord's residual, on every moving voice at the same sample under
 * `arrive: 'together'`.
 *
 * Measure: sine voices (nothing above the fundamental) with glass's articulation, high-passed
 * at 3 kHz; the residual is the high-passed RMS over the full-band RMS in 2 ms windows
 * (level-normalised, so the strike's own gain doesn't count). The worst window in [−5, +20] ms
 * of each arrival must stay within twice the worst window of the held chord after the last
 * arrival or of the 120 ms before it.
 */

import { describe, expect, it, vi } from 'vitest';
import { DRY_MIX, makeScore, type VoiceSpec } from '../../src/audio/fixtures/scores';
import { renderOffline } from '../../src/audio/offline';
import { BUILTIN_TIMBRES } from '../../src/core/timbres';
import type { CompiledScore, EaseRef, Timbre } from '../../src/core/types';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { RATE } from './helpers';

// Slowest test 1.5 s on 1 worker; ~10× so a loaded machine passes (build log: test hardening).
vi.setConfig({ testTimeout: 30_000 });

const STRIKE: Record<string, Timbre> = {
  strike: {
    ...BUILTIN_TIMBRES.sine,
    accent: 0,
    articulation: { ...BUILTIN_TIMBRES.glass.articulation },
  },
};

const EASES: [string, EaseRef][] = [
  ['smootherstep', 'smootherstep'],
  ['linear', 'linear'],
  ['expo', 'expo'],
  ['bezier', { kind: 'bezier', x1: 0.3, y1: 0, x2: 0.2, y2: 1 }],
];

const SECONDS = 6;

/** Four lines, chord to chord from 1 s; `together` ends every glide at 3 s, else 3–4.1 s. */
function chordToChord(ease: EaseRef, together: boolean): CompiledScore {
  const from = [45, 48, 52, 55];
  const to = [47, 50, 53, 57];
  const specs: VoiceSpec[] = from.map((p, i) => ({
    id: `line-${i}`,
    start: p,
    moves: [{ at: 1 + i * 0.13, to: to[i], len: together ? 2 - i * 0.13 : 2 + i * 0.24, ease }],
    timbre: 'strike',
  }));
  return makeScore(specs, SECONDS, 3);
}

/** Two cascaded biquads: a 4th-order Butterworth high-pass at fc. */
function highpass(x: Float32Array, fc: number): Float64Array {
  const w0 = (2 * Math.PI * fc) / RATE;
  const cs = Math.cos(w0);
  let src: ArrayLike<number> = x;
  let out = new Float64Array(0);
  for (const q of [0.5412, 1.3066]) {
    const al = Math.sin(w0) / (2 * q);
    const a0 = 1 + al;
    const b0 = (1 + cs) / 2 / a0;
    const b1 = -(1 + cs) / a0;
    const a1 = (-2 * cs) / a0;
    const a2 = (1 - al) / a0;
    out = new Float64Array(x.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const xi = src[i];
      const y = b0 * xi + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = xi;
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
    src = out;
  }
  return out;
}

function rmsOf(x: ArrayLike<number>, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
}

/** Worst 2 ms window of high-passed ÷ full-band RMS over [from, to) seconds (1 ms hop). */
function worstResidual(x: Float32Array, hp: Float64Array, from: number, to: number): number {
  const w = Math.round(0.002 * RATE);
  const hop = Math.round(0.001 * RATE);
  let worst = 0;
  for (let i = Math.round(from * RATE); i + w <= Math.round(to * RATE); i += hop) {
    worst = Math.max(worst, rmsOf(hp, i, i + w) / rmsOf(x, i, i + w));
  }
  return worst;
}

/** Worst arrival residual ÷ the steady residual around it, over every arrival of the score. */
function arrivalRatio(score: CompiledScore): number {
  const frames = Math.ceil((SECONDS * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
  const { left } = renderOffline(
    { score, mix: DRY_MIX, timbres: STRIKE, sampleRate: RATE },
    frames,
  );
  const hp = highpass(left, 3000);
  const times = [
    ...new Set(
      score.voices.flatMap((v) => v.segments.filter((s) => s.p0 !== s.p1).map((s) => s.t1)),
    ),
  ];
  const last = Math.max(...times);
  const held = worstResidual(left, hp, last + 0.4, last + 0.9);
  let worst = 0;
  for (const ta of times) {
    const steady = Math.max(held, worstResidual(left, hp, ta - 0.15, ta - 0.03));
    worst = Math.max(worst, worstResidual(left, hp, ta - 0.005, ta + 0.02) / steady);
  }
  return worst;
}

describe('arrival residual (glass articulation on sines, 3 kHz high-pass)', () => {
  it.each([true, false])(
    'together = %s: within 2× the steady residual for every ease',
    (together) => {
      const ratios = EASES.map(([, ease]) => arrivalRatio(chordToChord(ease, together)));
      console.info(
        `arrival residual ÷ steady, ${together ? 'together' : 'spread'}: ` +
          EASES.map(([name], i) => `${name} ${ratios[i].toFixed(2)}×`).join(', '),
      );
      EASES.forEach(([name], i) => expect(ratios[i], name).toBeLessThanOrEqual(2));
    },
  );
});
