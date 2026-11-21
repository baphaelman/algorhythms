/**
 * Bell redesign (docs/build-log.md, "Bell redesign"), measured on offline renders, never by ear:
 * - struck partials (`Timbre.strikePartials`) ring at their own decay from each strike, follow a
 *   seek, and fade out near Nyquist; the FM index envelope (`fm.held`) follows the articulation;
 * - both are off by default: a timbre that spells out the defaults renders bit for bit the same;
 * - the bell candidates on a held 4-voice chord: off-harmonic power while held (beating, the
 *   owner's "sour"), at the strike, and level against glass.
 */

import { describe, expect, it, vi } from 'vitest';
import { DRY_MIX, M6A_BELL, makeScore, type VoiceSpec } from '../../src/audio/fixtures/scores';
import { renderOffline } from '../../src/audio/offline';
import { BUILTIN_TIMBRES } from '../../src/core/timbres';
import type { Timbre } from '../../src/core/types';
import { BLOCK_FRAMES, LIMITER_LOOKAHEAD } from '../../src/dsp/constants';
import { TimbreExt } from '../../src/dsp/timbre-slot';
import { buildWavetables } from '../../src/dsp/wavetable';
import { Driver, RATE, rms } from './helpers';
import { besselJ, peakNear, powerSpectrum, strayShare, toneAmp } from './spectrum';

vi.setConfig({ testTimeout: 60_000 });

const NYQ = RATE / 2;
const db = (x: number) => 20 * Math.log10(x);
const hz = (p: number) => 440 * Math.pow(2, (p - 69) / 12);
const frames = (s: number) => Math.ceil((s * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;

const PLAIN: Timbre = {
  harmonics: [1],
  stretch: 0,
  brightness: { tilt: 0, track: 0 },
  detuneSpread: 0,
  accent: 0,
  articulation: { amount: 0, attack: 0.01, decay: 0.5, crisp: true },
  vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
};

/**
 * The candidates rendered for the owner (renders/bell/), besides the M6-a bell ("0-current").
 * `1-church` is the built-in `bell`.
 */
export const BELL_CANDIDATES: Record<string, Timbre> = {
  /** Church bell: hum, tierce, quint and upper partials struck over a harmonic tone. */
  '1-church': BUILTIN_TIMBRES.bell,
  /** DX-style: FM 3.5:1 whose index rings down with the strike (`held` 0) over a harmonic tone. */
  '2-fm-strike': {
    harmonics: [1, 0.35, 0.1, 0.12],
    stretch: 0,
    fm: { ratio: 3.5, index: 2.4, indexTrack: 0.6, held: 0 },
    brightness: { tilt: -1.5, track: 0.4 },
    detuneSpread: 1,
    accent: 0.1,
    articulation: { amount: 0.45, attack: 0.002, decay: 1.8, crisp: true },
    vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
  },
  /** Glass held (the glass preset's partials and vibrato), struck like a metal bar. */
  '3-glass-bell': {
    harmonics: [1, 0.06, 0.22, 0.03, 0.1, 0.02, 0.05, 0, 0.025],
    stretch: 0,
    strikePartials: [
      { ratio: 2, amp: 0.25, decay: 1.5 },
      { ratio: 2.756, amp: 0.55, decay: 1.6 },
      { ratio: 5.404, amp: 0.3, decay: 0.8 },
      { ratio: 8.933, amp: 0.15, decay: 0.4 },
      { ratio: 13.34, amp: 0.08, decay: 0.15 },
    ],
    brightness: { tilt: -1.5, track: 0.3 },
    detuneSpread: 1,
    accent: 0.25,
    articulation: { amount: 0.4, attack: 0.002, decay: 1.2, crisp: true },
    vibrato: { rate: 4.2, depthCents: 4, delay: 0.6 },
  },
};

/** One voice holding `pitch` (struck at birth); left channel. */
function hold(t: Timbre, pitch: number, seconds: number): Float32Array {
  const score = makeScore([{ start: pitch, pan: 0, timbre: 'x' }], seconds + 0.5);
  return renderOffline(
    { score, mix: DRY_MIX, timbres: { x: t }, sampleRate: RATE },
    frames(seconds),
  ).left;
}

/**
 * Hann-weighted mean of e^(−ln100·(t − attack)/decay) over output frames [from, from + n) (the
 * output lags piece time by the limiter's lookahead).
 */
function meanEnv(from: number, n: number, attack: number, decay: number): number {
  let s = 0;
  let w = 0;
  for (let i = 0; i < n; i++) {
    const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const t = (from + i) / RATE - LIMITER_LOOKAHEAD;
    s += h * Math.exp((-Math.log(100) * (t - attack)) / decay);
    w += h;
  }
  return s / w;
}

describe('struck partials and the FM index envelope', () => {
  it('leave a timbre that spells out the defaults bit for bit the same', () => {
    const fm: Timbre = { ...PLAIN, fm: { ratio: 1.37, index: 1.5, indexTrack: 0.3 } };
    const same = (a: Timbre, b: Timbre) => {
      const x = hold(a, 57, 1.5);
      const y = hold(b, 57, 1.5);
      return Buffer.from(x.buffer).equals(Buffer.from(y.buffer));
    };
    expect(same(fm, { ...fm, fm: { ...fm.fm!, held: 1 } })).toBe(true);
    expect(same(fm, { ...fm, strikePartials: [] })).toBe(true);
    const glass = BUILTIN_TIMBRES.glass;
    const silent = { ...glass, strikePartials: [{ ratio: 2.7, amp: 0, decay: 1 }] };
    expect(TimbreExt.of(buildWavetables(silent, RATE))).toBeNull();
    expect(same(glass, silent)).toBe(true);
  });

  it('ring from the strike at their own decay, relative to the tone', () => {
    const parts = [
      { ratio: 2.76, amp: 0.5, decay: 1 },
      { ratio: 5.4, amp: 0.25, decay: 0.4 },
    ];
    const x = hold({ ...PLAIN, strikePartials: parts }, 60, 1.5);
    const attack = 0.012; // MIN_ARTICULATION_ATTACK (crisp)
    const n = 4800;
    const f0 = peakNear(x, hz(60), 1, RATE, 24000, 24000).hz;
    const rows: string[] = [];
    for (const p of parts) {
      for (const t of [0.1, 0.3, 0.6]) {
        const from = Math.round(t * RATE);
        const got = toneAmp(x, p.ratio * f0, RATE, from, n) / toneAmp(x, f0, RATE, from, n);
        const want = p.amp * meanEnv(from, n, attack, p.decay);
        rows.push(`${p.ratio}@${t}s ${db(got / want).toFixed(3)} dB`);
        expect(Math.abs(db(got / want)), `${p.ratio} at ${t} s`).toBeLessThan(0.02);
      }
    }
    console.info(`struck partials vs amp·e^(−ln100·τ/decay): ${rows.join(', ')}`);
  });

  it('a seek mid-ring lands on the same envelope', () => {
    const t: Timbre = { ...PLAIN, strikePartials: [{ ratio: 2.76, amp: 0.5, decay: 1.5 }] };
    const score = makeScore([{ start: 60, pan: 0, timbre: 'x' }], 3);
    const full = renderOffline(
      { score, mix: DRY_MIX, timbres: { x: t }, sampleRate: RATE },
      frames(1.2),
    ).left;
    const d = new Driver(score, DRY_MIX, RATE, { x: t });
    d.graph.play(0);
    d.run(0.2);
    d.graph.seek(0.7);
    d.run(0.5);
    const live = d.out().left;
    const f = 2.76 * hz(60);
    const n = 4800;
    const a = toneAmp(full, f, RATE, Math.round(0.9 * RATE), n);
    const b = toneAmp(live, f, RATE, Math.round(0.4 * RATE), n);
    expect(Math.abs(db(b / a))).toBeLessThan(0.05);
  });

  it('fade out near Nyquist, so nothing folds at the top of the range', () => {
    // Long decays keep the lines narrow; the bell's ratios.
    const parts = BUILTIN_TIMBRES.bell.strikePartials!.map((p) => ({ ...p, decay: 60 }));
    const t: Timbre = { ...PLAIN, harmonics: [1, 0.4], strikePartials: parts };
    const rows: string[] = [];
    for (const p of [96, 100, 108]) {
      const x = hold(t, p, 2);
      const from = Math.round(0.3 * RATE);
      const fc = peakNear(x, hz(p), 0.004 * hz(p), RATE, from, 16384).hz;
      const comps = [fc, 2 * fc, ...parts.map((q) => q.ratio * fc)].filter((f) => f < NYQ);
      const stray = strayShare(powerSpectrum(x, from, 65536), comps, RATE);
      rows.push(`p${p} ${db(Math.sqrt(stray)).toFixed(1)} dB`);
      expect(db(Math.sqrt(stray)), `p${p}`).toBeLessThan(-50);
    }
    console.info(`struck partials, stray power: ${rows.join(', ')}`);
  });

  it('the FM index rings down to its held share with the articulation', () => {
    const rows: string[] = [];
    for (const held of [0, 0.5]) {
      const t: Timbre = {
        ...PLAIN,
        fm: { ratio: 3.5, index: 2, indexTrack: 0, held },
        articulation: { amount: 0, attack: 0.01, decay: 0.4, crisp: true },
      };
      const x = hold(t, 60, 3);
      const n = 32768;
      const from = Math.round(2 * RATE);
      const fc = peakNear(x, hz(60), 1, RATE, from, n).hz;
      // Carrier fc, sideband fc + 3.5·fc: J1(β)/J0(β) with β the held index.
      const side = toneAmp(x, 4.5 * fc, RATE, from, n) / toneAmp(x, fc, RATE, from, n);
      const beta = 2 * held;
      const want = Math.abs(besselJ(1, beta) / besselJ(0, beta));
      rows.push(`held ${held}: J1/J0 ${db(side).toFixed(2)} dB (want ${db(want).toFixed(2)})`);
      if (held === 0) expect(db(side)).toBeLessThan(-80);
      else expect(Math.abs(db(side / want))).toBeLessThan(0.1);
      // Just after the strike (β ≈ 1.4 here) the sideband is far above its held level.
      const early = toneAmp(x, 4.5 * fc, RATE, Math.round(0.02 * RATE), 2048);
      const earlyC = toneAmp(x, fc, RATE, Math.round(0.02 * RATE), 2048);
      expect(db(early / earlyC)).toBeGreaterThan(Math.max(-20, db(want) + 4));
    }
    console.info(`FM index envelope after 2 s: ${rows.join('; ')}`);
  });

  it('offline render equals block-by-block playback with both', () => {
    const timbres = {
      fmh: { ...PLAIN, fm: { ratio: 3.5, index: 2, indexTrack: 0.5, held: 0.2 } },
    };
    const score = makeScore(
      [
        { start: 57, moves: [{ at: 0.6, to: 62, len: 0.5 }], timbre: 'bell' },
        { start: 64, moves: [{ at: 1, to: 60, len: 0.4 }], timbre: 'fmh' },
      ],
      3,
    );
    const n = frames(2);
    const off = renderOffline({ score, mix: DRY_MIX, timbres, sampleRate: RATE }, n);
    const d = new Driver(score, DRY_MIX, RATE, timbres);
    d.graph.play(0);
    d.run(2);
    const live = d.out();
    expect(Buffer.from(off.left.buffer).equals(Buffer.from(live.left.buffer.slice(0, n * 4)))).toBe(
      true,
    );
  });
});

/** The owner's chord: C major held, a glide to F/A at 4–5.2 s (a re-strike), back at 8.5 s. */
const CHORD: VoiceSpec[] = [
  [48, 53, 48],
  [55, 57, 55],
  [64, 65, 64],
  [72, 69, 72],
].map((p) => ({
  start: p[0],
  moves: [
    { at: 4, to: p[1], len: 1.2 },
    { at: 8.5, to: p[2], len: 0.8 },
  ],
  timbre: 'x',
}));

function chord(t: Timbre): Float32Array {
  const score = makeScore(CHORD, 12);
  const o = renderOffline({ score, mix: DRY_MIX, timbres: { x: t }, sampleRate: RATE }, frames(12));
  const m = new Float32Array(o.left.length);
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * (o.left[i] + o.right[i]);
  return m;
}

/** Share of power off every harmonic of the given fundamentals (measured from the render). */
function offHarmonic(x: Float32Array, from: number, n: number, pitches: number[]): number {
  const comps: number[] = [];
  for (const p of pitches) {
    const f = peakNear(x, hz(p), 0.01 * hz(p), RATE, from, n).hz;
    for (let k = 1; k * f < NYQ; k++) comps.push(k * f);
  }
  return strayShare(powerSpectrum(x, from, n), comps, RATE, 12);
}

describe('bell candidates (renders/bell/, owner)', () => {
  it('held chords stay in tune, the strike is inharmonic, the level sits near glass', () => {
    const all: Record<string, Timbre> = { '0-current': M6A_BELL, ...BELL_CANDIDATES };
    const glassLevel = db(rms(chord(BUILTIN_TIMBRES.glass), 0, 12 * RATE));
    const rows: string[] = [];
    for (const [name, t] of Object.entries(all)) {
      const x = chord(t);
      // Held C major 2.5–3.9 s, after the strike at 0.
      const held = offHarmonic(x, Math.round(2.5 * RATE), 65536, [48, 55, 64, 72]);
      const level = db(rms(x, 0, 12 * RATE)) - glassLevel;
      const one = hold({ ...t, noise: undefined }, 60, 3.2);
      const strike = offHarmonic(one, Math.round(0.01 * RATE), 16384, [60]);
      const late = offHarmonic(one, Math.round(2.5 * RATE), 32768, [60]);
      rows.push(
        `${name}: held off-harmonic ${(100 * held).toFixed(2)} %, strike ${(100 * strike).toFixed(1)} % → ` +
          `${(100 * late).toFixed(2)} % at 2.5 s, level vs glass ${level >= 0 ? '+' : ''}${level.toFixed(2)} dB`,
      );
      if (name === '0-current') {
        expect(held).toBeGreaterThan(0.25); // the diagnosis: stretched partials held
        continue;
      }
      expect(held, name).toBeLessThan(0.02);
      expect(strike, name).toBeGreaterThan(0.1);
      expect(late, name).toBeLessThan(0.02);
      expect(Math.abs(level), name).toBeLessThan(3);
    }
    console.info(`bell candidates: ${rows.join('; ')}`);
  });
});
