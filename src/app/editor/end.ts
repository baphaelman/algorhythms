/**
 * The piece's end on the open-ended canvas (PLAN.md §11.3 revision 7). An automatic end (no
 * `end.at`) already follows content: the compiler ends 4 s after the last activity. An explicit
 * `end.at` is moved out whenever an edit adds or changes a moment that would reach past it, keeping
 * `MIN_TAIL` of silence. `history.edit` and `updateGesture` apply `followContent` to every edit, so
 * Add, drops, lane and dot drags and note adds all extend the piece. The ruler's end handle sets
 * `end.at` (`withEnd`); an edit that changes `end.at` itself is left alone.
 */

import type { Moment, Piece, Seconds } from '../../core/types';
import { estimateSpan } from './lane';

/** Silence kept after a moment that extends the end (as the compiler's END_TAIL). */
export const MIN_TAIL: Seconds = 4;
/** Shortest explicit end the handle sets, seconds. */
export const MIN_END: Seconds = 0.25;

const round3 = (t: Seconds): Seconds => Math.round(t * 1000) / 1000;

/** The latest time `m` is estimated to act at: its span, per-voice arrivals, a note's return. */
export function momentReach(m: Moment, piece: Piece): Seconds {
  let end = estimateSpan(m, piece.defaults.glide)[1];
  for (const o of m.overrides ?? []) if (o.end !== undefined) end = Math.max(end, m.at + o.end);
  if (m.type === 'note' && m.back !== undefined) end += Math.max(0, m.back);
  return end;
}

/** `piece` with an explicit `end.at` moved out so `moments` keep `MIN_TAIL` after them. */
export function extendEnd(piece: Piece, moments: readonly Moment[]): Piece {
  const endAt = piece.end.at;
  if (endAt === undefined) return piece;
  let reach = -Infinity;
  for (const m of moments) if (!m.muted) reach = Math.max(reach, momentReach(m, piece));
  const need = round3(reach + MIN_TAIL);
  return need > endAt ? { ...piece, end: { ...piece.end, at: need } } : piece;
}

/**
 * `after` with its explicit end moved out past the moments the edit `before → after` added or
 * changed. Unchanged when the edit set `end.at` itself or the end is automatic.
 */
export function followContent(before: Piece, after: Piece): Piece {
  if (after === before || after.end.at === undefined || after.end.at !== before.end.at) {
    return after;
  }
  const old = new Set(before.moments);
  const touched = after.moments.filter((m) => !old.has(m));
  return touched.length === 0 ? after : extendEnd(after, touched);
}

/** `piece` with `end.at` set to `at` (at least `MIN_END`, ms), or made automatic with `undefined`. */
export function withEnd(piece: Piece, at: Seconds | undefined): Piece {
  if (at === undefined) {
    if (piece.end.at === undefined) return piece;
    const { at: _old, ...rest } = piece.end;
    return { ...piece, end: rest };
  }
  const t = Math.max(MIN_END, round3(at)) + 0;
  return piece.end.at === t ? piece : { ...piece, end: { ...piece.end, at: t } };
}
