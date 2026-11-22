/**
 * Progression editing (PLAN.md §6.2 `progression`, revision 10): typed chords ("IV 2, V 2, iii 2,
 * vi 2", lengths in beats with a tempo, else seconds), the lane's chord names and end drag, a new
 * progression's chords and Freeze into chord moments. Pure.
 */

import { parseChord } from '../../core/chords';
import { harmonyLabel } from '../../core/harmony';
import { progressionChords, progressionStarts } from '../../core/moments/progression';
import type {
  ChordMoment,
  HarmonyChange,
  Key,
  Piece,
  ProgressionChord,
  ProgressionMoment,
  Seconds,
} from '../../core/types';
import { formatNum, parseNum } from '../ui/inspector/fields';
import { newMomentIds, randomU32 } from './ops';
import { MIN_TUNE_LEN, formatTuneLen, lenFromShown } from './tune';

/** Longest typed length: 64 beats, or 60 s without a tempo (as a tune's). */
const MAX_BEATS = 64;
const MAX_SECONDS = 60;

/** A new progression's chords: I vi IV V, a bar each with a tempo (`beat` s), else 2 s each. */
export function newProgressionChords(beat: Seconds | null, meter = 4): ProgressionChord[] {
  const len = beat ? Math.round(beat * meter * 1e6) / 1e6 : 2;
  return ['I', 'vi', 'IV', 'V'].map((notes) => ({ notes, len }));
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
 * or seconds; a missing length repeats the previous one (the first: `firstLen` s). With `prev`
 * (the current chords), a length typed as shown keeps its exact value. Errors name the chord.
 */
export function parseProgressionText(
  text: string,
  beat: Seconds | null,
  key: Key,
  prev: readonly ProgressionChord[] = [],
  firstLen: Seconds = beat ?? 2,
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
      len = chords.at(-1)?.len ?? firstLen;
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
