/**
 * Note points (PLAN.md §11.3, revision 6): pure helpers for the score gesture, the note dot and
 * the inspector's note fields.
 */

import { noteChanges } from '../../core/moments/note';
import { noteAt, pitchAt } from '../../core/query';
import type { CompiledScore, Key, NoteMoment, Pitch, Seconds } from '../../core/types';
import { scaleNeighbour } from './walk-steps';

/** Max ms between two presses for a double-click on the score. */
export const DOUBLE_MS = 450;
/** Max px between two presses for a double-click on the score. */
export const DOUBLE_PX = 6;

/** A press on the score, for double-click detection. */
export interface Press {
  x: number;
  y: number;
  /** ms (performance.now). */
  time: number;
}

/** True when `b` follows `a` closely enough in time and place (`px`) to make a double-click. */
export function isDoublePress(a: Press | null, b: Press, px = DOUBLE_PX): boolean {
  return (
    a !== null &&
    b.time - a.time <= DOUBLE_MS &&
    b.time >= a.time &&
    Math.hypot(b.x - a.x, b.y - a.y) <= px
  );
}

/**
 * The `from` of a note added on voice `voice` at `t`: that voice's sounding pitch, else the
 * nearest sounding line to `near`. Null when nothing sounds there.
 */
export function noteFrom(
  score: CompiledScore,
  voice: number,
  t: Seconds,
  near: Pitch,
): Pitch | null {
  const v = score.voices[voice];
  const p = v ? pitchAt(v, t) : null;
  if (p !== null) return p;
  return noteAt(score, t, near, 2)?.pitch ?? null;
}

/** `to` one scale step up or down in `key`, kept to 0..127. */
export function stepNoteTo(to: Pitch, dir: 1 | -1, key: Key): Pitch {
  return Math.min(127, Math.max(0, scaleNeighbour(to, dir, key)));
}

/**
 * When the note reaches `to`, for its score dot: the end of the earliest segment the note produced
 * that ends on `to` (not the return), else `at`. Several changes: the first change's.
 */
export function noteArrival(score: CompiledScore, m: NoteMoment): Seconds {
  return noteLanding(score, m).t;
}

/**
 * `noteArrival` for the change to `to` (default: the first change's), and the pool index of the
 * voice that lands there (undefined if none); voices in `skip` (other changes') are passed over.
 */
export function noteLanding(
  score: CompiledScore,
  m: NoteMoment,
  to: Pitch = noteChanges(m)[0]?.to ?? NaN,
  skip?: ReadonlySet<number>,
): { t: Seconds; voice?: number } {
  let best = Infinity;
  let voice: number | undefined;
  for (const v of score.voices) {
    if (skip?.has(v.index)) continue;
    for (const s of v.segments) {
      if (s.momentId !== m.id || s.t0 < m.at - 1e-9) continue;
      const end = s.curve ? s.curve.t1 : s.t1;
      const p1 = s.curve ? s.curve.p1 : s.p1;
      if (Math.abs(p1 - to) < 0.5 && end < best) {
        best = end;
        voice = v.index;
      }
    }
  }
  return Number.isFinite(best) ? { t: best, voice } : { t: m.at };
}

/**
 * The chord labels around a note point (§7.9 harmony): `before` = the harmony in effect just
 * before the note, `after` = the one it sets (unchanged if it sets none). Null when none.
 */
export function noteHarmony(
  score: CompiledScore,
  m: NoteMoment,
): { before: string | null; after: string | null } {
  const h = score.harmony ?? [];
  const k = h.findIndex((e) => e.momentId === m.id && !e.from && Math.abs(e.t - m.at) < 1e-9);
  if (k >= 0) return { before: k > 0 ? h[k - 1].label : null, after: h[k].label };
  let cur: string | null = null;
  for (const e of h) {
    if (e.t > m.at) break;
    cur = e.label;
  }
  return { before: cur, after: cur };
}

/** Default `back` when "Return after" is turned on, seconds. */
export const DEFAULT_BACK: Seconds = 1;
