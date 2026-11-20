/**
 * Pure camera maths (PLAN.md §10 "Camera (revision 5)"). Nothing here touches the DOM.
 *
 * The camera is `{ start, window }` in seconds plus the view width in px. Everything on the time
 * axis (score canvas, ruler, lanes, playhead) maps time to x with the one pair below:
 *
 *     timeToX(axis, t) = (t − start) · width / window      xToTime is its inverse
 *
 * `axis` is any `Axis` (a `View` is one; `axisOf(cam, width)` builds one without a score).
 * Follow (`followStart`), zoom (`zoomAround`) and pan only ever change `start` and `window`;
 * `start` is always clamped to [0, duration − window].
 */

import type { CompiledScore, FollowMode, Seconds } from '../core/types';
import type { CameraState, View } from './types';

/** Shortest visible window, seconds. */
export const MIN_WINDOW: Seconds = 2;
/** Smooth follow: the playhead's x as a fraction of the width. */
export const SMOOTH_X = 0.35;
/** Page follow: the view turns when the playhead passes this fraction of the width... */
export const PAGE_TURN_X = 0.92;
/** ...and lands so the playhead sits at this fraction. */
export const PAGE_LAND_X = 0.08;
/** Default opacity of the future (not yet played) lines. */
export const DEFAULT_FUTURE_OPACITY = 0.35;
/** Default follow mode. */
export const DEFAULT_FOLLOW: FollowMode = 'smooth';

/** One time axis: what `timeToX` / `xToTime` need. */
export interface Axis {
  /** Time at x = 0, seconds. */
  start: Seconds;
  /** Visible time span, seconds. */
  window: Seconds;
  /** Width in CSS px. */
  width: number;
  /** Pixels per second (`width / window`). */
  pps: number;
}

/** The axis for camera `cam` on a view `width` px wide (no clamping). */
export function axisOf(cam: { start: Seconds; window: Seconds }, width: number): Axis {
  return { start: cam.start, window: cam.window, width, pps: width / cam.window };
}

/** x (px) of time `t`. */
export function timeToX(axis: Pick<Axis, 'start' | 'pps'>, t: Seconds): number {
  return (t - axis.start) * axis.pps;
}

/** Time at x (px); inverse of `timeToX`. */
export function xToTime(axis: Pick<Axis, 'start' | 'pps'>, x: number): Seconds {
  return axis.start + x / axis.pps;
}

/** The allowed window range for a piece of this duration. */
export function windowRange(duration: Seconds): [Seconds, Seconds] {
  return [MIN_WINDOW, Math.max(MIN_WINDOW, duration)];
}

/** Clamps a window to [2 s, whole piece]. */
export function clampWindow(window: Seconds, duration: Seconds): Seconds {
  const [lo, hi] = windowRange(duration);
  return Math.min(hi, Math.max(lo, Number.isFinite(window) ? window : hi));
}

/** Clamps `start` to [0, duration − window] (0 when the window covers the piece). */
export function clampStart(start: Seconds, window: Seconds, duration: Seconds): Seconds {
  const hi = Math.max(0, duration - window);
  return Math.min(hi, Math.max(0, Number.isFinite(start) ? start : 0));
}

/** Slider position 0..1 (log scale) for a window. 0 = 2 s, 1 = the whole piece. */
export function windowToSlider(window: Seconds, duration: Seconds): number {
  const [lo, hi] = windowRange(duration);
  if (hi <= lo) return 1;
  const w = clampWindow(window, duration);
  return (Math.log(w) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
}

/** Window for a slider position 0..1 (log scale); inverse of `windowToSlider`. */
export function sliderToWindow(x: number, duration: Seconds): Seconds {
  const [lo, hi] = windowRange(duration);
  const k = Math.min(1, Math.max(0, x));
  return Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * k);
}

/** Multiplies the window by `factor` (e.g. 1.25 for `−`, 0.8 for `=`), clamped. */
export function zoomWindow(window: Seconds, factor: number, duration: Seconds): Seconds {
  return clampWindow(window * factor, duration);
}

/**
 * The view start after one frame of following playhead time `t`:
 * - `smooth`: the playhead at 35 % of the width;
 * - `page`: unchanged until the playhead passes 92 % (or leaves the view), then the playhead at 8 %;
 * - `off`: unchanged.
 * Always clamped, so near either end (and at Fit) the playhead moves across a still view.
 */
export function followStart(
  mode: FollowMode,
  start: Seconds,
  t: Seconds,
  window: Seconds,
  duration: Seconds,
): Seconds {
  let s = start;
  if (mode === 'smooth') s = t - SMOOTH_X * window;
  else if (mode === 'page' && (t >= start + PAGE_TURN_X * window || t < start)) {
    s = t - PAGE_LAND_X * window;
  }
  return clampStart(s, window, duration);
}

/**
 * The time a zoom keeps fixed on screen: the playhead `t` while it is in view, else the view's
 * centre.
 */
export function zoomAnchor(start: Seconds, window: Seconds, t: Seconds): Seconds {
  return t >= start && t <= start + window ? t : start + window / 2;
}

/**
 * Zooms to `next` (clamped) keeping time `anchor` at the same x; returns the new camera, start
 * clamped.
 */
export function zoomAround(
  cam: { start: Seconds; window: Seconds },
  next: Seconds,
  anchor: Seconds,
  duration: Seconds,
): { start: Seconds; window: Seconds } {
  const window = clampWindow(next, duration);
  const f = (anchor - cam.start) / cam.window;
  return { start: clampStart(anchor - f * window, window, duration), window };
}

/** The pitch range a score uses, plus a margin; cached per score. */
const extents = new WeakMap<CompiledScore, [number, number]>();

/** [low, high] pitch the score's lines cover, padded by 1.5 semitones (≥ 12 semitones tall). */
export function pitchExtent(score: CompiledScore): [number, number] {
  const hit = extents.get(score);
  if (hit) return hit;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of score.voices) {
    for (const s of v.segments) {
      const a = Math.min(s.p0, s.p1);
      const b = Math.max(s.p0, s.p1);
      if (a < lo) lo = a;
      if (b > hi) hi = b;
    }
  }
  if (!(hi >= lo)) {
    lo = 57;
    hi = 81;
  }
  lo -= 1.5;
  hi += 1.5;
  if (hi - lo < 12) {
    const mid = (lo + hi) / 2;
    lo = mid - 6;
    hi = mid + 6;
  }
  const out: [number, number] = [lo, hi];
  extents.set(score, out);
  return out;
}

/** What `cameraAt` needs from a score. */
export interface CameraScore {
  duration: Seconds;
  /** Pitch range to fit when the camera has no override. */
  pitchRange: [number, number];
}

/** Extracts what the camera needs from a compiled score (the pitch range is cached). */
export function cameraScore(score: CompiledScore): CameraScore {
  return { duration: score.duration, pitchRange: pitchExtent(score) };
}

/**
 * Resolves camera `cam` (window and start clamped to the piece) on a canvas of `size` CSS px, with
 * the playhead at time `t`. `hud` reserves room for the heads-up display at the bottom.
 */
export function cameraAt(
  score: CameraScore,
  cam: CameraState,
  t: Seconds,
  size: { width: number; height: number },
  hud = true,
): View {
  const { width: W, height: H } = size;
  const D = Math.max(score.duration, 1e-6);
  const window = clampWindow(cam.window, D);
  const start = clampStart(cam.start, window, D);
  const pps = W / window;
  const padT = Math.max(28, H * 0.08);
  const padB = hud ? Math.max(54, H * 0.15) : Math.max(16, H * 0.05);
  const padL = Math.max(16, W * 0.025);
  const [pLo, pHi] = cam.pitchRange ?? score.pitchRange;
  return {
    width: W,
    height: H,
    t,
    start,
    window,
    pps,
    xHead: (t - start) * pps,
    tL: start,
    tR: start + window,
    pLo,
    pHi,
    padT,
    padB,
    padL,
    padR: padL,
    duration: D,
  };
}

/** y (px) of pitch `p`; higher pitches are nearer the top. */
export function pitchToY(view: View, p: number): number {
  return (
    view.padT + ((view.pHi - p) / (view.pHi - view.pLo)) * (view.height - view.padT - view.padB)
  );
}

/** Pitch at y (px); inverse of `pitchToY`. */
export function yToPitch(view: View, y: number): number {
  return (
    view.pHi - ((y - view.padT) / (view.height - view.padT - view.padB)) * (view.pHi - view.pLo)
  );
}
