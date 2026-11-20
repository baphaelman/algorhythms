/**
 * Harmony labels for the HUD (PLAN.md §10 layer 7): names the chord a moment sets.
 *
 * - A written chord symbol is shown as written, with ♯/♭ glyphs ("F#m7b5" → "F♯m7♭5").
 * - A Roman numeral is shown with its letter chord, spelled from the key's tonic letter
 *   ("ii7" in C → "ii7 · Dm7", "bVII" in C → "♭VII · B♭").
 * - Any other note set is recognised from its pitch classes and bass ("F/A", "Am7"); a single
 *   pitch class reads "A (unison)", and an unrecognised set lists its pitch classes from the bass.
 *
 * Integer arithmetic and string work only (§7.11).
 */

import { parseChord } from './chords';
import { mod } from './math';
import { parsePitchClass, pitchClassOf, scaleIntervals } from './scales';
import type { Key } from './types';

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const SHARPS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLATS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const ROMAN_RE = /^([#b♯♭]?)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)/;

/** Semitones from the tonic of the scale's parent major (ionian) tonic, for flat/sharp choice. */
const PARENT_MAJOR: Readonly<Record<string, number>> = {
  dorian: 10,
  phrygian: 8,
  lydian: 7,
  mixolydian: 5,
  minor: 3,
  aeolian: 3,
  locrian: 1,
  'harmonic-minor': 3,
  'melodic-minor': 3,
  'pentatonic-minor': 3,
  blues: 3,
};
/** Parent-major tonics whose signatures use flats: F B♭ E♭ A♭ D♭ G♭. */
const FLAT_MAJORS = new Set([5, 10, 3, 8, 1, 6]);

/** Chord templates: intervals above the root (sorted) → suffix. Earlier entries win ties. */
const TEMPLATES: readonly [string, string][] = [
  ['0,4,7', ''],
  ['0,3,7', 'm'],
  ['0,3,6', '°'],
  ['0,4,8', '+'],
  ['0,5,7', 'sus4'],
  ['0,2,7', 'sus2'],
  ['0,7', '5'],
  ['0,4,7,10', '7'],
  ['0,4,7,11', 'maj7'],
  ['0,3,7,10', 'm7'],
  ['0,3,6,10', 'm7♭5'],
  ['0,3,6,9', '°7'],
  ['0,3,7,11', 'm(maj7)'],
  ['0,4,7,9', '6'],
  ['0,3,7,9', 'm6'],
  ['0,5,7,10', '7sus4'],
  ['0,4,8,10', '+7'],
  ['0,4,8,11', '+maj7'],
  ['0,2,4,7', 'add9'],
  ['0,2,3,7', 'm(add9)'],
  ['0,2,4,7,10', '9'],
  ['0,2,4,7,11', 'maj9'],
  ['0,2,3,7,10', 'm9'],
  ['0,2,4,7,9', '6/9'],
  ['0,1,4,7,10', '7♭9'],
  ['0,3,4,7,10', '7♯9'],
  ['0,2,3,5,7,10', 'm11'],
  ['0,2,4,7,9,10', '13'],
  ['0,2,4,7,9,11', 'maj13'],
];
const TEMPLATE_RANK = new Map(TEMPLATES.map(([k], i) => [k, i]));
const TEMPLATE_SUFFIX = new Map(TEMPLATES);

/** True when the key's signature is spelled with flats. */
function prefersFlats(key: Key): boolean {
  if (/b/.test(key.tonic)) return true;
  if (/#/.test(key.tonic)) return false;
  const scale = typeof key.scale === 'string' ? key.scale : '';
  const parent = mod(pitchClassOf(key.tonic) + (PARENT_MAJOR[scale] ?? 0), 12);
  return FLAT_MAJORS.has(parent);
}

/** ASCII accidentals → glyphs. */
function glyphs(s: string): string {
  return s.replace(/#/g, '♯').replace(/b/g, '♭');
}

/** A letter (index 0..6) with the accidentals that make it `pc`; null beyond a double accidental. */
function spellLetter(letter: number, pc: number): string | null {
  const d = mod(pc - LETTER_PC[mod(letter, 7)] + 6, 12) - 6; // −6..5
  if (d < -2 || d > 2) return null;
  const acc = d < 0 ? '♭'.repeat(-d) : '♯'.repeat(d);
  return LETTERS[mod(letter, 7)] + acc;
}

/**
 * Spells a pitch class in a key: a scale tone of a 7-note scale gets its degree's letter (F♯ in
 * G major, B♭ in F major); anything else follows the key signature's flats or sharps.
 */
export function spellPc(pc: number, key: Key): string {
  const p = mod(pc, 12);
  const tonic = pitchClassOf(key.tonic);
  const iv = scaleIntervals(key.scale);
  if (iv.length === 7) {
    const deg = iv.indexOf(mod(p - tonic, 12));
    if (deg >= 0) {
      const s = spellLetter(LETTERS.indexOf(key.tonic.charAt(0)) + deg, p);
      if (s) return s;
    }
  }
  return (prefersFlats(key) ? FLATS : SHARPS)[p];
}

/**
 * Names a pitch-class set with a bass: a chord symbol when a template matches (a root equal to
 * the bass wins, then the simpler template), with "/bass" for inversions; "X (unison)" for one
 * pitch class; otherwise the pitch classes from the bass up.
 */
export function nameChord(pcs: readonly number[], bass: number, key: Key): string {
  const set = [...new Set(pcs.map((p) => mod(p, 12)))];
  const b = mod(bass, 12);
  if (set.length === 0) return '';
  if (set.length === 1) return `${spellPc(set[0], key)} (unison)`;
  let best = -1;
  let bestScore = Infinity;
  let bestKey = '';
  for (const r of set) {
    const k = set
      .map((p) => mod(p - r, 12))
      .sort((x, y) => x - y)
      .join(',');
    const rank = TEMPLATE_RANK.get(k);
    if (rank === undefined) continue;
    const score = (r === b ? 0 : 1000) + rank;
    if (score < bestScore) {
      bestScore = score;
      best = r;
      bestKey = k;
    }
  }
  if (best < 0) {
    return set
      .sort((x, y) => mod(x - b, 12) - mod(y - b, 12))
      .map((p) => spellPc(p, key))
      .join(' ');
  }
  const name = spellPc(best, key) + (TEMPLATE_SUFFIX.get(bestKey) ?? '');
  return best === b || !set.includes(b) ? name : `${name}/${spellPc(b, key)}`;
}

/**
 * The letter chord of a Roman numeral in a key, spelled from the tonic letter ("ii7" in C →
 * "Dm7", "V7/V" → "D7", "bVII" → "B♭"). Null if the symbol is not a valid numeral.
 */
function romanLetterChord(symbol: string, key: Key): string | null {
  const s = symbol.replace(/\s+/g, '');
  const m = ROMAN_RE.exec(s);
  const parsed = parseChord(s, key);
  if (!m || !parsed.ok) return null;
  const slash = s.indexOf('/');
  const head = slash < 0 ? s : s.slice(0, slash);
  const tail = slash < 0 ? null : s.slice(slash + 1);
  let letter = LETTERS.indexOf(key.tonic.charAt(0)) + ROMAN.indexOf(m[2].toUpperCase());
  let bass = '';
  if (tail !== null) {
    const applied = ROMAN_RE.exec(tail);
    if (applied && applied[0] === tail) letter += ROMAN.indexOf(applied[2].toUpperCase());
    else bass = '/' + glyphs(tail);
  }
  const root = spellLetter(letter, parsed.root) ?? spellPc(parsed.root, key);
  let suffix = head.slice(m[0].length);
  const lower = m[2] !== m[2].toUpperCase();
  if (/^o(?!mit)/.test(suffix)) suffix = '°' + suffix.slice(1);
  if (lower && !/^(?:m(?!aj)|min|-|°|dim|ø)/.test(suffix)) suffix = 'm' + suffix;
  return root + glyphs(suffix) + bass;
}

/**
 * The HUD label of a moment's harmony. `symbol` is the written chord symbol (letter or Roman),
 * if any; otherwise the label is recognised from `pcs` and `bass`.
 */
export function harmonyLabel(
  symbol: string | undefined,
  pcs: readonly number[],
  bass: number,
  key: Key,
): string {
  const sym = symbol?.trim();
  if (sym) {
    if (ROMAN_RE.test(sym)) {
      const letter = romanLetterChord(sym, key);
      if (letter) return `${glyphs(sym)} · ${letter}`;
    } else if (parsePitchClass(sym.charAt(0)) !== null) {
      return glyphs(sym.replace(/\s+/g, ''));
    }
  }
  return nameChord(pcs, bass, key);
}
