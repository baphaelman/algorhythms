/**
 * Master tone (PLAN.md §8.6): a tilt EQ plus a low-pass, both linear, so they distribute over
 * stems (§12).
 *
 * Tilt in dB/octave is approximated by five first-order high shelves two octaves apart
 * (40 Hz … 10 kHz), each adding 2·tilt dB, normalised to 0 dB at 1 kHz: a smooth staircase that
 * tracks the requested slope across the audible band. The shelf corners are fixed, so tilt only
 * scales each shelf's high-pass output; those high-passes run even at tilt 0, so turning tilt on
 * starts from live state. The low-pass is a 2nd-order Butterworth as a TPT state-variable filter,
 * which stays clean under fast cutoff modulation; at or above 98 % of Nyquist it is crossfaded
 * out (its state keeps running at that cutoff).
 *
 * Smoothing (live edits, build log "Smooth master FX edits"): tilt follows its target with a
 * one-pole per block and its gains are interpolated per sample; the cutoff follows in log
 * frequency with a one-pole per 16-sample step. With constant settings nothing moves.
 */

import { BLOCK_FRAMES } from '../constants';
import * as pmath from '../pmath';

/** pmath's registers (allocation-free calls on the audio thread). */
const PR = pmath.R;

const SHELVES = 5;
const SHELF_HZ = [40, 160, 640, 2560, 10240];
const PIVOT_HZ = 1000;
/** Smoothing time constants (seconds). */
const TILT_TAU = 0.015;
const CUT_TAU = 0.015;
/** Cutoff coefficient update period (samples); divides BLOCK_FRAMES. */
const CUT_STEP = 16;
/** Butterworth damping, 1/Q. */
const SVF_K = Math.SQRT2;
/** Highest active cutoff, as a fraction of Nyquist; above it the low-pass is bypassed. */
const LP_MAX = 0.98;

export class Tone {
  private readonly sampleRate: number = 0;
  private readonly nyq: number = 0;
  // Shelf high-pass coefficients (bilinear, prewarped) and state per channel.
  private readonly hpB0 = new Float64Array(SHELVES);
  private readonly hpA1 = new Float64Array(SHELVES);
  private readonly x1 = new Float64Array(2 * SHELVES);
  private readonly y1 = new Float64Array(2 * SHELVES);
  /** Per-block one-pole coefficients. */
  private readonly tiltSmooth: number = 0;
  private readonly cutSmooth: number = 0;
  /** Shelf gain − 1 and the 1 kHz normalisation, at the end of the last block. */
  private gm1 = 0;
  private norm = 1;
  /** The same at the start of the current block (fields: doubles passed to calls box). */
  private gm1From = 0;
  private normFrom = 1;
  private tiltRamp = false;
  private tiltMoving = false;
  private lpMoving = false;
  /** Steady low-pass output: true when active (wet 1), false when bypassed. */
  private lpWrite = false;
  private tiltCur = 0;
  private tiltTarget = 0;
  // Low-pass: cutoff as log2(Hz), SVF coefficients, wet weight (0 = bypassed), state per channel.
  private cutTarget = 0;
  private logCut = 0;
  private logTarget = 0;
  private lpWet = 0;
  private lpWetTarget = 0;
  private wetFrom = 0;
  private dWet = 0;
  private a1 = 1;
  private a2 = 0;
  private a3 = 0;
  private readonly ic1 = new Float64Array(2);
  private readonly ic2 = new Float64Array(2);

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.nyq = sampleRate / 2;
    for (let k = 0; k < SHELVES; k++) {
      const fc = Math.min(SHELF_HZ[k], 0.45 * sampleRate);
      const K = pmath.tan((Math.PI * fc) / sampleRate);
      this.hpB0[k] = 1 / (1 + K);
      this.hpA1[k] = (K - 1) / (1 + K);
    }
    this.tiltSmooth = 1 - pmath.exp(-BLOCK_FRAMES / (TILT_TAU * sampleRate));
    this.cutSmooth = 1 - pmath.exp(-CUT_STEP / (CUT_TAU * sampleRate));
    this.setParams(0, sampleRate, true);
  }

  /** Sets the tilt (dB/oct) and low-pass cutoff (Hz); `immediate` skips smoothing. */
  setParams(tilt: number, lowpassHz: number, immediate = false): void {
    this.tiltTarget = Number.isFinite(tilt) ? Math.max(-6, Math.min(6, tilt)) : 0;
    const on = !(lowpassHz >= LP_MAX * this.nyq || !(lowpassHz > 0));
    this.cutTarget = on ? Math.max(20, lowpassHz) : LP_MAX * this.nyq;
    this.lpWetTarget = on ? 1 : 0;
    PR[0] = this.cutTarget;
    pmath.log2R();
    this.logTarget = PR[0];
    if (immediate) {
      this.tiltCur = this.tiltTarget;
      this.updateTilt();
      this.logCut = this.logTarget;
      this.lpWet = this.lpWetTarget;
      this.lpWrite = this.lpWet === 1;
      PR[0] = this.cutTarget;
      this.updateLowpassR();
    }
    this.tiltMoving = this.tiltCur !== this.tiltTarget;
    this.lpMoving = this.logCut !== this.logTarget || this.lpWet !== this.lpWetTarget;
  }

  /** Clears filter state. */
  reset(): void {
    this.x1.fill(0);
    this.y1.fill(0);
    this.ic1.fill(0);
    this.ic2.fill(0);
  }

  /** gm1 and norm for tiltCur. */
  private updateTilt(): void {
    if (this.tiltCur === 0) {
      this.gm1 = 0;
      this.norm = 1;
      return;
    }
    // Each shelf adds 2·tilt dB above its corner (two octaves per shelf).
    PR[0] = 2 * this.tiltCur;
    pmath.dbToGainR();
    const g = PR[0];
    PR[0] = (2 * Math.PI * PIVOT_HZ) / this.sampleRate;
    pmath.sinCosR();
    const s = PR[0];
    const c = PR[1];
    let mag = 1;
    for (let k = 0; k < SHELVES; k++) {
      // HP(e^{jw}) = b0 (1 − e^{−jw}) / (1 + a1 e^{−jw}); shelf = 1 + (g − 1)·HP.
      const nr = this.hpB0[k] * (1 - c);
      const ni = this.hpB0[k] * s;
      const dr = 1 + this.hpA1[k] * c;
      const di = -this.hpA1[k] * s;
      const den = dr * dr + di * di;
      const hr = (nr * dr + ni * di) / den;
      const hi = (ni * dr - nr * di) / den;
      const sr = 1 + (g - 1) * hr;
      const si = (g - 1) * hi;
      mag *= Math.sqrt(sr * sr + si * si);
    }
    this.gm1 = g - 1;
    this.norm = 1 / mag;
  }

  /** SVF coefficients for the cutoff in PR[0] (Hz). */
  private updateLowpassR(): void {
    PR[0] = (Math.PI * PR[0]) / this.sampleRate;
    pmath.sinCosR();
    const g = PR[0] / PR[1];
    this.a1 = 1 / (1 + g * (g + SVF_K));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  /**
   * Filters one stereo block in place. With constant settings this touches only booleans: it is
   * called once per block and runs interpreted (boxing every double it reads) until V8 tiers it up.
   */
  process(L: Float64Array, R: Float64Array): void {
    if (this.tiltMoving) this.advanceTilt();
    else this.tiltRamp = false;
    this.tiltBlock(L, 0);
    this.tiltBlock(R, 1);
    if (this.lpMoving) this.lowpassMovingBlock(L, R);
    else {
      this.lowpassSteady(L, 0);
      this.lowpassSteady(R, 1);
    }
  }

  /** Advances tilt's one-pole; tiltBlock ramps the gains across the block. */
  private advanceTilt(): void {
    this.gm1From = this.gm1;
    this.normFrom = this.norm;
    const d = this.tiltTarget - this.tiltCur;
    this.tiltCur = Math.abs(d) < 1e-4 ? this.tiltTarget : this.tiltCur + d * this.tiltSmooth;
    this.tiltMoving = this.tiltCur !== this.tiltTarget;
    this.updateTilt();
    this.tiltRamp = this.gm1From !== this.gm1 || this.normFrom !== this.norm;
  }

  /** Moving low-pass: cutoff per CUT_STEP, wet weight per sample; bypass waits for LP_MAX. */
  private lowpassMovingBlock(L: Float64Array, R: Float64Array): void {
    const wetFrom = this.lpWet;
    const wetTo =
      this.logCut !== this.logTarget ? Math.max(wetFrom, this.lpWetTarget) : this.lpWetTarget;
    this.lpWet = wetTo;
    this.lpWrite = wetTo === 1;
    this.wetFrom = wetFrom;
    this.dWet = (wetTo - wetFrom) / BLOCK_FRAMES;
    for (let j = 0; j < BLOCK_FRAMES; j += CUT_STEP) {
      if (this.logCut !== this.logTarget) {
        const d = this.logTarget - this.logCut;
        if (Math.abs(d) < 1e-4) {
          this.logCut = this.logTarget;
          PR[0] = this.cutTarget;
          this.updateLowpassR();
        } else {
          this.logCut += d * this.cutSmooth;
          PR[0] = this.logCut;
          pmath.exp2R();
          this.updateLowpassR();
        }
      }
      this.lowpassMoving(L, 0, j);
      this.lowpassMoving(R, 1, j);
    }
    this.lpMoving = this.logCut !== this.logTarget || this.lpWet !== this.lpWetTarget;
  }

  private tiltBlock(buf: Float64Array, ch: number): void {
    const gm1From = this.gm1From;
    const normFrom = this.normFrom;
    const ramp = this.tiltRamp;
    const gm1To = this.gm1;
    const dG = (gm1To - gm1From) / BLOCK_FRAMES;
    if (!ramp && gm1To === 0) {
      this.tiltFlat(buf, ch);
      return;
    }
    for (let k = 0; k < SHELVES; k++) {
      const b0 = this.hpB0[k];
      const a1 = this.hpA1[k];
      const si = ch * SHELVES + k;
      let x1 = this.x1[si];
      let y1 = this.y1[si];
      if (ramp) {
        let gm1 = gm1From;
        for (let i = 0; i < BLOCK_FRAMES; i++) {
          gm1 += dG;
          const x = buf[i];
          const y = b0 * (x - x1) - a1 * y1;
          x1 = x;
          y1 = y;
          buf[i] = x + gm1 * y;
        }
      } else {
        for (let i = 0; i < BLOCK_FRAMES; i++) {
          const x = buf[i];
          const y = b0 * (x - x1) - a1 * y1;
          x1 = x;
          y1 = y;
          buf[i] = x + gm1To * y;
        }
      }
      this.x1[si] = x1;
      this.y1[si] = y1;
    }
    if (ramp) {
      let norm = normFrom;
      const dN = (this.norm - normFrom) / BLOCK_FRAMES;
      for (let i = 0; i < BLOCK_FRAMES; i++) {
        norm += dN;
        buf[i] *= norm;
      }
    } else if (this.norm !== 1) {
      const norm = this.norm;
      for (let i = 0; i < BLOCK_FRAMES; i++) buf[i] *= norm;
    }
  }

  /**
   * Tilt 0: the output is the input, so every shelf's high-pass sees it; run them side by side
   * (independent chains) to keep the state live for when tilt moves.
   */
  private tiltFlat(buf: Float64Array, ch: number): void {
    const s = ch * SHELVES;
    const hb = this.hpB0;
    const ha = this.hpA1;
    const b0 = hb[0];
    const b1 = hb[1];
    const b2 = hb[2];
    const b3 = hb[3];
    const b4 = hb[4];
    const a0 = ha[0];
    const a1 = ha[1];
    const a2 = ha[2];
    const a3 = ha[3];
    const a4 = ha[4];
    let x10 = this.x1[s];
    let x11 = this.x1[s + 1];
    let x12 = this.x1[s + 2];
    let x13 = this.x1[s + 3];
    let x14 = this.x1[s + 4];
    let y0 = this.y1[s];
    let y1 = this.y1[s + 1];
    let y2 = this.y1[s + 2];
    let y3 = this.y1[s + 3];
    let y4 = this.y1[s + 4];
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      const x = buf[i];
      y0 = b0 * (x - x10) - a0 * y0;
      y1 = b1 * (x - x11) - a1 * y1;
      y2 = b2 * (x - x12) - a2 * y2;
      y3 = b3 * (x - x13) - a3 * y3;
      y4 = b4 * (x - x14) - a4 * y4;
      x10 = x11 = x12 = x13 = x14 = x;
    }
    this.x1[s] = x10;
    this.x1[s + 1] = x11;
    this.x1[s + 2] = x12;
    this.x1[s + 3] = x13;
    this.x1[s + 4] = x14;
    this.y1[s] = y0;
    this.y1[s + 1] = y1;
    this.y1[s + 2] = y2;
    this.y1[s + 3] = y3;
    this.y1[s + 4] = y4;
  }

  /** Steady low-pass: wet 1 replaces the block, wet 0 only runs the state. */
  private lowpassSteady(buf: Float64Array, ch: number): void {
    const write = this.lpWrite;
    const a1 = this.a1;
    const a2 = this.a2;
    const a3 = this.a3;
    let ic1 = this.ic1[ch];
    let ic2 = this.ic2[ch];
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      const v3 = buf[i] - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      if (write) buf[i] = v2;
    }
    this.ic1[ch] = ic1;
    this.ic2[ch] = ic2;
  }

  /** CUT_STEP samples from `from`, the wet weight ramping by dWet per sample. */
  private lowpassMoving(buf: Float64Array, ch: number, from: number): void {
    const a1 = this.a1;
    const a2 = this.a2;
    const a3 = this.a3;
    const dWet = this.dWet;
    let ic1 = this.ic1[ch];
    let ic2 = this.ic2[ch];
    let w = this.wetFrom + dWet * from;
    for (let i = from; i < from + CUT_STEP; i++) {
      w += dWet;
      const x = buf[i];
      const v3 = x - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      buf[i] = x + (v2 - x) * w;
    }
    this.ic1[ch] = ic1;
    this.ic2[ch] = ic2;
  }
}
