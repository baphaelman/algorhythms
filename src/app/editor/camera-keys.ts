/**
 * The piece's camera (PLAN.md §15 M11.5 C3): the mode the Export dialog's Camera group writes,
 * and pure recipes for editing keys (add, move, delete, pan, zoom). Keys stay sorted by `at`;
 * a moved key stops `KEY_GAP` short of its neighbours, so its index (the selection) holds.
 */

import { autoCameraKeys, type AutoCameraOptions } from '../../render/auto-camera';
import { MIN_WINDOW } from '../../render/camera';
import type {
  CameraFrame,
  CameraKey,
  CameraMode,
  CompiledScore,
  Piece,
  PieceCamera,
  PosterCameraKey,
  RowBreak,
  Seconds,
} from '../../core/types';

/** Closest two keys may be, s. */
export const KEY_GAP: Seconds = 0.05;
/** Widest window and pitch range a key may hold. */
export const MAX_KEY_WINDOW: Seconds = 3600;
export const MAX_KEY_RANGE = 128;

/** The auto camera's keys (`autoCameraKeys`, memoised per score; the editor asks every frame). */
export const autoKeysOf = (
  compiled: CompiledScore,
  opts?: AutoCameraOptions,
): readonly CameraKey[] => autoCameraKeys(compiled, opts);

/** The piece's camera mode; a piece without one is Auto (owner, 2026-11-23). */
export const cameraModeOf = (piece: Pick<Piece, 'camera'>): CameraMode =>
  piece.camera?.mode ?? 'auto';

/** The keys the piece's camera follows (Keys: its own; Auto: the auto keys); null = Follow. */
export function viewKeysOf(
  piece: Pick<Piece, 'camera'>,
  compiled: CompiledScore,
): readonly CameraKey[] | null {
  const mode = cameraModeOf(piece);
  if (mode === 'follow') return null;
  const keys = mode === 'keys' ? piece.camera?.keys : autoKeysOf(compiled);
  return keys && keys.length > 0 ? keys : null;
}

/** The piece's camera with `p` over it (mode Auto when it had none). */
function cameraWith(piece: Piece, p: Partial<PieceCamera>): Piece {
  return { ...piece, camera: { mode: 'auto', ...piece.camera, ...p } };
}

/**
 * The piece with camera mode `mode` (its keys, frame and row break kept); the same piece when
 * nothing changes.
 */
export function withCameraMode(piece: Piece, mode: CameraMode): Piece {
  if (piece.camera?.mode === mode) return piece;
  return cameraWith(piece, { mode });
}

/** The piece in Keys mode with One row's `keys`. */
export function withCameraKeys(piece: Piece, keys: readonly CameraKey[]): Piece {
  return cameraWith(piece, { mode: 'keys', keys: [...keys] });
}

/** The piece in Keys mode with Over the poster's `keys` (M15). */
export function withPosterKeys(piece: Piece, keys: readonly PosterCameraKey[]): Piece {
  return cameraWith(piece, { mode: 'keys', posterKeys: [...keys] });
}

/** The piece's video frame set (M15: Over the poster or One row). */
export function withCameraFrame(piece: Piece, frame: CameraFrame): Piece {
  if (piece.camera?.frame === frame) return piece;
  return cameraWith(piece, { frame });
}

/** The piece's row break set (M15, Over the poster). */
export function withRowBreak(piece: Piece, rowBreak: RowBreak): Piece {
  if (piece.camera?.rowBreak === rowBreak) return piece;
  return cameraWith(piece, { rowBreak });
}

const NO_KEYS: readonly CameraKey[] = [];
const NO_POSTER_KEYS: readonly PosterCameraKey[] = [];

/** The piece's own keys (none: one shared empty list, so a selector's value holds). */
export const keysOf = (piece: Pick<Piece, 'camera'>): readonly CameraKey[] =>
  piece.camera?.keys ?? NO_KEYS;

/** Over the poster's keys (M15; none: one shared empty list). */
export const posterKeysOf = (piece: Pick<Piece, 'camera'>): readonly PosterCameraKey[] =>
  piece.camera?.posterKeys ?? NO_POSTER_KEYS;

/** Smallest and largest frame height a poster key may hold, fractions of the artboard. */
export const POSTER_KEY_MIN_H = 0.02;
export const POSTER_KEY_MAX_H = 4;

/**
 * An Over-the-poster key's frame dragged by (dx, dy), fractions of the frame's width and height:
 * the paper follows the pointer, so the frame moves the other way. `artAspect` is the artboard's
 * width / height, `videoAspect` the frame's.
 */
export function panPosterKey(
  k: PosterCameraKey,
  dx: number,
  dy: number,
  artAspect: number,
  videoAspect: number,
): PosterCameraKey {
  const fw = (k.h * videoAspect) / artAspect;
  return { ...k, x: k.x - dx * fw, y: k.y - dy * k.h };
}

/** An Over-the-poster key zoomed by `factor` (> 1 shows more of the poster). */
export function zoomPosterKey(k: PosterCameraKey, factor: number): PosterCameraKey {
  if (!(factor > 0)) return k;
  return { ...k, h: Math.min(POSTER_KEY_MAX_H, Math.max(POSTER_KEY_MIN_H, k.h * factor)) };
}

/** Index of the key within KEY_GAP of t, or −1. */
export function keyNear(keys: readonly { at: Seconds }[], t: Seconds): number {
  return keys.findIndex((k) => Math.abs(k.at - t) < KEY_GAP);
}

/**
 * `key` added in time order. A key already within KEY_GAP of its time is replaced. Returns the
 * keys and the new key's index.
 */
export function addKey<K extends { at: Seconds }>(
  keys: readonly K[],
  key: K,
): { keys: K[]; index: number } {
  const k = { ...key, at: Math.max(0, key.at) };
  const near = keyNear(keys, k.at);
  if (near >= 0) {
    const out = [...keys];
    out[near] = { ...k, at: keys[near].at };
    return { keys: out, index: near };
  }
  const index = keys.findIndex((x) => x.at > k.at);
  const at = index < 0 ? keys.length : index;
  return { keys: [...keys.slice(0, at), k, ...keys.slice(at)], index: at };
}

/** Key i moved to time t (≥ 0), stopping KEY_GAP short of its neighbours. */
export function moveKey<K extends { at: Seconds }>(keys: readonly K[], i: number, t: Seconds): K[] {
  const k = keys[i];
  if (!k) return [...keys];
  const lo = i > 0 ? keys[i - 1].at + KEY_GAP : 0;
  const hi = i < keys.length - 1 ? keys[i + 1].at - KEY_GAP : Infinity;
  const at = Math.min(Math.max(t, lo), Math.max(lo, hi));
  const out = [...keys];
  out[i] = { ...k, at };
  return out;
}

/** Keys without key i. */
export const deleteKey = <K>(keys: readonly K[], i: number): K[] => keys.filter((_, j) => j !== i);

/** Key i with `fn` applied (the rest kept). */
export function updateKey<K>(keys: readonly K[], i: number, fn: (k: K) => K): K[] {
  if (!keys[i]) return [...keys];
  const out = [...keys];
  out[i] = fn(keys[i]);
  return out;
}

/**
 * A key's view dragged by (dx, dy), as fractions of the frame's width and height: the paper
 * follows the pointer, so right moves the playhead's place right and down raises the pitch
 * centre (the lines move down).
 */
export function panKey(k: CameraKey, dx: number, dy: number): CameraKey {
  const place = Math.min(1, Math.max(0, k.place + dx));
  return { ...k, place, pitch: k.pitch + dy * k.range };
}

/** A key zoomed by `factor` (> 1 shows more): its window, or with `range` its pitch range. */
export function zoomKey(k: CameraKey, factor: number, what: 'window' | 'range'): CameraKey {
  if (!(factor > 0)) return k;
  if (what === 'range') {
    return { ...k, range: Math.min(MAX_KEY_RANGE, Math.max(1, k.range * factor)) };
  }
  return { ...k, window: Math.min(MAX_KEY_WINDOW, Math.max(MIN_WINDOW, k.window * factor)) };
}

/** A focused key marker's keys: arrows move it (1 s; Shift 10 s; Alt 0.1 s). */
export function keyStep(key: string, mods: { shift: boolean; alt: boolean }): number | null {
  const d = mods.alt ? 0.1 : mods.shift ? 10 : 1;
  if (key === 'ArrowLeft') return -d;
  if (key === 'ArrowRight') return d;
  return null;
}
