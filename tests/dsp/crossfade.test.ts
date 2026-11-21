/**
 * Merges and splits crossfade in the engine (PLAN.md §11.3, owner 2026-11-21).
 *
 * - Power: across every merge and split, the lines' summed power Σ (life amplitude² × weight)
 *   stays within POWER_DB of its value before. The crossfade keeps it constant by construction
 *   (X + (1 − X) = 1), so the bound only allows rounding; the old 0.1 s hand-over dipped 0.7 dB
 *   here (a smootherstep amplitude fade against a linear weight ramp).
 * - The dying line's power share follows core/ease `crossfade` tick by tick: the curve the
 *   renderer bundles its strand by (tests/unit/render/strands.test.ts, "follows the crossfade").
 * - Group gain h: when a pair enters a unison group, h leaves 1 by at most H_ONSET per block
 *   (2.7 ms). It used to switch capture on at once as the warp started, stepping h by 0.31 here
 *   (the pop bisect's "v6 1.0 → 1.31"); capture now fades in over CAPTURE_RAMP (dsp/graph.ts).
 *   0.05 per block is a ramp of 50 ms or more for a full swing: no click. Once in a group, h
 *   follows beats by design (it keeps the group's sum steady), so only onsets are bounded.
 * - Clicks: the sample-level click score at each crossfade's start and end stays within 2× the
 *   same render's steady stretches (as tests/dsp/clicks.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { compile } from '../../src/core/compiler/compile';
import { crossfade } from '../../src/core/ease';
import { weightAt } from '../../src/core/query';
import type { CompiledScore } from '../../src/core/types';
import { DRY_MIX } from '../../src/audio/fixtures/scores';
import { BLOCK_FRAMES, CONTROL_PERIOD } from '../../src/dsp/constants';
import { TICKS_PER_BLOCK } from '../../src/dsp/voice';
import {
  CROSSFADE_PIECE_UNTIL,
  crossfadePiece,
  lockMergePiece,
  TUNE_MERGE_UNTIL,
  tuneMergePiece,
} from '../unit/core/crossfade-fixtures';
import { clickScore, Driver, RATE, render } from './helpers';

vi.setConfig({ testTimeout: 60_000 });

const POWER_DB = 0.01;
const H_ONSET = 0.05;

interface Trace {
  /** Per control tick: Σ lifeTick². */
  power: Float64Array;
  /** Per voice, per control tick: lifeTick. */
  life: Float64Array[];
  /** Per voice, per block: h at the block's end. */
  h: Float64Array[];
}

function trace(score: CompiledScore, seconds: number): Trace {
  const d = new Driver(score, DRY_MIX);
  d.graph.play(0);
  const blocks = Math.round((seconds * RATE) / BLOCK_FRAMES);
  const n = score.voices.length;
  const power = new Float64Array(blocks * TICKS_PER_BLOCK);
  const life = score.voices.map(() => new Float64Array(blocks * TICKS_PER_BLOCK));
  const h = score.voices.map(() => new Float64Array(blocks));
  const ctx = (d.graph as unknown as { ctx: { gH1: Float64Array } }).ctx;
  for (let b = 0; b < blocks; b++) {
    d.run(BLOCK_FRAMES / RATE);
    for (let k = 0; k < TICKS_PER_BLOCK; k++) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const x = d.graph.voiceAt(i).lifeTick[k + 1];
        life[i][b * TICKS_PER_BLOCK + k] = x;
        s += x * x;
      }
      power[b * TICKS_PER_BLOCK + k] = s;
    }
    for (let i = 0; i < n; i++) h[i][b] = ctx.gH1[i];
  }
  return { power, life, h };
}

/** Time of control tick j (the end of the tick: `computeLife` evaluates there). */
const tickT = (j: number): number => ((j + 1) * CONTROL_PERIOD) / RATE;

/** Largest one-block step of h as a voice leaves rest at 1 (four blocks at 1 before). */
function worstOnset(t: Trace): { step: number; at: number } {
  let worst = { step: 0, at: -1 };
  t.h.forEach((h, i) => {
    for (let b = 5; b < h.length; b++) {
      let rest = true;
      for (let k = 1; k <= 4 && rest; k++) rest = Math.abs(h[b - k] - 1) < 1e-3;
      if (!rest || !(t.life[i][(b + 1) * TICKS_PER_BLOCK - 1] > 0.05)) continue;
      const step = Math.abs(h[b] - h[b - 1]);
      if (step > worst.step) worst = { step, at: (b * BLOCK_FRAMES) / RATE };
    }
  });
  return worst;
}

describe('merges and splits crossfade (engine)', () => {
  const score = compile(crossfadePiece());
  const tr = trace(score, 15);

  it('keeps the summed power of the lines through every merge and split', () => {
    let worst = 0;
    let at = 0;
    for (let j = 0; j < tr.power.length; j++) {
      const t = tickT(j);
      if (t < 0.05 || t > CROSSFADE_PIECE_UNTIL) continue;
      const db = Math.abs(10 * Math.log10(tr.power[j] / 4));
      if (db > worst) {
        worst = db;
        at = t;
      }
    }
    console.info(`crossfade power: worst ${worst.toExponential(2)} dB at ${at.toFixed(3)} s`);
    expect(worst).toBeLessThan(POWER_DB);
  });

  it('a merging line’s power share follows crossfade(u), and its merged line gains the rest', () => {
    let checked = 0;
    for (const v of score.voices) {
      for (const l of v.lives) {
        if (!l.crossOut) continue;
        const t0 = l.died! - l.fadeOut!;
        for (let j = 0; j < tr.power.length; j++) {
          const t = tickT(j);
          if (t <= t0 || t >= l.died!) continue;
          const share = tr.life[v.index][j] ** 2 / weightAt(v, t);
          expect(share).toBeCloseTo(1 - crossfade((t - t0) / l.fadeOut!), 12);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('a split’s newborn fades in along crossfade(u)', () => {
    let checked = 0;
    for (const v of score.voices) {
      for (const l of v.lives) {
        if (!l.crossIn) continue;
        for (let j = 0; j < tr.power.length; j++) {
          const t = tickT(j);
          if (t <= l.born || t >= l.born + l.fadeIn) continue;
          const share = tr.life[v.index][j] ** 2 / weightAt(v, t);
          expect(share).toBeCloseTo(crossfade((t - l.born) / l.fadeIn), 12);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('h eases into each group: no step above H_ONSET per block', () => {
    const a = worstOnset(tr);
    const b = worstOnset(trace(compile(lockMergePiece()), 15));
    console.info(
      `h onset: crossfade piece ${a.step.toFixed(4)} at ${a.at.toFixed(3)} s, ` +
        `merge piece ${b.step.toFixed(4)} at ${b.at.toFixed(3)} s`,
    );
    expect(a.step).toBeLessThan(H_ONSET);
    expect(b.step).toBeLessThan(H_ONSET);
  });

  it('no clicks where a crossfade starts or ends', () => {
    const out = render(score, DRY_MIX, 15.5);
    const score2 = (x: Float32Array, from: number, to: number): number =>
      clickScore(x, from, to, RATE, 0.01, 1e-3, 2).ratio;
    const both = (from: number, to: number): number =>
      Math.max(score2(out.left, from, to), score2(out.right, from, to));
    const ends: number[] = [];
    for (const v of score.voices) {
      for (const l of v.lives) {
        if (l.crossIn) ends.push(l.born, l.born + l.fadeIn);
        if (l.crossOut) ends.push(l.died! - l.fadeOut!, l.died!);
      }
    }
    let steady = 0;
    for (let t = 0.3; t < 14.5; t += 0.05) {
      if (ends.some((e) => Math.abs(e - t) < 0.08 || Math.abs(e - (t + 0.05)) < 0.08)) continue;
      steady = Math.max(steady, both(Math.floor(t * RATE), Math.floor((t + 0.05) * RATE)));
    }
    let worst = 0;
    for (const e of ends) {
      worst = Math.max(worst, both(Math.floor((e - 0.03) * RATE), Math.floor((e + 0.06) * RATE)));
    }
    console.info(`crossfade clicks: steady ${steady.toFixed(3)}, worst ${worst.toFixed(3)}`);
    expect(ends.length).toBe(12);
    expect(worst).toBeLessThanOrEqual(2 * steady);
  });
});

describe('a tune merging into its own lines crossfades as any merge (R9-4)', () => {
  const score = compile(tuneMergePiece());
  const tr = trace(score, 9);

  it('both landings crossfade over the note’s 0.1 s glide, ending at the meeting', () => {
    const outs = score.voices.flatMap((v) => v.lives.filter((l) => l.crossOut));
    outs.sort((a, b) => a.died! - b.died!);
    expect(outs.map((l) => [l.died!, l.fadeOut!])).toEqual([
      [expect.closeTo(2.1, 9), expect.closeTo(0.1, 9)],
      [expect.closeTo(4.1, 9), expect.closeTo(0.1, 9)],
    ]);
  });

  it('keeps the summed power of the lines through both merges', () => {
    let worst = 0;
    let at = 0;
    for (let j = 0; j < tr.power.length; j++) {
      const t = tickT(j);
      if (t < 0.05 || t > TUNE_MERGE_UNTIL) continue;
      const db = Math.abs(10 * Math.log10(tr.power[j] / 4));
      if (db > worst) {
        worst = db;
        at = t;
      }
    }
    console.info(`tune merge power: worst ${worst.toExponential(2)} dB at ${at.toFixed(3)} s`);
    expect(worst).toBeLessThan(POWER_DB);
  });

  it('h eases into each group: no step above H_ONSET per block', () => {
    const w = worstOnset(tr);
    console.info(`h onset: tune merge piece ${w.step.toFixed(4)} at ${w.at.toFixed(3)} s`);
    expect(w.step).toBeLessThan(H_ONSET);
  });
});
