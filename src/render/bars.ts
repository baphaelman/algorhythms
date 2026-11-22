/**
 * The bar grid (PLAN.md §11.3 revision 7 "Snapping and bars"): beat and bar spacing at a zoom.
 * Drawn faint (beats) and stronger (bars) in the score and the ruler; never a default snap target.
 * Pure; shared by `drawScore` and the app's ruler.
 */

import type { Seconds } from '../core/types';

/** Tempo used when the piece has none, bpm. */
export const DEFAULT_BPM = 60;
/** Beats per bar when the piece has no meter. */
export const DEFAULT_METER = 4;
/** Beats closer than this (px) are not drawn. */
export const BEAT_MIN_PX = 8;
/** Bars closer than this (px) are thinned to every 2nd, 4th, ... bar. */
export const BAR_MIN_PX = 24;

/** Spacing of the drawn grid at one zoom. */
export interface BarGrid {
  /** Beat length, seconds; 0 when beats are too dense to draw. */
  beat: Seconds;
  /** Spacing of the drawn bar lines, seconds (a bar, or a power-of-two multiple of one). */
  bar: Seconds;
}

/**
 * The grid for `bpm` and `meter` at `pps` px per second (defaults for missing/invalid input).
 * `every`: every beat and bar whatever the zoom (no BEAT_MIN_PX / BAR_MIN_PX thinning).
 */
export function barGrid(
  bpm: number | undefined,
  meter: number | undefined,
  pps: number,
  every = false,
): BarGrid {
  const b = bpm !== undefined && Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM;
  const m = meter !== undefined && Number.isInteger(meter) && meter >= 1 ? meter : DEFAULT_METER;
  const beat = 60 / b;
  let bar = beat * m;
  if (every) return { beat: m > 1 ? beat : 0, bar };
  if (pps > 0) while (bar * pps < BAR_MIN_PX) bar *= 2;
  return { beat: pps > 0 && beat * pps >= BEAT_MIN_PX && m > 1 ? beat : 0, bar };
}
