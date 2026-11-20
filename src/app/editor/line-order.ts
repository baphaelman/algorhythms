/**
 * "Keep lines in order" (PLAN.md §11.3, revision 6): an editor preference, off by default, kept
 * in localStorage like the theme. It decides how new hand edits (dot drags, note points, chord
 * note edits) are written: a note's `order`, a frozen chord's `byVoice`. Auto-composed moves are
 * not affected.
 */

import { create } from 'zustand';

const KEY = 'algorhythms.keepOrder';

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export const useLineOrder = create<{ keep: boolean }>()(() => ({ keep: stored() }));

/** The current preference. */
export function keepOrder(): boolean {
  return useLineOrder.getState().keep;
}

/** Sets and persists the preference. */
export function setKeepOrder(keep: boolean): void {
  useLineOrder.setState({ keep });
  try {
    if (keep) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

/** The `order` field a hand-edited note gets: true, or absent (= false). */
export function noteOrder(keep: boolean = keepOrder()): true | undefined {
  return keep ? true : undefined;
}
