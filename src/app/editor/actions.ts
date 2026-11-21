/**
 * Undoable moment edits on the current piece (§11.3). Each is one `edit` (one undo entry); a
 * call that changes nothing records nothing. For drags, use the pure recipes in ./ops with
 * `beginGesture` / `updateGesture` / `endGesture` instead.
 */

import { compile } from '../../core/compiler/compile';
import type {
  CompiledScore,
  Key,
  MomentId,
  MomentType,
  NoteMoment,
  Piece,
  Pitch,
  Seconds,
} from '../../core/types';
import { keyAt } from '../../core/query';
import { auditionAfterEdit, auditionPointsAfterEdit, auditionStepAfterEdit } from '../audition';
import { usePlayer } from '../store';
import { keyBefore } from '../../core/transpose';
import { offerKeyCarry } from './key-carry';
import { PIECE_KEY_ID, setKeyOf } from './piece-key';
import { chordNotes, frozenPatch, unfreezePatch, withChordNote } from './chord-notes';
import { beginGesture, cancelGesture, edit, endGesture, select, updateGesture } from './history';
import { defaultMoment } from './new-moment';
import { stepNoteTo } from './note-points';
import { freezeWalk } from '../../core/moments/walk';
import { NOTE_MATCH, noteChanges, withNoteChanges } from '../../core/moments/note';
import { withoutOverride } from './overrides';
import { selectStep } from './step-selection';
import { movedFixed, scaleNeighbour, walkInsertAt, withNote, type StepRef } from './walk-steps';
import { dotAction, type ArrivalDot } from './arrival-points';
import {
  groupTargets,
  moveDots,
  noteHostAt,
  type DotMove,
  type MoveEnv,
  type MoveResult,
} from './group-move';
import { inRange } from './drag-edge';
import { OCTAVE, octaveGuides, octaveSnap, octaveSpan } from './octave-drag';
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
  pulse: 'pulse',
  tune: 'tune',
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
 * id. The defaults depend on the piece's state at `at` (see ./new-moment). A key at 0 selects the
 * piece key instead (`PIECE_KEY_ID`).
 */
export function addMoment(type: MomentType, at: Seconds): MomentId {
  const t = Math.max(0, at);
  // The key at 0:00 is the piece key (M4.5-39): adding one there selects it instead.
  if (type === 'key' && t === 0) {
    select([PIECE_KEY_ID]);
    return PIECE_KEY_ID;
  }
  const piece = usePlayer.getState().piece;
  const [id] = newMomentIds(piece, 1);
  const m = defaultMoment(type, t, id, piece, scoreOf(piece));
  edit((p) => insertMoments(p, [m]), `Add ${LABELS[type]}`);
  select([id]);
  if (type === 'key') offerKeyCarry(id, keyBefore(usePlayer.getState().piece, id));
  return id;
}

/**
 * Sets the piece's key (the key moment at 0:00) as one undo entry, then offers to carry its
 * span's fixed notes. False if nothing changed.
 */
export function setPieceKey(key: Key, label = 'Change key'): boolean {
  const old = usePlayer.getState().piece.key;
  const ok = edit((p) => setKeyOf(p, key), label);
  if (ok) offerKeyCarry(PIECE_KEY_ID, old);
  return ok;
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
  const moved = updateMoment(
    w.id,
    { fixed },
    w.fixed ? 'Move walk step' : 'Freeze walk and move step',
  );
  // Sounds the step's new note once the edit has compiled (§11.3 auditioning).
  if (moved) auditionStepAfterEdit(ref);
  return moved;
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
  const pitch = scaleNeighbour(notes[index], dir, keyAt(score, m.at));
  const moved = setChordNote(id, index, pitch);
  // Sounds the moved note once the edit has compiled (§11.3 auditioning).
  if (moved) auditionAfterEdit(id, [pitch]);
  return moved;
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
 * Revision 7: at the time of an existing note moment it joins it as one more change (or, on a
 * line that moment already changes, edits that change) instead of adding a moment.
 */
export function addNoteDrag(at: Seconds, from: Pitch): PitchDrag & { id: MomentId } {
  const t = Math.max(0, at);
  const piece = usePlayer.getState().piece;
  const order = noteOrder();
  const host = noteHostAt(piece, t);
  beginGesture(`Add ${LABELS.note}`);
  if (host) {
    const list = noteChanges(host);
    const same = list.findIndex((c) => Math.abs(c.from - from) < NOTE_MATCH);
    const base = same >= 0 ? list : [...list, { from, to: from }];
    const k = same >= 0 ? same : list.length;
    const set = (to: Pitch): void =>
      updateGesture((p) => {
        const next = withNoteChanges(
          host,
          base.map((c, i) => (i === k ? { from: c.from, to } : c)),
        );
        return patchMoment(p, host.id, {
          from: next.from,
          to: next.to,
          changes: next.changes,
          order: order ?? host.order,
        });
      });
    set(base[k].to);
    select([host.id]);
    return { id: host.id, to: set, end: finish };
  }
  const [id] = newMomentIds(piece, 1);
  const base = defaultMoment('note', t, id, piece, scoreOf(piece));
  const m: NoteMoment = { ...(base as NoteMoment), from, to: from };
  if (order) m.order = order;
  updateGesture((p) => insertMoments(p, [m]));
  select([id]);
  return {
    id,
    to(pitch) {
      updateGesture((p) => insertMoments(p, [{ ...m, to: pitch }]));
    },
    end: finish,
  };
}

function noteOf(piece: Piece, id: MomentId): NoteMoment | null {
  const m = piece.moments.find((x) => x.id === id);
  return m?.type === 'note' ? m : null;
}

/**
 * Steps note `id`'s change `change` (all its changes when absent) one scale step (in the key at
 * its time). False if nothing changed.
 */
export function stepNote(id: MomentId, dir: 1 | -1, change?: number, octave = false): boolean {
  const piece = usePlayer.getState().piece;
  const m = noteOf(piece, id);
  if (!m) return false;
  const key = keyAt(scoreOf(piece), m.at);
  // Shift+▲/▼ (§11.3 "Shift-drag moves by octaves"): an octave, unless that leaves 0..127.
  const byOctave = (to: Pitch): Pitch => {
    const q = to + dir * OCTAVE;
    return q >= 0 && q <= 127 ? q : to;
  };
  const list = noteChanges(m).map((c, i) =>
    change === undefined || i === change
      ? { from: c.from, to: octave ? byOctave(c.to) : stepNoteTo(c.to, dir, key) }
      : c,
  );
  const next = withNoteChanges(m, list);
  const moved = updateMoment(
    id,
    { from: next.from, to: next.to, changes: next.changes, order: noteOrder() },
    'Move note',
  );
  // Sounds the stepped note(s) once the edit has compiled (§11.3 auditioning).
  if (moved)
    auditionAfterEdit(
      id,
      list.filter((_, i) => change === undefined || i === change).map((c) => c.to),
    );
  return moved;
}

/** A drag of an arrival dot: `to(pitch, t)` with `t` its arrival; `end(true)` cancels it. */
export interface DotDrag {
  to(pitch: Pitch, t: Seconds): void;
  end(cancel?: boolean): void;
}

/** Closes a gesture: `end(true)` cancels it. */
function finish(cancel = false): void {
  if (cancel) cancelGesture();
  else endGesture();
}

/**
 * A drag of arrival dot `dot` (§11.3 "Every dot is draggable", revision 6): moves that dot by
 * editing its moment (./group-move `moveDots`). Null if the moment is gone or the dot has nothing
 * to edit.
 */
export function dragArrival(dot: ArrivalDot): DotDrag | null {
  const d = dragDots([dot], dot);
  return d && { to: (pitch, t) => d.to(pitch, t), end: (cancel) => void d.end(cancel) };
}

/** A drag of several dots: `to` places the grabbed one; `end` returns where they ended up. */
export interface DotsDrag {
  /**
   * The grabbed dot to (`pitch`, `t`); the others follow (`chromatic`: same semitones). The dots
   * that are gone from the piece are left out.
   */
  to(pitch: Pitch, t: Seconds, chromatic?: boolean): void;
  /**
   * Shift-drag (§11.3 "Shift-drag moves by octaves"): the whole octaves from the grabbed dot's
   * start nearest `raw`, kept so every dot stays inside its range; its pitch (pass it to `to` with
   * `chromatic`), and the guide pitches at each reachable octave of the start.
   */
  octaves(raw: Pitch): { k: number; pitch: Pitch; guides: Pitch[] };
  /**
   * Closes the gesture: the last move's result and its targets (per dot, in `dots` order), or
   * null when cancelled or nothing moved.
   */
  end(cancel?: boolean): (MoveResult & { targets: DotMove[] }) | null;
}

/** The union of `ranges`, or undefined when there are none. */
function poolRange(ranges: readonly [Pitch, Pitch][]): [Pitch, Pitch] | undefined {
  if (ranges.length === 0) return undefined;
  return [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))];
}

/** The undo label of a one-dot drag (null: the dot has nothing to edit). */
function dotLabel(piece: Piece, score: CompiledScore, dot: ArrivalDot): string | null {
  const a = dotAction(piece, dot, (m) => chordNotes(piece, score, m));
  const m = piece.moments.find((x) => x.id === dot.momentId);
  if (a.kind === 'none' || !m) return null;
  if (m.type === 'chord') return m.frozenFrom ? 'Move chord note' : 'Freeze chord and move note';
  if (m.type === 'walk') return m.fixed ? 'Move walk step' : 'Freeze walk and move step';
  if (m.type === 'note') return 'Move note';
  return `Move ${LABELS[m.type]} note`;
}

/**
 * A drag of `dots` (the score selection, §11.3 revision 7), grabbed by `grabbed` (one of them):
 * all move together, the same scale steps in the key and the same time offset (./group-move), as
 * one undo entry ("Move notes"; one dot: its own label). Pitches stay inside each voice's range
 * (unknown voice: all voices'), so the compiler never folds them. Null if `grabbed` is gone.
 */
export function dragDots(dots: readonly ArrivalDot[], grabbed: ArrivalDot): DotsDrag | null {
  const piece = usePlayer.getState().piece;
  const score = scoreOf(piece);
  const live = dots.filter((d) => piece.moments.some((m) => m.id === d.momentId));
  if (!live.includes(grabbed)) return null;
  const label = live.length === 1 ? dotLabel(piece, score, grabbed) : 'Move notes';
  if (label === null) return null;
  const voices = piece.voices;
  const pool = poolRange(voices.map((v) => v.range));
  const range = (d: ArrivalDot) =>
    (d.voice === undefined ? undefined : voices[d.voice]?.range) ?? pool;
  const env: MoveEnv = {
    score,
    chordNotes: (m) => chordNotes(piece, score, m),
    keep: keepOrder(),
    order: noteOrder(),
    ids: newMomentIds(piece, live.length),
  };
  const span = octaveSpan(live.map((d) => ({ pitch: d.pitch, range: range(d) })));
  const guides = octaveGuides(grabbed.pitch, span);
  beginGesture(label);
  let last: (MoveResult & { targets: DotMove[] }) | null = null;
  return {
    octaves(raw) {
      const k = octaveSnap(grabbed.pitch, raw, span);
      return { k, pitch: grabbed.pitch + k * OCTAVE, guides };
    },
    to(pitch, t, chromatic = false) {
      const moves = groupTargets(
        live,
        grabbed,
        inRange(pitch, range(grabbed)),
        t,
        (x) => keyAt(score, x),
        chromatic,
        range,
      );
      updateGesture((p) => {
        const r = moveDots(p, moves, env);
        last = { ...r, targets: moves };
        return r.piece;
      });
    },
    end(cancel = false) {
      finish(cancel);
      return cancel ? null : last;
    },
  };
}

/** Where moved dots ended up (`DotsDrag.end`'s result), for re-selecting them. */
export function landedDots(r: MoveResult & { targets: DotMove[] }): ArrivalDot[] {
  return r.targets.map(({ dot: d, pitch, t }, i) => {
    const out: ArrivalDot = { ...d, momentId: r.hosts[i], pitch, t };
    const step = r.steps[i];
    if (step) out.step = step;
    return out;
  });
}

/**
 * Shift+▲/▼ on selected dots (§11.3 "Shift-drag moves by octaves"): all of them an octave up or
 * down (none when one would leave its range), one undo entry; returns where they landed, or null
 * when nothing moved.
 */
export function octaveDots(dots: readonly ArrivalDot[], dir: 1 | -1): ArrivalDot[] | null {
  const g = dots[0];
  if (!g) return null;
  const d = dragDots(dots, g);
  if (!d) return null;
  const { k, pitch } = d.octaves(g.pitch + dir * OCTAVE);
  if (k === 0) {
    d.end(true);
    return null;
  }
  d.to(pitch, g.t, true);
  const r = d.end();
  const landed = r && landedDots(r);
  // Sounds the moved notes once the edit has compiled (§11.3 auditioning).
  if (landed) auditionPointsAfterEdit(landed);
  return landed;
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
