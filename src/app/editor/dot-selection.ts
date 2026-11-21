/**
 * Selected dots on the score (PLAN.md §11.3 revision 7 "Score selection"): click, Shift-click and
 * the marquee pick arrival dots; dragging one of them moves them all. The entries are snapshots;
 * `pickedIn` finds them among a moment's current dots (by place, else by step or voice), so a
 * selection survives recompiles and its own drags. Moments whose dots are selected are selected
 * too; dots of a moment that leaves the moment selection no longer count (`currentDots`).
 */

import { create } from 'zustand';
import type { MomentId } from '../../core/types';
import type { ArrivalDot } from './arrival-points';
import { select, useEditor } from './history';
import { sameStep } from './walk-steps';

export const useDotSelection = create<{ dots: readonly ArrivalDot[] }>()(() => ({ dots: [] }));

/** A dot within these of a selected one (s, semitones), in the same moment, is that dot. */
const NEAR_T = 0.02;
const NEAR_P = 0.25;

/** True if current dot `d` is selected entry `s`. */
export function isDot(s: ArrivalDot, d: ArrivalDot): boolean {
  if (s.momentId !== d.momentId) return false;
  if (Math.abs(s.t - d.t) < NEAR_T && Math.abs(s.pitch - d.pitch) < NEAR_P) return true;
  if (s.step || d.step) return sameStep(s.step ?? null, d.step ?? null);
  // Tune dots share one line: the note index tells them apart.
  if (s.note !== undefined || d.note !== undefined) return s.note === d.note;
  return s.voice !== undefined && s.voice === d.voice;
}

/** For each of `dots`, whether `sel` selects it (each entry picks at most one dot, the first). */
export function pickedIn(sel: readonly ArrivalDot[], dots: readonly ArrivalDot[]): boolean[] {
  const out = dots.map(() => false);
  for (const s of sel) {
    // Place first, then identity.
    let i = dots.findIndex(
      (d, j) =>
        !out[j] &&
        d.momentId === s.momentId &&
        Math.abs(s.t - d.t) < NEAR_T &&
        Math.abs(s.pitch - d.pitch) < NEAR_P,
    );
    if (i < 0) i = dots.findIndex((d, j) => !out[j] && isDot(s, d));
    if (i >= 0) out[i] = true;
  }
  return out;
}

/** The selected dots whose moments are still selected. */
export function currentDots(): ArrivalDot[] {
  const ids = new Set(useEditor.getState().selection);
  return useDotSelection.getState().dots.filter((d) => ids.has(d.momentId));
}

/** Unique moment ids of `dots`, in order. */
export function momentsOf(dots: readonly ArrivalDot[]): MomentId[] {
  return [...new Set(dots.map((d) => d.momentId))];
}

/**
 * Selects `dots` (replacing the dot selection) and their moments; `extend` keeps the moments
 * already selected.
 */
export function selectDots(dots: readonly ArrivalDot[], extend = false): void {
  const ids = momentsOf(dots);
  select(extend ? [...useEditor.getState().selection, ...ids] : ids);
  useDotSelection.setState({ dots: [...dots] });
}

/** Shift-click: adds `d` to the dot selection, or removes it; its moment stays selected. */
export function toggleDot(d: ArrivalDot): void {
  const cur = currentDots();
  const i = cur.findIndex((s) => isDot(s, d));
  const next = i >= 0 ? cur.filter((_, j) => j !== i) : [...cur, d];
  select([...useEditor.getState().selection, d.momentId]);
  useDotSelection.setState({ dots: next });
}

/** Clears the dot selection; false if it was empty. */
export function clearDots(): boolean {
  if (useDotSelection.getState().dots.length === 0) return false;
  useDotSelection.setState({ dots: [] });
  return true;
}
