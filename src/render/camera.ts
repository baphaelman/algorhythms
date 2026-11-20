/**
 * Pure camera maths for the score view (PLAN.md §10): the follow camera, the overview, the
 * log-interpolated blend between them, vertical auto-fit, and time/pitch <-> pixel mapping.
 * Nothing here touches the DOM.
 */

import type { CompiledScore, Seconds } from '../core/types';
import type { CameraState, View } from './types';

/** Shortest visible window, seconds. */
export const MIN_WINDOW: Seconds = 2;
/** Default playhead position as a fraction of the width. */
export const DEFAULT_PLAYHEAD_X = 0.78;
/** The window fraction of the piece at which the follow camera starts blending into the overview. */
export const BLEND_START = 0.4;
/** Duration of the app's overview tween, in ms (the prototype's 2400). */
export const OVERVIEW_TWEEN_MS = 2400;

/** Smootherstep on [0, 1], clamped. The prototype's `ease`. */
export function smootherstep(x: number): number {
  return x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10);
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

/** Multiplies the window by `factor` (e.g. 1.25 for `−`, 0.8 for `=`, exp(deltaY·0.01) for wheel). */
export function zoomWindow(window: Seconds, factor: number, duration: Seconds): Seconds {
  return clampWindow(window * factor, duration);
}

/**
 * Overview tween: the value of the overview factor `elapsedMs` into a tween from `from` to `to`
 * (smootherstep over `OVERVIEW_TWEEN_MS`; instant when `reducedMotion`).
 */
export function easeOverview(
  from: number,
  to: number,
  elapsedMs: number,
  reducedMotion = false,
): number {
  const k = reducedMotion ? 1 : Math.min(1, Math.max(0, elapsedMs / OVERVIEW_TWEEN_MS));
  return from + (to - from) * smootherstep(k);
}

/**
 * The blend (0 follow .. 1 overview) the window alone asks for: 0 until the window reaches 40 % of
 * the piece, then a smootherstep on the log of the window up to 1 at the whole piece.
 */
export function windowBlend(window: Seconds, duration: Seconds): number {
  const hi = Math.log(duration);
  const lo = Math.log(duration * BLEND_START);
  if (!(hi > lo)) return 1;
  return smootherstep((Math.log(window) - lo) / (hi - lo));
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
 * Resolves the camera for time `t` on a canvas of `size` CSS px. In follow mode the playhead sits
 * at `playheadX` (78 %) and the window is `cam.window` seconds wide. As the window nears the whole
 * piece, or `cam.overview` rises, pixels-per-second is interpolated on a log scale and the anchor
 * x linearly, until the whole piece fits between the side paddings (the prototype's formula).
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
  const win = clampWindow(cam.window, D);
  const padT = Math.max(28, H * 0.08);
  const padB = hud ? Math.max(54, H * 0.15) : Math.max(16, H * 0.05);
  const padL = Math.max(16, W * 0.025);
  const padR = padL;

  const ppsF = W / win;
  const xF = W * (cam.playheadX ?? DEFAULT_PLAYHEAD_X);
  const ppsO = Math.max(1e-9, (W - padL - padR) / D);
  const blend = Math.min(1, Math.max(cam.overview || 0, windowBlend(win, D)));

  const pps = Math.exp(Math.log(ppsF) + (Math.log(ppsO) - Math.log(ppsF)) * blend);
  const pan = (cam.pan ?? 0) * (1 - blend);
  const tc = Math.min(D, Math.max(0, t + pan));
  // The view centre tc sits where the playhead would with no pan; the playhead moves instead.
  const xAnchor = xF + (padL + tc * ppsO - xF) * blend;
  const xHead = xAnchor + (t - tc) * pps;
  const [pLo, pHi] = cam.pitchRange ?? score.pitchRange;
  return {
    width: W,
    height: H,
    t,
    tc,
    xAnchor,
    xHead,
    pps,
    tL: tc - xAnchor / pps,
    tR: tc + (W - xAnchor) / pps,
    blend,
    pLo,
    pHi,
    padT,
    padB,
    padL,
    padR,
    duration: D,
  };
}

/** x (px) of time `time`. */
export function timeToX(view: View, time: Seconds): number {
  return view.xAnchor + (time - view.tc) * view.pps;
}

/** Time at x (px); inverse of `timeToX`. */
export function xToTime(view: View, x: number): Seconds {
  return view.tc + (x - view.xAnchor) / view.pps;
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
