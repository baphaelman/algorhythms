/**
 * Folds (PLAN.md M13 "Upside down and wider/closer"): a mirror p → 2a − p about the axis a maps
 * the key's pitch classes S onto 2a − S. A key whose scale reads the same backwards has mirror
 * sums k (k − S = S): about an axis with 2a ≡ k (mod 12) the fold keeps the key, and about the
 * axis a semitone above (2a ≡ k + 2) it lands in the same scale a whole step up. Every diatonic
 * mode qualifies: the axis that keeps it is the 2nd degree of its major scale (the tonic in
 * dorian, the 2nd degree in major), and the one a tritone away. Harmonic minor and the blues
 * scale have no such axis. Pure and exact.
 */

import { mod } from './math';
import { SCALE_NAMES, pitchClassOf, scaleIntervals, scalePcs } from './scales';
import type { Key, PitchClass, Pitch, ScaleRef } from './types';

/** Mirror sums k in 0..11 with (k − S) mod 12 = S: a fold about a with 2a ≡ k keeps the key. */
export function mirrorSums(key: Key): number[] {
  const s = scalePcs(key);
  const has = new Set(s);
  const out: number[] = [];
  for (let k = 0; k < 12; k++) if (s.every((pc) => has.has(mod(k - pc, 12)))) out.push(k);
  return out;
}

/** The pitch classes a fold about `axis` maps the key onto; null unless 2·axis is whole. */
export function foldedPcs(key: Key, axis: Pitch): number[] | null {
  const a2 = 2 * axis;
  if (!Number.isInteger(a2)) return null;
  return scalePcs(key)
    .map((pc) => mod(a2 - pc, 12))
    .sort((a, b) => a - b);
}

const SHARP_TONICS: readonly PitchClass[] = [
  'C',
  'C#',
  'D',
  'Eb',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'Bb',
  'B',
];
const FLAT_TONICS: readonly PitchClass[] = [
  'C',
  'Db',
  'D',
  'Eb',
  'E',
  'F',
  'F#',
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
];

/** A tonic's usual spelling for a scale: C♯ and G♯ for minor-third scales, D♭ and A♭ else. */
function tonicName(pc: number, scale: ScaleRef): PitchClass {
  const iv = scaleIntervals(scale);
  const minor = iv.includes(3) && !iv.includes(4);
  return (minor ? SHARP_TONICS : FLAT_TONICS)[mod(pc, 12)];
}

function samePcs(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The key a fold about `axis` lands in: `key` itself when the fold keeps it; else the same scale
 * on another tonic; else a built-in scale with those pitch classes (its tonic nearest the folded
 * tonic). Null when 2·axis isn't whole or no built-in scale matches.
 */
export function foldedKey(key: Key, axis: Pitch): Key | null {
  const to = foldedPcs(key, axis);
  if (!to) return null;
  const from = scalePcs(key);
  if (samePcs(from, to)) return key;
  const tonic = pitchClassOf(key.tonic);
  for (let t = 1; t < 12; t++) {
    const moved = from.map((pc) => mod(pc + t, 12)).sort((a, b) => a - b);
    if (samePcs(moved, to)) return { tonic: tonicName(tonic + t, key.scale), scale: key.scale };
  }
  const mirrored = mod(2 * axis - tonic, 12);
  for (let d = 0; d < 12; d++) {
    const pc = mod(mirrored + d, 12);
    for (const scale of SCALE_NAMES) {
      const k: Key = { tonic: tonicName(pc, scale), scale };
      if (samePcs(scalePcs(k), to)) return k;
    }
  }
  return null;
}

/** The two axes a fold is offered about (see the module comment). */
export interface FoldAxes {
  /** Keeps the key. */
  keep: Pitch;
  /** A semitone above `keep`: lands a whole step up. */
  lift: Pitch;
}

/**
 * The axis nearest `near` that keeps the key (ties lower) and the one a semitone above it; null
 * when no fold keeps the key. An axis may fall between two semitones (2a odd) in a scale
 * mirrored that way; the folded notes are still whole semitones.
 */
export function foldAxes(key: Key, near: Pitch): FoldAxes | null {
  if (!Number.isFinite(near)) return null;
  let best = NaN;
  for (const k of mirrorSums(key)) {
    // Axes with 2a ≡ k (mod 12) are k/2 + 6j.
    const base = k / 2;
    const j = Math.round((near - base) / 6);
    for (const a of [base + 6 * (j - 1), base + 6 * j, base + 6 * (j + 1)]) {
      const d = Math.abs(a - near);
      const bd = Math.abs(best - near);
      if (best !== best || d < bd || (d === bd && a < best)) best = a;
    }
  }
  return best === best ? { keep: best, lift: best + 1 } : null;
}
