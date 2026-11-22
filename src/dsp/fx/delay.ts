/**
 * Stereo ping-pong delay on its own send (PLAN.md §8.6): mono in; the first echo is on the left,
 * the next on the right, and so on, each repeat scaled by `feedback` per round trip and gently
 * low-passed. Allocation-free after construction.
 *
 * Time changes (build log "Smooth master FX edits"): up to GLIDE_MAX the read head glides like
 * tape (smoothed per block, its position interpolated per sample); a bigger change crossfades
 * from the old read tap to the new one over XFADE_SECONDS instead of racing through the buffer.
 * The next change waits for a crossfade to finish.
 */

import { BLOCK_FRAMES } from '../constants';

const MAX_TIME = 2;
const SMOOTH = 0.15;
/** One-pole low-pass in the feedback path (per repeat). */
const FEEDBACK_DAMP = 0.6;
/** Largest time change (seconds) that glides; larger ones crossfade. */
const GLIDE_MAX = 0.01;
const XFADE_SECONDS = 0.04;
const STEADY = 0;
const GLIDE = 1;
const CROSSFADE = 2;

export class PingPongDelay {
  private readonly sampleRate: number = 0;
  private readonly mask: number = 0;
  private readonly bufL: Float64Array;
  private readonly bufR: Float64Array;
  private readonly glideMax: number = 0;
  private readonly xfStep: number = 0;
  private w = 0;
  private timeCur = 0;
  private timeTarget = 0;
  /** timeCur at the start of the block (a field: doubles passed to calls box). */
  private timeFrom = 0;
  /** Crossfade target tap (frames) and progress 0..1. */
  private timeNext = 0;
  private xf = 0;
  /** This block's read mode, and whether anything is still smoothing. */
  private mode = STEADY;
  private moving = false;
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
    this.glideMax = GLIDE_MAX * sampleRate;
    this.xfStep = 1 / Math.max(1, Math.round(XFADE_SECONDS * sampleRate));
    this.setParams(0.375, 0.35, true);
  }

  /** Sets the delay time (seconds) and feedback (0..0.95); `immediate` skips smoothing. */
  setParams(time: number, feedback: number, immediate = false): void {
    this.params[0] = time;
    this.params[1] = feedback;
    this.applyParams(immediate);
  }

  /** Inputs of applyParams: time, feedback (see Reverb.params). */
  readonly params = new Float64Array(2);

  /** setParams with the values in `params`. */
  applyParams(immediate = false): void {
    const time = this.params[0];
    const feedback = this.params[1];
    this.timeTarget = Math.max(1, Math.min(MAX_TIME, Math.max(0, time)) * this.sampleRate);
    this.fbTarget = Math.max(0, Math.min(0.95, feedback));
    if (immediate) {
      this.timeCur = this.timeTarget;
      this.mode = STEADY;
      this.fbCur = this.fbTarget;
    }
    this.moving =
      this.mode !== STEADY || this.timeCur !== this.timeTarget || this.fbCur !== this.fbTarget;
  }

  /** Clears all state (silence). */
  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.lp = 0;
  }

  /**
   * Processes one block: `input` (mono send) to `outL`/`outR` (overwritten). With constant
   * settings this reads no doubles: it runs interpreted (boxing them) until V8 tiers it up. The
   * smoothing stays inline: in a function of its own, called only while moving, it would stay
   * interpreted for longer.
   */
  process(input: Float64Array, outL: Float64Array, outR: Float64Array): void {
    if (this.moving) {
      // Feedback and time smoothing; picks this block's mode.
      if (this.fbCur !== this.fbTarget) {
        const d = this.fbTarget - this.fbCur;
        this.fbCur = Math.abs(d) < 1e-5 ? this.fbTarget : this.fbCur + d * SMOOTH;
      }
      if (this.mode !== CROSSFADE || this.xf >= 1) {
        if (this.mode === CROSSFADE) this.timeCur = this.timeNext;
        this.mode = STEADY;
        this.timeFrom = this.timeCur;
        const d = this.timeTarget - this.timeCur;
        if (Math.abs(d) > this.glideMax) {
          this.timeNext = this.timeTarget;
          this.xf = 0;
          this.mode = CROSSFADE;
        } else if (d !== 0) {
          this.timeCur = Math.abs(d) < 1e-3 ? this.timeTarget : this.timeCur + d * SMOOTH;
          this.mode = GLIDE;
        } else this.moving = this.fbCur !== this.fbTarget;
      }
    }
    if (this.mode === CROSSFADE) this.crossfade(input, outL, outR);
    else if (this.mode === GLIDE) this.glide(input, outL, outR);
    else this.steady(input, outL, outR);
  }

  private steady(input: Float64Array, outL: Float64Array, outR: Float64Array): void {
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

  /** The read position moves linearly from timeFrom to timeCur across the block. */
  private glide(input: Float64Array, outL: Float64Array, outR: Float64Array): void {
    const from = this.timeFrom;
    const bufL = this.bufL;
    const bufR = this.bufR;
    const mask = this.mask;
    const dt = (this.timeCur - from) / BLOCK_FRAMES;
    const fb = this.fbCur;
    let lp = this.lp;
    let w = this.w;
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      const t = from + dt * (i + 1);
      const di = Math.floor(t);
      const fr = t - di;
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

  /** Smoothstep blend of the timeCur tap into the timeNext tap. */
  private crossfade(input: Float64Array, outL: Float64Array, outR: Float64Array): void {
    const bufL = this.bufL;
    const bufR = this.bufR;
    const mask = this.mask;
    const d0 = Math.floor(this.timeCur);
    const f0 = this.timeCur - d0;
    const d1 = Math.floor(this.timeNext);
    const f1 = this.timeNext - d1;
    const fb = this.fbCur;
    const step = this.xfStep;
    let xf = this.xf;
    let lp = this.lp;
    let w = this.w;
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      xf = xf + step < 1 ? xf + step : 1;
      const u = xf * xf * (3 - 2 * xf);
      let i0 = (w - d0) & mask;
      let i1 = (w - d0 - 1) & mask;
      let a = bufL[i0];
      const l0 = a + (bufL[i1] - a) * f0;
      a = bufR[i0];
      const r0 = a + (bufR[i1] - a) * f0;
      i0 = (w - d1) & mask;
      i1 = (w - d1 - 1) & mask;
      a = bufL[i0];
      const l1 = a + (bufL[i1] - a) * f1;
      a = bufR[i0];
      const r1 = a + (bufR[i1] - a) * f1;
      const rl = l0 + (l1 - l0) * u;
      const rr = r0 + (r1 - r0) * u;
      lp += (rr - lp) * FEEDBACK_DAMP;
      bufL[w] = input[i] + fb * lp + 1e-24;
      bufR[w] = rl;
      outL[i] = rl;
      outR[i] = rr;
      w = (w + 1) & mask;
    }
    this.xf = xf;
    this.lp = lp;
    this.w = w;
  }
}
