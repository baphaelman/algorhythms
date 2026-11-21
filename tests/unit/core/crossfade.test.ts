/**
 * Merges and splits crossfade (PLAN.md §11.3, owner 2026-11-21): the shared function of time,
 * the additive weight timeline, and what the compiler writes for merges and splits.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { CROSSFADE_GLIDE, CROSSFADE_MIN, crossfade, crossfadeLength } from '../../../src/core/ease';
import { flatten } from '../../../src/core/flat';
import { pitchAt, weightAt, weightTargetAt } from '../../../src/core/query';
import {
  RAMP_STRIDE,
  RAMP_T,
  WEIGHT_STRIDE,
  weightRampValue,
  weightRamps,
} from '../../../src/core/segment';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import type {
  CompiledScore,
  CompiledVoice,
  Life,
  Piece,
  TuneMoment,
  WeightChange,
} from '../../../src/core/types';
import {
  CROSSFADE_PIECE_UNTIL,
  crossfadePiece,
  TUNE_MERGE_UNTIL,
  tuneMergePiece,
} from './crossfade-fixtures';

/** The power share a life sounds at t (crossfades in power; the engine's computeLife). */
function lifePower(l: Life, t: number): number {
  const end = l.died ?? Infinity;
  if (t < l.born || t >= end) return 0;
  const s = (x: number): number => x * x * x * (x * (x * 6 - 15) + 10);
  let p = 1;
  const u = (t - l.born) / Math.max(l.fadeIn, 0.005);
  if (u < 1) p = l.crossIn ? crossfade(u) : s(u);
  const v = (end - t) / Math.max(l.fadeOut ?? 0, 0.005);
  if (v < 1) p *= l.crossOut ? crossfade(v) : s(v);
  return p;
}

function power(score: CompiledScore, t: number): number {
  let sum = 0;
  for (const v of score.voices) for (const l of v.lives) sum += lifePower(l, t) * weightAt(v, t);
  return sum;
}

describe('crossfade(u), the one function of time', () => {
  it('runs from 0 to 1, clamped outside', () => {
    expect(crossfade(0)).toBe(0);
    expect(crossfade(1)).toBe(1);
    expect(crossfade(-0.5)).toBe(0);
    expect(crossfade(1.5)).toBe(1);
    expect(crossfade(0.5)).toBe(0.5);
  });

  it('is monotone', () => {
    let last = 0;
    for (let i = 1; i <= 10000; i++) {
      const x = crossfade(i / 10000);
      expect(x).toBeGreaterThanOrEqual(last);
      last = x;
    }
  });

  it('keeps power: what leaves one line (X) and what stays (1 − X at the mirrored time) sum to 1', () => {
    // A merge's dying line reads X(v), v = 1 − u, while its survivor gains X(u); a split's newborn
    // reads X(u) while its parent loses X(u): the split mirrors the merge.
    for (let i = 0; i <= 1000; i++) {
      const u = i / 1000;
      expect(Math.abs(crossfade(u) + crossfade(1 - u) - 1)).toBeLessThan(1e-15);
    }
  });

  it('has zero slope at both ends (no corner where a crossfade starts or ends)', () => {
    const h = 1e-4;
    expect(crossfade(h) / h).toBeLessThan(1e-6);
    expect((1 - crossfade(1 - h)) / h).toBeLessThan(1e-6);
  });

  it('lasts a third of the glide, at least CROSSFADE_MIN', () => {
    expect(crossfadeLength(0)).toBe(CROSSFADE_MIN);
    expect(crossfadeLength(0.2)).toBe(CROSSFADE_MIN);
    expect(crossfadeLength(3)).toBeCloseTo(3 * CROSSFADE_GLIDE, 15);
  });
});

describe('weight timeline: changes add up, each along its own ramp', () => {
  const voice = (weight: WeightChange[]): CompiledVoice => ({
    id: 'v1',
    index: 0,
    lives: [{ born: 0, fadeIn: 0 }],
    segments: [{ t0: 0, t1: 10, p0: 60, p1: 60, ease: 'linear' }],
    timbre: [{ t: 0, preset: 'sine', fade: 0 }],
    level: [],
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    sends: {},
    weight,
  });
  // Overlapping forks (falling, from t), a merge ending at its t (lead), and a linear edit.
  const W: WeightChange[] = [
    { t: 0, w: 4, over: 0 },
    { t: 1, w: 3, over: 1, cross: true },
    { t: 1.5, w: 2, over: 1, cross: true },
    { t: 4, w: 3, over: 0.8, lead: 0.8, cross: true },
    { t: 5, w: 5, over: 2 },
    { t: 5.5, w: 4, over: 0.5, cross: true },
  ];

  it('the core sum (query.weightAt) is the expected sum of shaped steps', () => {
    const v = voice(W);
    const at = (t: number): number => {
      const r = (t0: number, L: number, x: (u: number) => number): number =>
        t < t0 ? 0 : t >= t0 + L ? 1 : x((t - t0) / L);
      return (
        4 -
        r(1, 1, crossfade) -
        r(1.5, 1, crossfade) +
        r(3.2, 0.8, crossfade) +
        2 * r(5, 2, (u) => u) -
        r(5.5, 0.5, crossfade)
      );
    };
    for (let t = 0; t <= 8; t += 0.01) expect(weightAt(v, t)).toBeCloseTo(at(t), 12);
    expect(weightTargetAt(v, 3.9)).toBe(2); // the merge counts from its meeting
    expect(weightTargetAt(v, 4)).toBe(3);
  });

  it('the engine evaluation (segment.ts weightRamps) equals it, with the DSP cursor', () => {
    const v = voice(W);
    const fw = flatten({ ...emptyScore(), voices: [v] }).voices[0].weights;
    const n = fw.length / WEIGHT_STRIDE;
    const r = weightRamps(fw, n);
    for (let k = 1; k < n; k++)
      expect(r[k * RAMP_STRIDE + RAMP_T]).toBeGreaterThanOrEqual(r[(k - 1) * RAMP_STRIDE + RAMP_T]);
    let k = -1;
    for (let t = 0; t <= 8; t += 0.005) {
      while (k + 1 < n && r[(k + 1) * RAMP_STRIDE + RAMP_T] <= t) k++;
      expect(weightRampValue(r, k, t)).toBeCloseTo(weightAt(v, t), 12);
    }
  });
});

function emptyScore(): CompiledScore {
  return {
    duration: 10,
    voices: [],
    walkSteps: [],
    momentSpans: [],
    diagnostics: [],
    keys: [{ t: 0, key: { tonic: 'C', scale: 'major' } }],
    referenceHz: 440,
    seed: 1,
  };
}

describe('the compiler writes merges and splits as crossfades', () => {
  const s = compile(crossfadePiece());

  it('splits: each fork fades in over the first third of its departure, its parent losing as much', () => {
    const forks = s.voices.flatMap((v) => v.lives.filter((l) => l.crossIn).map((l) => ({ v, l })));
    expect(forks.length).toBe(3);
    for (const { v, l } of forks) {
      const g = v.segments.find((x) => x.t0 === l.born)!;
      expect(l.fadeIn).toBeCloseTo(crossfadeLength(g.t1 - g.t0), 12);
      // Born on its parent's note.
      const parent = s.voices.find(
        (u) => u !== v && u.weight?.some((c) => c.cross && c.t === l.born && !c.lead),
      )!;
      expect(pitchAt(parent, l.born)).toBe(pitchAt(v, l.born));
    }
  });

  it('merges: each merging line ends where it meets the merged line, its fade over the approach', () => {
    const deaths = s.voices.flatMap((v) =>
      v.lives.filter((l) => l.crossOut).map((l) => ({ v, l })),
    );
    expect(deaths.length).toBe(3); // two coincidence joins and the merge moment
    for (const { v, l } of deaths) {
      const t = l.died!;
      const survivor = s.voices.find(
        (u) => u !== v && u.weight?.some((c) => c.cross && c.t === t && c.lead === l.fadeOut),
      )!;
      expect(survivor).toBeDefined();
      expect(Math.abs(pitchAt(v, t - 1e-9)! - pitchAt(survivor, t)!)).toBeLessThan(1e-6);
      expect(l.fadeOut).toBeGreaterThanOrEqual(CROSSFADE_MIN);
    }
  });

  it('summed power stays constant through every merge and split', () => {
    // Only crossfades change power before the end fade: the total stays 4 (four lines' worth).
    let worst = 0;
    for (let t = 0.01; t < CROSSFADE_PIECE_UNTIL; t += 0.001) {
      worst = Math.max(worst, Math.abs(10 * Math.log10(power(s, t) / 4)));
    }
    expect(worst).toBeLessThan(1e-9); // dB
  });
});

describe('crossfades with a tune merging (R9-4), and incremental = full', () => {
  it('a tune landing on its own lines ends each merging line at the meeting, power kept', () => {
    const s = compile(tuneMergePiece());
    const deaths = s.voices.flatMap((v) => v.lives.filter((l) => l.crossOut));
    expect(deaths.map((l) => l.died!).sort((a, b) => a - b)).toEqual(
      [2.1, 4.1].map((x) => expect.closeTo(x, 9)),
    );
    let worst = 0;
    for (let t = 0.01; t < TUNE_MERGE_UNTIL; t += 0.001) {
      worst = Math.max(worst, Math.abs(10 * Math.log10(power(s, t) / 4)));
    }
    expect(worst).toBeLessThan(1e-9); // dB
    // The merged line carries the tune on: 55 at 4.5 (weight 3), 64 at 5.5.
    const last = s.voices.find((v) => pitchAt(v, 5.5) === 64)!;
    expect(weightAt(last, 5.5)).toBeCloseTo(3, 12);
  });

  it('incremental compiles match a full compile across edits after the crossfades', () => {
    const inc = createIncrementalCompiler();
    const check = (q: Piece): void => expect(inc.compile(q)).toEqual(compile(q));
    const tuneOf = (q: Piece): TuneMoment => q.moments.find((m) => m.type === 'tune') as TuneMoment;
    const cases: [Piece, ((q: Piece) => void)[]][] = [
      [
        tuneMergePiece(),
        [
          (q) => (tuneOf(q).notes[3].pitch = 67),
          (q) => (tuneOf(q).notes[2].pitch = 54),
          (q) => tuneOf(q).notes.push({ pitch: 48, len: 1 }),
          (q) => (q.end = { at: 10, fade: 1 }),
        ],
      ],
      [
        crossfadePiece(),
        [(q) => (q.moments[q.moments.length - 1].at = 10.5), (q) => (q.end = { at: 15, fade: 1 })],
      ],
    ];
    for (const [p, edits] of cases) {
      check(p);
      let q = p;
      for (const e of edits) {
        q = structuredClone(q);
        e(q);
        check(q);
        check(q);
        expect(inc.stats.mode).toBe('resume');
      }
    }
  });
});
