/**
 * The selected walk step (§11.3 Walk, §10 Drawing rules 7), shared by the inspector's Steps list
 * and the score's step dots. Cleared when the moment selection stops being that one walk.
 */

import { create } from 'zustand';
import { useEditor } from './history';
import type { StepRef } from './walk-steps';

export const useStepSelection = create<{ step: StepRef | null }>()(() => ({ step: null }));

export function selectStep(step: StepRef | null): void {
  useStepSelection.setState({ step });
}

useEditor.subscribe((s, prev) => {
  if (s.selection === prev.selection) return;
  const cur = useStepSelection.getState().step;
  if (cur && !(s.selection.length === 1 && s.selection[0] === cur.momentId)) selectStep(null);
});
