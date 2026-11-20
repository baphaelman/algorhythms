/**
 * Undoable moment edits on the current piece (§11.3). Each is one `edit` (one undo entry); a
 * call that changes nothing records nothing. For drags, use the pure recipes in ./ops with
 * `beginGesture` / `updateGesture` / `endGesture` instead.
 */

import { compile } from '../../core/compiler/compile';
import type {
  CompiledScore,
  MomentId,
  MomentType,
  NoteMoment,
  Piece,
  Pitch,
  Seconds,
} from '../../core/types';
import { keyAt } from '../../core/query';
import { usePlayer } from '../store';
import { chordNotes, frozenPatch, unfreezePatch, withChordNote } from './chord-notes';
import { beginGesture, cancelGesture, edit, endGesture, select, updateGesture } from './history';
import { defaultMoment } from './new-moment';
import { stepNoteTo } from './note-points';
import { movedFixed, scaleNeighbour, type StepRef } from './walk-steps';
import {
  copyMoments,
  insertMoments,
  moveMomentsBy,
  newMomentIds,
  patchMoment,
  randomU32,
  removeMoments,
  type MomentPatch,
} from './ops';

const LABELS: Record<MomentType, string> = {
  chord: 'chord',
  unison: 'unison',
  split: 'split',
  merge: 'merge',
  shift: 'shift',
  spread: 'spread',
  walk: 'walk',
  note: 'note',
  pin: 'pin',
  key: 'key change',
  level: 'level',
};

let cached: { piece: Piece; score: CompiledScore } | null = null;

/** The compiled score of `piece`: the store's when current, else compiled now (and cached). */
function scoreOf(piece: Piece): CompiledScore {
  if (cached?.piece === piece) return cached.score;
  const s = usePlayer.getState();
  // The store's `compiled` lags `piece` by up to a frame; only trust it when nothing is pending.
  const score = s.piece === piece && !pendingSince(piece) ? s.compiled : compile(piece);
  cached = { piece, score };
  return score;
}

let lastCompiledPiece: Piece | null = null;
usePlayer.subscribe((s, prev) => {
  if (s.compiled !== prev.compiled) lastCompiledPiece = s.piece;
});
/** True if `piece` may not yet be reflected in `usePlayer.getState().compiled`. */
function pendingSince(piece: Piece): boolean {
  return lastCompiledPiece !== piece;
}

/**
 * Adds a default moment of `type` at `at` (seconds, clamped at 0), selects it and returns its
 * id. The defaults depend on the piece's state at `at` (see ./new-moment).
 */
export function addMoment(type: MomentType, at: Seconds): MomentId {
  const t = Math.max(0, at);
  const piece = usePlayer.getState().piece;
  const [id] = newMomentIds(piece, 1);
  const m = defaultMoment(type, t, id, piece, scoreOf(piece));
  edit((p) => insertMoments(p, [m]), `Add ${LABELS[type]}`);
  select([id]);
  return id;
}

/** Sets fields of moment `id` (`undefined` removes an optional field). False if nothing changed. */
export function updateMoment(id: MomentId, patch: MomentPatch, label = 'Edit moment'): boolean {
  return edit((p) => patchMoment(p, id, patch), label);
}

/** Moves moments by `dt` seconds; the group is clamped so none goes before 0. */
export function moveMoments(ids: readonly MomentId[], dt: Seconds): boolean {
  return edit((p) => moveMomentsBy(p, ids, dt), ids.length === 1 ? 'Move moment' : 'Move moments');
}

/** Deletes moments (the selection is pruned). */
export function deleteMoments(ids: readonly MomentId[]): boolean {
  return edit((p) => removeMoments(p, ids), ids.length === 1 ? 'Delete moment' : 'Delete moments');
}

/**
 * Duplicates moments `dt` seconds later; each copy keeps its original's effective seed (§7.7).
 * Selects and returns the copies' ids (in piece order of the originals).
 */
export function duplicateMoments(ids: readonly MomentId[], dt: Seconds): MomentId[] {
  let out: MomentId[] = [];
  edit(
    (p) => {
      const r = copyMoments(p, ids, dt);
      out = r.ids;
      return r.piece;
    },
    ids.length === 1 ? 'Duplicate moment' : 'Duplicate moments',
  );
  if (out.length > 0) select(out);
  return out;
}

/** Gives moment `id` a new explicit seed. Returns the seed, or null if there is no such moment. */
export function reroll(id: MomentId): number | null {
  const m = usePlayer.getState().piece.moments.find((x) => x.id === id);
  if (!m) return null;
  let seed = randomU32();
  while (seed === m.seed) seed = randomU32();
  updateMoment(id, { seed }, 'Reroll');
  return seed;
}

/**
 * Moves walk step `ref` one scale step up or down (§6.2). On an unfrozen walk this freezes it and
 * moves the note as one undo entry. False if nothing changed.
 */
export function moveWalkStep(ref: StepRef, dir: 1 | -1): boolean {
  const piece = usePlayer.getState().piece;
  const w = piece.moments.find((m) => m.id === ref.momentId);
  if (w?.type !== 'walk') return false;
  const fixed = movedFixed(w, scoreOf(piece), ref, dir);
  if (!fixed) return false;
  return updateMoment(w.id, { fixed }, w.fixed ? 'Move walk step' : 'Freeze walk and move step');
}

function chordOf(piece: Piece, id: MomentId) {
  const m = piece.moments.find((x) => x.id === id);
  return m?.type === 'chord' ? m : null;
}

/**
 * Sets note `index` (low to high) of chord `id` to `pitch` (§11.3 Chord notes). An unfrozen chord
 * is frozen first, in the same undo entry. False if nothing changed.
 */
export function setChordNote(id: MomentId, index: number, pitch: number): boolean {
  const piece = usePlayer.getState().piece;
  const m = chordOf(piece, id);
  const notes = m && chordNotes(piece, scoreOf(piece), m);
  const next = notes && withChordNote(notes, index, pitch);
  if (!m || !next) return false;
  const label = m.frozenFrom ? 'Move chord note' : 'Freeze chord and move note';
  return updateMoment(id, frozenPatch(m, next), label);
}

/** Moves note `index` of chord `id` one scale step (in the key at the chord's time). */
export function moveChordNote(id: MomentId, index: number, dir: 1 | -1): boolean {
  const piece = usePlayer.getState().piece;
  const m = chordOf(piece, id);
  if (!m) return false;
  const score = scoreOf(piece);
  const notes = chordNotes(piece, score, m);
  if (!notes || index < 0 || index >= notes.length) return false;
  return setChordNote(id, index, scaleNeighbour(notes[index], dir, keyAt(score, m.at)));
}

/** Restores chord `id`'s notes from before it was frozen. */
export function unfreezeChord(id: MomentId): boolean {
  const m = chordOf(usePlayer.getState().piece, id);
  const patch = m && unfreezePatch(m);
  return patch ? updateMoment(id, patch, 'Unfreeze chord') : false;
}

/**
 * A drag of chord `id`'s note `index` (score dots): one undo entry for the whole drag, freezing
 * the chord on the first change. Null if the chord has no notes.
 */
export function dragChordNote(
  id: MomentId,
  index: number,
): { to(pitch: number): void; end(cancel?: boolean): void } | null {
  const piece = usePlayer.getState().piece;
  const m = chordOf(piece, id);
  const notes = m && chordNotes(piece, scoreOf(piece), m);
  if (!m || !notes || index < 0 || index >= notes.length) return null;
  beginGesture(m.frozenFrom ? 'Move chord note' : 'Freeze chord and move note');
  return {
    to(pitch) {
      const next = withChordNote(notes, index, pitch);
      updateGesture((p) => (next ? patchMoment(p, id, frozenPatch(m, next)) : p));
    },
    end(cancel = false) {
      if (cancel) cancelGesture();
      else endGesture();
    },
  };
}

/** A drag that sets a pitch; `end(true)` cancels it. */
export interface PitchDrag {
  to(pitch: Pitch): void;
  end(cancel?: boolean): void;
}

/**
 * Adds a note point at `at` with `from` = `to` = `from` (§11.3 Note points), selects it and keeps
 * the gesture open: `to(p)` sets its `to`; the add and the drag are one undo entry ("Add note").
 */
export function addNoteDrag(at: Seconds, from: Pitch): PitchDrag & { id: MomentId } {
  const t = Math.max(0, at);
  const piece = usePlayer.getState().piece;
  const [id] = newMomentIds(piece, 1);
  const base = defaultMoment('note', t, id, piece, scoreOf(piece));
  const m: NoteMoment = { ...(base as NoteMoment), from, to: from };
  beginGesture(`Add ${LABELS.note}`);
  updateGesture((p) => insertMoments(p, [m]));
  select([id]);
  return {
    id,
    to(pitch) {
      updateGesture((p) => insertMoments(p, [{ ...m, to: pitch }]));
    },
    end(cancel = false) {
      if (cancel) cancelGesture();
      else endGesture();
    },
  };
}

function noteOf(piece: Piece, id: MomentId): NoteMoment | null {
  const m = piece.moments.find((x) => x.id === id);
  return m?.type === 'note' ? m : null;
}

/** Steps note `id`'s `to` one scale step (in the key at its time). False if nothing changed. */
export function stepNote(id: MomentId, dir: 1 | -1): boolean {
  const piece = usePlayer.getState().piece;
  const m = noteOf(piece, id);
  if (!m) return false;
  const to = stepNoteTo(m.to, dir, keyAt(scoreOf(piece), m.at));
  return updateMoment(id, { to }, 'Move note');
}

/** A drag of note `id`'s `to` (its score dot): one undo entry. Null if there is no such note. */
export function dragNote(id: MomentId): PitchDrag | null {
  if (!noteOf(usePlayer.getState().piece, id)) return null;
  beginGesture('Move note');
  return {
    to(pitch) {
      updateGesture((p) => patchMoment(p, id, { to: pitch }));
    },
    end(cancel = false) {
      if (cancel) cancelGesture();
      else endGesture();
    },
  };
}
