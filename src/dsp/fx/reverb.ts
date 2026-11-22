/**
 * Feedback-delay-network reverb (PLAN.md §8.6): mono in, stereo out. A smoothed pre-delay, four
 * series allpass diffusers, then 8 delay lines mixed by a Householder matrix with a one-pole
 * damping filter and an RT60-calibrated gain in every line. Deterministic, no impulse responses.
 *
 * Line lengths are whole samples: a fractional (interpolated) read would low-pass every pass and
 * shorten the broadband RT60 (~12 % with linear interpolation). Decay, damping and pre-delay are
 * smoothed per block (the pre-delay read position is interpolated per sample). A `size` change
 * crossfades every line from its old integer tap to the new one over XFADE_SECONDS (a convex
 * blend of two delays, so the FDN stays passive); the next change waits for it, so a drag steps
 * through crossfades. Allocation-free after construction.
 */

import { BLOCK_FRAMES } from '../constants';
import * as pmath from '../pmath';

const LINES = 8;
/** Line lengths at size = 1/1.1 (scale 1), in seconds; spread and mutually incommensurate. */
const LINE_SECONDS = [0.0317, 0.0373, 0.0419, 0.0473, 0.0531, 0.0597, 0.0671, 0.0739];
/** size 0..1 maps to a length scale MIN_SCALE..MIN_SCALE + SCALE_RANGE. */
const MIN_SCALE = 0.4;
const SCALE_RANGE = 1.1;
const DIFFUSER_SECONDS = [0.0047, 0.0036, 0.0127, 0.0093];
const DIFFUSER_GAIN = 0.6;
const MAX_PREDELAY = 0.5;
/** Input distribution: orthogonal to the all-ones vector, which Householder merely negates. */
const IN_SIGN = [1, -1, 1, -1, -1, 1, -1, 1];
const OUT_L = [1, -1, 1, -1, 1, -1, 1, -1];
const OUT_R = [1, 1, -1, -1, 1, 1, -1, -1];
const IN_GAIN = 1 / Math.sqrt(LINES);
/** Output scale: with the default mix (send 0.5, return 0.35, 3.2 s) the return sits ~10 dB under the dry signal. Tune by ear. */
const OUT_GAIN = 0.7;
/** Per-block smoothing of decay, damping and pre-delay. */
const SMOOTH = 0.08;
/** Read-tap crossfade on a size change. */
const XFADE_SECONDS = 0.05;
/** Tiny DC injected so recirculating tails never become denormal. */
const ANTI_DENORMAL = 1e-24;
const LN1000 = 6.907755278982137;

function pow2Above(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export class Reverb {
  private readonly sampleRate: number = 0;
  private readonly lineMask: number = 0;
  private readonly lineCap: number = 0;
  private readonly lines: Float64Array;
  /** Line lengths in whole samples. */
  private readonly lenCur = new Int32Array(LINES);
  private readonly lenTarget = new Int32Array(LINES);
  private readonly gain = new Float64Array(LINES);
  /** Size crossfade: the new lengths, their gains, and progress 0..1 (−1 when idle). */
  private readonly lenNext = new Int32Array(LINES);
  private readonly gainNext = new Float64Array(LINES);
  /** Gains for lenTarget at decayTarget. */
  private readonly gainTarget = new Float64Array(LINES);
  private xf = -1;
  private readonly xfStep: number = 0;
  private readonly damp = new Float64Array(LINES);
  private readonly y = new Float64Array(LINES);
  private writePos = 0;

  private readonly pre: Float64Array;
  private readonly preMask: number = 0;
  private preWrite = 0;
  private preCur = 0;
  private preTarget = 0;
  /** preCur at the start of the last block. */
  private prePrev = 0;

  private readonly diff: Float64Array[];
  private readonly diffLen: Int32Array;
  private readonly diffPos = new Int32Array(4);

  private decay = 2;
  private dampCoef = 1;
  private dampTarget = 1;
  private decayTarget = 2;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.xfStep = 1 / Math.max(1, Math.round(XFADE_SECONDS * sampleRate));
    const maxLen = Math.ceil(LINE_SECONDS[LINES - 1] * (MIN_SCALE + SCALE_RANGE) * sampleRate) + 4;
    this.lineCap = pow2Above(maxLen);
    this.lineMask = this.lineCap - 1;
    this.lines = new Float64Array(LINES * this.lineCap);
    this.preMask = pow2Above(Math.ceil(MAX_PREDELAY * sampleRate) + BLOCK_FRAMES + 4) - 1;
    this.pre = new Float64Array(this.preMask + 1);
    this.diffLen = new Int32Array(4);
    this.diff = [];
    for (let i = 0; i < 4; i++) {
      this.diffLen[i] = Math.max(1, Math.round(DIFFUSER_SECONDS[i] * sampleRate));
      this.diff.push(new Float64Array(this.diffLen[i]));
    }
    this.setParams(0.5, 2, 0.5, 0.02, true);
  }

  /** Sets targets; `immediate` jumps there (used on load). */
  setParams(
    size: number,
    decay: number,
    damping: number,
    preDelay: number,
    immediate = false,
  ): void {
    const p = this.params;
    p[0] = size;
    p[1] = decay;
    p[2] = damping;
    p[3] = preDelay;
    this.applyParams(immediate);
  }

  /**
   * Inputs of applyParams: size, decay, damping, pre-delay. The graph writes them here, as a double
   * passed to a call that is not inlined is boxed (FX edits arrive on the audio thread).
   */
  readonly params = new Float64Array(4);

  /** setParams with the values in `params`. */
  applyParams(immediate = false): void {
    const size = this.params[0];
    const decay = this.params[1];
    const damping = this.params[2];
    const preDelay = this.params[3];
    const s = Math.min(1, Math.max(0, size));
    const scale = MIN_SCALE + SCALE_RANGE * s;
    for (let k = 0; k < LINES; k++)
      this.lenTarget[k] = Math.round(LINE_SECONDS[k] * scale * this.sampleRate);
    this.decayTarget = Math.max(0.05, Math.min(60, decay));
    this.dampTarget = 1 - 0.85 * Math.min(1, Math.max(0, damping));
    this.preTarget = Math.min(MAX_PREDELAY, Math.max(0, preDelay)) * this.sampleRate;
    // The target taps' gains, so starting a size crossfade computes nothing in process().
    for (let k = 0; k < LINES; k++) {
      pmath.R[0] = (-LN1000 * this.lenTarget[k]) / (this.sampleRate * this.decayTarget);
      pmath.expR();
      this.gainTarget[k] = pmath.R[0];
    }
    if (immediate) {
      this.lenCur.set(this.lenTarget);
      this.xf = -1;
      this.decay = this.decayTarget;
      this.dampCoef = this.dampTarget;
      this.preCur = this.preTarget;
      this.prePrev = this.preCur;
      this.updateGains();
    }
  }

  /** Clears all state (silence). */
  reset(): void {
    this.lines.fill(0);
    this.pre.fill(0);
    this.damp.fill(0);
    for (let i = 0; i < 4; i++) this.diff[i].fill(0);
  }

  private updateGains(): void {
    for (let k = 0; k < LINES; k++) {
      // RT60: amplitude falls by 1000 after `decay` seconds.
      pmath.R[0] = (-LN1000 * this.lenCur[k]) / (this.sampleRate * this.decay);
      pmath.expR();
      this.gain[k] = pmath.R[0];
      if (this.xf >= 0) {
        pmath.R[0] = (-LN1000 * this.lenNext[k]) / (this.sampleRate * this.decay);
        pmath.expR();
        this.gainNext[k] = pmath.R[0];
      }
    }
  }

  private smoothParams(): void {
    let changed = false;
    if (this.xf >= 1) {
      // Crossfade done: the new taps take over.
      this.lenCur.set(this.lenNext);
      this.gain.set(this.gainNext);
      this.xf = -1;
    }
    if (this.xf < 0) {
      for (let k = 0; k < LINES; k++) {
        if (this.lenTarget[k] !== this.lenCur[k]) {
          this.lenNext.set(this.lenTarget);
          this.xf = 0;
          if (this.decay === this.decayTarget) this.gainNext.set(this.gainTarget);
          else changed = true;
          break;
        }
      }
    }
    if (this.decay !== this.decayTarget) {
      const d = this.decayTarget - this.decay;
      this.decay = Math.abs(d) < 1e-4 ? this.decayTarget : this.decay + d * SMOOTH;
      changed = true;
    }
    if (changed) this.updateGains();
    if (this.dampCoef !== this.dampTarget) {
      const d = this.dampTarget - this.dampCoef;
      this.dampCoef = Math.abs(d) < 1e-5 ? this.dampTarget : this.dampCoef + d * SMOOTH;
    }
    if (this.preCur !== this.preTarget) {
      const d = this.preTarget - this.preCur;
      this.preCur = Math.abs(d) < 1e-3 ? this.preTarget : this.preCur + d * SMOOTH;
    }
  }

  /** Processes one block: `input` (mono send) to `outL`/`outR` (overwritten). */
  process(input: Float64Array, outL: Float64Array, outR: Float64Array): void {
    this.smoothParams();
    const lines = this.lines;
    const mask = this.lineMask;
    const cap = this.lineCap;
    const lenCur = this.lenCur;
    const gain = this.gain;
    const damp = this.damp;
    const y = this.y;
    const dc = this.dampCoef;
    const pre = this.pre;
    const preMask = this.preMask;
    const preFrom = this.prePrev;
    const preMoving = preFrom !== this.preCur;
    const dPre = (this.preCur - preFrom) / BLOCK_FRAMES;
    this.prePrev = this.preCur;
    let preDi = Math.floor(this.preCur);
    let preFr = this.preCur - preDi;
    const xfOn = this.xf >= 0;
    let xf = this.xf;
    const xfStep = this.xfStep;
    const lenNext = this.lenNext;
    const gainNext = this.gainNext;
    let w = this.writePos;
    let pw = this.preWrite;

    if (!xfOn) {
      // The steady case, written out per line with the state in locals: the ±1 input and output
      // signs become adds and subtracts (exact), so this is bit for bit the loop below.
      const G = DIFFUSER_GAIN;
      const inGain = IN_GAIN;
      const b0 = this.diff[0];
      const b1 = this.diff[1];
      const b2 = this.diff[2];
      const b3 = this.diff[3];
      const n0 = this.diffLen[0];
      const n1 = this.diffLen[1];
      const n2 = this.diffLen[2];
      const n3 = this.diffLen[3];
      let q0 = this.diffPos[0];
      let q1 = this.diffPos[1];
      let q2 = this.diffPos[2];
      let q3 = this.diffPos[3];
      const L0 = lenCur[0];
      const L1 = lenCur[1];
      const L2 = lenCur[2];
      const L3 = lenCur[3];
      const L4 = lenCur[4];
      const L5 = lenCur[5];
      const L6 = lenCur[6];
      const L7 = lenCur[7];
      const c1 = cap;
      const c2 = 2 * cap;
      const c3 = 3 * cap;
      const c4 = 4 * cap;
      const c5 = 5 * cap;
      const c6 = 6 * cap;
      const c7 = 7 * cap;
      const g0 = gain[0];
      const g1 = gain[1];
      const g2 = gain[2];
      const g3 = gain[3];
      const g4 = gain[4];
      const g5 = gain[5];
      const g6 = gain[6];
      const g7 = gain[7];
      let d0 = damp[0];
      let d1 = damp[1];
      let d2 = damp[2];
      let d3 = damp[3];
      let d4 = damp[4];
      let d5 = damp[5];
      let d6 = damp[6];
      let d7 = damp[7];
      for (let i = 0; i < BLOCK_FRAMES; i++) {
        if (preMoving) {
          const p = preFrom + dPre * (i + 1);
          preDi = Math.floor(p);
          preFr = p - preDi;
        }
        pre[pw] = input[i];
        const r0 = pre[(pw - preDi) & preMask];
        const r1 = pre[(pw - preDi - 1) & preMask];
        pw = (pw + 1) & preMask;
        let x = r0 + (r1 - r0) * preFr + ANTI_DENORMAL;

        let dl = b0[q0];
        let v = x + G * dl;
        x = dl - G * v;
        b0[q0] = v;
        q0 = q0 + 1 === n0 ? 0 : q0 + 1;
        dl = b1[q1];
        v = x + G * dl;
        x = dl - G * v;
        b1[q1] = v;
        q1 = q1 + 1 === n1 ? 0 : q1 + 1;
        dl = b2[q2];
        v = x + G * dl;
        x = dl - G * v;
        b2[q2] = v;
        q2 = q2 + 1 === n2 ? 0 : q2 + 1;
        dl = b3[q3];
        v = x + G * dl;
        x = dl - G * v;
        b3[q3] = v;
        q3 = q3 + 1 === n3 ? 0 : q3 + 1;

        const o0 = lines[(w - L0) & mask];
        const o1 = lines[c1 + ((w - L1) & mask)];
        const o2 = lines[c2 + ((w - L2) & mask)];
        const o3 = lines[c3 + ((w - L3) & mask)];
        const o4 = lines[c4 + ((w - L4) & mask)];
        const o5 = lines[c5 + ((w - L5) & mask)];
        const o6 = lines[c6 + ((w - L6) & mask)];
        const o7 = lines[c7 + ((w - L7) & mask)];
        // OUT_L, OUT_R.
        let l = 0;
        l += o0;
        l -= o1;
        l += o2;
        l -= o3;
        l += o4;
        l -= o5;
        l += o6;
        l -= o7;
        let r = 0;
        r += o0;
        r += o1;
        r -= o2;
        r -= o3;
        r += o4;
        r += o5;
        r -= o6;
        r -= o7;
        d0 += (o0 - d0) * dc;
        d1 += (o1 - d1) * dc;
        d2 += (o2 - d2) * dc;
        d3 += (o3 - d3) * dc;
        d4 += (o4 - d4) * dc;
        d5 += (o5 - d5) * dc;
        d6 += (o6 - d6) * dc;
        d7 += (o7 - d7) * dc;
        const y0 = d0 * g0;
        const y1 = d1 * g1;
        const y2 = d2 * g2;
        const y3 = d3 * g3;
        const y4 = d4 * g4;
        const y5 = d5 * g5;
        const y6 = d6 * g6;
        const y7 = d7 * g7;
        let sum = 0;
        sum += y0;
        sum += y1;
        sum += y2;
        sum += y3;
        sum += y4;
        sum += y5;
        sum += y6;
        sum += y7;
        const h = sum * (2 / LINES);
        const xin = x * inGain;
        // IN_SIGN.
        lines[w] = y0 - h + xin;
        lines[c1 + w] = y1 - h - xin;
        lines[c2 + w] = y2 - h + xin;
        lines[c3 + w] = y3 - h - xin;
        lines[c4 + w] = y4 - h - xin;
        lines[c5 + w] = y5 - h + xin;
        lines[c6 + w] = y6 - h - xin;
        lines[c7 + w] = y7 - h + xin;
        w = (w + 1) & mask;
        outL[i] = l * OUT_GAIN;
        outR[i] = r * OUT_GAIN;
      }
      damp[0] = d0;
      damp[1] = d1;
      damp[2] = d2;
      damp[3] = d3;
      damp[4] = d4;
      damp[5] = d5;
      damp[6] = d6;
      damp[7] = d7;
      this.diffPos[0] = q0;
      this.diffPos[1] = q1;
      this.diffPos[2] = q2;
      this.diffPos[3] = q3;
      this.writePos = w;
      this.preWrite = pw;
      return;
    }

    for (let i = 0; i < BLOCK_FRAMES; i++) {
      // Pre-delay (fractional; interpolated per sample while it moves).
      if (preMoving) {
        const p = preFrom + dPre * (i + 1);
        preDi = Math.floor(p);
        preFr = p - preDi;
      }
      pre[pw] = input[i];
      const r0 = pre[(pw - preDi) & preMask];
      const r1 = pre[(pw - preDi - 1) & preMask];
      pw = (pw + 1) & preMask;
      let x = r0 + (r1 - r0) * preFr + ANTI_DENORMAL;

      // Allpass diffusers.
      for (let a = 0; a < 4; a++) {
        const buf = this.diff[a];
        const p = this.diffPos[a];
        const delayed = buf[p];
        const v = x + DIFFUSER_GAIN * delayed;
        x = delayed - DIFFUSER_GAIN * v;
        buf[p] = v;
        this.diffPos[a] = p + 1 === this.diffLen[a] ? 0 : p + 1;
      }

      // Read the lines, damp, apply the RT60 gain.
      let sum = 0;
      let l = 0;
      let r = 0;
      if (xfOn) {
        // Smoothstep blend of the old and new taps, and of their gains.
        xf = xf + xfStep < 1 ? xf + xfStep : 1;
        const u = xf * xf * (3 - 2 * xf);
        for (let k = 0; k < LINES; k++) {
          const base = k * cap;
          const o0 = lines[base + ((w - lenCur[k]) & mask)];
          const o1 = lines[base + ((w - lenNext[k]) & mask)];
          const out = o0 + (o1 - o0) * u;
          l += OUT_L[k] * out;
          r += OUT_R[k] * out;
          damp[k] += (out - damp[k]) * dc;
          const v = damp[k] * (gain[k] + (gainNext[k] - gain[k]) * u);
          y[k] = v;
          sum += v;
        }
      } else {
        for (let k = 0; k < LINES; k++) {
          const out = lines[k * cap + ((w - lenCur[k]) & mask)];
          l += OUT_L[k] * out;
          r += OUT_R[k] * out;
          damp[k] += (out - damp[k]) * dc;
          const v = damp[k] * gain[k];
          y[k] = v;
          sum += v;
        }
      }
      // Householder feedback: y − (2/N)·Σy, plus the input.
      const h = sum * (2 / LINES);
      const xin = x * IN_GAIN;
      for (let k = 0; k < LINES; k++) {
        lines[k * cap + w] = y[k] - h + IN_SIGN[k] * xin;
      }
      w = (w + 1) & mask;
      outL[i] = l * OUT_GAIN;
      outR[i] = r * OUT_GAIN;
    }
    if (xfOn) this.xf = xf;
    this.writePos = w;
    this.preWrite = pw;
  }
}
