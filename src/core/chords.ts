/**
 * Chord-symbol parser (PLAN.md §7.3): turns "Am9", "F#m7b5", "C/E", "ii7" or "bVII" into pitch
 * classes.
 *
 * Grammar, informally:
 *
 *   chord   = (letter-root | roman) suffix ["/" (note | roman)]
 *   letter-root = A–G followed by any accidentals (#, b, ♯, ♭)
 *   roman   = [b | #] (I II III IV V VI VII | i ii iii iv v vi vii)
 *   suffix  = [quality] [extension] modifier*
 *   quality = m min mi - | M maj ma Δ | dim ° o | aug + | ø
 *   extension = 5 6 69 (or 6/9) 7 9 11 13
 *   modifier  = sus2 sus4 sus | add2 add4 add6 add9 add11 add13 (also add#11, addb9, …)
 *             | b5 #5 b9 #9 #11 b13 (also +5, -9, …) | no3 no5 omit3 omit5 | alt
 *             | maj7 M7 Δ7 (after a minor or augmented quality: mM7, m(maj7), +M7)
 *             | 9, 11, 13 or an alteration inside parentheses: C7(b9, 13)
 *
 * Meanings follow common lead-sheet practice: 7 alone is dominant; 11 on a major-quality chord
 * omits the 3rd; 13 on a major-quality chord omits the 11th; dim7 has a diminished 7th; ø and m7b5
 * are half-diminished; alt is 1 3 b7 b9 #9 #11 b13.
 *
 * Roman numerals are measured from the key's tonic on *major-scale* degrees (I = 0, II = 2,
 * III = 4, IV = 5, V = 7, VI = 9, VII = 11 semitones), whatever the key's scale, and an
 * accidental moves the root a semitone: bVII is a whole tone below the tonic in every mode. Case
 * sets the default quality (upper = major, lower = minor); the suffix can override it (vii°,
 * viiø7, III+). A slash followed by a numeral is an applied chord (V7/V); a slash followed by a
 * note name is a slash bass.
 */

import { mod } from './math';
import { parsePitchClass, pitchClassOf } from './scales';
import type { Key } from './types';

/** Result of `parseChord`. */
export type ChordParse =
  | {
      ok: true;
      /**
       * Pitch classes 0..11 without duplicates, in stacking order from the root (root, 3rd, 5th,
       * 6th, 7th, 9th, 11th, 13th). A slash bass that is not a chord tone is appended last.
       */
      pcs: number[];
      /** The root's pitch class. */
      root: number;
      /** The slash bass's pitch class, when the symbol has one. */
      bass?: number;
    }
  | { ok: false; error: string };

/** Semitones above the tonic of the major-scale degrees I..VII. */
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
/** Longest first, so 'VII' is tried before 'VI' and 'V', and 'III' before 'II' and 'I'. */
const ROMAN_RE = /^([#b]?)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)/;

type Quality = 'maj' | 'min' | 'dim' | 'aug' | 'hdim';

function mod12(x: number): number {
  return mod(x, 12);
}

function fail(error: string): ChordParse {
  return { ok: false, error };
}

/** Replaces Unicode look-alikes with their ASCII forms and removes whitespace. */
function normalise(symbol: string): string {
  return symbol
    .replace(/\s+/g, '')
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b')
    .replace(/∆/g, 'Δ')
    .replace(/[−–]/g, '-')
    .replace(/º/g, '°')
    .replace(/Ø/g, 'ø');
}

/** A parsed Roman numeral: its root's offset in semitones from the tonic, and its case. */
function romanRoot(accidental: string, numeral: string): { offset: number; minor: boolean } {
  const upper = numeral.toUpperCase();
  const degree = ROMAN.indexOf(upper);
  const acc = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  return { offset: MAJOR_STEPS[degree] + acc, minor: numeral !== upper };
}

/**
 * Parses a chord suffix into semitone intervals above the root, or returns an error message.
 * `defaultMinor` is the quality when the suffix gives none (lower-case Roman numerals).
 */
function parseSuffix(suffix: string, defaultMinor: boolean): number[] | string {
  let rest = suffix;
  let quality: Quality | null = null;
  let majorSeventh = false;
  let sixWithMajorSeventh = false;
  let deltaAlone = false;
  let ext = 0; // 0, 5, 6, 69, 7, 9, 11 or 13
  let sus = 0; // 0, 2 or 4
  let alt = false;
  let no3 = false;
  let no5 = false;
  let fifth: number | null = null; // altered fifth (6 or 8)
  const added: number[] = [];
  const altered: number[] = [];
  let depth = 0;

  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = rest.slice(m[0].length);
    return m;
  };

  // Quality, at the start only. After a lower-case numeral, M/maj/Δ adds a major seventh to the
  // minor triad (iM7 = mM7) instead of making the chord major.
  if (take(/^(?:maj|Maj|MAJ|ma(?=\d)|M)/)) {
    quality = defaultMinor ? null : 'maj';
    majorSeventh = true;
  } else if (take(/^Δ/)) {
    quality = defaultMinor ? null : 'maj';
    majorSeventh = true;
    deltaAlone = true;
  } else if (take(/^(?:min|mi|m|-)/)) {
    quality = 'min';
  } else if (take(/^(?:dim|°|o(?!mit))/)) {
    quality = 'dim';
  } else if (take(/^(?:aug|\+)/)) {
    quality = 'aug';
  } else if (take(/^ø/)) {
    quality = 'hdim';
  }

  // Extension, directly after the quality.
  const e = take(/^(13|11|9|7|69|6|5)/);
  if (e) {
    ext = Number(e[1]);
    deltaAlone = false;
  }

  // Modifiers, in any order.
  while (rest.length > 0) {
    let m: RegExpExecArray | null;
    if (take(/^[(]/)) {
      depth++;
    } else if (take(/^[)]/)) {
      if (--depth < 0) return 'Unbalanced parentheses';
    } else if (take(/^,/)) {
      if (depth === 0) return "A ',' is only allowed inside parentheses";
    } else if ((m = take(/^sus([24]?)/))) {
      sus = m[1] === '2' ? 2 : 4;
    } else if ((m = take(/^add([#b+-]?)(2|4|6|9|11|13)/))) {
      added.push(degreeSemitones(m[2]) + accidentalOffset(m[1]));
    } else if ((m = take(/^([#b+-])(5|9|11|13)/))) {
      const offset = accidentalOffset(m[1]);
      if (m[2] === '5') fifth = 7 + offset;
      else altered.push(degreeSemitones(m[2]) + offset);
    } else if ((m = take(/^(?:no|omit)([35])/))) {
      if (m[1] === '3') no3 = true;
      else no5 = true;
    } else if (take(/^alt/)) {
      alt = true;
    } else if ((m = take(/^(?:maj|Maj|M|Δ)(13|11|9|7)?/))) {
      // mM7, m(maj7), +M7, 6(maj7): a major seventh on a non-major quality.
      majorSeventh = true;
      if (ext === 6 || ext === 69) sixWithMajorSeventh = true;
      else if (m[1]) ext = Math.max(ext, Number(m[1]));
      else if (ext < 7) ext = 7;
    } else if (take(/^\+(?![0-9])/)) {
      fifth = 8; // C7+
    } else if (depth > 0 && (m = take(/^(13|11|9|7|6)/))) {
      added.push(degreeSemitones(m[1])); // C7(9, 13)
    } else {
      return `Unrecognised '${rest}'`;
    }
  }
  if (depth !== 0) return 'Unbalanced parentheses';
  if (deltaAlone) ext = 7;

  const q: Quality = quality ?? (defaultMinor ? 'min' : 'maj');
  const minorish = q === 'min' || q === 'dim' || q === 'hdim';
  const intervals = new Set<number>([0]);

  // Power chord: root and fifth only.
  if (ext === 5) {
    if (quality !== null) return "A power chord ('5') takes no quality";
    intervals.add(fifth ?? 7);
    for (const a of added) intervals.add(a);
    return [...intervals].sort((a, b) => a - b);
  }

  // Third and fifth.
  let third: number | null = sus === 2 ? 2 : sus === 4 ? 5 : minorish ? 3 : 4;
  let fifthTone: number | null = fifth ?? (q === 'dim' || q === 'hdim' ? 6 : q === 'aug' ? 8 : 7);
  if (ext === 11 && q === 'maj' && !majorSeventh && sus === 0) third = null; // C11 = C9sus4-ish
  if (alt) fifthTone = null;
  if (no3) third = null;
  if (no5) fifthTone = null;
  if (third !== null) intervals.add(third);
  if (fifthTone !== null) intervals.add(fifthTone);

  // Sixths.
  if (ext === 6 || ext === 69) intervals.add(9);
  if (ext === 69) intervals.add(14);

  // Seventh and upper extensions.
  const hasSeventh = ext >= 7 && ext !== 69;
  if (hasSeventh || q === 'hdim' || alt) {
    intervals.add(majorSeventh ? 11 : q === 'dim' ? 9 : 10);
  }
  if (hasSeventh && ext >= 9) intervals.add(14);
  if (hasSeventh && ext === 11) intervals.add(17);
  if (hasSeventh && ext === 13) {
    if (minorish) intervals.add(17);
    intervals.add(21);
  }
  // Six chords with a major seventh, e.g. C6(maj7).
  if (sixWithMajorSeventh) intervals.add(11);

  // Alterations replace the natural tone of the same degree.
  const alterations = alt ? [13, 15, 18, 20] : altered;
  for (const a of alterations) {
    const natural = a <= 15 ? 14 : a <= 18 ? 17 : 21;
    intervals.delete(natural);
    intervals.add(a);
  }
  for (const a of added) intervals.add(a);

  return [...intervals].sort((a, b) => a - b);
}

function accidentalOffset(acc: string): number {
  return acc === '#' || acc === '+' ? 1 : acc === 'b' || acc === '-' ? -1 : 0;
}

/** Semitones of a natural chord degree above the root (2 → 14, 4 → 17, 6 → 21, as tensions). */
function degreeSemitones(degree: string): number {
  switch (degree) {
    case '2':
    case '9':
      return 14;
    case '4':
    case '11':
      return 17;
    case '6':
    case '13':
      return 21;
    case '5':
      return 7;
    default:
      return 10; // '7'
  }
}

/**
 * Parses a chord symbol in the context of a key (the key matters only for Roman numerals).
 * Returns pitch classes, or `{ ok: false, error }` with a readable message.
 */
export function parseChord(symbol: string, key: Key): ChordParse {
  const s = normalise(symbol).replace(/6\/9/g, '69');
  if (s === '') return fail('The chord symbol is empty.');
  const quote = `'${symbol.trim()}'`;

  const slash = s.indexOf('/');
  const head = slash < 0 ? s : s.slice(0, slash);
  const tail = slash < 0 ? null : s.slice(slash + 1);
  if (tail !== null && tail.includes('/')) {
    return fail(`Chord ${quote} has more than one '/'.`);
  }
  if (tail === '') return fail(`Chord ${quote} ends with '/'; put a bass note after it.`);

  let root: number;
  let suffix: string;
  let defaultMinor = false;
  let bass: number | undefined;

  const letter = /^([A-G])([#b]*)/.exec(head);
  const roman = letter ? null : ROMAN_RE.exec(head);
  if (letter) {
    root = parsePitchClass(letter[0]) ?? 0;
    suffix = head.slice(letter[0].length);
    if (tail !== null) {
      const b = parsePitchClass(tail);
      if (b === null) return fail(`The bass in ${quote} is not a note name: '${tail}'.`);
      bass = b;
    }
  } else if (roman) {
    let tonic = pitchClassOf(key.tonic);
    const numeral = romanRoot(roman[1], roman[2]);
    if (tail !== null) {
      const applied = /^([#b]?)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)$/.exec(tail);
      if (applied) {
        tonic = mod12(tonic + romanRoot(applied[1], applied[2]).offset); // V/V: V of V
      } else {
        const b = parsePitchClass(tail);
        if (b === null) {
          return fail(`After '/' in ${quote}, expected a note name or a Roman numeral: '${tail}'.`);
        }
        bass = b;
      }
    }
    root = mod12(tonic + numeral.offset);
    suffix = head.slice(roman[0].length);
    defaultMinor = numeral.minor;
  } else {
    const first = head.charAt(0);
    if (/[a-g]/.test(first)) {
      return fail(`Chord ${quote}: write the root as a capital letter (${first.toUpperCase()}).`);
    }
    return fail(
      `Chord ${quote} must start with a note (A–G) or a Roman numeral (I–VII, i–vii, bVII).`,
    );
  }

  const intervals = parseSuffix(suffix, defaultMinor);
  if (typeof intervals === 'string') return fail(`Chord ${quote}: ${intervals}.`);

  const pcs: number[] = [];
  for (const i of intervals) {
    const pc = mod12(root + i);
    if (!pcs.includes(pc)) pcs.push(pc);
  }
  if (bass !== undefined && !pcs.includes(bass)) pcs.push(bass);
  return bass === undefined ? { ok: true, pcs, root } : { ok: true, pcs, root, bass };
}
