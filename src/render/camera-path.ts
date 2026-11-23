/**
 * The camera path (PLAN.md §15 M11.5): a piece's camera keys evaluated at a time. View-agnostic:
 * the result is seconds and pitches (a `CameraState`), so any view, of any size, draws it with
 * `drawScore`/`cameraAt` (video frames, the Export dialog's preview, the editor's playing view).
 *
 * Between keys each parameter is eased with the earlier key's ease: the window geometrically (a
 * zoom at an even speed), the playhead's place, the pitch centre and the range linearly. Before
 * the first key and after the last, that key's values hold (the view still moves with the
 * playhead). The start is t − place · window, so it may be below 0: blank paper before the
 * piece, with the first notes appearing at the playhead's place. Pure in t: no state between
 * frames, like Follow.
 */

import { bezierOf, ease, easeCodeOf } from '../core/ease';
import type { CameraKey, EaseRef, Piece, Seconds } from '../core/types';
import { MIN_WINDOW } from './camera';
import type { CameraState } from './types';

/** A key's ease when it names none. */
export const DEFAULT_KEY_EASE: EaseRef = 'smootherstep';

/** The camera parameters at a time (what a key holds, without its time and ease). */
export interface CameraPose {
  window: Seconds;
  place: number;
  pitch: number;
  range: number;
}

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);
const fin = (x: number, d: number) => (Number.isFinite(x) ? x : d);

/** A key's pose, sanitised: window ≥ MIN_WINDOW, place in 0..1, range ≥ 1 semitone. */
function poseOf(k: CameraKey): CameraPose {
  return {
    window: Math.max(MIN_WINDOW, fin(k.window, MIN_WINDOW)),
    place: clamp01(fin(k.place, 0.35)),
    pitch: fin(k.pitch, 69),
    range: Math.max(1, fin(k.range, 24)),
  };
}

/** Index of the last key with `at` ≤ t (−1 before the first); keys sorted by `at`. */
function keyBefore(keys: readonly CameraKey[], t: Seconds): number {
  let lo = 0;
  let hi = keys.length - 1;
  let out = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].at <= t) {
      out = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return out;
}

/**
 * The pose at time t: eased between the keys around t, held outside them. Keys must be sorted
 * by `at` (the schema checks); null when there are none.
 */
export function cameraPoseAt(keys: readonly CameraKey[], t: Seconds): CameraPose | null {
  if (keys.length === 0) return null;
  const i = keyBefore(keys, t);
  if (i < 0) return poseOf(keys[0]);
  if (i >= keys.length - 1) return poseOf(keys[keys.length - 1]);
  const k0 = keys[i];
  const k1 = keys[i + 1];
  const a = poseOf(k0);
  const b = poseOf(k1);
  const span = k1.at - k0.at;
  if (!(span > 0)) return b;
  if (t <= k0.at) return a;
  const ref = k0.ease ?? DEFAULT_KEY_EASE;
  const e = ease(easeCodeOf(ref), clamp01((t - k0.at) / span), bezierOf(ref));
  const lerp = (x: number, y: number) => x + (y - x) * e;
  return {
    window: Math.exp(lerp(Math.log(a.window), Math.log(b.window))),
    place: lerp(a.place, b.place),
    pitch: lerp(a.pitch, b.pitch),
    range: Math.max(1, lerp(a.range, b.range)),
  };
}

/** The camera of a pose with the playhead at t: start = t − place · window, may be < 0. */
export function cameraOfPose(pose: CameraPose, t: Seconds): CameraState {
  const half = pose.range / 2;
  return {
    start: t - pose.place * pose.window,
    window: pose.window,
    pitchRange: [pose.pitch - half, pose.pitch + half],
    free: true,
  };
}

/**
 * The camera at time t from a piece's keys (see the module comment); null without keys (the
 * caller falls back to Follow). `free` is set, so `cameraAt` keeps a start below 0.
 */
export function cameraPathAt(keys: readonly CameraKey[], t: Seconds): CameraState | null {
  const pose = cameraPoseAt(keys, t);
  return pose ? cameraOfPose(pose, t) : null;
}

/** A key from a camera seen at time t (the inverse of `cameraOfPose`; for editing in C3). */
export function keyOfCamera(
  cam: { start: Seconds; window: Seconds; pitchRange: [number, number] },
  t: Seconds,
  easeRef?: EaseRef,
): CameraKey {
  const [lo, hi] = cam.pitchRange;
  const k: CameraKey = {
    at: t,
    window: cam.window,
    place: (t - cam.start) / cam.window,
    pitch: (lo + hi) / 2,
    range: hi - lo,
  };
  if (easeRef !== undefined) k.ease = easeRef;
  return k;
}

/**
 * The keys a piece's camera path uses, or null when it has none to follow: no `camera`, mode
 * `follow`, or `keys` without keys. TODO(C2): `auto` makes keys from the piece; until then it
 * reads as Follow.
 */
export function pieceCameraKeys(piece: Pick<Piece, 'camera'>): readonly CameraKey[] | null {
  const c = piece.camera;
  if (!c || c.mode !== 'keys' || !c.keys || c.keys.length === 0) return null;
  return c.keys;
}
