/**
 * BS.1770-4 meter and true peak (PLAN.md §12 "Ready for YouTube"): EBU Tech 3341 test signals
 * synthesised here (stereo 1 kHz sines and the gating sequences), the published 48 kHz K-weighting
 * coefficients, and inter-sample peaks; `normalize` on synthetic material.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  kWeighting,
  measureLoudness,
  normalize,
  normalizePlan,
  truePeakDb,
} from '../../src/dsp/loudness';

/** A sine at `dbfs` peak level, `hz`, for `seconds`, phase `phase` (radians). */
function sine(rate: number, hz: number, dbfs: number, seconds: number, phase = 0): Float32Array {
  const a = 10 ** (dbfs / 20);
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a * Math.sin((2 * Math.PI * hz * i) / rate + phase);
  return out;
}

/** Concatenated 1 kHz segments [dbfs, seconds]. */
function sequence(rate: number, parts: [number, number][]): Float32Array {
  const segs = parts.map(([db, s]) => sine(rate, 1000, db, s));
  const out = new Float32Array(segs.reduce((n, s) => n + s.length, 0));
  let at = 0;
  for (const s of segs) {
    out.set(s, at);
    at += s.length;
  }
  return out;
}

const stereo = (x: Float32Array) => ({ left: x, right: x.slice() });

describe('K-weighting', () => {
  it('matches the published 48 kHz coefficients', () => {
    const { shelf, highpass } = kWeighting(48000);
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);
    near(shelf.b0, 1.53512485958697);
    near(shelf.b1, -2.69169618940638);
    near(shelf.b2, 1.19839281085285);
    near(shelf.a1, -1.69065929318241);
    near(shelf.a2, 0.73248077421585);
    near(highpass.a1, -1.99004745483398);
    near(highpass.a2, 0.99007225036621);
  });
});

vi.setConfig({ testTimeout: 60_000 });

describe('integrated loudness (EBU Tech 3341)', () => {
  for (const rate of [48000, 44100]) {
    it(`stereo 1 kHz at −23 dBFS reads −23 LUFS ±0.1 (${rate} Hz)`, () => {
      const m = measureLoudness(stereo(sine(rate, 1000, -23, 20)), rate);
      expect(Math.abs(m.lufs + 23)).toBeLessThan(0.1);
    });
    it(`stereo 1 kHz at −33 dBFS reads −33 LUFS ±0.1 (${rate} Hz)`, () => {
      const m = measureLoudness(stereo(sine(rate, 1000, -33, 20)), rate);
      expect(Math.abs(m.lufs + 33)).toBeLessThan(0.1);
    });
  }

  it('mono counts one channel: −23 dBFS reads −26 LUFS', () => {
    const m = measureLoudness({ left: sine(48000, 1000, -23, 20), right: null }, 48000);
    expect(Math.abs(m.lufs + 26.01)).toBeLessThan(0.1);
  });

  it('gating cases 3–5 read −23 LUFS ±0.1', () => {
    const rate = 48000;
    const cases: [number, number][][] = [
      [
        [-36, 10],
        [-23, 60],
        [-36, 10],
      ],
      [
        [-72, 10],
        [-36, 10],
        [-23, 60],
        [-36, 10],
        [-72, 10],
      ],
      [
        [-26, 20],
        [-20, 20.1],
        [-26, 20],
      ],
    ];
    for (const c of cases) {
      const m = measureLoudness(stereo(sequence(rate, c)), rate);
      expect(Math.abs(m.lufs + 23), JSON.stringify(c)).toBeLessThan(0.1);
    }
  });

  it('silence and too-short renders gate out', () => {
    expect(measureLoudness(stereo(new Float32Array(48000)), 48000).lufs).toBe(-Infinity);
    expect(measureLoudness(stereo(sine(48000, 1000, -20, 0.3)), 48000).lufs).toBe(-Infinity);
  });
});

describe('true peak', () => {
  it('finds the inter-sample peak of a fs/4 sine at 45° (sample peak −3 dB under it)', () => {
    const x = sine(48000, 12000, -6, 1, Math.PI / 4);
    const m = measureLoudness(stereo(x), 48000);
    expect(m.samplePeakDb).toBeCloseTo(-6 - 3.01, 1);
    // EBU 3341 true-peak tolerance: +0.2 / −0.4 dB.
    expect(m.truePeakDb).toBeGreaterThan(-6.4);
    expect(m.truePeakDb).toBeLessThan(-5.8);
  });

  it('reads an in-phase sine at its sample peak, and a lone full-scale sample near 0 dBTP', () => {
    const x = sine(48000, 997, -3, 1);
    expect(Math.abs(truePeakDb({ left: x, right: null }) + 3)).toBeLessThan(0.2);
    const impulse = new Float32Array(1000);
    impulse[500] = 1;
    expect(truePeakDb({ left: impulse, right: null })).toBeCloseTo(0, 1);
  });

  it('fs/4 sines at several phases (EBU 3341 cases 15–18 style) read their amplitude', () => {
    for (const deg of [0, 22.5, 45, 67.5]) {
      const x = sine(48000, 12000, -6, 0.5, (deg * Math.PI) / 180);
      const tp = truePeakDb({ left: x, right: null });
      expect(tp, `${deg}°`).toBeGreaterThan(-6.4);
      expect(tp, `${deg}°`).toBeLessThan(-5.8);
    }
  });
});

describe('normalize', () => {
  /** A dense test signal: chords of sines with a loud burst in the middle. */
  function material(rate: number, seconds: number, burstDb: number): Float32Array[] {
    const n = Math.round(seconds * rate);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    const hz = [110, 220, 330, 440, 587, 880, 1320];
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      let a = 0;
      let b = 0;
      hz.forEach((f, k) => {
        a += Math.sin(2 * Math.PI * f * t + k) * 0.02;
        b += Math.sin(2 * Math.PI * f * 1.003 * t + 2 * k) * 0.02;
      });
      const burst = t > seconds / 2 && t < seconds / 2 + 0.5 ? 10 ** (burstDb / 20) : 1;
      l[i] = a * burst;
      r[i] = b * burst;
    }
    return [l, r];
  }

  it('reaches −14 ±0.5 LUFS with true peak ≤ −1 dBTP, even with a loud burst to limit', () => {
    const rate = 48000;
    const [l, r] = material(rate, 20, 16);
    const mix = { left: l, right: r };
    const before = measureLoudness(mix, rate);
    const plan = normalizePlan(before, -14);
    const rep = normalize(mix, rate, -14);
    const after = measureLoudness(mix, rate);
    expect(rep.gainDb).toBeGreaterThan(plan.gainDb - 0.01);
    expect(rep.limitDb).toBeCloseTo(plan.limitDb, 6);
    expect(rep.limitDb).toBeGreaterThan(3);
    expect(Math.abs(after.lufs + 14)).toBeLessThan(0.5);
    expect(after.truePeakDb).toBeLessThanOrEqual(-1);
    expect(rep.output.lufs).toBeCloseTo(after.lufs, 6);
  });

  it('only scales a piece that fits (no limiting), and turns a loud one down', () => {
    const rate = 48000;
    const x = sine(rate, 1000, -30, 5);
    const mix = stereo(x.slice());
    const rep = normalize(mix, rate, -16);
    expect(rep.limitDb).toBe(0);
    const g = 10 ** (rep.gainDb / 20);
    for (let i = 0; i < x.length; i += 997) expect(mix.left[i]).toBeCloseTo(x[i] * g, 5);
    const loud = stereo(sine(rate, 1000, -2, 5));
    const r2 = normalize(loud, rate, -16);
    expect(r2.gainDb).toBeLessThan(0);
    expect(Math.abs(measureLoudness(loud, rate).lufs + 16)).toBeLessThan(0.1);
  });

  it('limits without clicks: the gain never steps', () => {
    const rate = 48000;
    const [l, r] = material(rate, 6, 20);
    const ref = l.slice();
    normalize({ left: l, right: r }, rate, -14);
    // The applied gain (output / input, read where the input is not near zero) moves by under
    // 1 % of its value from one sample to the next.
    let worst = 0;
    for (let i = 1; i < l.length; i++) {
      if (Math.abs(ref[i]) < 0.02 || Math.abs(ref[i - 1]) < 0.02) continue;
      const g = l[i] / ref[i];
      const prev = l[i - 1] / ref[i - 1];
      worst = Math.max(worst, Math.abs(g - prev) / prev);
    }
    expect(worst).toBeLessThan(0.01);
  });

  it('is deterministic and leaves silence alone', () => {
    const rate = 44100;
    const a = material(rate, 4, 12);
    const b = material(rate, 4, 12);
    normalize({ left: a[0], right: a[1] }, rate, -14);
    normalize({ left: b[0], right: b[1] }, rate, -14);
    expect(a[0]).toEqual(b[0]);
    const silent = stereo(new Float32Array(rate));
    expect(normalize(silent, rate, -14).gainDb).toBe(0);
    expect(silent.left.every((v) => v === 0)).toBe(true);
  });
});
