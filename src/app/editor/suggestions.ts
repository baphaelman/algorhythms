/**
 * Next-move suggestions (PLAN.md §11.3, revision 6): `core/suggest` at the end of the selected
 * moment (the latest end when several are selected), or at the grid-snapped playhead when nothing
 * is selected. `watchSuggestions` keeps `useSuggestions` current (200 ms poll, paused while playing).
 */

import { create } from 'zustand';
import { suggestNext, type Suggestion } from '../../core/suggest';
import type { CompiledScore, Moment, MomentId, Piece, Seconds } from '../../core/types';
import { usePlayer } from '../store';
import { edit, select, useEditor } from './history';
import { insertMoments, newMomentIds } from './ops';
import { addTime } from './palette-effects';

/** Where a moment's effect ends: its span's end, else its region (walk, level), else `at`. */
function momentEnd(m: Moment, score: CompiledScore): Seconds {
  const span = score.momentSpans.find((s) => s.id === m.id);
  const own = m.type === 'walk' ? m.until : m.type === 'level' ? m.at + m.over : m.at;
  return Math.max(own, span?.end ?? -Infinity);
}

/** The time suggestions are for, given the piece, its score and the selection. */
export function suggestionTime(
  piece: Piece,
  score: CompiledScore,
  selection: readonly MomentId[],
  playhead: Seconds,
): Seconds {
  let end = -Infinity;
  for (const id of selection) {
    const m = piece.moments.find((x) => x.id === id);
    if (m) end = Math.max(end, momentEnd(m, score));
  }
  if (end === -Infinity) return playhead;
  const bpm = piece.view.gridBpm;
  if (bpm && bpm > 0) {
    const beat = 60 / bpm;
    end = Math.ceil(end / beat - 1e-9) * beat;
  }
  return Math.round(end * 1000) / 1000;
}

interface SuggestionsState {
  /** The time the suggestions are for (NaN before the first run). */
  t: Seconds;
  items: Suggestion[];
}

export const useSuggestions = create<SuggestionsState>()(() => ({ t: NaN, items: [] }));

let last: { t: Seconds; score: CompiledScore | null } = { t: NaN, score: null };

/** Recomputes the suggestions if their time or the score changed (or `force`). */
export function refreshSuggestions(force = false): void {
  const { piece, compiled } = usePlayer.getState();
  const t = suggestionTime(piece, compiled, useEditor.getState().selection, addTime());
  if (!force && t === last.t && compiled === last.score) return;
  last = { t, score: compiled };
  let items: Suggestion[];
  try {
    items = suggestNext(piece, compiled, t);
  } catch {
    items = [];
  }
  useSuggestions.setState({ t, items });
}

/** Adds a suggestion's moment with a fresh id (one undo entry), selects it and returns its id. */
export function addSuggestion(s: Suggestion): MomentId {
  const [id] = newMomentIds(usePlayer.getState().piece, 1);
  edit((p) => insertMoments(p, [{ ...s.moment, id }]), s.label);
  select([id]);
  return id;
}

const POLL_MS = 200;

/**
 * Starts keeping `useSuggestions` current; returns a stop function. Frozen during playback (the
 * strip is for editing; refreshing it as the playhead moves cost frames).
 */
export function watchSuggestions(): () => void {
  refreshSuggestions(true);
  const unsub = useEditor.subscribe((s, prev) => {
    if (s.selection !== prev.selection) refreshSuggestions();
  });
  const timer = setInterval(() => {
    if (document.hidden || usePlayer.getState().transport.status === 'playing') return;
    refreshSuggestions();
  }, POLL_MS);
  return () => {
    clearInterval(timer);
    unsub();
  };
}
