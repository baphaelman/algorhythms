/**
 * Snapping to note changes (PLAN.md §11.3 revision 7 "Snapping and bars"). Times snap to the
 * nearest point where some line starts or ends a move (moving segments' ends, which include
 * moment arrivals, walk step ticks and note points) or a moment starts, when within `SNAP_PX`
 * at the current zoom; zooming in far enough leaves a time free. The bar grid is not a target.
 * Alt disables snapping. Pure: callers take the points at gesture start, so the dragged item's
 * own (moving) times never feed back.
 *
 * Revision 9 "Snap to beats": when the piece has a tempo and the toggle is on (`beatStep`), the
 * beats are a target as well: a time goes to the nearer of its nearest beat and a note change
 * within `SNAP_PX`.
 */

import type { CompiledScore, MomentId, Piece, Seconds, ViewSettings } from '../../core/types';
import { momentArrivals, type ArrivalDot } from './arrival-points';
import { sameStep } from './walk-steps';

/** Next's hold after the piece's last moment without a tempo, s (with one: a bar). */
export const NEXT_HOLD = 2;

/** Snap reach, CSS px. */
export const SNAP_PX = 8;

/** One note-change point. */
export interface ChangePoint {
  t: Seconds;
  /** The moment that produced it. */
  momentId?: MomentId;
  /** Pool index of the voice, absent for a moment's own time. */
  voice?: number;
}

/** Points closer than this (s) from the same source are merged. */
const SAME_T = 1e-6;

const cache = new WeakMap<CompiledScore, { piece: Piece; points: ChangePoint[] }>();

/**
 * The beat length (s) times snap to: the piece's tempo (`gridBpm`) when "Snap to beats" is on
 * (`snapBeats` is not false), else null (no tempo, or the toggle is off).
 */
export function beatStep(view: Pick<ViewSettings, 'gridBpm' | 'snapBeats'>): Seconds | null {
  const bpm = view.gridBpm;
  if (view.snapBeats === false || bpm === undefined || !Number.isFinite(bpm) || !(bpm > 0)) {
    return null;
  }
  return 60 / bpm;
}

/** `t` rounded to the nearest beat of a `step`-second grid, to 1 µs; never below 0. */
export function nearestBeat(t: Seconds, step: Seconds): Seconds {
  return Math.max(0, Math.round(Math.round(t / step) * step * 1e6) / 1e6) + 0;
}

/** `t` rounded up to the next beat (itself when it is on one), to 1 µs. */
export function nextBeat(t: Seconds, step: Seconds): Seconds {
  const k = t / step;
  const n = Math.abs(k - Math.round(k)) < 1e-6 ? Math.round(k) : Math.ceil(k);
  return Math.max(0, Math.round(n * step * 1e6) / 1e6) + 0;
}

/** Every note-change point of `score` (and `piece`'s moment times), sorted by time; cached. */
export function changePoints(score: CompiledScore, piece: Piece): readonly ChangePoint[] {
  const hit = cache.get(score);
  if (hit && hit.piece === piece) return hit.points;
  const out: ChangePoint[] = [];
  for (const v of score.voices) {
    for (const s of v.segments) {
      if (s.p0 === s.p1) continue;
      const m = s.momentId;
      out.push({ t: s.t0, momentId: m, voice: v.index });
      if (s.t1 - s.t0 > SAME_T) out.push({ t: s.t1, momentId: m, voice: v.index });
    }
  }
  for (const m of piece.moments) if (!m.muted) out.push({ t: m.at, momentId: m.id });
  out.sort((a, b) => a.t - b.t);
  cache.set(score, { piece, points: out });
  return out;
}

/** Excludes the dragged item's own points. */
export type Exclude = (p: ChangePoint) => boolean;

/** Excludes every point of moments `ids` (a moment drag on the lane). */
export function ofMoments(ids: readonly MomentId[]): Exclude {
  const set = new Set(ids);
  return (p) => p.momentId !== undefined && set.has(p.momentId);
}

/** Excludes voice `voice`'s points of moment `id` (a dot drag), and the moment's own time. */
export function ofVoice(id: MomentId, voice: number | undefined): Exclude {
  return (p) => p.momentId === id && (p.voice === undefined || p.voice === voice);
}

/** Index of the first point at or after `t` (binary search). */
function lowerBound(points: readonly { t: Seconds }[], t: Seconds): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The point time nearest `t` within `reach` seconds (ties: the earlier), skipping excluded; or null. */
export function nearestPoint(
  t: Seconds,
  points: readonly ChangePoint[],
  reach: Seconds,
  exclude?: Exclude,
): Seconds | null {
  let best: Seconds | null = null;
  let bestD = reach;
  const i0 = lowerBound(points, t - reach);
  for (let i = i0; i < points.length; i++) {
    const p = points[i]!;
    if (p.t > t + reach) break;
    if (exclude?.(p)) continue;
    const d = Math.abs(p.t - t);
    if (d < bestD || (best === null && d <= bestD)) {
      best = p.t;
      bestD = d;
    }
  }
  return best;
}

/** `t` rounded to the ms, never below 0. */
export function freeTime(t: Seconds): Seconds {
  return Math.max(0, Math.round(t * 1000) / 1000) + 0;
}

/** What a time-setting gesture snaps to. */
export interface SnapSet {
  points: readonly ChangePoint[];
  exclude?: Exclude;
  /** Times tried first (a walk step's sibling steps), each within the same reach. */
  prefer?: readonly Seconds[];
  /** Beat length (s) when "Snap to beats" is on (`beatStep`); the nearest beat is a target. */
  grid?: Seconds | null;
}

/**
 * `t` snapped at `pps` px/s: to the nearest preferred time within `SNAP_PX`, else the nearer of
 * the nearest change point within it and the nearest beat (`grid`), else free (ms). `alt` (or no
 * zoom) leaves it free. Never below 0.
 */
export function snapTime(t: Seconds, set: SnapSet, pps: number, alt = false): Seconds {
  if (alt || !(pps > 0)) return freeTime(t);
  const reach = SNAP_PX / pps;
  if (set.prefer && set.prefer.length > 0) {
    let best: Seconds | null = null;
    for (const q of set.prefer) {
      if (Math.abs(q - t) <= reach && (best === null || Math.abs(q - t) < Math.abs(best - t))) {
        best = q;
      }
    }
    if (best !== null) return Math.max(0, best);
  }
  const hit = nearestPoint(t, set.points, reach, set.exclude);
  const beat = set.grid ? nearestBeat(t, set.grid) : null;
  if (beat !== null && (hit === null || Math.abs(beat - t) <= Math.abs(hit - t))) return beat;
  return hit === null ? freeTime(t) : Math.max(0, hit);
}

/**
 * What a dot drag's time snaps to, taken at drag start: a walk step to its walk's other steps
 * first (so the walk's lines stay in sync), then every note change outside that walk; any other
 * dot to every note change but its own voice's in its moment.
 */
export function dotSnaps(score: CompiledScore, piece: Piece, dot: ArrivalDot): SnapSet {
  const points = changePoints(score, piece);
  const grid = beatStep(piece.view);
  if (!dot.step) return { points, exclude: ofVoice(dot.momentId, dot.voice), grid };
  const step = dot.step;
  const walk = piece.moments.find((m) => m.id === dot.momentId);
  const prefer = walk
    ? momentArrivals(score, walk)
        .filter((d) => d.step && !sameStep(d.step, step))
        .map((d) => d.t)
    : [];
  return { points, exclude: ofMoments([dot.momentId]), prefer, grid };
}
