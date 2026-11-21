/**
 * Timbre moments in the engine (M6-b2; PLAN.md §6.2 `timbre`, §8.5, §8.11, §15 M6): the mix of a
 * voice's timbre timeline (a change arriving mid-fade starts from the mix sounding then; a seek
 * or birth mid-fade starts on the mix), the crossfade's gain law (no dip or bump), clicks across
 * synthesis paths, a missing table, the unison lock with locked voices changing apart, no
 * re-strike, hot swaps, and offline = live.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DRY_MIX,
  FIXTURE_MIX,
  M6A_BELL,
  makeScore,
  timbreMomentScore,
  type VoiceSpec,
} from '../../src/audio/fixtures/scores';
import { createLoadedGraph, renderOffline } from '../../src/audio/offline';
import { tablesFor } from '../../src/audio/timbres';
import { flatten } from '../../src/core/flat';
import { BUILTIN_TIMBRES } from '../../src/core/timbres';
import type { CompiledScore, Timbre, TimbreChange } from '../../src/core/types';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { Graph } from '../../src/dsp/graph';
import type { TimbreSlot } from '../../src/dsp/timbre-slot';
import { fmLimits, VoiceData } from '../../src/dsp/voice';
import {
  besselJ,
  COH_NOISE,
  COH_PER_OCTAVE,
  COH_REST,
  COH_STRIDE,
  FM_ALIAS_LIMIT,
  FM_SIDEBAND_MARGIN,
  FM_TRACK_MAX_OCT,
  FM_TRACK_MIN_OCT,
  MAX_HARMONICS,
} from '../../src/dsp/wavetable';
import { clickScore, RATE } from './helpers';

vi.setConfig({ testTimeout: 60_000 });

type Out = { left: Float32Array; right: Float32Array };

/** A preset without articulation, vibrato or drift: a steady tone at its tables' own level. */
function steady(t: Timbre): Timbre {
  return {
    ...t,
    articulation: { ...t.articulation, amount: 0 },
    vibrato: { ...t.vibrato, depthCents: 0 },
    drift: undefined,
  };
}

const frames = (s: number) => Math.ceil((s * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;

/** Renders specs block by block from 0; `strip` removes the coherence rows (constant amplitude). */
function renderSpecs(
  specs: VoiceSpec[],
  timbres: Record<string, Timbre>,
  seconds: number,
  strip = false,
): Out {
  const g = createLoadedGraph({
    score: makeScore(specs, seconds + 1),
    mix: DRY_MIX,
    timbres,
    sampleRate: RATE,
  });
  if (strip) {
    for (const name of Object.keys(timbres)) {
      const set = { ...tablesFor(timbres[name], RATE) };
      delete set.coherence;
      g.setTables(name, set, 0);
    }
  }
  g.play(0);
  return drive(g, seconds);
}

function drive(g: Graph, seconds: number): Out {
  const n = frames(seconds);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const bl = new Float32Array(BLOCK_FRAMES);
  const br = new Float32Array(BLOCK_FRAMES);
  for (let f = 0; f < n; f += BLOCK_FRAMES) {
    g.process(bl, br);
    left.set(bl, f);
    right.set(br, f);
  }
  return { left, right };
}

/** Level (dB, both channels) of [t, t + win) seconds. */
function level(o: Out, t: number, win: number): number {
  const a = Math.floor(t * RATE);
  const b = Math.floor((t + win) * RATE);
  let s = 0;
  for (let i = a; i < b; i++) s += o.left[i] ** 2 + o.right[i] ** 2;
  return 10 * Math.log10(s / (b - a) + 1e-30);
}

/**
 * Worst deviation (dB) of the level during a fade at [at, at + fade] from the power moving in a
 * straight line between the levels before and after (0.5 s each, 0.1 s windows).
 */
function fadeDeviation(o: Out, at: number, fade: number): number {
  const before = level(o, at - 0.5, 0.5);
  const after = level(o, at + fade, 0.5);
  const p0 = 10 ** (before / 10);
  const p1 = 10 ** (after / 10);
  let worst = 0;
  for (let t = at; t < at + fade - 1e-9; t += 0.1) {
    const x = (t + 0.05 - at) / fade;
    const d = level(o, t, 0.1) - 10 * Math.log10(p0 + (p1 - p0) * x);
    if (Math.abs(d) > Math.abs(worst)) worst = d;
  }
  return worst;
}

function changes(...list: [number, string, number][]): TimbreChange[] {
  return list.map(([t, preset, fade]) => ({ t, preset, fade }));
}

/** Worst click ratio within [e − 30 ms, e + 60 ms] of each time, and the clean reference. */
function clicks(x: Float32Array, at: number[], steadyAt: number[]): { worst: number; ref: number } {
  let worst = 0;
  for (const e of at)
    worst = Math.max(
      worst,
      clickScore(x, Math.floor((e - 0.03) * RATE), Math.floor((e + 0.06) * RATE)).ratio,
    );
  let ref = 0;
  for (const a of steadyAt)
    ref = Math.max(ref, clickScore(x, Math.floor(a * RATE), Math.floor((a + 0.4) * RATE)).ratio);
  return { worst, ref };
}

describe('coherence rows', () => {
  it('the voice copies the FM limits of wavetable.ts', () => {
    expect(fmLimits()).toEqual([
      FM_ALIAS_LIMIT,
      FM_SIDEBAND_MARGIN,
      FM_TRACK_MIN_OCT,
      FM_TRACK_MAX_OCT,
    ]);
  });

  it('besselJ matches tabulated values', () => {
    const J = new Float64Array(12);
    besselJ(1.4, 4, J);
    expect(J[0]).toBeCloseTo(0.5668551203, 9);
    expect(J[1]).toBeCloseTo(0.5419477139, 9);
    expect(J[2]).toBeCloseTo(0.2073558995, 9);
    besselJ(10, 10, J);
    expect(J[0]).toBeCloseTo(-0.2459357645, 9);
    expect(J[5]).toBeCloseTo(-0.2340615282, 9);
    expect(J[10]).toBeCloseTo(0.2074861066, 9);
    besselJ(0, 3, J);
    expect(Array.from(J.slice(0, 4))).toEqual([1, 0, 0, 0]);
  });

  it('a sine is one phase-locked harmonic; FM 1:1 folds its lower sidebands onto it', () => {
    const sine = tablesFor(BUILTIN_TIMBRES.sine, RATE).coherence!;
    const m = 4; // 320 Hz
    const o = m * COH_PER_OCTAVE * COH_STRIDE;
    expect(sine[o]).toBeCloseTo(1, 12);
    expect(sine[o + 1]).toBeCloseTo(0, 12);
    expect(sine[o + COH_REST]).toBeCloseTo(0, 12);
    // epiano: sin(φ + β sin φ) = Σ J_k(β) sin((1 + k)φ); harmonic 1 gets J0 − J2.
    const ep = tablesFor(BUILTIN_TIMBRES.epiano, RATE);
    const beta = 1.4 * 2 ** (-0.6 * Math.log2((20 * 2 ** m) / 261.6255653005986));
    const J = new Float64Array(8);
    besselJ(beta, 6, J);
    const c = ep.coherence!;
    expect(c[o]).toBeCloseTo(J[0] - J[2], 9);
    expect(c[o + 2]).toBeCloseTo(J[1] + J[3], 9);
    let p = c[o + COH_REST] + c[o + COH_NOISE] ** 2;
    for (let i = 0; i < 2 * MAX_HARMONICS; i++) p += c[o + i] ** 2;
    expect(p).toBeLessThan(1);
  });

  it('predicts each preset’s level against the sine within 0.3 dB', () => {
    let worst = 0;
    const names = Object.keys(BUILTIN_TIMBRES);
    for (const pitch of [48, 60, 72]) {
      const lv = (name: string) => {
        const o = renderSpecs(
          [{ start: pitch, timbre: 'x', pan: 0 }],
          { x: steady(BUILTIN_TIMBRES[name]) },
          2,
        );
        return level(o, 1, 1);
      };
      const sine = lv('sine');
      for (const name of names) {
        // Predicted: the coherence row's power at the voice's mip position.
        const set = tablesFor(steady(BUILTIN_TIMBRES[name]), RATE);
        const f = 440 * 2 ** ((pitch - 69) / 12);
        const pos = Math.log2(f / 20) * COH_PER_OCTAVE;
        const m = Math.floor(pos);
        const w = pos - m;
        const c = set.coherence!;
        const row = (k: number) =>
          c[m * COH_STRIDE + k] + (c[(m + 1) * COH_STRIDE + k] - c[m * COH_STRIDE + k]) * w;
        let p = row(COH_REST) + row(COH_NOISE) ** 2;
        for (let i = 0; i < 2 * MAX_HARMONICS; i++) p += row(i) ** 2;
        const d = lv(name) - sine - 10 * Math.log10(p);
        if (Math.abs(d) > Math.abs(worst)) worst = d;
      }
    }
    console.info(
      `coherence power vs measured level (all presets, p48/60/72): worst ${worst.toFixed(2)} dB`,
    );
    expect(Math.abs(worst)).toBeLessThan(0.3);
  });
});

describe('crossfade gain law', () => {
  const PAIRS: [string, string][] = [
    ['glass', 'sine'],
    ['glass', 'bell'],
    ['sine', 'epiano'],
    ['choir', 'bell'],
    ['sine', 'reed'],
  ];

  it('no dip or bump beyond 1 dB on a sustained note (constant amplitude shown for contrast)', () => {
    const rows: string[] = [];
    let worst = 0;
    let worstLinear = 0;
    for (const [a, b] of PAIRS) {
      const timbres = { a: steady(BUILTIN_TIMBRES[a]), b: steady(BUILTIN_TIMBRES[b]) };
      const res: string[] = [];
      for (const pitch of [48, 60, 72]) {
        const specs = [{ start: pitch, timbre: changes([0, 'a', 0], [2, 'b', 2]) }];
        const d = fadeDeviation(renderSpecs(specs, timbres, 5), 2, 2);
        const lin = fadeDeviation(renderSpecs(specs, timbres, 5, true), 2, 2);
        worst = Math.max(worst, Math.abs(d));
        worstLinear = Math.max(worstLinear, Math.abs(lin));
        res.push(`p${pitch} ${d.toFixed(2)} (${lin.toFixed(2)})`);
      }
      rows.push(`${a}→${b}: ${res.join(', ')}`);
    }
    console.info(`fade level deviation, dB (constant amplitude):\n  ${rows.join('\n  ')}`);
    expect(worst).toBeLessThan(1);
    expect(worstLinear, 'constant amplitude dips (positive control)').toBeGreaterThan(2);
  });

  it('real presets glass → bell → glass: the level moves between the ends, without clicks', () => {
    const specs = [
      { start: 60, timbre: changes([0, 'glass', 0], [2, 'bell', 2], [6, 'glass', 2]) },
    ];
    const o = renderSpecs(specs, {}, 9);
    const report: string[] = [];
    for (const at of [2, 6]) {
      const l0 = level(o, at - 0.3, 0.3);
      const l1 = level(o, at + 2, 0.3);
      let lo = Infinity;
      let hi = -Infinity;
      for (let t = at; t < at + 2; t += 0.1) {
        lo = Math.min(lo, level(o, t, 0.1));
        hi = Math.max(hi, level(o, t, 0.1));
      }
      report.push(
        `${at} s: ${l0.toFixed(1)} → ${l1.toFixed(1)} dB, range ${lo.toFixed(1)}…${hi.toFixed(1)}`,
      );
      expect(lo).toBeGreaterThan(Math.min(l0, l1) - 1);
      expect(hi).toBeLessThan(Math.max(l0, l1) + 1);
    }
    const c = clicks(o.left, [2, 3, 6, 7], [1, 4.5, 8.3]);
    console.info(
      `glass → bell → glass: ${report.join('; ')}; clicks ${c.worst.toFixed(3)} (steady ${c.ref.toFixed(3)})`,
    );
    expect(c.worst).toBeLessThanOrEqual(2 * c.ref);
  });

  it('no re-strike: a change mid-hold never lifts the level above both ends', () => {
    for (const [a, b] of [
      ['pluck', 'bell'],
      ['glass', 'epiano'],
      ['epiano', 'flute'],
    ]) {
      const o = renderSpecs([{ start: 57, timbre: changes([0, a, 0], [2.5, b, 1]) }], {}, 5);
      const ends = Math.max(level(o, 2.3, 0.2), level(o, 3.5, 0.2));
      let hi = -Infinity;
      for (let t = 2.5; t < 3.5; t += 0.05) hi = Math.max(hi, level(o, t, 0.05));
      expect(hi, `${a} → ${b}`).toBeLessThan(ends + 0.5);
    }
  });
});

describe('the timbre mix', () => {
  /** glass, then bell over 2 s from 2 s, then sine over 2 s from 3 s (mid-fade). */
  const MIDFADE = changes([0, 'glass', 0], [2, 'bell', 2], [3, 'sine', 2]);

  function weightsAt(g: Graph, names: string[]): number[] {
    const v = g.voiceAt(0);
    return names.map((n) => v.timbreWeight(g.timbreSlotOf(n)));
  }

  it('a change arriving mid-fade starts from the mix sounding then (continuous weights)', () => {
    const names = ['glass', 'bell', 'sine'];
    const g2 = createLoadedGraph({
      score: makeScore([{ start: 60, timbre: MIDFADE }], 7),
      mix: DRY_MIX,
      sampleRate: RATE,
    });
    g2.play(0);
    const bl = new Float32Array(BLOCK_FRAMES);
    const br = new Float32Array(BLOCK_FRAMES);
    const rec: number[][] = [];
    for (let b = 0; b < frames(6) / BLOCK_FRAMES; b++) {
      g2.process(bl, br);
      rec.push(weightsAt(g2, names));
    }
    const step = BLOCK_FRAMES / RATE / 2; // fastest fade: 1/2 per second
    let jump = 0;
    for (let b = 1; b < rec.length; b++)
      for (let i = 0; i < 3; i++) jump = Math.max(jump, Math.abs(rec[b][i] - rec[b - 1][i]));
    expect(jump).toBeLessThanOrEqual(2 * step + 1e-12);
    // At 3.5 s: sine 1/4, bell 3/4 · 3/4, glass 3/4 · 1/4 (the first fade carries on under it).
    const b35 = Math.round((3.5 * RATE) / BLOCK_FRAMES) - 1;
    const t = ((b35 + 1) * BLOCK_FRAMES) / RATE; // the block's last tick
    const xs = (t - 3) / 2;
    const xb = (t - 2) / 2;
    expect(rec[b35][2]).toBeCloseTo(xs, 9);
    expect(rec[b35][1]).toBeCloseTo((1 - xs) * xb, 9);
    expect(rec[b35][0]).toBeCloseTo((1 - xs) * (1 - xb), 9);
    expect(rec[rec.length - 1]).toEqual([0, 0, 1]);
  });

  it('a seek into a fade lands on the mix and the level of playing through', () => {
    const score = makeScore([{ start: 60, timbre: MIDFADE }], 7);
    const names = ['glass', 'bell', 'sine'];
    const through = createLoadedGraph({ score, mix: DRY_MIX, sampleRate: RATE });
    through.play(0);
    const a = drive(through, 3.6);
    const seek = createLoadedGraph({ score, mix: DRY_MIX, sampleRate: RATE });
    seek.play(3.2);
    const b = drive(seek, 0.4);
    const wa = weightsAt(through, names);
    const wb = weightsAt(seek, names);
    for (let i = 0; i < 3; i++) expect(wb[i]).toBeCloseTo(wa[i], 12);
    const la = level(a, 3.45, 0.15);
    const lb = level(b, 0.25, 0.15);
    console.info(`seek mid-fade: level ${lb.toFixed(3)} vs ${la.toFixed(3)} dB playing through`);
    expect(Math.abs(la - lb)).toBeLessThan(0.2);
  });

  it('a voice born mid-fade sounds exactly as when played from just before its birth', () => {
    const specs: VoiceSpec[] = [{ start: 60, born: 3.3, fadeIn: 0.05, timbre: MIDFADE }];
    const score = makeScore(specs, 7);
    const timbres = {};
    const full = renderOffline({ score, mix: DRY_MIX, timbres, sampleRate: RATE }, frames(4.5));
    const g = createLoadedGraph({ score, mix: DRY_MIX, sampleRate: RATE });
    g.play(3);
    const part = drive(g, 1.5);
    const off = 3 * RATE;
    let worst = 0;
    let peak = 0;
    for (let i = 0; i < part.left.length; i++) {
      worst = Math.max(worst, Math.abs(part.left[i] - full.left[off + i]));
      peak = Math.max(peak, Math.abs(full.left[off + i]));
    }
    expect(peak).toBeGreaterThan(0.01);
    expect(worst).toBeLessThan(1e-6);
  });

  it('switches across every synthesis path, overlapping and instant, without clicks', () => {
    // wavetable → FM (epiano) → additive + FM + noise (the M6-a bell) → noise (flute) → formants
    // (choir) → sine, the later ones arriving mid-fade (five timbres at once around 1.6 s), then
    // a fade 0 change (the engine plays MIN_TIMBRE_FADE), marimba, and struck partials (bell).
    const tl = changes(
      [0, 'glass', 0],
      [1, 'epiano', 0.5],
      [1.25, 'm6a', 0.5],
      [1.5, 'flute', 0.3],
      [1.6, 'choir', 1],
      [1.8, 'sine', 0.2],
      [3, 'm6a', 0],
      [3.5, 'marimba', 0.05],
      [4, 'bell', 0.3],
    );
    for (const pitch of [45, 64, 81]) {
      const o = renderSpecs([{ start: pitch, timbre: tl }], { m6a: M6A_BELL }, 5);
      const c = clicks(o.left, [1, 1.25, 1.5, 1.6, 1.8, 3, 3.5, 4], [0.4, 2.7, 4.5]);
      console.info(
        `path switches at p${pitch}: worst ${c.worst.toFixed(3)} (steady ${c.ref.toFixed(3)})`,
      );
      expect(c.worst, `p${pitch}`).toBeLessThanOrEqual(2 * c.ref);
    }
  });

  it('a missing table keeps the timbre before it; tables arriving mid-note crossfade in', () => {
    const score = makeScore([{ start: 60, timbre: changes([0, 'glass', 0], [1, 'bell', 0.5]) }], 5);
    const g = new Graph(RATE);
    g.load(flatten(score), DRY_MIX);
    g.setTables('glass', tablesFor(BUILTIN_TIMBRES.glass, RATE), 0);
    g.play(0);
    const a = drive(g, 2);
    // Bell has no tables: glass carries on at its level through the change.
    expect(Math.abs(level(a, 1.5, 0.3) - level(a, 0.5, 0.3))).toBeLessThan(0.5);
    g.setTables('bell', tablesFor(BUILTIN_TIMBRES.bell, RATE));
    const b = drive(g, 1);
    const joined = new Float32Array(a.left.length + b.left.length);
    joined.set(a.left);
    joined.set(b.left, a.left.length);
    const c = clicks(joined, [2], [0.5, 2.6]);
    expect(c.worst).toBeLessThanOrEqual(2 * c.ref);
    expect(g.voiceAt(0).timbreWeight(g.timbreSlotOf('bell'))).toBe(1);
  });

  it('a hot swap mid-fade: same timeline slews, an edited fade crossfades, neither clicks', () => {
    const mk = (fade: number) =>
      makeScore([{ start: 60, timbre: changes([0, 'glass', 0], [1, 'epiano', fade]) }], 5);
    const g = createLoadedGraph({ score: mk(2), mix: DRY_MIX, sampleRate: RATE });
    g.play(0);
    const v = g.voiceAt(0);
    const a = drive(g, 1.5);
    const slots = (g as unknown as { slots: TimbreSlot[] }).slots;
    const data = (s: CompiledScore) => {
      const f = flatten(s);
      const slotOf = Int32Array.from(f.timbreNames.map((n) => g.timbreSlotOf(n)));
      return VoiceData.fromFlat(f.voices[0], f.voiceParams, 0, slotOf);
    };
    const at = frames(1.5);
    expect(v.swapNeedsCrossfade(data(mk(2)), at, RATE, slots)).toBe(false);
    expect(v.swapNeedsCrossfade(data(mk(0.6)), at, RATE, slots)).toBe(true);
    g.swap(flatten(mk(0.6)));
    const b = drive(g, 1);
    const joined = new Float32Array(a.left.length + b.left.length);
    joined.set(a.left);
    joined.set(b.left, a.left.length);
    const c = clicks(joined, [1.5], [0.4, 2.1]);
    expect(c.worst).toBeLessThanOrEqual(2 * c.ref);
  });
});

describe('unison lock with timbre changes', () => {
  it('a locked pair keeps its chord level while one voice changes timbre', () => {
    const rows: string[] = [];
    for (const [a, b] of [
      ['sine', 'epiano'],
      ['glass', 'bell'],
      ['choir', 'bell'],
    ]) {
      const timbres = { a: steady(BUILTIN_TIMBRES[a]), b: steady(BUILTIN_TIMBRES[b]) };
      const v0: VoiceSpec = {
        start: 58,
        moves: [{ at: 0.2, to: 60, len: 1 }],
        timbre: changes([0, 'a', 0], [3, 'b', 1]),
        pan: 0,
      };
      const v1: VoiceSpec = {
        start: 62,
        moves: [{ at: 0.2, to: 60, len: 1 }],
        timbre: 'a',
        pan: 0,
      };
      const pair = renderSpecs([v0, v1], timbres, 6.5);
      const solo0 = renderSpecs([v0], timbres, 6.5);
      const solo1 = renderSpecs([{ ...v1, id: 'v2' }], timbres, 6.5);
      // Pair level minus the two voices' power sum (a chord), before and after the change.
      const rel = (t: number) =>
        level(pair, t, 0.5) -
        10 * Math.log10(10 ** (level(solo0, t, 0.5) / 10) + 10 ** (level(solo1, t, 0.5) / 10));
      const before = rel(2);
      let worst = 0;
      for (let t = 2.5; t < 6; t += 0.5) worst = Math.max(worst, Math.abs(rel(t) - before));
      rows.push(`${a}→${b} ${worst.toFixed(2)}`);
      expect(worst, `${a} → ${b}`).toBeLessThan(0.25);
    }
    console.info(
      `locked pair, one voice changing: worst level change vs a chord, dB: ${rows.join(', ')}`,
    );
  });

  it('the timbre-moments fixture renders offline exactly as block by block', () => {
    const score: CompiledScore = timbreMomentScore();
    const n = frames(6);
    const off = renderOffline({ score, mix: FIXTURE_MIX, sampleRate: RATE }, n);
    const g = createLoadedGraph({ score, mix: FIXTURE_MIX, sampleRate: RATE });
    g.play(0);
    const live = drive(g, 6);
    expect(Buffer.from(off.left.buffer).equals(Buffer.from(live.left.buffer))).toBe(true);
    expect(Buffer.from(off.right.buffer).equals(Buffer.from(live.right.buffer))).toBe(true);
  });
});
