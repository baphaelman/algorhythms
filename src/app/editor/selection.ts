/**
 * Multi-select helpers (PLAN.md §11.3 "Select several with Shift-click or a marquee"): pure.
 * Shift- or ⌘/Ctrl-click toggles a moment; the lane's Shift-drag marquee and ⌘/Ctrl+A select
 * many. The piece key at 0:00 is never part of a marquee or select-all (it can't be moved,
 * copied or deleted).
 */

import type { MomentId, Piece } from '../../core/types';

/** `sel` with `id` added (at the end) or removed. */
export function toggleId(sel: readonly MomentId[], id: MomentId): MomentId[] {
  return sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
}

/** Every moment's id, in piece order (⌘/Ctrl+A). */
export function allMomentIds(piece: Piece): MomentId[] {
  return piece.moments.map((m) => m.id);
}

/** A rectangle in one coordinate space (client px). */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The rectangle spanned by two corners, in any order. */
export function rectOf(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    right: Math.max(x0, x1),
    bottom: Math.max(y0, y1),
  };
}

/** Ids of `boxes` that overlap `r` (touching edges count), in `boxes` order. */
export function idsInRect(boxes: readonly ({ id: MomentId } & Rect)[], r: Rect): MomentId[] {
  return boxes
    .filter((b) => b.right >= r.left && b.left <= r.right && b.bottom >= r.top && b.top <= r.bottom)
    .map((b) => b.id);
}

/** A marquee's result: `inside` alone, or added to `sel` (`extend`), without duplicates. */
export function marqueeSelection(
  sel: readonly MomentId[],
  inside: readonly MomentId[],
  extend: boolean,
): MomentId[] {
  return extend ? [...new Set([...sel, ...inside])] : [...inside];
}
