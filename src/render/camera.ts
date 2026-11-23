/**
 * Pure camera maths (PLAN.md §10 "Camera (revision 5)"). Nothing here touches the DOM.
 *
 * The camera is `{ start, window }` in seconds plus the view width in px. Everything on the time
 * axis (score canvas, ruler, lanes, playhead) maps time to x with the one pair below:
 *
 *     timeToX(axis, t) = (t − start) · width / window      xToTime is its inverse
 *
 * `axis` is any `Axis` (a `View` is one; `axisOf(cam, width)` builds one without a score).
 * Follow (`followStart`), zoom (`zoomAround`) and pan only ever change `start` and `window`.
 * The canvas is open-ended (§11.3 revision 7): `start` is clamped to [0, canvasEnd − window], where
 * `canvasEnd(duration)` lies well past the piece's end; Fit and following still frame the piece.
 */

import { evalSegment } from '../core/segment';
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

/** Shortest stretch of open canvas past the piece's end, seconds. */
export const CANVAS_EXTRA: Seconds = 600;

/**
 * How far the view may go (open-ended canvas, §11.3 revision 7): max(4 × the piece, its end +
 * 10 min). Pan and zoom stop there, never before 0.
 */
export function canvasEnd(duration: Seconds): Seconds {
  const d = Math.max(0, Number.isFinite(duration) ? duration : 0);
  return Math.max(d * 4, d + CANVAS_EXTRA);
}

/** The allowed window range for a piece of this duration: [2 s, the whole open canvas]. */
export function windowRange(duration: Seconds): [Seconds, Seconds] {
  return [MIN_WINDOW, Math.max(MIN_WINDOW, canvasEnd(duration))];
}

/** Clamps a window to [2 s, the open canvas]; a missing one fits the piece. */
export function clampWindow(window: Seconds, duration: Seconds): Seconds {
  const [lo, hi] = windowRange(duration);
  return Math.min(hi, Math.max(lo, Number.isFinite(window) ? window : duration));
}

/** Clamps `start` to [0, canvasEnd(duration) − window] (0 when the window covers the canvas). */
export function clampStart(start: Seconds, window: Seconds, duration: Seconds): Seconds {
  return clampTo(start, window, canvasEnd(duration));
}

/** Clamps `start` to [0, end − window]. */
function clampTo(start: Seconds, window: Seconds, end: Seconds): Seconds {
  const hi = Math.max(0, end - window);
  return Math.min(hi, Math.max(0, Number.isFinite(start) ? start : 0));
}

/** Slider position 0..1 (log scale) for a window. 0 = 2 s, 1 = the whole open canvas. */
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
 * A moved view is clamped to the piece, so near either end (and at Fit) the playhead moves across a
 * still view; a playhead resting past the end is followed out there. An unmoved view is only
 * clamped to the open canvas.
 */
export function followStart(
  mode: FollowMode,
  start: Seconds,
  t: Seconds,
  window: Seconds,
  duration: Seconds,
): Seconds {
  let s: Seconds;
  if (mode === 'smooth') s = t - SMOOTH_X * window;
  else if (mode === 'page' && (t >= start + PAGE_TURN_X * window || t < start)) {
    s = t - PAGE_LAND_X * window;
  } else return clampStart(start, window, duration);
  const end = t > duration ? Math.max(duration, s + window) : duration;
  return clampTo(s, window, end);
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
  const out = padExtent(lo, hi);
  extents.set(score, out);
  return out;
}

/** Samples inside a segment's part in a span, besides its ends (eases can overshoot). */
const SPAN_SAMPLES = 8;

/**
 * As `pitchExtent`, for the lines sounding in [start, end] only (a section of the piece: the
 * export's section, §12 rev 15): each segment's pitch over its part in the span, from its ends
 * and a few samples between. Falls back to `pitchExtent` when nothing sounds there.
 */
export function pitchExtentIn(
  score: CompiledScore,
  start: Seconds,
  end: Seconds,
): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of score.voices) {
    for (const s of v.segments) {
      if (s.t1 < start || s.t0 > end) continue;
      const a = Math.max(s.t0, start);
      const b = Math.min(s.t1, end);
      for (let i = 0; i <= SPAN_SAMPLES + 1; i++) {
        const p = evalSegment(s, a + ((b - a) * i) / (SPAN_SAMPLES + 1));
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
    }
  }
  return hi >= lo ? padExtent(lo, hi) : pitchExtent(score);
}

/** [lo, hi] padded by 1.5 semitones, at least 12 tall; A3–A5 when empty. */
function padExtent(lo: number, hi: number): [number, number] {
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
  return [lo, hi];
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

/** The plot keeps at least this share of the canvas height when the paddings would crowd it. */
export const MIN_PLOT_SHARE = 0.4;

/** HUD row spacing and type size, px (rows are 14 px apart, 10.5 px type). */
export const HUD_ROW = 14;

/** Bottom padding (px) that holds `rows` HUD rows and `extra` px below them. */
export function hudPad(rows: number, extra = 0): number {
  return 26 + HUD_ROW * (Math.max(1, rows) - 1) + extra;
}

/**
 * Top and bottom paddings (px) of a canvas `H` tall: ≥ 28 / ≥ 54 with the HUD (≥ 16 without), shrunk
 * proportionally on a short canvas so the plot keeps MIN_PLOT_SHARE of it (from ~137 px with the
 * HUD down): the plot height is always > 0 for H > 0. `hud` may be a row count (true = 3): more
 * than 3 rows, or `extra` px below them, grow the bottom band to fit.
 */
export function scorePads(
  H: number,
  hud: boolean | number = true,
  extra = 0,
): { padT: number; padB: number } {
  const h = H > 0 ? H : 0;
  const rows = hud === true ? 3 : hud === false ? 0 : hud;
  const padT = Math.max(28, h * 0.08);
  const padB =
    rows > 0 ? Math.max(54, h * 0.15, hudPad(rows, extra)) : Math.max(16, h * 0.05, extra);
  const room = h * (1 - MIN_PLOT_SHARE);
  if (padT + padB <= room) return { padT, padB };
  const k = room / (padT + padB);
  return { padT: padT * k, padB: padB * k };
}

/**
 * HUD text lines (14 px apart, 10.5 px type) that fit in a bottom padding `padB` px tall, at most
 * `rows` (today's HUD: 3).
 */
export function hudLines(padB: number, rows = 3): number {
  if (!(padB >= 16)) return 0;
  return Math.min(rows, Math.floor((padB - 16) / HUD_ROW) + 1);
}

/**
 * Resolves camera `cam` (window and start clamped to the piece; start kept with `free`) on a canvas of `size` CSS px, with
 * the playhead at time `t`. `hud` reserves room for the heads-up display at the bottom (a row
 * count, or true = 3), `extra` px more below it (`scorePads`).
 */
export function cameraAt(
  score: CameraScore,
  cam: CameraState,
  t: Seconds,
  size: { width: number; height: number },
  hud: boolean | number = true,
  extra = 0,
): View {
  const { width: W, height: H } = size;
  const D = Math.max(score.duration, 1e-6);
  const window = clampWindow(cam.window, D);
  const start =
    cam.free === true && Number.isFinite(cam.start) ? cam.start : clampStart(cam.start, window, D);
  const pps = W / window;
  const { padT, padB } = scorePads(H, hud, extra);
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
