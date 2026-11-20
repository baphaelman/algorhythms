/**
 * Fixed-Hz formants and seeded drift (PLAN.md §8.4, §8.5): the formant envelope stays at the same
 * frequencies as the pitch moves, and drift and vibrato jitter are a pure function of the piece
 * seed and voice id.
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_TIMBRES } from '../../src/core/timbres';
import type { Timbre } from '../../src/core/types';
import { createLoadedGraph, renderOffline } from '../../src/audio/offline';
import { DRY_MIX, longGlideScore, makeScore } from '../../src/audio/fixtures/scores';
import {
  buildWavetables,
  FORMANT_MIPS_PER_OCTAVE,
  formantGain,
  MIP_BASE_HZ,
  mipCountFor,
  WAVETABLE_SIZE,
  WAVETABLE_STRIDE,
  type WavetableSet,
} from '../../src/dsp/wavetable';
import { clickScore, RATE } from './helpers';

/** Amplitude of harmonic n in mip `mip`, by DFT. */
function harmonic(set: WavetableSet, mip: number, n: number): number {
  let re = 0;
  let im = 0;
  const o = mip * WAVETABLE_STRIDE;
  for (let i = 0; i < WAVETABLE_SIZE; i++) {
    const a = (2 * Math.PI * n * i) / WAVETABLE_SIZE;
    re += set.data[o + i] * Math.cos(a);
    im += set.data[o + i] * Math.sin(a);
  }
  return (2 * Math.hypot(re, im)) / WAVETABLE_SIZE;
}

/** The table a fundamental of `hz` reads at weight 0 (its mip's bottom is exactly `hz`). */
function mipFor(set: WavetableSet, hz: number): number {
  return Math.round(Math.log2(hz / MIP_BASE_HZ) * set.mipsPerOctave);
}

/** Frequency (Hz) of the loudest partial in mip `mip`, and the amplitude-weighted centroid. */
function spectrum(set: WavetableSet, mip: number): { peakHz: number; centroidHz: number } {
  const f0 = MIP_BASE_HZ * Math.pow(2, mip / set.mipsPerOctave);
  let best = 0;
  let peakHz = 0;
  let sum = 0;
  let wsum = 0;
  for (let n = 1; n <= 32; n++) {
    const a = harmonic(set, mip, n);
    if (a > best) {
      best = a;
      peakHz = n * f0;
    }
    sum += a * n * f0;
    wsum += a;
  }
  return { peakHz, centroidHz: sum / wsum };
}

/** A two-voice score of a held note per voice, `seconds` long. */
function held(timbre: string, seed: number, seconds = 4) {
  return makeScore(
    [
      { start: 57, timbre },
      { start: 64, timbre },
    ],
    seconds,
    seed,
  );
}

describe('formants (§8.5)', () => {
  it('formantGain peaks at each centre and is −3 dB at ±bw/2', () => {
    const F = [{ hz: 1000, bw: 200, gain: 0.5 }];
    expect(formantGain(F, 1000)).toBeCloseTo(0.5, 12);
    expect(formantGain(F, 1100)).toBeCloseTo(0.5 / Math.SQRT2, 12);
    expect(formantGain(F, 900)).toBeCloseTo(0.5 / Math.SQRT2, 12);
  });

  it('uses finer mips only for formant timbres', () => {
    const choir = buildWavetables(BUILTIN_TIMBRES.choir, RATE);
    expect(choir.mipsPerOctave).toBe(FORMANT_MIPS_PER_OCTAVE);
    expect(choir.data.length).toBe(mipCountFor(FORMANT_MIPS_PER_OCTAVE) * WAVETABLE_STRIDE);
    expect(buildWavetables(BUILTIN_TIMBRES.organ, RATE).mipsPerOctave).toBe(1);
  });

  it('keeps the vowel at fixed Hz across an octave (choir at A2 and A3)', () => {
    const set = buildWavetables(BUILTIN_TIMBRES.choir, RATE);
    const lo = spectrum(set, mipFor(set, 110));
    const hi = spectrum(set, mipFor(set, 220));
    // F1 (700 Hz) is the loudest region at both pitches, within one partial spacing of A3.
    expect(Math.abs(lo.peakHz - 700)).toBeLessThan(220);
    expect(Math.abs(hi.peakHz - 700)).toBeLessThan(220);
    // The spectral centroid barely moves (a pitch-locked spectrum would double it).
    expect(hi.centroidHz / lo.centroidHz).toBeGreaterThan(0.85);
    expect(hi.centroidHz / lo.centroidHz).toBeLessThan(1.25);
  });

  it('per-partial weights without formants move with the pitch (the old behaviour)', () => {
    // The pre-formant choir: fixed weights per partial index, peaking at partial 3.
    const old: Timbre = {
      ...BUILTIN_TIMBRES.choir,
      harmonics: [0.55, 0.7, 1, 0.85, 0.45, 0.25, 0.14, 0.1, 0.12, 0.2, 0.26, 0.2, 0.11],
      brightness: { tilt: 0, track: 0 },
      formants: undefined,
    };
    const set = buildWavetables(old, RATE);
    const lo = spectrum(set, mipFor(set, 110));
    const hi = spectrum(set, mipFor(set, 220));
    expect(hi.peakHz / lo.peakHz).toBeCloseTo(2, 6);
  });

  it('glides through the finer mips without clicks (24 → 108 → 36)', () => {
    // The same sweep with formants off (octave mips) sets the clean reference.
    const plain: Timbre = { ...BUILTIN_TIMBRES.choir, formants: undefined };
    const score = longGlideScore('x');
    const frames = 30 * RATE;
    const run = (t: Timbre) =>
      clickScore(
        renderOffline({ score, mix: DRY_MIX, sampleRate: RATE, timbres: { x: t } }, frames).left,
      ).ratio;
    const clean = run(plain);
    const formant = run(BUILTIN_TIMBRES.choir);
    console.info(
      `choir sweep click score: formants ${formant.toFixed(3)}, octave mips ${clean.toFixed(3)}`,
    );
    expect(formant).toBeLessThan(2 * clean);
  });

  it('holds no partial that could alias at the finer spacing', () => {
    for (const rate of [44100, 48000]) {
      const t: Timbre = { ...BUILTIN_TIMBRES.choir, brightness: { tilt: 0, track: 0 } };
      const set = buildWavetables(t, rate);
      const count = mipCountFor(set.mipsPerOctave);
      for (let m = 0; m < count; m++) {
        const fTop = MIP_BASE_HZ * Math.pow(2, (m + 1) / set.mipsPerOctave);
        for (let n = 1; n <= 32; n++) {
          if (n * fTop > rate / 2)
            expect(harmonic(set, m, n), `mip ${m}, n ${n}`).toBeLessThan(1e-6);
        }
      }
    }
  });
});

describe('drift and vibrato jitter (§8.4)', () => {
  it('draws the same drift knots for the same seed and voice, different ones otherwise', () => {
    const knots = (seed: number, voice: number) => {
      const g = createLoadedGraph({ score: held('choir', seed), mix: DRY_MIX, sampleRate: RATE });
      return Array.from({ length: 64 }, (_, i) => g.voiceAt(voice).driftKnot(i));
    };
    const a = knots(5, 0);
    expect(knots(5, 0)).toEqual(a);
    expect(knots(6, 0)).not.toEqual(a);
    expect(knots(5, 1)).not.toEqual(a);
    for (const k of a) expect(Math.abs(k)).toBeLessThanOrEqual(1);
  });

  it('renders bit-identically for the same seed and differently for another seed', () => {
    const frames = 3 * RATE;
    const a = renderOffline({ score: held('choir', 5), mix: DRY_MIX, sampleRate: RATE }, frames);
    const b = renderOffline({ score: held('choir', 5), mix: DRY_MIX, sampleRate: RATE }, frames);
    const c = renderOffline({ score: held('choir', 6), mix: DRY_MIX, sampleRate: RATE }, frames);
    expect(b.left).toEqual(a.left);
    expect(b.right).toEqual(a.right);
    expect(c.left).not.toEqual(a.left);
  });

  it('wanders the pitch slowly by a few cents when drift is on, and not when it is off', () => {
    const base: Timbre = { ...BUILTIN_TIMBRES.sine, vibrato: { rate: 5, depthCents: 0, delay: 0 } };
    const drifting: Timbre = { ...base, drift: { cents: 10, rate: 1 } };
    const spreadCents = (t: Timbre) => {
      const score = makeScore([{ start: 69, timbre: 'x' }], 6, 3);
      const { left } = renderOffline(
        { score, mix: DRY_MIX, sampleRate: RATE, timbres: { x: t } },
        6 * RATE,
      );
      // Frequency over 0.25 s windows from zero crossings.
      const f: number[] = [];
      for (let w = 0.5; w + 0.25 <= 5.5; w += 0.25) {
        const c: number[] = [];
        for (let i = Math.floor(w * RATE) + 1; i < Math.floor((w + 0.25) * RATE); i++) {
          if (left[i - 1] < 0 && left[i] >= 0)
            c.push(i - 1 + -left[i - 1] / (left[i] - left[i - 1]));
        }
        f.push(((c.length - 1) * RATE) / (c[c.length - 1] - c[0]));
      }
      return 1200 * Math.log2(Math.max(...f) / Math.min(...f));
    };
    expect(spreadCents(base)).toBeLessThan(0.2);
    const s = spreadCents(drifting);
    expect(s).toBeGreaterThan(2);
    expect(s).toBeLessThan(25);
  });
});
