/**
 * M6-a timbre depth (PLAN.md §8.4, §8.5, §15 M6): FM with its own modulator phase, breath noise
 * and the stretch/additive path, measured on offline renders (never by ear):
 * - FM sidebands at fc ± k·fm with Bessel amplitudes; non-integer ratios click-free (the §15
 *   acceptance), against an ideal FM signal and a positive control that reads the modulator off
 *   the wrapped carrier phase;
 * - stretched partial frequencies n^(1+stretch) and their amplitudes;
 * - noise level (relative to the tone) and band-pass spectrum;
 * - aliasing at the top of the range: power away from the expected components;
 * - timbre changes and table replacements to and from M6 timbres, offline = block-by-block.
 */

import { describe, expect, it, vi } from 'vitest';
import { DRY_MIX, makeScore } from '../../src/audio/fixtures/scores';
import { renderOffline } from '../../src/audio/offline';
import { tablesFor } from '../../src/audio/timbres';
import { parsePiece, TimbreSchema } from '../../src/core/schema';
import { BUILTIN_TIMBRES } from '../../src/core/timbres';
import type { CompiledScore, Timbre } from '../../src/core/types';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { TimbreExt } from '../../src/dsp/timbre-slot';
import { buildWavetables, MAX_PARTIALS, timbreParams } from '../../src/dsp/wavetable';
import { allFinite, clickScore, Driver, RATE, rms } from './helpers';
import { besselJ, peakNear, powerSpectrum, strayShare, toneAmp } from './spectrum';

vi.setConfig({ testTimeout: 60_000 });

const NYQ = RATE / 2;

/** A plain sine with nothing else on, to which each test adds one feature. */
const PLAIN: Timbre = {
  harmonics: [1],
  stretch: 0,
  brightness: { tilt: 0, track: 0 },
  detuneSpread: 0,
  accent: 0,
  articulation: { amount: 0, attack: 0.01, decay: 0.2 },
  vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
};
const fmSine = (ratio: number, index: number, indexTrack = 0): Timbre => ({
  ...PLAIN,
  fm: { ratio, index, indexTrack },
});

const hz = (p: number) => 440 * Math.pow(2, (p - 69) / 12);

/** One voice holding `pitch` for `seconds` with timbre `t`; left channel. */
function hold(t: Timbre, pitch: number, seconds = 3): Float32Array {
  const score = makeScore([{ start: pitch, timbre: 'x' }], seconds + 0.5);
  const frames = Math.ceil((seconds * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
  return renderOffline({ score, mix: DRY_MIX, timbres: { x: t }, sampleRate: RATE }, frames).left;
}

const db = (x: number) => 20 * Math.log10(x);

describe('M6 params and presets', () => {
  it('only bell and the M6-c presets use an M6 path; bell’s params are sane', () => {
    const m6 = ['bell', 'epiano', 'flute', 'marimba', 'brass'];
    for (const [name, t] of Object.entries(BUILTIN_TIMBRES)) {
      const ext = TimbreExt.of(buildWavetables(t, RATE));
      expect(ext === null, name).toBe(!m6.includes(name));
    }
    const p = timbreParams(BUILTIN_TIMBRES.bell);
    expect(p).toMatchObject({ fmRatio: 1.41, fmIndex: 0.35, noiseLevel: 0.04, stretch: 0.12 });
    expect(p.fmTop).toBeCloseTo(Math.pow(7, 1.12), 9);
    const parsed = TimbreSchema.safeParse(BUILTIN_TIMBRES.bell);
    expect(parsed.success).toBe(true);
  });

  it('the schema bounds stretch, fm and noise', () => {
    const bad = (patch: Partial<Timbre>) => !TimbreSchema.safeParse({ ...PLAIN, ...patch }).success;
    expect(bad({ stretch: 1.5 })).toBe(true);
    expect(bad({ stretch: -0.6 })).toBe(true);
    expect(bad({ fm: { ratio: 0, index: 1, indexTrack: 0 } })).toBe(true);
    expect(bad({ fm: { ratio: 40, index: 1, indexTrack: 0 } })).toBe(true);
    expect(bad({ fm: { ratio: 1.5, index: 21, indexTrack: 0 } })).toBe(true);
    expect(bad({ noise: { level: 1, bandwidth: 0 } })).toBe(true);
    expect(bad({ noise: { level: 5, bandwidth: 1 } })).toBe(true);
    expect(bad({ stretch: 0.3, fm: { ratio: 2.7, index: 3, indexTrack: 1 } })).toBe(false);
    // A piece using them round-trips through the parser.
    const piece = parsePiece({
      format: 'algorhythms',
      version: 2,
      timbres: { b: { ...PLAIN, stretch: 0.2, noise: { level: 0.3, bandwidth: 0.5 } } },
    });
    expect(piece.ok).toBe(true);
  });

  it('additive partials sit at n^(1+stretch) and are normalised to unit-sine RMS at C4', () => {
    const t: Timbre = { ...PLAIN, harmonics: [1, 0, 0.5, 0.25], stretch: 0.2 };
    const set = buildWavetables(t, RATE);
    const want = [1, Math.pow(3, 1.2), Math.pow(4, 1.2)];
    expect(set.partialRatio.length).toBe(3);
    set.partialRatio.forEach((r, i) => expect(Math.abs(r / want[i]! - 1)).toBeLessThan(1e-13));
    const P = set.partialRatio.length;
    // Mip 4 starts at 320 Hz; tilt and track are 0, so every row equals the reference.
    let power = 0;
    for (let i = 0; i < P; i++) power += set.partialAmp[4 * P + i] ** 2;
    expect(power).toBeCloseTo(1, 12);
    // At most MAX_PARTIALS partials.
    const many = buildWavetables({ ...PLAIN, harmonics: Array(32).fill(1), stretch: 0.1 }, RATE);
    expect(many.partialRatio.length).toBe(MAX_PARTIALS);
    expect(buildWavetables(PLAIN, RATE).partialRatio.length).toBe(0);
  });
});

describe('FM', () => {
  it('puts sidebands at |fc ± k·fm| with Bessel amplitudes J_k(β)', () => {
    const ratio = 1.37;
    const beta = 1.5;
    const x = hold(fmSine(ratio, beta), 57, 3);
    const from = Math.round(0.5 * RATE);
    const n = 2 * RATE;
    const c = peakNear(x, hz(57), 1.5, RATE, from, n); // detune moves it by a few cents
    const fm = ratio * c.hz;
    const rows: string[] = [];
    for (let k = -3; k <= 3; k++) {
      const f = Math.abs(c.hz + k * fm);
      const amp = toneAmp(x, f, RATE, from, n);
      const want = Math.abs(besselJ(k, beta) / besselJ(0, beta));
      rows.push(
        `k=${k} ${f.toFixed(1)} Hz ${db(amp / c.amp).toFixed(2)} dB (J ${db(want).toFixed(2)})`,
      );
      expect(Math.abs(db(amp / c.amp) - db(want)), `k=${k}`).toBeLessThan(0.3);
    }
    console.info(`FM r=${ratio} β=${beta} at ${c.hz.toFixed(2)} Hz: ${rows.join('; ')}`);
    // Nothing between the sidebands (e.g. halfway).
    const between = toneAmp(x, c.hz + 0.5 * fm, RATE, from, n);
    expect(db(between / c.amp)).toBeLessThan(-70);
  });

  it('a non-integer ratio is click-free: like ideal FM, unlike a wrapped-phase modulator', () => {
    const ratio = 1.37;
    const beta = 3;
    const x = hold(fmSine(ratio, beta), 57, 3);
    const from = Math.round(0.5 * RATE);
    const n = 2 * RATE;
    const fc = peakNear(x, hz(57), 1.5, RATE, from, n).hz;
    const level = rms(x, from, from + n);
    const ideal = new Float32Array(n);
    const naive = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      ideal[i] =
        level *
        Math.SQRT2 *
        Math.sin(2 * Math.PI * fc * t + beta * Math.sin(2 * Math.PI * ratio * fc * t));
      // The trap §8.4 warns of: sin(2π·r·φc) with φc wrapped jumps every carrier cycle.
      const pc = (fc * t) % 1;
      naive[i] =
        level * Math.SQRT2 * Math.sin(2 * Math.PI * pc + beta * Math.sin(2 * Math.PI * ratio * pc));
    }
    const score = (y: Float32Array, a: number, b: number, order: 1 | 2) =>
      clickScore(y, a, b, RATE, 0.01, 1e-3, order).ratio;
    for (const order of [1, 2] as const) {
      const eng = score(x, from, from + n, order);
      const id = score(ideal, 1, n, order);
      const nv = score(naive, 1, n, order);
      console.info(
        `FM click detector (order ${order}): engine ${eng.toFixed(3)}, ideal ${id.toFixed(3)}, wrapped-phase ${nv.toFixed(3)}`,
      );
      expect(eng).toBeLessThan(1.25 * id);
      expect(nv).toBeGreaterThan(2 * id);
    }
  });

  it('seeks, loops and glides with a non-integer ratio stay click-free', () => {
    const t = { ...fmSine(2.71, 2, 0.5), articulation: { amount: 0.3, attack: 0.01, decay: 0.6 } };
    const score: CompiledScore = makeScore(
      [0, 1, 2].map((v) => ({
        start: 50 + v * 5,
        moves: [1, 2.5, 4, 5.5, 7].map((at, k) => ({
          at,
          to: 50 + v * 5 + ((k * 3) % 7),
          len: 0.6,
        })),
        timbre: 'x',
      })),
      10,
    );
    const ref = new Driver(score, DRY_MIX, RATE, { x: t });
    ref.graph.play(0);
    ref.run(9);
    const clean = clickScore(ref.out().left, 480).ratio;
    const s = new Driver(score, DRY_MIX, RATE, { x: t });
    s.graph.setLoop(3, 6.3);
    s.graph.play(0);
    const events: number[] = [];
    s.run(2);
    events.push(s.frames / RATE);
    s.graph.seek(4.4);
    s.run(1);
    events.push(s.frames / RATE);
    s.graph.seek(3.2);
    s.run(6); // loops at 6.3 → 3
    const out = s.out().left;
    let worst = 0;
    for (const e of events) {
      worst = Math.max(
        worst,
        clickScore(out, Math.floor((e - 0.03) * RATE), Math.floor((e + 0.06) * RATE)).ratio,
      );
    }
    worst = Math.max(worst, clickScore(out, Math.floor(3 * RATE), out.length).ratio);
    console.info(`FM r=2.71 transport: clean ${clean.toFixed(3)}, worst ${worst.toFixed(3)}`);
    expect(allFinite(out)).toBe(true);
    expect(worst).toBeLessThanOrEqual(2 * clean);
  });

  it('indexTrack lowers β by 2^(−track) per octave', () => {
    const at = (p: number) => {
      const x = hold(fmSine(2.5, 1, 1), p, 2);
      const from = Math.round(0.5 * RATE);
      const n = RATE;
      const c = peakNear(x, hz(p), 1.5, RATE, from, n);
      const s1 = toneAmp(x, 3.5 * c.hz, RATE, from, n);
      return s1 / c.amp; // J1(β)/J0(β)
    };
    const ratioC4 = at(60);
    const ratioC5 = at(72);
    const want = (b: number) => besselJ(1, b) / besselJ(0, b);
    console.info(
      `FM indexTrack 1: J1/J0 at C4 ${db(ratioC4).toFixed(2)} dB (β 1: ${db(want(1)).toFixed(2)}), ` +
        `C5 ${db(ratioC5).toFixed(2)} dB (β 0.5: ${db(want(0.5)).toFixed(2)})`,
    );
    expect(Math.abs(db(ratioC4) - db(want(1)))).toBeLessThan(0.3);
    expect(Math.abs(db(ratioC5) - db(want(0.5)))).toBeLessThan(0.3);
  });
});

/** Expected components of FM on partials R_i·fc: |R_i·fc + k·fm| below Nyquist. */
function fmComponents(fc: number, ratios: number[], fm: number): number[] {
  const out: number[] = [];
  for (const r of ratios) {
    for (let k = -60; k <= 60; k++) {
      const f = Math.abs(r * fc + k * fm);
      if (f < NYQ) out.push(f);
    }
  }
  return out;
}

describe('aliasing at the top of the range', () => {
  const N = 65536;
  const from = Math.round(0.3 * RATE);

  it('FM: the index cap keeps folded sidebands under −40 dB (uncapped: far above)', () => {
    const ratio = 1.41;
    const rows: string[] = [];
    for (const p of [96, 100, 106]) {
      const x = hold(fmSine(ratio, 5), p, 2);
      const fc = peakNear(x, hz(p), 0.004 * hz(p), RATE, from, 16384).hz;
      const stray = strayShare(powerSpectrum(x, from, N), fmComponents(fc, [1], ratio * fc), RATE);
      rows.push(`p${p} ${db(Math.sqrt(stray)).toFixed(1)} dB`);
      expect(db(Math.sqrt(stray)), `p${p}`).toBeLessThan(-40);
    }
    // Positive control: the same FM without the cap, sampled directly.
    const fc = hz(100);
    const raw = new Float64Array(N + from);
    for (let i = 0; i < raw.length; i++) {
      const t = i / RATE;
      raw[i] = Math.sin(2 * Math.PI * fc * t + 5 * Math.sin(2 * Math.PI * ratio * fc * t));
    }
    const strayRaw = strayShare(
      powerSpectrum(raw, from, N),
      fmComponents(fc, [1], ratio * fc),
      RATE,
    );
    console.info(
      `FM stray power: ${rows.join(', ')}; uncapped p100 ${db(Math.sqrt(strayRaw)).toFixed(1)} dB`,
    );
    expect(db(Math.sqrt(strayRaw))).toBeGreaterThan(-25);
  });

  it('bell and a 16-partial stretch: partials past Nyquist are skipped, nothing folds', () => {
    const rich: Timbre = { ...PLAIN, harmonics: Array(16).fill(0.5), stretch: 0.3 };
    const rows: string[] = [];
    for (const [name, t, p] of [
      ['bell', BUILTIN_TIMBRES.bell, 100],
      ['bell', BUILTIN_TIMBRES.bell, 108],
      ['stretch16', rich, 96],
    ] as const) {
      // No noise, and no strike: a decaying envelope would widen every line past the guard.
      const noiseless = { ...t, noise: undefined, articulation: PLAIN.articulation };
      const x = hold(noiseless, p, 2);
      const fc = peakNear(x, hz(p), 0.004 * hz(p), RATE, from, 16384).hz;
      const set = buildWavetables(noiseless, RATE);
      const ratios = Array.from(set.partialRatio);
      const comps = t.fm ? fmComponents(fc, ratios, t.fm.ratio * fc) : ratios.map((r) => r * fc);
      const stray = strayShare(powerSpectrum(x, from, N), comps, RATE);
      rows.push(`${name} p${p} ${db(Math.sqrt(stray)).toFixed(1)} dB`);
      expect(db(Math.sqrt(stray)), `${name} p${p}`).toBeLessThan(-40);
    }
    console.info(`additive stray power: ${rows.join(', ')}`);
  });
});

describe('stretch (additive path)', () => {
  it('renders partials at fc·n^(1+stretch) with their relative amplitudes', () => {
    const stretch = 0.1;
    const t: Timbre = { ...PLAIN, harmonics: [1, 0.5, 0.3, 0.2], stretch };
    const x = hold(t, 57, 4);
    const from = Math.round(0.5 * RATE);
    const n = 3 * RATE;
    const f1 = peakNear(x, hz(57), 1.5, RATE, from, n);
    const rows: string[] = [];
    for (let k = 2; k <= 4; k++) {
      const want = f1.hz * Math.pow(k, 1 + stretch);
      const got = peakNear(x, want, 2, RATE, from, n);
      rows.push(
        `n${k} ${got.hz.toFixed(3)} Hz (want ${want.toFixed(3)}), ${db(got.amp / f1.amp).toFixed(2)} dB`,
      );
      expect(Math.abs(got.hz / want - 1), `n=${k}`).toBeLessThan(2e-5);
      expect(Math.abs(db(got.amp / f1.amp) - db(t.harmonics[k - 1])), `n=${k}`).toBeLessThan(0.1);
    }
    console.info(`stretch ${stretch} at ${f1.hz.toFixed(3)} Hz: ${rows.join('; ')}`);
  });

  it('has the RMS of the same timbre on the wavetable path (both unit-sine at C4)', () => {
    const t: Timbre = { ...PLAIN, harmonics: [1, 0.5, 0.3, 0.2], stretch: 0 };
    const a = hold(t, 60, 2);
    const b = hold({ ...t, stretch: 0.05 }, 60, 2);
    const from = Math.round(0.5 * RATE);
    const ra = rms(a, from, a.length);
    const rb = rms(b, from, b.length);
    expect(Math.abs(db(rb / ra))).toBeLessThan(0.2);
  });
});

describe('breath noise', () => {
  const noisy = (level: number, bandwidth: number): Timbre => ({
    ...PLAIN,
    harmonics: [],
    noise: { level, bandwidth },
  });

  it('sits at `level` × the tone RMS, for narrow and wide bands', () => {
    const from = Math.round(0.5 * RATE);
    const tone = hold(PLAIN, 69, 3);
    const toneRms = rms(tone, from, tone.length);
    const rows: string[] = [];
    for (const [level, bw, p] of [
      [1, 0.25, 69],
      [1, 1, 69],
      [0.5, 2, 57],
      [1, 0.5, 96],
    ] as const) {
      const x = hold(noisy(level, bw), p, 3);
      const r = rms(x, from, x.length);
      // Same voice, same loudness tilt: compare against the tone at the same pitch.
      const ref = p === 69 ? toneRms : rms(hold(PLAIN, p, 3), from, x.length);
      rows.push(`L${level} bw${bw} p${p}: ${db(r / (level * ref)).toFixed(2)} dB`);
      expect(Math.abs(db(r / (level * ref))), `bw ${bw} p${p}`).toBeLessThan(1);
    }
    console.info(`noise level vs tone: ${rows.join(', ')}`);
  });

  it('is band-passed around f: half its power inside f·(1 ± bw/2), far less off-centre', () => {
    const N = 65536;
    const from = Math.round(0.5 * RATE);
    const bw = 0.3;
    const x = hold(noisy(1, bw), 69, 2);
    const p = powerSpectrum(x, from, N);
    const binHz = RATE / N;
    /** Power in a band of the −3 dB width centred on `c` Hz. */
    const band = (c: number) => {
      let s = 0;
      for (let k = 1; k < p.length; k++) {
        const f = k * binHz;
        if (f >= c - (440 * bw) / 2 && f <= c + (440 * bw) / 2) s += p[k];
      }
      return s;
    };
    let total = 0;
    for (let k = 1; k < p.length; k++) total += p[k];
    const inside = band(440);
    const below = band(440 * 0.6);
    const above = band(440 * 1.6);
    console.info(
      `noise bw ${bw} at 440 Hz: ${((100 * inside) / total).toFixed(1)} % inside the −3 dB band; ` +
        `bands at 0.6 f and 1.6 f ${db(Math.sqrt(below / inside)).toFixed(1)} / ${db(Math.sqrt(above / inside)).toFixed(1)} dB`,
    );
    expect(inside / total).toBeGreaterThan(0.4);
    expect(inside / total).toBeLessThan(0.6);
    // A two-pole band-pass with Q ≈ 3.3 is ~10 dB down there.
    expect(db(Math.sqrt(below / inside))).toBeLessThan(-7);
    expect(db(Math.sqrt(above / inside))).toBeLessThan(-7);
  });

  it('is seeded: identical renders, uncorrelated noise per voice', () => {
    const a = hold(noisy(1, 1), 69, 1);
    const b = hold(noisy(1, 1), 69, 1);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    // Two voices on one pitch, hard left and hard right: the channels are the two voices.
    const score = makeScore(
      [
        { start: 69, timbre: 'x', pan: -1 },
        { start: 69, timbre: 'x', pan: 1 },
      ],
      2,
    );
    const frames = Math.round(RATE / BLOCK_FRAMES) * BLOCK_FRAMES;
    const out = renderOffline(
      { score, mix: DRY_MIX, timbres: { x: noisy(1, 1) }, sampleRate: RATE },
      frames,
    );
    const from = Math.round(0.3 * RATE);
    let lr = 0;
    let ll = 0;
    let rr = 0;
    for (let i = from; i < frames; i++) {
      lr += out.left[i] * out.right[i];
      ll += out.left[i] ** 2;
      rr += out.right[i] ** 2;
    }
    const corr = lr / Math.sqrt(ll * rr);
    console.info(`noise: correlation between two voices ${corr.toFixed(4)}`);
    expect(Math.abs(corr)).toBeLessThan(0.05);
  });
});

describe('M6 timbre changes and table swaps', () => {
  const fmx = fmSine(2.71, 2.5, 0.3);

  it('timbre crossfades glass → bell → FM → noise stay click-free', () => {
    const changes = [
      { t: 0, preset: 'glass', fade: 0 },
      { t: 2, preset: 'bell', fade: 0.05 },
      { t: 4, preset: 'fmx', fade: 0.03 },
      { t: 6, preset: 'breath', fade: 0.05 },
    ];
    const score = makeScore([{ start: 57, timbre: changes }], 8);
    const timbres = {
      fmx,
      breath: { ...BUILTIN_TIMBRES.reed, noise: { level: 0.4, bandwidth: 0.8 } },
    };
    const frames = Math.ceil((7.5 * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
    const out = renderOffline({ score, mix: DRY_MIX, timbres, sampleRate: RATE }, frames).left;
    expect(allFinite(out)).toBe(true);
    let steady = 0;
    for (const a of [0.5, 2.5, 4.5, 6.5]) {
      steady = Math.max(
        steady,
        clickScore(out, Math.floor(a * RATE), Math.floor((a + 1) * RATE)).ratio,
      );
    }
    let worst = 0;
    for (const c of changes.slice(1)) {
      worst = Math.max(
        worst,
        clickScore(out, Math.floor((c.t - 0.03) * RATE), Math.floor((c.t + 0.1) * RATE)).ratio,
      );
    }
    console.info(
      `timbre changes: steady ${steady.toFixed(3)}, worst at a change ${worst.toFixed(3)}`,
    );
    expect(worst).toBeLessThanOrEqual(2 * steady);
  });

  it('replacing tables mid-note (plain → FM → bell → plain) crossfades without a click', () => {
    const score = makeScore(
      [
        { start: 57, timbre: 'x' },
        { start: 64, timbre: 'x' },
      ],
      8,
    );
    const d = new Driver(score, DRY_MIX, RATE, { x: BUILTIN_TIMBRES.glass });
    d.graph.play(0);
    const swaps: number[] = [];
    d.run(1.5);
    for (const t of [fmx, BUILTIN_TIMBRES.bell, BUILTIN_TIMBRES.organ]) {
      swaps.push(d.frames / RATE);
      d.graph.setTables('x', tablesFor(t, RATE));
      d.run(1.5);
    }
    const out = d.out().left;
    let steady = 0;
    for (const a of [0.5, 2.1, 3.6, 5.1]) {
      steady = Math.max(
        steady,
        clickScore(out, Math.floor(a * RATE), Math.floor((a + 0.8) * RATE)).ratio,
      );
    }
    let worst = 0;
    for (const s of swaps) {
      worst = Math.max(
        worst,
        clickScore(out, Math.floor((s - 0.02) * RATE), Math.floor((s + 0.06) * RATE)).ratio,
      );
    }
    console.info(`table swaps: steady ${steady.toFixed(3)}, worst at a swap ${worst.toFixed(3)}`);
    expect(worst).toBeLessThanOrEqual(2 * steady);
  });

  it('offline render equals block-by-block playback (the live host) for M6 timbres', () => {
    const score = makeScore(
      [
        { start: 57, moves: [{ at: 1, to: 62, len: 0.7 }], timbre: 'bell' },
        { start: 64, moves: [{ at: 1.5, to: 60, len: 0.5 }], timbre: 'fmx' },
      ],
      4,
    );
    const timbres = { fmx: { ...fmx, noise: { level: 0.2, bandwidth: 1 } } };
    const frames = Math.ceil((3 * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
    const off = renderOffline({ score, mix: DRY_MIX, timbres, sampleRate: RATE }, frames);
    const d = new Driver(score, DRY_MIX, RATE, timbres);
    d.graph.play(0);
    d.run(3);
    const live = d.out();
    expect(
      Buffer.from(off.left.buffer).equals(Buffer.from(live.left.buffer.slice(0, frames * 4))),
    ).toBe(true);
    expect(
      Buffer.from(off.right.buffer).equals(Buffer.from(live.right.buffer.slice(0, frames * 4))),
    ).toBe(true);
  });
});
