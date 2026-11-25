/**
 * A switch's details in the poster workspace's right panel (PLAN.md §15 M14, the owner's notes:
 * "dropdown on toggle"): a switch whose thing has a style opens that group's style controls in
 * place. Which details are open is remembered per viewer (localStorage).
 */

import { create } from 'zustand';
import type { PosterGroup } from '../core/types';

/** The details a switch opens: its id (test ids, the remembered list) and the groups it styles. */
export interface DetailsSpec {
  id: string;
  /** What the disclosure's label names ("Pulse marks: style"). */
  name: string;
  groups: readonly PosterGroup[];
}

export const DETAILS = {
  sectionLabels: { id: 'sectionLabels', name: 'Section labels', groups: ['sectionLabels'] },
  sectionLines: { id: 'sectionLines', name: 'Section lines', groups: ['sectionLines'] },
  momentLabels: { id: 'momentLabels', name: 'Moment labels', groups: ['momentLabels'] },
  momentLines: { id: 'momentLines', name: 'Moment lines', groups: ['momentLines'] },
  guideLabels: { id: 'guideLabels', name: 'Hz labels', groups: ['guideLabels'] },
  guideLines: { id: 'guideLines', name: 'Octave guides', groups: ['guideLines'] },
  beatLines: { id: 'beatLines', name: 'Beat lines', groups: ['beatLines'] },
  pulseMarks: { id: 'pulseMarks', name: 'Pulse marks', groups: ['pulseMarks'] },
  pitchGuides: { id: 'pitchGuides', name: 'Guide notes', groups: ['pitchLines', 'pitchLabels'] },
  hud: { id: 'hud', name: 'HUD readouts', groups: ['hud'] },
  rowNames: { id: 'rowNames', name: 'Row labels', groups: ['rowNames'] },
  rowLabels: { id: 'rowLabels', name: 'Row times', groups: ['rowLabels'] },
} as const satisfies Record<string, DetailsSpec>;

export type DetailsId = keyof typeof DETAILS;

const KEY = 'algorhythms.posterDetails';

/** The remembered open list: known ids only, each once. */
export function parseOpenDetails(raw: string | null): DetailsId[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: DetailsId[] = [];
    for (const x of v) {
      if (typeof x === 'string' && x in DETAILS && !out.includes(x as DetailsId)) {
        out.push(x as DetailsId);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** `open` with `id` switched. */
export const toggledDetails = (open: readonly DetailsId[], id: DetailsId): DetailsId[] =>
  open.includes(id) ? open.filter((x) => x !== id) : [...open, id];

function load(): DetailsId[] {
  try {
    return parseOpenDetails(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

export const useDetails = create<{ open: DetailsId[] }>()(() => ({ open: load() }));

/** Opens or closes a switch's details (remembered). */
export function toggleDetails(id: DetailsId): void {
  const open = toggledDetails(useDetails.getState().open, id);
  useDetails.setState({ open });
  try {
    localStorage.setItem(KEY, JSON.stringify(open));
  } catch {
    // Not remembered (private mode, blocked storage): still open for this visit.
  }
}
