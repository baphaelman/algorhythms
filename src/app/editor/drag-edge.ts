/**
 * Dragging a dot past the view's edge (PLAN.md §11.3 revision 7): the pitch follows the pointer
 * up to the edge of the plot area and stays there (no jump), and it is kept inside the voice's
 * range so the compiler never folds it by an octave (§7.8). The view's pitch range is held for
 * the drag (`camera.pitch`), so it cannot re-fit under the pointer. Pure.
 */

import type { Pitch } from '../../core/types';
import { yToPitch, type View } from '../../render';

/** The pitch at `y` px, with `y` clamped to the plot area [padT, height − padB]. */
export function edgePitch(view: View, y: number): Pitch {
  const lo = view.padT;
  const hi = view.height - view.padB;
  return yToPitch(view, Math.min(hi, Math.max(lo, y)));
}

/** `p` clamped to `range` ([low, high]; absent: MIDI 0..127). */
export function inRange(p: Pitch, range?: readonly [number, number]): Pitch {
  const [lo, hi] = range ?? [0, 127];
  return Math.min(Math.max(lo, hi), Math.max(Math.min(lo, hi), p));
}
