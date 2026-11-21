/**
 * Shift-drag feedback (PLAN.md §11.3 "Shift-drag moves by octaves"): guide lines at each octave of
 * the start pitch and a label ("+1 oct") at the dragged dot, at (`t`, `pitch`). The dot and note
 * point drags write it; the dots overlay draws it each frame, so no React render sits on the
 * pointer path.
 */

import type { Pitch, Seconds } from '../core/types';
import { octaveLabel } from './editor/octave-drag';

export const octaveGuide = {
  on: false,
  guides: [] as readonly Pitch[],
  label: '',
  t: 0 as Seconds,
  pitch: 0 as Pitch,
};

/** Shows the feedback: `k` octaves, the dot at (`t`, `pitch`), guide lines at `guides`. */
export function showOctaves(k: number, t: Seconds, pitch: Pitch, guides: readonly Pitch[]): void {
  octaveGuide.on = true;
  octaveGuide.label = octaveLabel(k);
  octaveGuide.t = t;
  octaveGuide.pitch = pitch;
  octaveGuide.guides = guides;
}

export function hideOctaves(): void {
  octaveGuide.on = false;
}
