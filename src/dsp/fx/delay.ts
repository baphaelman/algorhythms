/**
 * Stereo ping-pong delay on its own send (PLAN.md §8.6): mono in; the first echo is on the left,
 * the next on the right, and so on, each repeat scaled by `feedback` per round trip and gently
 * low-passed. The delay time is smoothed per block and read with linear interpolation, so changing
 * it glides like tape instead of clicking. Allocation-free after construction.
 */

import { BLOCK_FRAMES } from '../constants';

const MAX_TIME = 2;
const SMOOTH = 0.15;
/** One-pole low-pass in the feedback path (per repeat). */
const FEEDBACK_DAMP = 0.6;

export class PingPongDelay {
  private readonly sampleRate: number;
  private readonly mask: number;
  private readonly bufL: Float64Array;
  private readonly bufR: Float64Array;
  private w = 0;
  private timeCur = 0;
  private timeTarget = 0;
  private fbCur = 0;
  private fbTarget = 0;
  private lp = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    let cap = 1;
    while (cap < Math.ceil(MAX_TIME * sampleRate) + BLOCK_FRAMES + 4) cap *= 2;
    this.mask = cap - 1;
    this.bufL = new Float64Array(cap);
    this.bufR = new Float64Array(cap);
    this.setParams(0.375, 0.35, true);
  }

  /** Sets the delay time (seconds) and feedback (0..0.95); `immediate` skips smoothing. */
  setParams(time: number, feedback: number, immediate = false): void {
    this.timeTarget = Math.max(1, Math.min(MAX_TIME, Math.max(0, time)) * this.sampleRate);
    this.fbTarget = Math.max(0, Math.min(0.95, feedback));
    if (immediate) {
      this.timeCur = this.timeTarget;
      this.fbCur = this.fbTarget;
    }
  }

  /** Clears all state (silence). */
  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.lp = 0;
  }

  /** Processes one block: `input` (mono send) to `outL`/`outR` (overwritten). */
  process(input: Float64Array, outL: Float64Array, outR: Float64Array): void {
    if (this.timeCur !== this.timeTarget) {
      const d = this.timeTarget - this.timeCur;
      this.timeCur = Math.abs(d) < 1e-3 ? this.timeTarget : this.timeCur + d * SMOOTH;
    }
    if (this.fbCur !== this.fbTarget) {
      const d = this.fbTarget - this.fbCur;
      this.fbCur = Math.abs(d) < 1e-5 ? this.fbTarget : this.fbCur + d * SMOOTH;
    }
    const bufL = this.bufL;
    const bufR = this.bufR;
    const mask = this.mask;
    const di = Math.floor(this.timeCur);
    const fr = this.timeCur - di;
    const fb = this.fbCur;
    let lp = this.lp;
    let w = this.w;
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      const i0 = (w - di) & mask;
      const i1 = (w - di - 1) & mask;
      const a = bufL[i0];
      const rl = a + (bufL[i1] - a) * fr;
      const b = bufR[i0];
      const rr = b + (bufR[i1] - b) * fr;
      lp += (rr - lp) * FEEDBACK_DAMP;
      bufL[w] = input[i] + fb * lp + 1e-24;
      bufR[w] = rl;
      outL[i] = rl;
      outR[i] = rr;
      w = (w + 1) & mask;
    }
    this.lp = lp;
    this.w = w;
  }
}
