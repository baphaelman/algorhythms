/**
 * The piece's camera (PLAN.md §15 M11.5 C3): the mode the Export dialog's Camera group writes,
 * and pure recipes for editing keys (add, move, delete, pan, zoom). Keys stay sorted by `at`;
 * a moved key stops `KEY_GAP` short of its neighbours, so its index (the selection) holds.
 */

import { autoCameraKeys, type AutoCameraOptions } from '../../render/auto-camera';
import { MIN_WINDOW } from '../../render/camera';
import type { CameraKey, CameraMode, CompiledScore, Piece, Seconds } from '../../core/types';

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

/** The piece with camera mode `mode` (its keys kept); the same piece when nothing changes. */
export function withCameraMode(piece: Piece, mode: CameraMode): Piece {
  if (piece.camera?.mode === mode) return piece;
  const keys = piece.camera?.keys;
  return { ...piece, camera: keys ? { mode, keys } : { mode } };
}

/** The piece in Keys mode with `keys`. */
export function withCameraKeys(piece: Piece, keys: readonly CameraKey[]): Piece {
  return { ...piece, camera: { mode: 'keys', keys: [...keys] } };
}

const NO_KEYS: readonly CameraKey[] = [];

/** The piece's own keys (none: one shared empty list, so a selector's value holds). */
export const keysOf = (piece: Pick<Piece, 'camera'>): readonly CameraKey[] =>
  piece.camera?.keys ?? NO_KEYS;

/** Index of the key within KEY_GAP of t, or −1. */
export function keyNear(keys: readonly CameraKey[], t: Seconds): number {
  return keys.findIndex((k) => Math.abs(k.at - t) < KEY_GAP);
}

/**
 * `key` added in time order. A key already within KEY_GAP of its time is replaced. Returns the
 * keys and the new key's index.
 */
export function addKey(
  keys: readonly CameraKey[],
  key: CameraKey,
): { keys: CameraKey[]; index: number } {
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
export function moveKey(keys: readonly CameraKey[], i: number, t: Seconds): CameraKey[] {
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
export const deleteKey = (keys: readonly CameraKey[], i: number): CameraKey[] =>
  keys.filter((_, j) => j !== i);

/** Key i with `fn` applied (the rest kept). */
export function updateKey(
  keys: readonly CameraKey[],
  i: number,
  fn: (k: CameraKey) => CameraKey,
): CameraKey[] {
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
