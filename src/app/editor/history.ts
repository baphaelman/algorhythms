/**
 * Undo history and selection for the editor (PLAN.md §11.3a, §11.4).
 *
 * The history holds immutable piece snapshots (recipes return new objects and share the rest),
 * capped at `HISTORY_CAP` entries and cleared by `loadPiece`. Every committed edit goes through
 * `edit` (one entry) or a gesture (one entry for a whole drag). Each entry also keeps the
 * selection of its side, so undo and redo restore it. Selection is pruned whenever the piece
 * changes, so it never names a moment that is gone.
 *
 * `useEditor` is reactive for the UI (selection, canUndo/canRedo and labels); the piece itself
 * lives in the player store (`usePlayer`).
 */

import { create } from 'zustand';
import type { MomentId, Piece } from '../../core/types';
import { onLoadPiece, setPiece, usePlayer } from '../store';

/** Maximum number of undo entries. */
export const HISTORY_CAP = 200;

/** A pure piece transform. Return the same object to mean "no change". */
export type Recipe = (piece: Piece) => Piece;

export interface EditorState {
  /** Selected moment ids, in selection order. */
  selection: MomentId[];
  canUndo: boolean;
  canRedo: boolean;
  /** Label of the edit `undo` would revert ('' when none). */
  undoLabel: string;
  /** Label of the edit `redo` would re-apply ('' when none). */
  redoLabel: string;
}

/** Reactive editor state: `useEditor(selector)` in components, `useEditor.getState()` elsewhere. */
export const useEditor = create<EditorState>()(() => ({
  selection: [],
  canUndo: false,
  canRedo: false,
  undoLabel: '',
  redoLabel: '',
}));

interface Entry {
  /** The piece before the edit (in `past`) or after it (in `future`). */
  piece: Piece;
  label: string;
  /** The selection at that side of the edit. */
  selection: MomentId[];
}

let past: Entry[] = [];
let future: Entry[] = [];
let gesture: { start: Piece; label: string; selection: MomentId[] } | null = null;

const piece = (): Piece => usePlayer.getState().piece;
const selection = (): MomentId[] => useEditor.getState().selection;

function publish(): void {
  useEditor.setState({
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    undoLabel: past.at(-1)?.label ?? '',
    redoLabel: future.at(-1)?.label ?? '',
  });
}

function push(before: Piece, label: string, sel: MomentId[]): void {
  past.push({ piece: before, label, selection: sel });
  if (past.length > HISTORY_CAP) past.splice(0, past.length - HISTORY_CAP);
  future = [];
  publish();
}

/**
 * Applies `recipe` to the current piece as one undo entry, then `setPiece`. Returns false (and
 * records nothing) when the recipe returns the piece unchanged. Ends an open gesture first.
 */
export function edit(recipe: Recipe, label = 'Edit'): boolean {
  if (gesture) endGesture();
  const before = piece();
  const after = recipe(before);
  if (after === before) return false;
  push(before, label, selection());
  setPiece(after);
  return true;
}

/** Starts a drag-like gesture: later `updateGesture` calls replace each other; one entry at the end. */
export function beginGesture(label = 'Edit'): void {
  if (gesture) endGesture();
  gesture = { start: piece(), label, selection: selection() };
}

/** True while a gesture is open. */
export function inGesture(): boolean {
  return gesture !== null;
}

/**
 * Applies `recipe` to the piece as it was at `beginGesture` (so it receives the gesture's
 * cumulative change, e.g. the total drag offset) and shows the result. No history entry. Call it
 * at most once per animation frame (§11.3a). Without an open gesture it acts like `edit`.
 */
export function updateGesture(recipe: Recipe): void {
  if (!gesture) {
    edit(recipe);
    return;
  }
  const next = recipe(gesture.start);
  if (next !== piece()) setPiece(next);
}

/** Closes the gesture: one undo entry if the piece changed. */
export function endGesture(): void {
  if (!gesture) return;
  const { start, label, selection: sel } = gesture;
  gesture = null;
  if (piece() !== start) push(start, label, sel);
}

/** Abandons the gesture and restores the piece as it was at `beginGesture`. */
export function cancelGesture(): void {
  if (!gesture) return;
  const { start } = gesture;
  gesture = null;
  if (piece() !== start) setPiece(start);
}

/** Reverts the last edit. During a gesture, cancels the gesture instead. */
export function undo(): boolean {
  if (gesture) {
    cancelGesture();
    return true;
  }
  const e = past.pop();
  if (!e) return false;
  future.push({ piece: piece(), label: e.label, selection: selection() });
  publish();
  setPiece(e.piece);
  select(e.selection);
  return true;
}

/** Re-applies the last undone edit. */
export function redo(): boolean {
  if (gesture) endGesture();
  const e = future.pop();
  if (!e) return false;
  past.push({ piece: piece(), label: e.label, selection: selection() });
  publish();
  setPiece(e.piece);
  select(e.selection);
  return true;
}

/** Forgets every entry and any open gesture (called on `loadPiece`). */
export function resetHistory(): void {
  past = [];
  future = [];
  gesture = null;
  publish();
}

/** Replaces the selection (ids not in the piece are dropped; duplicates removed). */
export function select(ids: readonly MomentId[]): void {
  const present = new Set(piece().moments.map((m) => m.id));
  const next = [...new Set(ids)].filter((id) => present.has(id));
  const cur = useEditor.getState().selection;
  if (next.length === cur.length && next.every((id, i) => id === cur[i])) return;
  useEditor.setState({ selection: next });
}

onLoadPiece(resetHistory);

// Prune the selection whenever the piece changes (delete, undo, redo, load).
usePlayer.subscribe((s, prev) => {
  if (s.piece === prev.piece) return;
  const sel = useEditor.getState().selection;
  if (sel.length > 0) select(sel);
});
