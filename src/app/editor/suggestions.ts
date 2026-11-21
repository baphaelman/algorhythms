/**
 * Next-move suggestions (PLAN.md §11.3, revision 7 "Add vs Next"): `core/suggest` at the end of
 * the piece's last moment (the latest end of any unmuted moment), appended there. Independent of
 * the playhead and the selection. Adding one extends `end.at` when the piece has one and the new
 * moment would reach past it. `watchSuggestions` keeps `useSuggestions` current.
 */

import { create } from 'zustand';
import { suggestNext, type Suggestion } from '../../core/suggest';
import type { CompiledScore, Moment, MomentId, Piece, Seconds } from '../../core/types';
import { usePlayer } from '../store';
import { edit, select } from './history';
import { extendEnd } from './end';
import { beatStep, nextBeat } from './snap';
import { withChordFill } from './new-moment';
import { insertMoments, newMomentIds } from './ops';

const round3 = (t: Seconds): Seconds => Math.round(t * 1000) / 1000;

/** Where a moment's effect ends: its span's end, else its region (walk, level), else `at`. */
function momentEnd(m: Moment, score: CompiledScore): Seconds {
  const span = score.momentSpans.find((s) => s.id === m.id);
  const own = m.type === 'walk' ? m.until : m.type === 'level' ? m.at + m.over : m.at;
  return Math.max(own, span?.end ?? -Infinity);
}

/**
 * The time suggestions are for: the latest end of the piece's unmuted moments (0 with none); with
 * "Snap to beats" (revision 9), the next beat at or after it.
 */
export function suggestionTime(piece: Piece, score: CompiledScore): Seconds {
  let end = 0;
  for (const m of piece.moments) if (!m.muted) end = Math.max(end, momentEnd(m, score));
  const step = beatStep(piece.view);
  return round3(step ? nextBeat(end, step) : end);
}

/** `m` moved by `dt` (a walk's `until` too). */
function shifted(m: Moment, dt: Seconds): Moment {
  if (dt === 0) return m;
  const at = round3(m.at + dt);
  return m.type === 'walk' ? { ...m, at, until: round3(m.until + dt) } : { ...m, at };
}

/**
 * Suggestions appended at `t`. The state is read at `t`, or just before an explicit `end.at` that
 * comes first (voices are closed there), and the moments are moved to `t`.
 */
export function suggestionsAt(piece: Piece, score: CompiledScore, t: Seconds): Suggestion[] {
  const endAt = piece.end.at;
  const read = endAt !== undefined && endAt - 0.01 < t ? Math.max(0, round3(endAt - 0.01)) : t;
  // A suggested chord brings in its extra notes, as a palette chord does (./new-moment).
  const out = suggestNext(piece, score, read).map((s) => {
    const moment = withChordFill(s.moment, piece, score, read);
    return moment === s.moment ? s : { ...s, moment };
  });
  return read === t ? out : out.map((s) => ({ ...s, moment: shifted(s.moment, t - read) }));
}

/**
 * The piece with `moment` appended: an explicit `end.at` that would leave less than 4 s after the
 * moment's span moves out to that. Used for adding and for the hover preview.
 */
export function appendMoment(piece: Piece, moment: Moment): Piece {
  return extendEnd(insertMoments(piece, [moment]), [moment]);
}

interface SuggestionsState {
  /** The time the suggestions are for (NaN before the first run). */
  t: Seconds;
  items: Suggestion[];
}

export const useSuggestions = create<SuggestionsState>()(() => ({ t: NaN, items: [] }));

let last: { t: Seconds; score: CompiledScore | null } = { t: NaN, score: null };

/** Recomputes the suggestions if the score changed (or `force`). */
export function refreshSuggestions(force = false): void {
  const { piece, compiled } = usePlayer.getState();
  if (!force && compiled === last.score) return;
  const t = suggestionTime(piece, compiled);
  last = { t, score: compiled };
  let items: Suggestion[];
  try {
    items = suggestionsAt(piece, compiled, t);
  } catch {
    items = [];
  }
  useSuggestions.setState({ t, items });
}

/**
 * Appends a suggestion's moment with a fresh id (one undo entry, extending the end if needed),
 * selects it and returns its id.
 */
export function addSuggestion(s: Suggestion): MomentId {
  const [id] = newMomentIds(usePlayer.getState().piece, 1);
  edit((p) => appendMoment(p, { ...s.moment, id }), s.label);
  select([id]);
  return id;
}

const POLL_MS = 200;

/**
 * Starts keeping `useSuggestions` current; returns a stop function. A 200 ms poll recomputes
 * only when the compiled score changed (so a drag recomputes at most 5 times a second, and
 * playback costs nothing).
 */
export function watchSuggestions(): () => void {
  refreshSuggestions(true);
  const timer = setInterval(() => {
    if (!document.hidden) refreshSuggestions();
  }, POLL_MS);
  return () => clearInterval(timer);
}
