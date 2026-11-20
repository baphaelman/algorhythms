/**
 * Ranges (PLAN.md §7.8): out-of-range targets fold by octave into the voice's range. If the range
 * is narrower than an octave and no octave of the pitch fits, the nearest octave is clamped into
 * the range and the caller raises a diagnostic.
 */

import type { Pitch } from '../types';

export interface Folded {
  p: Pitch;
  /** The pitch was moved by octaves. */
  folded: boolean;
  /** No octave fitted (range narrower than an octave); `p` was clamped. */
  clampedToRange: boolean;
}

function distance(x: number, lo: number, hi: number): number {
  return x < lo ? lo - x : x > hi ? x - hi : 0;
}

export function foldIntoRange(x: Pitch, lo: Pitch, hi: Pitch): Folded {
  if (x >= lo && x <= hi) return { p: x, folded: false, clampedToRange: false };
  const y = x > hi ? x - 12 * Math.ceil((x - hi) / 12) : x + 12 * Math.ceil((lo - x) / 12);
  if (y >= lo && y <= hi) return { p: y, folded: true, clampedToRange: false };
  const alt = x > hi ? y + 12 : y - 12;
  const pick = distance(y, lo, hi) <= distance(alt, lo, hi) ? y : alt;
  return { p: pick < lo ? lo : pick > hi ? hi : pick, folded: true, clampedToRange: true };
}

/** A usable [low, high] range from a VoiceDef's, or the full MIDI range. */
export function sanitizeRange(r: unknown): [Pitch, Pitch] {
  if (Array.isArray(r) && r.length === 2) {
    const a = Number(r[0]);
    const b = Number(r[1]);
    if (Number.isFinite(a) && Number.isFinite(b)) return a <= b ? [a, b] : [b, a];
  }
  return [0, 127];
}
