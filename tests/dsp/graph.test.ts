/** DSP graph properties (PLAN.md §8.4–§8.8, §14): finiteness, ceiling, detune, tables, pitch. */

import { describe, expect, it } from 'vitest';
import { BUILTIN_TIMBRES } from '../../src/core/timbres';
import type { Timbre } from '../../src/core/types';
import { flatten } from '../../src/core/flat';
import { renderOffline } from '../../src/audio/offline';
import {
  DRY_MIX,
  FIXTURE_MIX,
  FIXTURE_NAMES,
  denseScore,
  fixtureScore,
  makeScore,
} from '../../src/audio/fixtures/scores';
import { Graph } from '../../src/dsp/graph';
import {
  buildWavetables,
  MIP_BASE_HZ,
  MIP_COUNT,
  WAVETABLE_SIZE,
  WAVETABLE_STRIDE,
} from '../../src/dsp/wavetable';
import { allFinite, Driver, peak, RATE, render, rms } from './helpers';

const CEILING = Math.pow(10, -1 / 20);

/** Mean frequency from linearly interpolated rising zero crossings in [from, to) seconds. */
function frequency(x: Float32Array, from: number, to: number, rate = RATE): number {
  const a = Math.floor(from * rate);
  const b = Math.floor(to * rate);
  const c: number[] = [];
  for (let i = a + 1; i < b; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) c.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  }
  return ((c.length - 1) * rate) / (c[c.length - 1] - c[0]);
}

/** Standard deviation of zero-crossing periods (Hz units), a vibrato detector. */
function periodSpread(x: Float32Array, from: number, to: number, rate = RATE): number {
  const a = Math.floor(from * rate);
  const b = Math.floor(to * rate);
  const c: number[] = [];
  for (let i = a + 1; i < b; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) c.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  }
  const f = c.slice(1).map((v, i) => rate / (v - c[i]));
  const mean = f.reduce((s, v) => s + v, 0) / f.length;
  return Math.sqrt(f.reduce((s, v) => s + (v - mean) ** 2, 0) / f.length);
}

describe('graph output', () => {
  it.each(FIXTURE_NAMES)(
    'fixture %s renders with no NaN or Inf, under the ceiling',
    (name) => {
      const score = fixtureScore(name);
      const out = render(score, FIXTURE_MIX, Math.min(score.duration + 2, 32));
      expect(allFinite(out.left) && allFinite(out.right)).toBe(true);
      expect(Math.max(peak(out.left), peak(out.right))).toBeLessThanOrEqual(CEILING);
      expect(rms(out.left)).toBeGreaterThan(1e-3);
    },
    30_000,
  ); // dense-24 renders 32 s of 24 voices: slow on a loaded machine

  it('holds the −1 dBFS ceiling when 24 voices at 4× gain drive the limiter hard', () => {
    const score = denseScore(24, 12);
    for (const v of score.voices) v.gain = 4;
    const out = render(score, FIXTURE_MIX, 12);
    const p = Math.max(peak(out.left), peak(out.right));
    expect(p).toBeLessThanOrEqual(CEILING);
    expect(p).toBeGreaterThan(CEILING * 0.98); // the limiter really was engaged
    expect(allFinite(out.left)).toBe(true);
  });

  it('honours a custom ceiling', () => {
    const score = denseScore(12, 6);
    for (const v of score.voices) v.gain = 4;
    const mix = { ...FIXTURE_MIX, limiter: { ceilingDb: -6 } };
    const out = render(score, mix, 6);
    expect(Math.max(peak(out.left), peak(out.right))).toBeLessThanOrEqual(Math.pow(10, -6 / 20));
  });

  it('is silent outside every life and before play', () => {
    const score = makeScore([{ start: 60, born: 1, died: 2, fadeIn: 0.1, fadeOut: 0.1 }], 3);
    const out = render(score, DRY_MIX, 3);
    expect(peak(out.left, 0, Math.floor(0.99 * RATE))).toBe(0);
    expect(peak(out.left, Math.floor(2.01 * RATE))).toBe(0);
    const g = new Graph(RATE);
    g.load(flatten(score), DRY_MIX);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    g.process(l, r);
    expect(peak(l)).toBe(0);
  });
});

describe('detune and phase (§8.4)', () => {
  const score = makeScore(
    Array.from({ length: 32 }, (_, i) => ({ id: `voice-${i}`, start: 60 })),
    1,
    1234,
  );
  const graph = new Graph(RATE);
  graph.load(flatten(score), DRY_MIX);

  it('alternates sign by pool index, 1.5–4 cents, fixed by the voice id', () => {
    const cents = Array.from({ length: 32 }, (_, i) => graph.voiceAt(i).detuneCents(0));
    cents.forEach((c, i) => {
      expect(Math.sign(c)).toBe(i % 2 === 1 ? 1 : -1);
      expect(Math.abs(c)).toBeGreaterThanOrEqual(1.5);
      expect(Math.abs(c)).toBeLessThanOrEqual(4);
    });
    // Same ids, another piece: same detune.
    const other = new Graph(RATE);
    other.load(
      flatten(
        makeScore(
          score.voices.map((v) => ({ id: v.id, start: 50 })),
          1,
          99,
        ),
      ),
      DRY_MIX,
    );
    expect(other.voiceAt(5).detuneCents(0)).toBe(cents[5]);
  });

  it('detuneSpread widens it and can never take a voice below 1 cent', () => {
    for (let i = 0; i < 32; i++) {
      const v = graph.voiceAt(i);
      expect(Math.abs(v.detuneCents(4))).toBeGreaterThanOrEqual(Math.abs(v.detuneCents(0)));
      expect(Math.abs(v.detuneCents(-100))).toBe(1);
    }
  });

  it('wobble scales the base detune to a mean |detune| of `wobble` cents', () => {
    const base = Array.from({ length: 32 }, (_, i) => graph.voiceAt(i).detuneCents(0));
    // 2.75 cents is the old always-on detune exactly.
    for (let i = 0; i < 32; i++) expect(graph.voiceAt(i).detuneCents(0, 2.75)).toBe(base[i]);
    for (const w of [1, 3, 10]) {
      const cents = base.map((_, i) => graph.voiceAt(i).detuneCents(0, w));
      cents.forEach((c, i) => {
        expect(Math.sign(c)).toBe(Math.sign(base[i]));
        expect(c / base[i]).toBeCloseTo(w / 2.75, 12);
      });
    }
    // Small wobbles scale the 1-cent floor too.
    expect(Math.abs(graph.voiceAt(0).detuneCents(-100, 0.55))).toBeCloseTo(0.2, 12);
  });

  it('seeds the start phase from the voice id and piece seed', () => {
    const a = new Graph(RATE);
    a.load(flatten(makeScore([{ id: 'x', start: 60 }], 1, 1)), DRY_MIX);
    const b = new Graph(RATE);
    b.load(flatten(makeScore([{ id: 'x', start: 60 }], 1, 2)), DRY_MIX);
    const c = new Graph(RATE);
    c.load(flatten(makeScore([{ id: 'x', start: 60 }], 1, 1)), DRY_MIX);
    expect(a.voiceAt(0).phaseCycles).not.toBe(b.voiceAt(0).phaseCycles);
    expect(a.voiceAt(0).phaseCycles).toBe(c.voiceAt(0).phaseCycles);
  });
});

describe('wavetables (§8.4)', () => {
  /** Amplitude of harmonic n in a table row, by DFT. */
  function harmonic(data: Float32Array, mip: number, n: number): number {
    let re = 0;
    let im = 0;
    const o = mip * WAVETABLE_STRIDE;
    for (let i = 0; i < WAVETABLE_SIZE; i++) {
      const a = (2 * Math.PI * n * i) / WAVETABLE_SIZE;
      re += data[o + i] * Math.cos(a);
      im += data[o + i] * Math.sin(a);
    }
    return (2 * Math.hypot(re, im)) / WAVETABLE_SIZE;
  }

  it.each([44100, 48000])('holds no partial that could alias at %i Hz', (rate) => {
    const t: Timbre = { ...BUILTIN_TIMBRES.organ, harmonics: Array(32).fill(1) };
    const set = buildWavetables(t, rate);
    for (let m = 0; m < MIP_COUNT; m++) {
      const fTop = MIP_BASE_HZ * Math.pow(2, m + 1); // highest fundamental this mip serves
      for (let n = 1; n <= 32; n++) {
        const a = harmonic(set.data, m, n);
        if (n * fTop > rate / 2) expect(a, `mip ${m}, partial ${n}`).toBeLessThan(1e-6);
      }
    }
    expect(harmonic(set.data, 0, 32)).toBeGreaterThan(0.01); // low mips keep every partial
  });

  it('normalises every preset to the RMS of a unit sine at middle C', () => {
    for (const [name, t] of Object.entries(BUILTIN_TIMBRES)) {
      const set = buildWavetables(t, RATE);
      // Octave mips: the one containing C4. Finer (formant) mips: the one nearest C4, since the
      // formant weighting changes faster than the tilt across a mip.
      const pos = Math.log2(261.63 / MIP_BASE_HZ) * set.mipsPerOctave;
      const mip = set.mipsPerOctave === 1 ? Math.floor(pos) : Math.round(pos);
      const row = set.data.subarray(
        mip * WAVETABLE_STRIDE,
        mip * WAVETABLE_STRIDE + WAVETABLE_SIZE,
      );
      // Tracking changes the tilt between the mip's bottom and middle C, so allow a little.
      expect(rms(row), name).toBeGreaterThan(0.6);
      expect(rms(row), name).toBeLessThan(0.8);
    }
  });

  it('has a guard point equal to the first sample in every mip', () => {
    const set = buildWavetables(BUILTIN_TIMBRES.reed, RATE);
    for (let m = 0; m < MIP_COUNT; m++) {
      expect(set.data[m * WAVETABLE_STRIDE + WAVETABLE_SIZE]).toBe(set.data[m * WAVETABLE_STRIDE]);
    }
  });
});

describe('voice synthesis (§8.4)', () => {
  it('plays A4 at 440 Hz times its detune', () => {
    const score = makeScore([{ id: 'a', start: 69, timbre: 'sine' }], 4);
    const d = new Driver(score, DRY_MIX);
    const cents = d.graph.voiceAt(0).detuneCents(0);
    d.graph.play(0);
    d.run(3);
    const f = frequency(d.out().left, 0.5, 2.5);
    expect(f).toBeCloseTo(440 * Math.pow(2, cents / 1200), 2);
  });

  it('follows a glide between pitches', () => {
    const score = makeScore([{ start: 57, moves: [{ at: 1, to: 69, len: 1 }] }], 4);
    const out = render(score, DRY_MIX, 4);
    expect(frequency(out.left, 0.3, 0.9)).toBeGreaterThan(218);
    expect(frequency(out.left, 0.3, 0.9)).toBeLessThan(222);
    expect(frequency(out.left, 2.5, 3.5)).toBeGreaterThan(436);
    expect(frequency(out.left, 2.5, 3.5)).toBeLessThan(444);
  });

  it('applies vibrato only after arrival, after its delay', () => {
    const wobble: Timbre = {
      ...BUILTIN_TIMBRES.sine,
      vibrato: { rate: 6, depthCents: 40, delay: 0.5 },
    };
    const score = makeScore(
      [{ start: 57, moves: [{ at: 0.2, to: 69, len: 1.5, ease: 'linear' }], timbre: 'wobble' }],
      5,
    );
    const out = renderOffline(
      { score, mix: DRY_MIX, sampleRate: RATE, timbres: { wobble } },
      5 * RATE,
    );
    const holdEarly = periodSpread(out.left, 1.75, 2.15); // arrived at 1.7, delay 0.5
    const holdLate = periodSpread(out.left, 3, 4.5);
    expect(holdEarly).toBeLessThan(0.5);
    expect(holdLate).toBeGreaterThan(5);
  });

  it('articulation makes a pluck loud at each arrival and quieter after', () => {
    const score = makeScore(
      [{ start: 60, moves: [{ at: 1, to: 64, len: 0.3 }], timbre: 'pluck' }],
      4,
    );
    const out = render(score, DRY_MIX, 4);
    const atArrival = rms(out.left, Math.floor(1.31 * RATE), Math.floor(1.36 * RATE));
    const later = rms(out.left, Math.floor(2.8 * RATE), Math.floor(2.85 * RATE));
    expect(atArrival).toBeGreaterThan(4 * later);
  });

  it('silences muted voices and everything but soloed ones', () => {
    const base = [{ start: 60 }, { start: 67 }];
    const muted = makeScore(
      [
        { ...base[0], mute: true },
        { ...base[1], mute: true },
      ],
      2,
    );
    expect(peak(render(muted, DRY_MIX, 2).left)).toBe(0);
    const solo = makeScore([{ ...base[0], solo: true }, base[1]], 2);
    const out = render(solo, DRY_MIX, 2);
    expect(frequency(out.left, 0.5, 1.5)).toBeLessThan(270); // only C4 (261.6 Hz) remains
  });

  it('ramps a mute toggled by param without stepping', () => {
    const d = new Driver(makeScore([{ id: 'a', start: 60 }], 3), DRY_MIX);
    d.graph.play(0);
    d.run(1);
    expect(d.graph.setParam('voices.a.mute', true)).toBe(true);
    d.run(0.1);
    const out = d.out();
    const at = Math.floor(1 * RATE);
    expect(peak(out.left, at + Math.floor(0.03 * RATE))).toBe(0);
    let maxStep = 0;
    for (let i = at; i < at + 0.03 * RATE; i++)
      maxStep = Math.max(maxStep, Math.abs(out.left[i] - out.left[i - 1]));
    expect(maxStep).toBeLessThan(0.01);
  });
});
