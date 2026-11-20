/**
 * Scales, pitch classes and scale-degree arithmetic (PLAN.md §7.8).
 *
 * Conventions:
 * - Pitch classes are integers 0..11 with C = 0. Pitches are (fractional) MIDI note numbers.
 * - A *scale tone* is an integer pitch whose pitch class is in the key's scale.
 * - The *global degree index* numbers every scale tone from the tonic: index k·n + j (n = the
 *   scale's size) is degree j of the octave that starts at tonicPc + 12·k. So index 0 is the
 *   tonic just above MIDI 0 (or at it, for C), index mod n is the scale degree (0 = tonic), and
 *   the index is strictly increasing in pitch. Negative indices continue below.
 * - Snapping goes to the nearest scale tone; exact ties go down (§7.8).
 *
 * Integer and exact floating-point operations only (§7.11).
 */

import type { Key, Pitch, PitchClass, ScaleName, ScaleRef } from './types';

/**
 * Built-in scales as ascending semitone offsets from the tonic, keyed by `ScaleName`. Aliases
 * (major/ionian, minor/aeolian) share their arrays. Frozen.
 */
export const SCALES: Readonly<Record<string, readonly number[]>> = (() => {
  const ionian = Object.freeze([0, 2, 4, 5, 7, 9, 11]);
  const aeolian = Object.freeze([0, 2, 3, 5, 7, 8, 10]);
  return Object.freeze({
    major: ionian,
    ionian,
    dorian: Object.freeze([0, 2, 3, 5, 7, 9, 10]),
    phrygian: Object.freeze([0, 1, 3, 5, 7, 8, 10]),
    lydian: Object.freeze([0, 2, 4, 6, 7, 9, 11]),
    mixolydian: Object.freeze([0, 2, 4, 5, 7, 9, 10]),
    minor: aeolian,
    aeolian,
    locrian: Object.freeze([0, 1, 3, 5, 6, 8, 10]),
    'harmonic-minor': Object.freeze([0, 2, 3, 5, 7, 8, 11]),
    'melodic-minor': Object.freeze([0, 2, 3, 5, 7, 9, 11]),
    'pentatonic-major': Object.freeze([0, 2, 4, 7, 9]),
    'pentatonic-minor': Object.freeze([0, 3, 5, 7, 10]),
    blues: Object.freeze([0, 3, 5, 6, 7, 10]),
    'whole-tone': Object.freeze([0, 2, 4, 6, 8, 10]),
    chromatic: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
  } satisfies Record<ScaleName, readonly number[]>);
})();

/** Every built-in scale name, in display order. */
export const SCALE_NAMES = Object.keys(SCALES) as readonly ScaleName[];

/** Floored modulo: the result has the sign of `n` (so mod(−1, 12) = 11). */
function mod(x: number, n: number): number {
  const r = x % n;
  return r < 0 ? r + n : r === 0 ? 0 : r; // `=== 0` folds −0 to 0
}

const LETTER_PC: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Parses a note name: a letter A–G (case-insensitive) followed by any number of accidentals
 * ('#', 'b', '♯', '♭', and 'x' or '𝄪' for a double sharp). Returns the pitch class 0..11, or null
 * if `name` is not a note name. Accepts more than `PitchClass` (e.g. 'Cb', 'E#', 'F##').
 */
export function parsePitchClass(name: string): number | null {
  const m = /^([A-Ga-g])((?:#|b|♯|♭|x|𝄪)*)$/u.exec(name);
  if (!m) return null;
  let pc = LETTER_PC[m[1].toUpperCase()];
  for (const ch of m[2]) {
    if (ch === '#' || ch === '♯') pc += 1;
    else if (ch === 'b' || ch === '♭') pc -= 1;
    else pc += 2; // x, 𝄪
  }
  return mod(pc, 12);
}

/** Pitch class 0..11 of a note name ('C'..'B' with '#' or 'b'). Throws on an invalid name. */
export function pitchClassOf(name: PitchClass): number {
  const pc = parsePitchClass(name);
  if (pc === null) throw new RangeError(`Not a pitch class: '${String(name)}'`);
  return pc;
}

/** Sharp spellings of the 12 pitch classes. */
export const SHARP_NAMES: readonly PitchClass[] = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
];

/** Flat spellings of the 12 pitch classes. */
export const FLAT_NAMES: readonly PitchClass[] = [
  'C',
  'Db',
  'D',
  'Eb',
  'E',
  'F',
  'Gb',
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
];

/**
 * The name of the nearest semitone, with its octave (MIDI 60 = 'C4', 69 = 'A4'). Sharps by
 * default. For hover readouts (§11.3).
 */
export function noteName(p: Pitch, flats = false): string {
  const n = Math.round(p);
  return (flats ? FLAT_NAMES : SHARP_NAMES)[mod(n, 12)] + String(Math.floor(n / 12) - 1);
}

/**
 * The semitone offsets of a scale from its tonic: ascending, unique, in [0, 12), starting with 0.
 * Custom intervals are normalised (taken mod 12, rounded, sorted, deduplicated, 0 added), so a
 * malformed custom scale still behaves; an empty one becomes [0] (the tonic in every octave).
 */
export function scaleIntervals(scale: ScaleRef): readonly number[] {
  if (typeof scale === 'string') {
    const builtin = SCALES[scale];
    if (!builtin) throw new RangeError(`Unknown scale: '${String(scale)}'`);
    return builtin;
  }
  const set = new Set<number>([0]);
  for (const i of scale.intervals) if (Number.isFinite(i)) set.add(mod(Math.round(i), 12));
  return [...set].sort((a, b) => a - b);
}

/** The key's pitch classes, sorted ascending (0..11). */
export function scalePcs(key: Key): number[] {
  const t = pitchClassOf(key.tonic);
  return scaleIntervals(key.scale)
    .map((i) => mod(t + i, 12))
    .sort((a, b) => a - b);
}

/** True if `p` is an integer pitch whose pitch class is in the key. */
export function isScaleTone(p: Pitch, key: Key): boolean {
  return Number.isInteger(p) && scalePcs(key).includes(mod(p, 12));
}

/** The pitch of global degree index `i` (see the module comment). Non-integers are rounded. */
export function pitchOfDegreeIndex(i: number, key: Key): Pitch {
  const iv = scaleIntervals(key.scale);
  const n = iv.length;
  const k = Math.round(i);
  const octave = Math.floor(k / n);
  return pitchClassOf(key.tonic) + 12 * octave + iv[k - octave * n];
}

/**
 * The nearest scale tone to `p`; an exact tie goes to the lower tone (§7.8). Always an integer
 * pitch. Non-finite input is returned unchanged.
 */
export function snapToScale(p: Pitch, key: Key): Pitch {
  if (!Number.isFinite(p)) return p;
  const iv = scaleIntervals(key.scale);
  const t = pitchClassOf(key.tonic);
  const base = t + 12 * Math.floor((p - t) / 12); // the tonic at or below p
  let best = NaN;
  let bestDist = Infinity;
  // Candidates in the octaves below, at and above p's; ascending, so `<` keeps the lower on ties.
  for (let o = -1; o <= 1; o++) {
    for (const i of iv) {
      const c = base + 12 * o + i;
      const d = Math.abs(p - c);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
  }
  return best;
}

/** The global degree index of `p` after snapping it to the scale. Monotone in pitch. */
export function scaleDegreeIndex(p: Pitch, key: Key): number {
  const q = snapToScale(p, key);
  const iv = scaleIntervals(key.scale);
  const rel = q - pitchClassOf(key.tonic);
  const octave = Math.floor(rel / 12);
  return octave * iv.length + iv.indexOf(rel - 12 * octave);
}

/**
 * Moves `p` by `steps` scale steps: snaps first (§7.8), then steps by global degree index.
 * Non-integer `steps` are rounded.
 */
export function stepByScale(p: Pitch, steps: number, key: Key): Pitch {
  return pitchOfDegreeIndex(scaleDegreeIndex(p, key) + Math.round(steps), key);
}

/**
 * Pitch classes of 0-based scale degrees in the key, one per input degree (same order, not
 * deduplicated). Degrees may exceed the scale size or be negative, and wrap: in A dorian, degree
 * 8 is degree 1 (B) an octave up and degree 9 is degree 2 (C) an octave up, so their pitch classes
 * are 11 and 0. Non-integer degrees are rounded.
 */
export function degreesToPcs(degrees: number[], key: Key): number[] {
  const iv = scaleIntervals(key.scale);
  const t = pitchClassOf(key.tonic);
  return degrees.map((d) => mod(t + iv[mod(Math.round(d), iv.length)], 12));
}

/**
 * Every integer pitch in [low, high] whose pitch class is in `pcs`, ascending. This is the
 * candidate list a chord-like NoteSet is voiced from (§7.3).
 */
export function pitchesWithPcs(pcs: readonly number[], low: Pitch, high: Pitch): Pitch[] {
  const set = new Set(pcs.map((pc) => mod(Math.round(pc), 12)));
  const out: Pitch[] = [];
  for (let p = Math.ceil(low); p <= high; p++) if (set.has(mod(p, 12))) out.push(p);
  return out;
}
