/**
 * Melodies that fit the chords (PLAN.md §6.4, M10b-5): a tune with `fit` holds the melody
 * core/melody.ts draws over the chords under it. `refitTunes` keeps it so after every edit
 * (history.ts): when the chords, key, tempo or lines under a fitted tune change, its notes are
 * redrawn in the same undo entry; when its notes are edited by hand, `fit` goes.
 */

import { compile } from '../../core/compiler/compile';
import { fitMelody, melodyHarmony } from '../../core/melody';
import { progressionStarts } from '../../core/moments/progression';
import { isRest } from '../../core/moments/tune';
import type {
  CompiledScore,
  HarmonyChange,
  Moment,
  Piece,
  Pitch,
  Seconds,
  TuneMoment,
  TuneNote,
} from '../../core/types';
import { beatAndBar, rowsOf, textureUntil } from './rows';
import { shiftTuneNotes, tuneEnd, tuneLineAt, tuneShiftIn } from './tune';

/** Moment types whose edits never change the harmony under a tune. */
const NO_HARMONY: ReadonlySet<Moment['type']> = new Set(['level', 'timbre']);

const isFitted = (m: Moment): m is TuneMoment & { fit: { seed: number } } =>
  m.type === 'tune' && m.fit !== undefined;

/** The piece with its fitted tunes muted: the chords alone, as the melody reads them. */
export function harmonyScore(piece: Piece): CompiledScore {
  return compile({
    ...piece,
    moments: piece.moments.map((m) => (isFitted(m) ? { ...m, muted: true } : m)),
  });
}

/**
 * A new melody's length at `at`: to the end of the Chords block there (2 bars without one),
 * between 1 and 8 bars.
 */
export function melodyLength(piece: Piece, score: CompiledScore, at: Seconds): Seconds {
  const { bar } = beatAndBar(piece);
  const len = textureUntil(rowsOf(piece, score), piece, at) - at;
  return Math.round(Math.min(8 * bar, Math.max(bar, len)) * 1e6) / 1e6;
}

/**
 * The time a harmony entry's chord counts from: its moment's marker (a land chord's entry starts
 * at its lead-in); a progression chord's own start.
 */
function markerIn(piece: Piece): (h: HarmonyChange) => Seconds {
  const byId = new Map(piece.moments.map((m) => [m.id, m]));
  return (h) => {
    const m = byId.get(h.momentId);
    if (!m || m.type === 'tune') return h.t;
    if (m.type !== 'progression') return Math.max(h.t, m.at);
    const starts = progressionStarts(m);
    return starts.find((t) => t >= h.t - 1e-6) ?? h.t;
  };
}

/** Highest (or lowest) pitch other sounding lines reach over [from, to); null when none. */
function othersExtent(
  score: CompiledScore,
  skip: number | undefined,
  from: Seconds,
  to: Seconds,
): { min: Pitch; max: Pitch } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const v of score.voices) {
    if (v.index === skip) continue;
    for (const s of v.segments) {
      if (s.t1 <= from || s.t0 >= to) continue;
      min = Math.min(min, s.p0, s.p1);
      max = Math.max(max, s.p0, s.p1);
    }
  }
  return max >= min ? { min, max } : null;
}

/**
 * The fitted melody for tune `m` (written pitches, as the tune stores them) from `seed`: over
 * the tune's length (`len`, default its current length), the harmony of `hs` (a `harmonyScore`),
 * on its line, above the other lines when it is the top one (below them otherwise).
 */
export function fittedNotes(
  piece: Piece,
  hs: CompiledScore,
  m: TuneMoment,
  seed: number,
  len: Seconds = tuneEnd(m) - m.at,
): TuneNote[] {
  if (!(len > 1e-9)) return [];
  const from = m.at;
  const to = from + len;
  const line = tuneLineAt(piece, hs, m);
  const [rLo, rHi] = line.range;
  const others = othersExtent(hs, line.voice, from, to);
  let lo: Pitch;
  let hi: Pitch;
  if (!others) {
    lo = Math.max(rLo, Math.round(line.pitch) - 5);
    hi = Math.min(rHi, lo + 16);
  } else if (line.pitch >= others.min) {
    // On top: clear of the chords (no line shares its pitch, so no merges).
    lo = Math.max(rLo, Math.ceil(others.max) + 2);
    hi = Math.min(rHi, lo + 16);
  } else {
    hi = Math.min(rHi, Math.floor(others.min) - 2);
    lo = Math.max(rLo, hi - 16);
  }
  if (hi - lo < 9) lo = Math.max(rLo, hi - 12);
  if (hi - lo < 9) hi = Math.min(rHi, lo + 12);
  const { beat, perBar } = beatAndBar(piece);
  const { chords, keys } = melodyHarmony(hs, from, to, markerIn(piece));
  const notes = fitMelody({
    seed,
    from,
    to,
    chords,
    keys,
    beat,
    meter: perBar,
    register: [lo, hi],
    start: line.pitch,
  });
  // Drawn at sounding pitches; written back un-transposed (revision 10).
  return shiftTuneNotes(notes, -tuneShiftIn(hs, m));
}

function sameNotes(a: readonly TuneNote[], b: readonly TuneNote[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    if (isRest(x) || isRest(y)) return isRest(x) && isRest(y) && Math.abs(x.len - y.len) < 1e-6;
    return Math.abs(x.pitch - y.pitch) < 1e-6 && Math.abs(x.len - y.len) < 1e-6;
  });
}

/** Tune `id` fitted to its chords with `seed` (Fit to chords, New melody); unchanged if not a tune. */
export function fitTune(piece: Piece, id: string, seed: number): Piece {
  const m = piece.moments.find((x) => x.id === id);
  if (!m || m.type !== 'tune') return piece;
  const fitted: TuneMoment = { ...m, fit: { seed } };
  const next = { ...piece, moments: piece.moments.map((x) => (x === m ? fitted : x)) };
  let hs: CompiledScore;
  try {
    hs = harmonyScore(next);
  } catch {
    return piece;
  }
  fitted.notes = fittedNotes(next, hs, fitted, seed);
  return next;
}

/** True if going from `before` to `after` may change what a fitted tune reads. */
function mayChangeHarmony(before: Piece, after: Piece): boolean {
  if (before.key !== after.key || before.voices !== after.voices) return true;
  if (before.view.gridBpm !== after.view.gridBpm || before.view.meter !== after.view.meter) {
    return true;
  }
  if (before.moments === after.moments) return false;
  const old = new Map(before.moments.map((m) => [m.id, m]));
  const counts = (m: Moment): boolean =>
    !NO_HARMONY.has(m.type) && (m.type !== 'tune' || m.fit !== undefined);
  for (const m of after.moments) {
    const o = old.get(m.id);
    old.delete(m.id);
    if (o !== m && (counts(m) || (o !== undefined && counts(o)))) return true;
  }
  for (const o of old.values()) if (counts(o)) return true;
  return false;
}

/**
 * `after` (the result of an edit of `before`) with its fitted tunes kept fitted: a tune whose
 * notes were edited by hand loses `fit`; the others are redrawn when the edit may change the
 * harmony, the key, the tempo or the lines under them. Returns `after` itself when nothing moves.
 */
export function refitTunes(before: Piece, after: Piece): Piece {
  if (after === before || !after.moments.some(isFitted)) return after;
  const old = new Map(before.moments.map((m) => [m.id, m]));
  let moments = after.moments.map((m): Moment => {
    if (!isFitted(m)) return m;
    const o = old.get(m.id);
    // New notes on the same line, seed and key: a hand edit. A line or Follow key change
    // rewrites the notes too, but the melody is redrawn for the new line instead.
    const handEdit =
      o?.type === 'tune' &&
      o.fit?.seed === m.fit.seed &&
      o.target === m.target &&
      o.line === m.line &&
      o.writtenIn === m.writtenIn &&
      !sameNotes(o.notes, m.notes);
    if (!handEdit) return m;
    const { fit: _, ...rest } = m;
    return rest;
  });
  if (moments.every((m, i) => m === after.moments[i])) moments = after.moments;
  let piece = moments === after.moments ? after : { ...after, moments };
  if (!piece.moments.some(isFitted) || !mayChangeHarmony(before, piece)) return piece;
  let hs: CompiledScore;
  try {
    hs = harmonyScore(piece);
  } catch {
    return piece;
  }
  const next = piece.moments.map((m): Moment => {
    if (!isFitted(m)) return m;
    const notes = fittedNotes(piece, hs, m, m.fit.seed);
    return sameNotes(notes, m.notes) ? m : { ...m, notes };
  });
  if (next.some((m, i) => m !== piece.moments[i])) piece = { ...piece, moments: next };
  return piece;
}
