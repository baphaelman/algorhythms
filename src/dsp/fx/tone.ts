/**
 * Master tone (PLAN.md §8.6): a tilt EQ plus a low-pass, both linear, so they distribute over
 * stems (§12).
 *
 * Tilt in dB/octave is approximated by five first-order high shelves two octaves apart
 * (40 Hz … 10 kHz), each adding 2·tilt dB, normalised to 0 dB at 1 kHz: a smooth staircase that
 * tracks the requested slope across the audible band. The low-pass is a 2nd-order Butterworth
 * (RBJ); at or above 98 % of Nyquist it is bypassed. Parameters are smoothed per block.
 */

import { BLOCK_FRAMES } from '../constants';
import * as pmath from '../pmath';

/** pmath's registers (allocation-free calls on the audio thread). */
const PR = pmath.R;

const SHELVES = 5;
const SHELF_HZ = [40, 160, 640, 2560, 10240];
const PIVOT_HZ = 1000;
const SMOOTH = 0.2;

export class Tone {
  private readonly sampleRate: number = 0;
  // Shelf high-pass coefficients (bilinear, prewarped) and state per channel.
  private readonly hpB0 = new Float64Array(SHELVES);
  private readonly hpA1 = new Float64Array(SHELVES);
  private readonly shelfG = new Float64Array(SHELVES);
  private readonly x1 = new Float64Array(2 * SHELVES);
  private readonly y1 = new Float64Array(2 * SHELVES);
  private norm = 1;
  private tiltCur = 0;
  private tiltTarget = 0;
  // Low-pass biquad (transposed direct form II) per channel.
  private lpOn = false;
  private cutCur = 0;
  private cutTarget = 0;
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private readonly s1 = new Float64Array(2);
  private readonly s2 = new Float64Array(2);

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    for (let k = 0; k < SHELVES; k++) {
      const fc = Math.min(SHELF_HZ[k], 0.45 * sampleRate);
      const K = pmath.tan((Math.PI * fc) / sampleRate);
      this.hpB0[k] = 1 / (1 + K);
      this.hpA1[k] = (K - 1) / (1 + K);
    }
    this.setParams(0, sampleRate, true);
  }

  /** Sets the tilt (dB/oct) and low-pass cutoff (Hz); `immediate` skips smoothing. */
  setParams(tilt: number, lowpassHz: number, immediate = false): void {
    this.tiltTarget = Number.isFinite(tilt) ? Math.max(-6, Math.min(6, tilt)) : 0;
    const nyq = this.sampleRate / 2;
    this.cutTarget = lowpassHz >= 0.98 * nyq || !(lowpassHz > 0) ? nyq : Math.max(20, lowpassHz);
    if (immediate) {
      this.tiltCur = this.tiltTarget;
      this.cutCur = this.cutTarget;
      this.updateTilt();
      this.updateLowpass();
    }
  }

  /** Clears filter state. */
  reset(): void {
    this.x1.fill(0);
    this.y1.fill(0);
    this.s1.fill(0);
    this.s2.fill(0);
  }

  private updateTilt(): void {
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
      this.shelfG[k] = g - 1;
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
    this.norm = 1 / mag;
  }

  private updateLowpass(): void {
    const nyq = this.sampleRate / 2;
    if (this.cutCur >= 0.98 * nyq) {
      this.lpOn = false;
      return;
    }
    this.lpOn = true;
    PR[0] = (2 * Math.PI * this.cutCur) / this.sampleRate;
    pmath.sinCosR();
    const cw = PR[1];
    const alpha = PR[0] / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    this.b0 = (1 - cw) / 2 / a0;
    this.b1 = (1 - cw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  private smoothParams(): void {
    if (this.tiltCur !== this.tiltTarget) {
      const d = this.tiltTarget - this.tiltCur;
      this.tiltCur = Math.abs(d) < 1e-4 ? this.tiltTarget : this.tiltCur + d * SMOOTH;
      this.updateTilt();
    }
    if (this.cutCur !== this.cutTarget) {
      const r = this.cutTarget / this.cutCur;
      if (Math.abs(r - 1) < 1e-4) this.cutCur = this.cutTarget;
      else {
        PR[0] = r;
        PR[1] = SMOOTH;
        pmath.powR();
        this.cutCur *= PR[0];
      }
      const wasOn = this.lpOn;
      this.updateLowpass();
      if (wasOn && !this.lpOn) {
        this.s1.fill(0);
        this.s2.fill(0);
      }
    }
  }

  /** Filters one stereo block in place. */
  process(L: Float64Array, R: Float64Array): void {
    this.smoothParams();
    const tiltOn = this.tiltCur !== 0;
    for (let ch = 0; ch < 2; ch++) {
      const buf = ch === 0 ? L : R;
      if (tiltOn) {
        const norm = this.norm;
        for (let k = 0; k < SHELVES; k++) {
          const b0 = this.hpB0[k];
          const a1 = this.hpA1[k];
          const gm1 = this.shelfG[k];
          const si = ch * SHELVES + k;
          let x1 = this.x1[si];
          let y1 = this.y1[si];
          for (let i = 0; i < BLOCK_FRAMES; i++) {
            const x = buf[i];
            const y = b0 * (x - x1) - a1 * y1;
            x1 = x;
            y1 = y;
            buf[i] = x + gm1 * y;
          }
          this.x1[si] = x1;
          this.y1[si] = y1;
        }
        for (let i = 0; i < BLOCK_FRAMES; i++) buf[i] *= norm;
      }
      if (this.lpOn) {
        const b0 = this.b0;
        const b1 = this.b1;
        const b2 = this.b2;
        const a1 = this.a1;
        const a2 = this.a2;
        let s1 = this.s1[ch];
        let s2 = this.s2[ch];
        for (let i = 0; i < BLOCK_FRAMES; i++) {
          const x = buf[i];
          const y = b0 * x + s1;
          s1 = b1 * x - a1 * y + s2;
          s2 = b2 * x - a2 * y;
          buf[i] = y;
        }
        this.s1[ch] = s1;
        this.s2[ch] = s2;
      }
    }
  }
}
