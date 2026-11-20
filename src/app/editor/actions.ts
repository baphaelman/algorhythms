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
import { freezeWalk } from '../../core/moments/walk';
import { arrivalEnd, withOverride, withoutOverride } from './overrides';
import { selectStep } from './step-selection';
import {
  movedFixed,
  movedStep,
  scaleNeighbour,
  tickAt,
  walkInsertAt,
  withNote,
  type StepRef,
} from './walk-steps';
import { dotAction, type ArrivalDot } from './arrival-points';
import { keepOrder, noteOrder } from './line-order';
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
  const keep = keepOrder();
  const next = notes && withChordNote(notes, index, pitch, keep);
  if (!m || !next) return false;
  const label = m.frozenFrom ? 'Move chord note' : 'Freeze chord and move note';
  return updateMoment(id, frozenPatch(m, next, keep), label);
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
  const keep = keepOrder();
  beginGesture(m.frozenFrom ? 'Move chord note' : 'Freeze chord and move note');
  return {
    to(pitch) {
      const next = withChordNote(notes, index, pitch, keep);
      updateGesture((p) => (next ? patchMoment(p, id, frozenPatch(m, next, keep)) : p));
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
  const order = noteOrder();
  if (order) m.order = order;
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
  return updateMoment(id, { to, order: noteOrder() }, 'Move note');
}

/** A drag of note `id`'s `to` (its score dot): one undo entry. Null if there is no such note. */
export function dragNote(id: MomentId): PitchDrag | null {
  if (!noteOf(usePlayer.getState().piece, id)) return null;
  const order = noteOrder();
  beginGesture('Move note');
  return {
    to(pitch) {
      updateGesture((p) => patchMoment(p, id, { to: pitch, order }));
    },
    end(cancel = false) {
      if (cancel) cancelGesture();
      else endGesture();
    },
  };
}

/** A drag of an arrival dot: `to(pitch, t)` with `t` its arrival; `end(true)` cancels it. */
export interface DotDrag {
  to(pitch: Pitch, t: Seconds): void;
  end(cancel?: boolean): void;
}

/** Closes a gesture: `end(true)` cancels it. */
function finish(cancel: boolean): void {
  if (cancel) cancelGesture();
  else endGesture();
}

/**
 * A drag of walk step `ref` (its score dot, §11.3): sets the step's pitch and, when `t` differs
 * from `t0` (the dot's arrival), its tick (the step then arrives at `t`), freezing the walk on
 * the first change; one undo entry. The selected step follows. Null if there is no such walk.
 */
export function dragWalkStep(ref: StepRef, t0: Seconds): DotDrag | null {
  const piece = usePlayer.getState().piece;
  const w = piece.moments.find((m) => m.id === ref.momentId);
  if (w?.type !== 'walk') return null;
  const score = scoreOf(piece);
  let cur = ref;
  beginGesture(w.fixed ? 'Move walk step' : 'Freeze walk and move step');
  return {
    to(pitch, t) {
      const tick = t === t0 ? ref.tick : (tickAt(w, t - (w.stepGlide ?? 0)) ?? ref.tick);
      const r = movedStep(w, score, ref, pitch, tick);
      if (!r) return;
      cur = r.ref;
      updateGesture((p) => patchMoment(p, w.id, { fixed: r.fixed }));
    },
    end(cancel = false) {
      finish(cancel);
      if (!cancel) selectStep(cur);
    },
  };
}

/**
 * A drag of arrival dot `dot` (§11.3 "Every dot is draggable", revision 6): moves that dot by
 * editing its moment, never adding one. Chord: that note (freezing) and that voice's arrival
 * (`overrides`); walk: the step's pitch and tick; note: `to` and the arrival; any other moment:
 * that voice's override. The pitch changes only when it differs from the dot's, the arrival only
 * when `t` differs from `dot.t`. One undo entry. Null if the moment is gone.
 */
export function dragArrival(dot: ArrivalDot): DotDrag | null {
  const piece = usePlayer.getState().piece;
  const score = scoreOf(piece);
  const a = dotAction(piece, dot, (m) => chordNotes(piece, score, m));
  if (a.kind === 'none') return null;
  if (a.kind === 'walk') return dragWalkStep(a.step, dot.t);
  const m = piece.moments.find((x) => x.id === a.id);
  if (!m) return null;
  const voice = a.voice;
  /** The arrival part of a patch: that voice's override `end` (merged into `list`). */
  const timed = (t: Seconds, list = m.overrides): MomentPatch =>
    voice === undefined || t === dot.t
      ? {}
      : ({ overrides: withOverride(list, voice, { end: arrivalEnd(m, t) }) } as MomentPatch);
  let patchOf: (pitch: Pitch, t: Seconds) => MomentPatch;
  if (a.kind === 'chord' && m.type === 'chord') {
    const notes = chordNotes(piece, score, m);
    const keep = keepOrder();
    beginGesture(m.frozenFrom ? 'Move chord note' : 'Freeze chord and move note');
    patchOf = (pitch, t) => {
      const next = notes && pitch !== dot.pitch ? withChordNote(notes, a.index, pitch, keep) : null;
      return { ...(next ? frozenPatch(m, next, keep) : {}), ...timed(t) } as MomentPatch;
    };
  } else if (a.kind === 'note' && m.type === 'note') {
    const order = noteOrder();
    beginGesture('Move note');
    patchOf = (pitch, t) =>
      ({ ...(pitch !== dot.pitch ? { to: pitch, order } : {}), ...timed(t) }) as MomentPatch;
  } else if (a.kind === 'override' && voice !== undefined) {
    beginGesture(`Move ${LABELS[m.type]} note`);
    // Kept inside the voice's range: the compiler would fold it by an octave (§7.8).
    const [lo, hi] = piece.voices[voice]?.range ?? [0, 127];
    patchOf = (pitch0, t) => {
      const pitch = Math.min(hi, Math.max(lo, pitch0));
      const list = pitch !== dot.pitch ? withOverride(m.overrides, voice, { pitch }) : m.overrides;
      const p = timed(t, list);
      return Object.keys(p).length > 0 || list === m.overrides
        ? p
        : ({ overrides: list } as MomentPatch);
    };
  } else return null;
  return {
    to(pitch, t) {
      const patch = patchOf(pitch, t);
      updateGesture((p) => (Object.keys(patch).length > 0 ? patchMoment(p, m.id, patch) : p));
    },
    end(cancel = false) {
      finish(cancel);
    },
  };
}

/** Removes voice `voice`'s override from moment `id` ("Clear override"). False if none. */
export function clearOverride(id: MomentId, voice: number): boolean {
  const m = usePlayer.getState().piece.moments.find((x) => x.id === id);
  if (!m?.overrides?.some((o) => o.voice === voice)) return false;
  return updateMoment(
    id,
    { overrides: withoutOverride(m.overrides, voice) } as MomentPatch,
    'Clear override',
  );
}

/** Removes all of moment `id`'s overrides ("Clear overrides"). False if none. */
export function clearOverrides(id: MomentId): boolean {
  return updateMoment(id, { overrides: undefined } as MomentPatch, 'Clear overrides');
}

/**
 * Adds a note on pool voice `voice` at `at` with `from` (a double-click or N-click on a line,
 * §11.3) and keeps the gesture open: `to(p)` sets its pitch. Inside a walk that drives the voice,
 * this inserts a step into the walk (freezing it) instead of a note moment; one undo entry
 * either way ("Add walk step" / "Freeze walk and add step" / "Add note").
 */
export function addPointDrag(at: Seconds, voice: number, from: Pitch): PitchDrag {
  const piece = usePlayer.getState().piece;
  const score = scoreOf(piece);
  const ins = walkInsertAt(piece, score, voice, at);
  const id = score.voices[voice]?.id;
  if (!ins || id === undefined) return addNoteDrag(at, from);
  const w = ins.walk;
  const ref: StepRef = { momentId: w.id, tick: ins.tick, voice: id };
  const base = w.fixed ?? freezeWalk(score, w.id);
  beginGesture(w.fixed ? 'Add walk step' : 'Freeze walk and add step');
  const set = (pitch: Pitch): void =>
    updateGesture((p) =>
      patchMoment(p, w.id, { fixed: withNote(base, { tick: ins.tick, voice: id, pitch }) }),
    );
  set(from);
  select([w.id]);
  selectStep(ref);
  return {
    to: set,
    end(cancel = false) {
      finish(cancel);
      if (cancel) selectStep(null);
    },
  };
}
