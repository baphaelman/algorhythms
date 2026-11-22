/**
 * Master FX behaviour (PLAN.md §8.6), each effect on its own (docs/m6-acceptance.md): the FDN
 * reverb's decay follows its RT60 setting and its pre-delay, deterministically; the ping-pong
 * delay alternates sides at its time with feedback per round trip; the tone's low-pass and tilt
 * have the asked-for response; the limiter looks ahead 5 ms.
 */

import { describe, expect, it } from 'vitest';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { PingPongDelay } from '../../src/dsp/fx/delay';
import { Limiter } from '../../src/dsp/fx/limiter';
import { Reverb } from '../../src/dsp/fx/reverb';
import { Tone } from '../../src/dsp/fx/tone';
import { RATE } from './helpers';

type Fx = (input: Float64Array, l: Float64Array, r: Float64Array) => void;

/** Runs a mono-in, stereo-out effect over `input`, block by block. */
function run(fx: Fx, input: Float64Array): { l: Float64Array; r: Float64Array } {
  const n = Math.ceil(input.length / BLOCK_FRAMES) * BLOCK_FRAMES;
  const l = new Float64Array(n);
  const r = new Float64Array(n);
  const bi = new Float64Array(BLOCK_FRAMES);
  const bl = new Float64Array(BLOCK_FRAMES);
  const br = new Float64Array(BLOCK_FRAMES);
  for (let f = 0; f < n; f += BLOCK_FRAMES) {
    bi.fill(0);
    bi.set(input.subarray(f, Math.min(input.length, f + BLOCK_FRAMES)));
    fx(bi, bl, br);
    l.set(bl, f);
    r.set(br, f);
  }
  return { l, r };
}

const impulse = (seconds: number) => {
  const x = new Float64Array(Math.round(seconds * RATE));
  x[0] = 1;
  return x;
};

/** RT60 from the Schroeder energy decay curve, fitted between −5 and −35 dB. */
function rt60(l: Float64Array, r: Float64Array): number {
  const e = new Float64Array(l.length + 1);
  for (let i = l.length - 1; i >= 0; i--) e[i] = e[i + 1] + l[i] * l[i] + r[i] * r[i];
  const db = (i: number) => 10 * Math.log10(e[i] / e[0]);
  let a = 0;
  while (db(a) > -5) a++;
  let b = a;
  while (db(b) > -35) b++;
  return ((b - a) / RATE) * (60 / 30);
}

/** Two one-pole low-passes at 200 Hz. */
function lowpass(x: Float64Array): Float64Array {
  const o = new Float64Array(x.length);
  const c = 1 - Math.exp((-2 * Math.PI * 200) / RATE);
  let s = 0;
  let t = 0;
  for (let i = 0; i < x.length; i++) {
    s += (x[i] - s) * c;
    t += (s - t) * c;
    o[i] = t;
  }
  return o;
}

describe('reverb (FDN, 8 lines, Householder)', () => {
  it.each([1, 3])('decays at its RT60 setting (%f s, no damping)', (decay) => {
    const rv = new Reverb(RATE);
    rv.setParams(0.6, decay, 0, 0, true);
    const { l, r } = run((i, a, b) => rv.process(i, a, b), impulse(decay * 1.6));
    const low = rt60(lowpass(l), lowpass(r));
    const broad = rt60(l, r);
    console.info(
      `reverb RT60 set ${decay} s: < 200 Hz ${low.toFixed(3)} s, broadband ${broad.toFixed(3)} s`,
    );
    expect(Math.abs(low / decay - 1)).toBeLessThan(0.05);
    // Known (docs/m6-acceptance.md): the lines' linear-interpolated fractional reads lose some
    // high end each pass, so even at damping 0 the broadband tail is 10–13 % short.
    expect(broad / decay).toBeGreaterThan(0.85);
    expect(broad / decay).toBeLessThan(1.05);
  });

  it('damping shortens the high end only; pre-delay delays the onset; renders are identical', () => {
    const hf = (damping: number) => {
      const rv = new Reverb(RATE);
      rv.setParams(0.6, 2, damping, 0, true);
      const { l } = run((i, a, b) => rv.process(i, a, b), impulse(1.5));
      // Energy of the first difference (high band) vs plain energy, 0.5–1.5 s.
      let hi = 0;
      let all = 0;
      for (let i = RATE / 2; i < l.length; i++) {
        hi += (l[i] - l[i - 1]) ** 2;
        all += l[i] ** 2;
      }
      return hi / all;
    };
    expect(hf(0.8)).toBeLessThan(0.25 * hf(0));

    const onset = (pre: number) => {
      const rv = new Reverb(RATE);
      rv.setParams(0.6, 2, 0.5, pre, true);
      const { l, r } = run((i, a, b) => rv.process(i, a, b), impulse(0.4));
      let i = 0;
      while (Math.abs(l[i]) < 1e-9 && Math.abs(r[i]) < 1e-9) i++;
      return { i, l, r };
    };
    const a = onset(0);
    const b = onset(0.1);
    expect(b.i - a.i).toBeGreaterThanOrEqual(Math.round(0.1 * RATE) - 1);
    expect(b.i - a.i).toBeLessThanOrEqual(Math.round(0.1 * RATE) + 1);
    // Deterministic: the same settings give the same tail, bit for bit; the sides differ.
    const c = onset(0);
    expect(Buffer.from(c.l.buffer).equals(Buffer.from(a.l.buffer))).toBe(true);
    let corr = 0;
    let ll = 0;
    let rr = 0;
    for (let i = 0; i < a.l.length; i++) {
      corr += a.l[i] * a.r[i];
      ll += a.l[i] ** 2;
      rr += a.r[i] ** 2;
    }
    expect(Math.abs(corr / Math.sqrt(ll * rr))).toBeLessThan(0.3);
  });
});

describe('ping-pong delay', () => {
  it('echoes left at T, right at 2T, left at 3T (× feedback, low-passed)', () => {
    const T = 0.25;
    const fb = 0.5;
    const d = new PingPongDelay(RATE);
    d.setParams(T, fb, true);
    const { l, r } = run((i, a, b) => d.process(i, a, b), impulse(4.2 * T));
    const at = (x: Float64Array, k: number) => {
      // Sum of the echo around k·T (the feedback low-pass smears it over a few samples).
      let s = 0;
      const c = Math.round(k * T * RATE);
      for (let i = c - 4; i < c + 40; i++) s += x[i];
      return s;
    };
    expect(at(l, 1)).toBeCloseTo(1, 6);
    expect(Math.abs(at(r, 1))).toBeLessThan(1e-9);
    expect(at(r, 2)).toBeCloseTo(1, 6);
    expect(Math.abs(at(l, 2))).toBeLessThan(1e-9);
    // The feedback low-pass has unity DC gain, so the echo's area is × feedback per round trip.
    expect(at(l, 3)).toBeCloseTo(fb, 3);
    expect(at(r, 4)).toBeCloseTo(fb, 3);
  });
});

describe('master tone', () => {
  const gainAt = (hz: number, tilt: number, lp: number) => {
    const tone = new Tone(RATE);
    tone.setParams(tilt, lp, true);
    const n = RATE;
    const L = new Float64Array(BLOCK_FRAMES);
    const R = new Float64Array(BLOCK_FRAMES);
    let sIn = 0;
    let sOut = 0;
    for (let f = 0; f < n; f += BLOCK_FRAMES) {
      for (let i = 0; i < BLOCK_FRAMES; i++) {
        L[i] = Math.sin((2 * Math.PI * hz * (f + i)) / RATE);
        R[i] = L[i];
      }
      const before = Float64Array.from(L);
      tone.process(L, R);
      if (f >= n / 2) {
        for (let i = 0; i < BLOCK_FRAMES; i++) {
          sIn += before[i] ** 2;
          sOut += L[i] ** 2;
        }
      }
    }
    return 10 * Math.log10(sOut / sIn);
  };

  it('low-pass: −3 dB at the cutoff, 2nd order above; flat when bypassed', () => {
    expect(gainAt(1000, 0, 1000)).toBeCloseTo(-3.01, 1);
    expect(gainAt(250, 0, 1000)).toBeGreaterThan(-0.1);
    const oct2 = gainAt(4000, 0, 1000);
    expect(oct2).toBeLessThan(-20);
    expect(oct2).toBeGreaterThan(-28);
    expect(Math.abs(gainAt(5000, 0, 24000))).toBeLessThan(0.01);
  });

  it('tilt: about tilt dB per octave around 1 kHz', () => {
    for (const tilt of [-3, 2]) {
      const lo = gainAt(250, tilt, 24000);
      const pivot = gainAt(1000, tilt, 24000);
      const hi = gainAt(4000, tilt, 24000);
      console.info(
        `tilt ${tilt}: 250 Hz ${lo.toFixed(2)}, 1 kHz ${pivot.toFixed(2)}, 4 kHz ${hi.toFixed(2)} dB`,
      );
      expect(Math.abs(pivot)).toBeLessThan(1);
      expect(Math.abs((hi - lo) / 4 - tilt)).toBeLessThan(0.35 * Math.abs(tilt));
    }
  });
});

describe('limiter', () => {
  it('looks ahead 5 ms: the output lags, and a sudden peak is already turned down when it lands', () => {
    const lim = new Limiter(RATE);
    expect(lim.delay).toBe(Math.round(0.005 * RATE));
    const n = 4 * BLOCK_FRAMES;
    const inL = new Float64Array(n);
    inL.fill(0.1);
    for (let i = 2 * BLOCK_FRAMES; i < n; i++) inL[i] = 4;
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    lim.process(inL, inL, outL, outR, n);
    const D = lim.delay;
    const ceiling = Math.pow(10, -1 / 20);
    expect(outL[D + 10]).toBeCloseTo(0.1, 6);
    // The gain starts falling D frames before the step reaches the output, and never overshoots.
    expect(outL[2 * BLOCK_FRAMES + 1] / 0.1).toBeLessThan(1);
    for (let i = 0; i < n; i++) expect(Math.abs(outL[i])).toBeLessThanOrEqual(ceiling);
    expect(outL[n - 1]).toBeGreaterThan(0.95 * ceiling);
  });
});
