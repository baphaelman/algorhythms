/**
 * Walk step editing (PLAN.md §6.2 "Frozen walks", §11.3 Walk): pure helpers. A step is named by
 * (moment, tick, voice), which stays the same when the walk is frozen.
 */

import { freezeWalk, walkTickTime } from '../../core/moments/walk';
import { activeAt, keyAt, pitchAt, segmentAt } from '../../core/query';
import { snapToScale, stepByScale } from '../../core/scales';
import type {
  CompiledScore,
  Key,
  MomentId,
  Piece,
  Pitch,
  Seconds,
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

/**
 * The walk tick whose step starts at `t`: an integer when within 0.001 of one, else fractional
 * (to 1e-4; a step between ticks, §11.3). Null before the walk or at/after its end.
 */
export function tickAt(w: WalkMoment, t: Seconds): number | null {
  const x = (t - w.at) / w.grid;
  const r = Math.round(x);
  const k = Math.abs(x - r) < 1e-3 ? r : Math.round(x * 1e4) / 1e4;
  if (!(k >= 0) || !(w.at + k * w.grid < w.until)) return null;
  return k;
}

/**
 * Step `ref` moved to `tick` with `pitch` (a dot drag, §11.3): the walk's `fixed` (frozen first
 * if needed) without the old note and with the new one, and the step's new ref. Null if `pitch`
 * is outside MIDI 0..127.
 */
export function movedStep(
  w: WalkMoment,
  score: CompiledScore,
  ref: StepRef,
  pitch: Pitch,
  tick: number,
): { fixed: WalkNote[]; ref: StepRef } | null {
  if (pitch < 0 || pitch > 127) return null;
  const base = (w.fixed ?? freezeWalk(score, w.id)).filter(
    (n) => !(n.tick === ref.tick && n.voice === ref.voice),
  );
  return {
    fixed: withNote(base, { tick, voice: ref.voice, pitch }),
    ref: { momentId: w.id, tick, voice: ref.voice },
  };
}

/** True if walk `w` targets pool voice `v` at t (its selector, read at t as the compiler does). */
function targets(
  score: CompiledScore,
  piece: Piece,
  w: WalkMoment,
  v: number,
  t: Seconds,
): boolean {
  const sel = w.target;
  if (sel === undefined || sel === 'all') return true;
  if ('voices' in sel) return sel.voices.includes(piece.voices[v]?.id ?? '');
  const active = activeAt(score, t)
    .map((i) => ({ i, p: pitchAt(score.voices[i], t) ?? 0 }))
    .sort((a, b) => a.p - b.p || a.i - b.i);
  const r = active.findIndex((a) => a.i === v);
  const [a, b] = sel.rank;
  return r >= Math.min(a, b) && r <= Math.max(a, b);
}

/**
 * The walk that drives pool voice `v` at t (§7.1: the latest-starting unmuted walk whose span
 * holds t and that targets v), or null.
 */
export function walkAt(
  piece: Piece,
  score: CompiledScore,
  v: number,
  t: Seconds,
): WalkMoment | null {
  let best: WalkMoment | null = null;
  piece.moments.forEach((m) => {
    if (m.type !== 'walk' || m.muted || !(m.at <= t && t < m.until)) return;
    if (best && m.at < best.at) return;
    if (targets(score, piece, m, v, t)) best = m;
  });
  return best;
}

/**
 * Where a note added on voice `v` at `t` becomes a walk step instead (§11.3): the driving walk
 * and the step's tick. On a voice still gliding at t the step starts when the glide ends (the
 * compiler ignores a step on a moving voice). Null outside a walk, or past its end.
 */
export function walkInsertAt(
  piece: Piece,
  score: CompiledScore,
  v: number,
  t: Seconds,
): { walk: WalkMoment; tick: number } | null {
  const w = walkAt(piece, score, v, t);
  if (!w) return null;
  const voice = score.voices[v];
  const seg = voice && segmentAt(voice, t);
  if (!seg) return null;
  if (seg.p0 !== seg.p1 && t < seg.t1) {
    let k = Math.ceil(((seg.t1 - w.at) / w.grid) * 1e4) / 1e4;
    if (w.at + k * w.grid < seg.t1) k = Math.round(k * 1e4 + 1) / 1e4;
    return w.at + k * w.grid < w.until ? { walk: w, tick: k } : null;
  }
  const tick = tickAt(w, t);
  return tick === null ? null : { walk: w, tick };
}
