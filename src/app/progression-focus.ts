/**
 * The progression chord the inspector points at (owner notes 2026-11-22): the row being changed or
 * hovered. The lane bar highlights that chord's span.
 */

import { create } from 'zustand';
import type { MomentId } from '../core/types';

export interface ProgressionFocus {
  /** The progression, or null for none. */
  id: MomentId | null;
  /** Chord index (−1: none). */
  k: number;
}

export const useProgressionFocus = create<ProgressionFocus>()(() => ({ id: null, k: -1 }));

/** Points at chord `k` of progression `id` (null or k < 0: none). */
export function setProgressionFocus(id: MomentId | null, k = -1): void {
  const next = id !== null && k >= 0 ? { id, k } : { id: null, k: -1 };
  const cur = useProgressionFocus.getState();
  if (cur.id !== next.id || cur.k !== next.k) useProgressionFocus.setState(next);
}
