/**
 * Walk step editing (PLAN.md §6.2 "Frozen walks", §11.3 Walk): pure helpers. A step is named by
 * (moment, tick, voice), which stays the same when the walk is frozen.
 */

import { freezeWalk, walkTickTime } from '../../core/moments/walk';
import { keyAt } from '../../core/query';
import { snapToScale, stepByScale } from '../../core/scales';
import type {
  CompiledScore,
  Key,
  MomentId,
  Pitch,
  VoiceId,
  WalkMoment,
  WalkNote,
  WalkStepRecord,
} from '../../core/types';

export interface StepRef {
  momentId: MomentId;
  tick: number;
  voice: VoiceId;
}

export function sameStep(a: StepRef | null, b: StepRef | null): boolean {
  return !!a && !!b && a.momentId === b.momentId && a.tick === b.tick && a.voice === b.voice;
}

/** The steps walk `momentId` takes in `score`, in time order. */
export function stepsOf(score: CompiledScore, momentId: MomentId): WalkStepRecord[] {
  return score.walkSteps.filter((s) => s.momentId === momentId);
}

/** The nearest scale tone strictly above (`dir` 1) or below (−1) `p` in `key`. */
export function scaleNeighbour(p: Pitch, dir: 1 | -1, key: Key): Pitch {
  const q = snapToScale(p, key);
  if (dir > 0) return q > p ? q : stepByScale(q, 1, key);
  return q < p ? q : stepByScale(q, -1, key);
}

/** `fixed` with the note at (tick, voice) set to `note` (inserted in tick order if absent). */
export function withNote(fixed: readonly WalkNote[], note: WalkNote): WalkNote[] {
  const i = fixed.findIndex((n) => n.tick === note.tick && n.voice === note.voice);
  if (i >= 0) return fixed.map((n, j) => (j === i ? note : n));
  const at = fixed.findIndex((n) => n.tick > note.tick);
  const out = fixed.slice();
  out.splice(at < 0 ? out.length : at, 0, note);
  return out;
}

/**
 * The walk's `fixed` after moving step `ref` one scale step (in the key in effect at its tick).
 * An unfrozen walk is frozen first (`freezeWalk`). Null if the step is unknown or would leave
 * MIDI 0..127.
 */
export function movedFixed(
  w: WalkMoment,
  score: CompiledScore,
  ref: StepRef,
  dir: 1 | -1,
): WalkNote[] | null {
  const base = w.fixed ?? freezeWalk(score, w.id);
  const note = base.find((n) => n.tick === ref.tick && n.voice === ref.voice);
  const from =
    note?.pitch ??
    score.walkSteps.find((s) => s.momentId === w.id && s.tick === ref.tick && s.voice === ref.voice)
      ?.to;
  if (from === undefined) return null;
  const pitch = scaleNeighbour(from, dir, keyAt(score, walkTickTime(w, ref.tick)));
  return fixedWith(w, score, ref, pitch);
}

/**
 * The walk's `fixed` with step `ref` set to `pitch` (an unfrozen walk is frozen first). Null if
 * `pitch` is outside MIDI 0..127.
 */
export function fixedWith(
  w: WalkMoment,
  score: CompiledScore,
  ref: StepRef,
  pitch: Pitch,
): WalkNote[] | null {
  if (pitch < 0 || pitch > 127) return null;
  const base = w.fixed ?? freezeWalk(score, w.id);
  return withNote(base, { tick: ref.tick, voice: ref.voice, pitch });
}
