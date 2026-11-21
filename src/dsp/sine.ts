/**
 * The shared 4096-point sine table (PLAN.md §8.4). Vibrato, motion curves, pan laws and
 * crossfades read it with linear interpolation; nothing in the DSP evaluates a sine per sample.
 */

import * as pmath from './pmath';

/** Points in one cycle. */
export const SINE_TABLE_SIZE = 4096;

/** One cycle of sin(2πx) with a guard point (SINE[SIZE] = SINE[0]), so reads never wrap. */
export const SINE: Float64Array = (() => {
  const t = new Float64Array(SINE_TABLE_SIZE + 1);
  for (let i = 0; i < SINE_TABLE_SIZE; i++) t[i] = pmath.sinPi((2 * i) / SINE_TABLE_SIZE);
  t[SINE_TABLE_SIZE] = t[0];
  return t;
})();

/** sin(2π·x) for any finite x, by table lookup. */
export function sin2pi(x: number): number {
  let f = x - Math.floor(x);
  if (f >= 1) f = 0;
  const pos = f * SINE_TABLE_SIZE;
  const i = pos | 0;
  const a = SINE[i];
  return a + (SINE[i + 1] - a) * (pos - i);
}

/** cos(2π·x) by table lookup. */
export function cos2pi(x: number): number {
  return sin2pi(x + 0.25);
}
