/**
 * Chords as picker choices (PLAN.md §11.3, inspector revision 5): root, quality and bass to and
 * from a chord symbol, the diatonic triads of a key, and a chord's Roman numeral in a key.
 *
 * Symbols written here use ASCII accidentals ("F#m7b5", "C/E") and round-trip through
 * `parseChord`. Integer arithmetic and string work only (§7.11).
 */

import { parseChord } from './chords';
import { spellPc } from './harmony';
import { mod } from './math';
import { parsePitchClass, pitchClassOf, scaleIntervals } from './scales';
import type { Key } from './types';

/** A chord quality the picker offers. */
export interface ChordQuality {
  id: string;
  /** Display label (glyphs). */
  label: string;
  /** Suffix written in the symbol (ASCII). */
  suffix: string;
  /** Semitones above the root in stacking order: root, 3rd (or sus tone), 5th, then the rest. */
  intervals: readonly number[];
  /** Lower-case Roman numeral. */
  minor: boolean;
  /** Suffix after a Roman numeral. */
  romanSuffix: string;
}

const q = (
  id: string,
  label: string,
  suffix: string,
  intervals: number[],
  minor: boolean,
  romanSuffix: string,
): ChordQuality => ({ id, label, suffix, intervals, minor, romanSuffix });

/** The qualities of §11.3, in display order. */
export const CHORD_QUALITIES: readonly ChordQuality[] = [
  q('maj', 'major', '', [0, 4, 7], false, ''),
  q('min', 'minor', 'm', [0, 3, 7], true, ''),
  q('7', '7', '7', [0, 4, 7, 10], false, '7'),
  q('maj7', 'maj7', 'maj7', [0, 4, 7, 11], false, 'maj7'),
  q('m7', 'm7', 'm7', [0, 3, 7, 10], true, '7'),
  q('6', '6', '6', [0, 4, 7, 9], false, '6'),
  q('sus2', 'sus2', 'sus2', [0, 2, 7], false, 'sus2'),
  q('sus4', 'sus4', 'sus4', [0, 5, 7], false, 'sus4'),
  q('dim', 'dim', 'dim', [0, 3, 6], true, '°'),
  q('aug', 'aug', 'aug', [0, 4, 8], false, '+'),
  q('add9', 'add9', 'add9', [0, 4, 7, 14], false, 'add9'),
  q('m9', 'm9', 'm9', [0, 3, 7, 10, 14], true, '9'),
  q('m7b5', 'm7♭5', 'm7b5', [0, 3, 6, 10], true, 'ø7'),
];

/** Which chord tone is in the bass: none written, or a slash chord on the root, 3rd or 5th. */
export type ChordBass = 'any' | 'root' | 'third' | 'fifth';

/** A chord as picker choices. */
export interface ChordSpec {
  /** Root pitch class. */
  root: number;
  /** A `CHORD_QUALITIES` id. */
  quality: string;
  bass: ChordBass;
}

/** A symbol decomposed for the picker; `quality` null and `bass` 'other' when they don't fit. */
export interface ChordReading {
  root: number;
  quality: string | null;
  bass: ChordBass | 'other';
}

function setKey(xs: readonly number[]): string {
  return [...new Set(xs.map((x) => mod(x, 12)))].sort((a, b) => a - b).join(',');
}

const BY_SET = new Map(CHORD_QUALITIES.map((c) => [setKey(c.intervals), c]));
const BY_ID = new Map(CHORD_QUALITIES.map((c) => [c.id, c]));

export function qualityById(id: string): ChordQuality | null {
  return BY_ID.get(id) ?? null;
}

/** The quality whose pitch-class set, relative to `root`, equals `pcs`; null if none. */
export function qualityOf(pcs: readonly number[], root: number): ChordQuality | null {
  return BY_SET.get(setKey(pcs.map((p) => p - root))) ?? null;
}

/** "♯"/"♭" → "#"/"b". */
function ascii(s: string): string {
  return s.replace(/♯/g, '#').replace(/♭/g, 'b');
}

/** The chord symbol of a picker choice, spelled in `key` ("C", "Dm7", "C/E", "C/C"). */
export function chordSymbol(spec: ChordSpec, key: Key): string {
  const c = qualityById(spec.quality) ?? CHORD_QUALITIES[0];
  const name = ascii(spellPc(spec.root, key)) + c.suffix;
  if (spec.bass === 'any') return name;
  const tone = spec.bass === 'root' ? 0 : spec.bass === 'third' ? c.intervals[1] : c.intervals[2];
  return `${name}/${ascii(spellPc(spec.root + tone, key))}`;
}

/**
 * Reads a chord symbol (letter or Roman) as picker choices, or null if it doesn't parse. A slash
 * bass is read from the text after '/', so "C7/Bb" is a 7th chord over its 7th ('other').
 */
export function readChord(symbol: string, key: Key): ChordReading | null {
  const full = parseChord(symbol, key);
  if (!full.ok) return null;
  const s = symbol.trim();
  const slash = s.indexOf('/');
  const tail = slash < 0 ? null : s.slice(slash + 1).trim();
  const bassPc = tail === null ? null : parsePitchClass(tail);
  // A slash bass that is not a chord tone is appended to `pcs`; read the quality from the head.
  const head = bassPc === null ? full : parseChord(s.slice(0, slash), key);
  if (!head.ok) return null;
  const c = qualityOf(head.pcs, head.root);
  let bass: ChordBass | 'other' = 'any';
  if (bassPc !== null) {
    const rel = mod(bassPc - head.root, 12);
    if (rel === 0) bass = 'root';
    else if (c && rel === mod(c.intervals[1], 12)) bass = 'third';
    else if (c && rel === mod(c.intervals[2], 12)) bass = 'fifth';
    else bass = 'other';
  }
  return { root: head.root, quality: c?.id ?? null, bass };
}

/** Semitones above the tonic of the major-scale degrees I..VII. */
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
/** Numerals for roots outside a 7-note scale, by semitones above the tonic. */
const CHROMATIC: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, -1],
  [1, 0],
  [2, -1],
  [2, 0],
  [3, 0],
  [3, 1],
  [4, 0],
  [5, -1],
  [5, 0],
  [6, -1],
  [6, 0],
];

/**
 * The Roman numeral of a chord in a key ("ii7", "♭VII", "vii°", "♭III+"). A root on a degree of
 * a 7-note scale takes that degree's number, with an accidental against the major scale (♭III in
 * minor); other roots follow C = I, D♭ = ♭II, …, F♯ = ♯IV. An unknown quality reads as a plain
 * upper-case numeral.
 */
export function romanNumeral(root: number, quality: ChordQuality | null, key: Key): string {
  const off = mod(root - pitchClassOf(key.tonic), 12);
  const iv = scaleIntervals(key.scale);
  let degree: number;
  let acc: number;
  const d = iv.length === 7 ? iv.indexOf(off) : -1;
  if (d >= 0 && Math.abs(off - MAJOR_STEPS[d]) <= 1) {
    degree = d;
    acc = off - MAJOR_STEPS[d];
  } else {
    [degree, acc] = CHROMATIC[off];
  }
  const numeral = quality?.minor ? ROMAN[degree].toLowerCase() : ROMAN[degree];
  return (acc < 0 ? '♭' : acc > 0 ? '♯' : '') + numeral + (quality?.romanSuffix ?? '');
}

/** One diatonic triad of a key. */
export interface DiatonicChord {
  /** 0-based scale degree. */
  degree: number;
  root: number;
  quality: ChordQuality;
  /** Roman numeral, display form ("ii", "vii°"). */
  numeral: string;
  /** Symbol to write ("Dm"). */
  symbol: string;
}

/**
 * The triads on each degree of a 7-note scale (stacked thirds of the scale), skipping any whose
 * shape isn't a picker quality. Empty for other scales.
 */
export function diatonicChords(key: Key): DiatonicChord[] {
  const iv = scaleIntervals(key.scale);
  if (iv.length !== 7) return [];
  const tonic = pitchClassOf(key.tonic);
  const out: DiatonicChord[] = [];
  for (let d = 0; d < 7; d++) {
    const root = mod(tonic + iv[d], 12);
    const pcs = [0, 2, 4].map((k) => mod(tonic + iv[mod(d + k, 7)], 12));
    const c = qualityOf(pcs, root);
    if (!c) continue;
    out.push({
      degree: d,
      root,
      quality: c,
      numeral: romanNumeral(root, c, key),
      symbol: chordSymbol({ root, quality: c.id, bass: 'any' }, key),
    });
  }
  return out;
}
