/**
 * Master glue compressor (PLAN.md §12 "Ready for YouTube", `mix.glue`): feed-forward on the sum,
 * before the limiter. It only computes a gain per sample; the limiter applies it together with its
 * own (fx/limiter.ts `pre`), so stems record both as the one curve g_L (§12 "Stems").
 *
 * Every GLUE_STEP samples: the stereo-linked sample peak of those samples, in dB, through a
 * soft-knee gain computer (threshold −16 dBFS, ratio 1 + glue: 2:1 at 1); the gain reduction is
 * smoothed in dB (attack 10 ms, release 200 ms) and the linear gain is interpolated per sample
 * between steps. Threshold and times put 2–4 dB on the peaks of dense pieces (Crease, Night
 * Sleeper) at glue 1. With glue 0 and nothing left to release, `process` reports unity and the
 * mix is bit-identical to having no glue. Allocation-free.
 */

import * as pmath from '../pmath';

/** pmath's registers (allocation-free calls on the audio thread). */
const PR = pmath.R;

/** Gain-computer period in samples; divides BLOCK_FRAMES. */
export const GLUE_STEP = 16;
const THRESHOLD_DB = -16;
const KNEE_DB = 6;
const ATTACK = 0.01;
const RELEASE = 0.2;
/** Below this gain reduction (dB) with glue 0, the compressor is off. */
const OFF_DB = 1e-4;
/** 20·log10(2). */
const DB_PER_OCTAVE = 6.020599913279624;

export class Glue {
  /** 0..1: the ratio is 1 + amount. */
  amount = 0;
  /** Smoothed gain reduction (dB, ≥ 0) and the linear gain at the end of the last step. */
  private gr = 0;
  private gain = 1;
  private readonly att: number = 0;
  private readonly rel: number = 0;
  /** Deepest reduction since `resetMeter` (dB, tests and diagnostics). */
  maxReductionDb = 0;

  constructor(sampleRate: number) {
    const stepSeconds = GLUE_STEP / sampleRate;
    this.att = 1 - pmath.exp(-stepSeconds / ATTACK);
    this.rel = 1 - pmath.exp(-stepSeconds / RELEASE);
  }

  reset(): void {
    this.gr = 0;
    this.gain = 1;
    this.maxReductionDb = 0;
  }

  /**
   * Writes the gain for each of `frames` samples of inL/inR into `out`. Returns false (and writes
   * nothing) when the compressor is off: glue 0 and fully released.
   */
  process(inL: Float64Array, inR: Float64Array, out: Float64Array, frames: number): boolean {
    const amount = this.amount;
    if (amount <= 0 && this.gr === 0) return false;
    const slope = amount > 0 ? 1 - 1 / (1 + amount) : 0;
    let gr = this.gr;
    let gain = this.gain;
    let maxGr = this.maxReductionDb;
    for (let s = 0; s < frames; s += GLUE_STEP) {
      let peak = 0;
      for (let i = s; i < s + GLUE_STEP; i++) {
        const l = inL[i];
        const r = inR[i];
        const al = l < 0 ? -l : l;
        const ar = r < 0 ? -r : r;
        if (al > peak) peak = al;
        if (ar > peak) peak = ar;
      }
      let target = 0;
      if (slope > 0 && peak > 0) {
        PR[0] = peak;
        pmath.log2R();
        const over = PR[0] * DB_PER_OCTAVE - THRESHOLD_DB;
        if (over >= KNEE_DB / 2) target = slope * over;
        else if (over > -KNEE_DB / 2) {
          const k = over + KNEE_DB / 2;
          target = (slope * k * k) / (2 * KNEE_DB);
        }
      }
      gr += (target - gr) * (target > gr ? this.att : this.rel);
      if (amount <= 0 && gr < OFF_DB) gr = 0;
      if (gr > maxGr) maxGr = gr;
      PR[0] = -gr;
      pmath.dbToGainR();
      const next = gr === 0 ? 1 : PR[0];
      const d = (next - gain) / GLUE_STEP;
      for (let i = 0; i < GLUE_STEP; i++) {
        gain += d;
        out[s + i] = gain;
      }
      gain = next;
      out[s + GLUE_STEP - 1] = next;
    }
    this.gr = gr;
    this.gain = gain;
    this.maxReductionDb = maxGr;
    return true;
  }
}
