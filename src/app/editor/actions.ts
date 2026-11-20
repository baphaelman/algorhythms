/**
 * Undoable moment edits on the current piece (§11.3). Each is one `edit` (one undo entry); a
 * call that changes nothing records nothing. For drags, use the pure recipes in ./ops with
 * `beginGesture` / `updateGesture` / `endGesture` instead.
 */

import { compile } from '../../core/compiler/compile';
import type { CompiledScore, MomentId, MomentType, Piece, Seconds } from '../../core/types';
import { usePlayer } from '../store';
import { edit, select } from './history';
import { defaultMoment } from './new-moment';
import { movedFixed, type StepRef } from './walk-steps';
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
