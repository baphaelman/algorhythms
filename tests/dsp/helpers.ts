/** Shared helpers for the DSP tests (PLAN.md §14): rendering, levels and the click detector. */

import type { CompiledScore, MixSettings } from '../../src/core/types';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { Graph } from '../../src/dsp/graph';
import { createLoadedGraph, renderOffline } from '../../src/audio/offline';

export const RATE = 48000;

/** Renders `seconds` of a score from t = 0 (whole blocks). */
export function render(
  score: CompiledScore,
  mix: MixSettings,
  seconds: number,
  sampleRate = RATE,
): { left: Float32Array; right: Float32Array } {
  const frames = Math.ceil((seconds * sampleRate) / BLOCK_FRAMES) * BLOCK_FRAMES;
  return renderOffline({ score, mix, sampleRate }, frames);
}

/** A loaded graph plus a block-by-block driver that records the output. */
export class Driver {
  readonly graph: Graph;
  readonly left: number[] = [];
  readonly right: number[] = [];
  private readonly bl = new Float32Array(BLOCK_FRAMES);
  private readonly br = new Float32Array(BLOCK_FRAMES);

  constructor(score: CompiledScore, mix: MixSettings, sampleRate = RATE) {
    this.graph = createLoadedGraph({ score, mix, sampleRate });
  }

  /** Renders whole blocks covering `seconds`. */
  run(seconds: number): void {
    const blocks = Math.ceil((seconds * this.graph.sampleRate) / BLOCK_FRAMES);
    for (let b = 0; b < blocks; b++) {
      this.graph.process(this.bl, this.br);
      for (let i = 0; i < BLOCK_FRAMES; i++) {
        this.left.push(this.bl[i]);
        this.right.push(this.br[i]);
      }
    }
  }

  /** Current output length in frames. */
  get frames(): number {
    return this.left.length;
  }

  out(): { left: Float32Array; right: Float32Array } {
    return { left: Float32Array.from(this.left), right: Float32Array.from(this.right) };
  }
}

export function allFinite(x: Float32Array): boolean {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false;
  return true;
}

export function peak(x: Float32Array, from = 0, to = x.length): number {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

export function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/** RMS of both channels together over [from, to) seconds. */
export function stereoRms(out: { left: Float32Array; right: Float32Array }, from: number, to: number, rate = RATE): number {
  const a = Math.floor(from * rate);
  const b = Math.floor(to * rate);
  const l = rms(out.left, a, b);
  const r = rms(out.right, a, b);
  return Math.sqrt((l * l + r * r) / 2);
}

export function dbfs(x: number): number {
  return 20 * Math.log10(x);
}

/**
 * Click detector (§14): the largest sample-to-sample step |x[n] − x[n−1]|, divided by the local
 * level (RMS over ±`window` seconds around n, floored at `floor`). A clean signal of moderate
 * bandwidth stays well below the threshold; a discontinuity of a few percent of full scale
 * stands out. Returns the worst ratio and where it happened.
 */
export function clickScore(
  x: Float32Array,
  from = 1,
  to = x.length,
  rate = RATE,
  window = 0.01,
  floor = 1e-3,
): { ratio: number; at: number } {
  const w = Math.max(1, Math.round(window * rate));
  // Prefix sums of squares for O(1) local RMS.
  const pre = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) pre[i + 1] = pre[i] + x[i] * x[i];
  let worst = 0;
  let at = -1;
  for (let i = Math.max(1, from); i < to; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(x.length, i + w);
    const local = Math.sqrt((pre[b] - pre[a]) / (b - a));
    const ratio = Math.abs(x[i] - x[i - 1]) / Math.max(local, floor);
    if (ratio > worst) {
      worst = ratio;
      at = i;
    }
  }
  return { ratio: worst, at: at / rate };
}
