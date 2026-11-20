/**
 * M0 pipeline proof: a sine test tone read from a 4096-point table with linear interpolation, the
 * way §8.4 asks the DSP to make sines (no per-sample Math.sin). Fades use the shared smootherstep
 * from core/ease, which also proves that the worklet can import core and dsp modules in both
 * `vite dev` and the production build. M2 may replace this file.
 *
 * `render` is allocation-free (§8.11).
 */

import { EaseCode, easeRaw } from '../core/ease';
import type { Seconds } from '../core/types';

/** Points in one cycle of the sine table. */
export const SINE_TABLE_SIZE = 4096;

/** One sine cycle with a guard point (table[SIZE] = table[0]) so interpolation never wraps. */
export function makeSineTable(): Float32Array {
  const table = new Float32Array(SINE_TABLE_SIZE + 1);
  for (let i = 0; i <= SINE_TABLE_SIZE; i++) {
    table[i] = Math.sin((2 * Math.PI * i) / SINE_TABLE_SIZE);
  }
  return table;
}

/** A sine oscillator with smootherstep gain fades. */
export class TestTone {
  private readonly table = makeSineTable();
  /** Phase in cycles, [0, 1). */
  private phase = 0;
  private gainFrom = 0;
  private gainTo = 0;
  private fadeFrames = 0;
  private fadePos = 0;

  /**
   * @param sampleRate output sample rate in Hz
   * @param frequency  tone frequency in Hz
   * @param amplitude  peak amplitude at full gain
   */
  constructor(
    private readonly sampleRate: number,
    public frequency = 440,
    public amplitude = 0.2,
  ) {}

  /** Current fade gain, 0..1. */
  get gain(): number {
    if (this.fadePos >= this.fadeFrames) return this.gainTo;
    const e = easeRaw(EaseCode.Smootherstep, this.fadePos / this.fadeFrames, 0, 0, 1, 1);
    return this.gainFrom + (this.gainTo - this.gainFrom) * e;
  }

  /** Starts a smootherstep fade from the current gain to `target` over `seconds`. */
  fadeTo(target: number, seconds: Seconds): void {
    this.gainFrom = this.gain;
    this.gainTo = target;
    this.fadeFrames = Math.max(1, Math.round(seconds * this.sampleRate));
    this.fadePos = 0;
  }

  /** Writes `frames` samples into `out`. */
  render(out: Float32Array, frames: number): void {
    const table = this.table;
    const inc = this.frequency / this.sampleRate;
    let phase = this.phase;
    for (let i = 0; i < frames; i++) {
      const pos = phase * SINE_TABLE_SIZE;
      const idx = pos | 0;
      const frac = pos - idx;
      const a = table[idx];
      const s = a + (table[idx + 1] - a) * frac;
      out[i] = s * this.amplitude * this.gain;
      if (this.fadePos < this.fadeFrames) this.fadePos++;
      phase += inc;
      if (phase >= 1) phase -= 1;
    }
    this.phase = phase;
  }
}
