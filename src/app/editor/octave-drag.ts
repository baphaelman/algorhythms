/**
 * Shift-drag by octaves (PLAN.md §11.3 "Shift-drag moves by octaves", owner 2026-11-21). Pure.
 * - `octaveSpan`: the whole octaves every dot can move and stay inside its range (always holds 0).
 * - `octaveSnap`: the octaves nearest a raw pointer pitch, clamped to a span.
 * - `octaveGuides`: the start pitch at each octave in a span (the score's guide lines).
 * - `octaveLabel`: "+1 oct", "−2 oct".
 */

import type { Pitch } from '../../core/types';

export const OCTAVE = 12;

/** A dot's pitch and its line's range ([low, high]; absent: MIDI 0..127). */
export interface OctaveDot {
  pitch: Pitch;
  range?: readonly [Pitch, Pitch] | undefined;
}

/** [lowest, highest] octaves that keep every dot inside its range; 0 always included. */
export function octaveSpan(dots: readonly OctaveDot[]): [number, number] {
  let lo = -Infinity;
  let hi = Infinity;
  for (const { pitch, range } of dots) {
    const [a, b] = range ?? [0, 127];
    const rLo = Math.max(0, Math.min(a, b));
    const rHi = Math.min(127, Math.max(a, b));
    lo = Math.max(lo, Math.min(0, Math.ceil((rLo - pitch) / OCTAVE)));
    hi = Math.min(hi, Math.max(0, Math.floor((rHi - pitch) / OCTAVE)));
  }
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi)) hi = 0;
  return [lo + 0, hi + 0];
}

/** The whole octaves from `start` nearest `raw`, clamped to `span`. */
export function octaveSnap(start: Pitch, raw: Pitch, span: readonly [number, number]): number {
  const k = Math.round((raw - start) / OCTAVE);
  return Math.min(span[1], Math.max(span[0], k)) + 0;
}

/** `start` at every octave in `span` (0 included), low to high. */
export function octaveGuides(start: Pitch, span: readonly [number, number]): Pitch[] {
  const out: Pitch[] = [];
  for (let k = span[0]; k <= span[1]; k++) out.push(start + k * OCTAVE);
  return out;
}

/** "+1 oct", "−2 oct", "0 oct" (a real minus sign). */
export function octaveLabel(k: number): string {
  if (k > 0) return `+${k} oct`;
  if (k < 0) return `−${-k} oct`;
  return '0 oct';
}
