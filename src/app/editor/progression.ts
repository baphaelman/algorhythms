/**
 * Progression editing (PLAN.md §6.2 `progression`, revision 10): typed chords ("IV 2, V 2, iii 2,
 * vi 2", lengths in beats with a tempo, else seconds), the default spacing (owner notes
 * 2026-11-22), the inspector's list edits (append, change, retime, remove, reorder), the lane's
 * chord names and end drag, a new progression's chords and Freeze into chord moments. Pure.
 */

import { diatonicChords, type DiatonicChord } from '../../core/chord-spec';
import { parseChord } from '../../core/chords';
import { momentGlide, sanitizeGlide } from '../../core/compiler/glide';
import { defaultGlide } from '../../core/defaults';
import { harmonyLabel } from '../../core/harmony';
import { progressionChords, progressionStarts } from '../../core/moments/progression';
import { scaleIntervals } from '../../core/scales';
import type {
  ChordMoment,
  HarmonyChange,
  Key,
  Moment,
  Piece,
  ProgressionChord,
  ProgressionMoment,
  ScaleName,
  Seconds,
} from '../../core/types';
import { formatNum, parseNum } from '../ui/inspector/fields';
import { newMomentIds, randomU32 } from './ops';
import { NEXT_HOLD } from './snap';
import { MIN_TUNE_LEN, formatTuneLen, lenFromShown, tuneBeat } from './tune';

/** Longest typed length: 64 beats, or 60 s without a tempo (as a tune's). */
export const MAX_BEATS = 64;
export const MAX_SECONDS = 60;

const roundUs = (t: Seconds): Seconds => Math.round(t * 1e6) / 1e6;

/**
 * The default chord length (owner notes 2026-11-22): what separate chords added with Next get, so
 * changes don't chain: the glide (length + stagger of `m`'s glide over the piece's default), then
 * Next's hold (a bar with a tempo, else `NEXT_HOLD`). With a tempo, rounded up to whole beats.
 */
export function progressionSpacing(
  piece: Pick<Piece, 'defaults' | 'view'>,
  m: Pick<Moment, 'glide'> = {},
): Seconds {
  const g = momentGlide(sanitizeGlide(piece.defaults?.glide, defaultGlide()), {
    type: 'progression',
    glide: m.glide,
  });
  const beat = tuneBeat(piece.view);
  const meter = piece.view?.meter && piece.view.meter > 0 ? piece.view.meter : 4;
  const raw = g.length + g.stagger + (beat ? beat * meter : NEXT_HOLD);
  return beat ? roundUs(Math.ceil(raw / beat - 1e-6) * beat) : roundUs(raw);
}

/**
 * A new progression's default degrees (0-based) in each 7-note scale: the tonic first, then a
 * common order for the mode, all major or minor triads of the key. Locrian's tonic is
 * diminished, so it starts on ♭II.
 */
const MODE_DEGREES: Readonly<Partial<Record<ScaleName, readonly number[]>>> = {
  major: [0, 5, 3, 4], // I vi IV V
  ionian: [0, 5, 3, 4],
  minor: [0, 5, 2, 6], // i ♭VI ♭III ♭VII
  aeolian: [0, 5, 2, 6],
  dorian: [0, 3, 6, 0], // i IV ♭VII i
  phrygian: [0, 1, 2, 0], // i ♭II ♭III i
  lydian: [0, 1, 4, 0], // I II V I
  mixolydian: [0, 6, 3, 0], // I ♭VII IV I
  locrian: [1, 6, 3, 1], // ♭II ♭vii iv ♭II
  'harmonic-minor': [0, 5, 3, 4], // i ♭VI iv V
  'melodic-minor': [0, 3, 4, 0], // i IV V i
};

/**
 * The defaults for scales without diatonic chips: the scale's own triads (pentatonic i/♭III,
 * I/vi), then the nearest triads by fifths, which hold one note outside the scale.
 */
const OTHER_SCALE_CHORDS: Readonly<Partial<Record<ScaleName, readonly string[]>>> = {
  'pentatonic-major': ['I', 'vi', 'V', 'I'],
  'pentatonic-minor': ['i', '♭III', '♭VII', 'i'],
  blues: ['i', '♭III', '♭VII', 'i'],
  'whole-tone': ['I', 'II', '♭VII', 'I'],
  chromatic: ['I', 'vi', 'IV', 'V'],
};

const plainTriad = (d: DiatonicChord): boolean => d.quality.id === 'maj' || d.quality.id === 'min';

/**
 * A new progression's four chord symbols in `key`: the key's own major and minor triads as the
 * picker's chips name them (Roman numerals on the major-scale ruler), never diminished. Major
 * keeps I vi IV V.
 */
export function defaultProgressionSymbols(key: Key): string[] {
  const name = typeof key.scale === 'string' ? key.scale : null;
  const chips = diatonicChords(key).filter(plainTriad);
  if (chips.length > 0) {
    const byDegree = new Map(chips.map((d) => [d.degree, d.numeral]));
    const want = (name && MODE_DEGREES[name]) ?? [0, 5, 3, 4];
    const fill = chips.map((d) => d.numeral);
    const out = want.map((d) => byDegree.get(d));
    if (out.every((x) => x !== undefined)) return out as string[];
    // A custom 7-note scale: the chips in degree order, from the first plain triad.
    return [0, 1, 2, 3].map((k) => fill[k % fill.length]);
  }
  const fixed = name ? OTHER_SCALE_CHORDS[name] : undefined;
  if (fixed) return fixed.slice();
  // A custom scale: the tonic triad (minor when the scale has a minor 3rd but no major one),
  // then the major- and minor-scale neighbours.
  const iv = scaleIntervals(key.scale);
  const minor = iv.includes(3) && !iv.includes(4);
  return minor ? ['i', '♭VI', '♭VII', 'i'] : ['I', 'IV', 'V', 'I'];
}

/** A new progression's chords in `key` (`defaultProgressionSymbols`), each `len` s. */
export function newProgressionChords(len: Seconds, key: Key): ProgressionChord[] {
  return defaultProgressionSymbols(key).map((notes) => ({ notes, len }));
}

/** `chords` with `notes` appended, `len` s long. */
export function appendProgressionChord(
  chords: readonly ProgressionChord[],
  notes: string,
  len: Seconds,
): ProgressionChord[] {
  return [...chords, { notes, len }];
}

/** `chords` with chord k's symbol set to `notes`; null when out of range or unchanged. */
export function setProgressionChord(
  chords: readonly ProgressionChord[],
  k: number,
  notes: string,
): ProgressionChord[] | null {
  const c = chords[k];
  if (!c || c.notes === notes) return null;
  return chords.map((x, i) => (i === k ? { ...x, notes } : x));
}

/** `chords` with chord k `len` s long (≥ MIN_TUNE_LEN); null when out of range or unchanged. */
export function retimeProgressionChord(
  chords: readonly ProgressionChord[],
  k: number,
  len: Seconds,
): ProgressionChord[] | null {
  const c = chords[k];
  const l = Math.max(MIN_TUNE_LEN, roundUs(len));
  if (!c || !Number.isFinite(len) || c.len === l) return null;
  return chords.map((x, i) => (i === k ? { ...x, len: l } : x));
}

/** `chords` without chord k; null when out of range. */
export function removeProgressionChord(
  chords: readonly ProgressionChord[],
  k: number,
): ProgressionChord[] | null {
  if (k < 0 || k >= chords.length) return null;
  return chords.filter((_, i) => i !== k);
}

/** `chords` with chord k swapped with its neighbour (`dir` −1: earlier, +1: later); null at an end. */
export function moveProgressionChord(
  chords: readonly ProgressionChord[],
  k: number,
  dir: -1 | 1,
): ProgressionChord[] | null {
  const j = k + dir;
  if (k < 0 || k >= chords.length || j < 0 || j >= chords.length) return null;
  const out = chords.slice();
  [out[k], out[j]] = [out[j], out[k]];
  return out;
}

/** The chords as typed text, "IV 2, V 2": symbol and length (beats with a tempo, else seconds). */
export function formatProgressionText(
  chords: readonly ProgressionChord[],
  beat: Seconds | null,
): string {
  return chords.map((c) => `${c.notes} ${formatTuneLen(c.len, beat)}`).join(', ');
}

export type ProgressionParse =
  { ok: true; chords: ProgressionChord[] } | { ok: false; error: string };

/**
 * Parses typed chords: comma-separated "<symbol> <length>" items. A symbol is a chord symbol or
 * Roman numeral as a chord's (checked in `key`); a length is beats (with a tempo, `beat` s each)
 * or seconds; a missing length is `defaultLen` s (the default spacing, owner notes 2026-11-22).
 * With `prev` (the current chords), a length typed as shown keeps its exact value. Errors name
 * the chord.
 */
export function parseProgressionText(
  text: string,
  beat: Seconds | null,
  key: Key,
  prev: readonly ProgressionChord[] = [],
  defaultLen: Seconds = beat ?? 2,
): ProgressionParse {
  const t = text.trim();
  if (t === '') return { ok: true, chords: [] };
  const items = t.split(',').map((s) => s.trim());
  const unit = beat ? 'beats' : 's';
  const min = beat ? MIN_TUNE_LEN / beat : MIN_TUNE_LEN;
  const max = beat ? MAX_BEATS : MAX_SECONDS;
  const chords: ProgressionChord[] = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const at = `Chord ${k + 1}`;
    if (it === '') return { ok: false, error: `${at} is empty: remove the extra comma` };
    const parts = it.split(/\s+/);
    if (parts.length > 2) {
      return { ok: false, error: `${at}: “${it}” should be a chord and a length, like “IV 2”` };
    }
    const symbol = parts[0];
    const r = parseChord(symbol, key);
    if (!r.ok) return { ok: false, error: `${at}: “${symbol}” is not a chord (${r.error})` };
    let len: Seconds;
    if (parts.length === 1) {
      len = defaultLen;
    } else {
      const v = parseNum(parts[1]);
      if (v === null) return { ok: false, error: `${at}: “${parts[1]}” is not a length` };
      if (v < min - 1e-9) {
        return {
          ok: false,
          error: `${at}: the length must be at least ${formatNum(min, 3)} ${unit}`,
        };
      }
      if (v > max) return { ok: false, error: `${at}: the length must be at most ${max} ${unit}` };
      const old = prev[k];
      len =
        old && formatTuneLen(old.len, beat) === formatNum(v, 3) ? old.len : lenFromShown(v, beat);
    }
    chords.push({ notes: symbol, len });
  }
  return { ok: true, chords };
}

/** Chord k's name as the lane and the list show it: the compiled label, else the symbol's. */
export function progressionChordNames(
  m: ProgressionMoment,
  harmony: readonly HarmonyChange[] | undefined,
  keyAt: (t: Seconds) => Key,
): string[] {
  const starts = progressionStarts(m);
  const mine = (harmony ?? []).filter((h) => h.momentId === m.id && !h.from);
  return m.chords.map((c, k) => {
    // A land chord decides before its start: take the harmony entry nearest its start.
    const lo = k > 0 ? (starts[k - 1] + starts[k]) / 2 : -Infinity;
    const hi = (starts[k] + starts[k + 1]) / 2;
    let h: HarmonyChange | undefined;
    for (const x of mine) if (x.t > lo && x.t <= hi) h = x;
    if (h) return h.label;
    const key = keyAt(starts[k]);
    const r = parseChord(c.notes, key);
    return r.ok ? harmonyLabel(c.notes, r.pcs, r.bass ?? r.root, key) : c.notes;
  });
}

/** The short form of a harmony label for a lane bar: "ii7 · Dm7" → "ii7". */
export function shortChordName(label: string): string {
  const dot = label.indexOf(' · ');
  return dot < 0 ? label : label.slice(0, dot);
}

/**
 * Dragging the progression's end on the lane by `dt` seconds: the last chord's length
 * (≥ MIN_TUNE_LEN). Null when nothing changes (or it has no chords).
 */
export function progressionEndDrag(
  m: Pick<ProgressionMoment, 'chords'>,
  dt: Seconds,
): ProgressionChord[] | null {
  const k = m.chords.length - 1;
  if (k < 0) return null;
  const len = Math.max(MIN_TUNE_LEN, Math.round((m.chords[k].len + dt) * 1e6) / 1e6);
  if (len === m.chords[k].len) return null;
  return m.chords.map((c, i) => (i === k ? { ...c, len } : c));
}

/**
 * Freeze (§6.2): the chord moments progression `m` stands for, each with a fresh id and its
 * explicit seed (`progressionChords`), so they sound the same. Its label goes on the first.
 */
export function splitProgression(
  piece: Piece,
  m: ProgressionMoment,
  rnd: () => number = randomU32,
): ChordMoment[] {
  const chords = progressionChords(m, piece.seed);
  const ids = newMomentIds(piece, chords.length, rnd);
  return chords.map((c, k) => {
    const out: ChordMoment = { ...c, id: ids[k] };
    if (k === 0 && m.label) out.label = m.label;
    return out;
  });
}

/** `piece` with progression `id` replaced in place by its chord moments (Freeze). */
export function freezeProgression(piece: Piece, id: string, rnd: () => number = randomU32): Piece {
  const i = piece.moments.findIndex((x) => x.id === id);
  const m = piece.moments[i];
  if (!m || m.type !== 'progression') return piece;
  const chords = splitProgression(piece, m, rnd);
  if (chords.length === 0) return piece;
  const moments = piece.moments.slice();
  moments.splice(i, 1, ...chords);
  // Stable by time: each chord keeps the progression's place among moments at its time.
  const sorted = moments
    .map((x, j) => ({ x, j }))
    .sort((a, b) => a.x.at - b.x.at || a.j - b.j)
    .map((e) => e.x);
  return { ...piece, moments: sorted };
}
