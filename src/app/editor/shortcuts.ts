/**
 * The moment palette's entries and the editor's global keys (PLAN.md §11.3): the ten letters add a
 * moment at the playhead, Delete/Backspace delete the selection, Escape clears it.
 */

import type { MomentId, MomentType, Seconds } from '../../core/types';
import { currentTime, usePlayer } from '../store';
import { addMoment, deleteMoments } from './actions';
import { select, useEditor } from './history';

export interface PaletteEntry {
  type: MomentType;
  /** Shortcut letter, upper case for display. */
  key: string;
  /** Short name on the button. */
  name: string;
  /** Glyph shown before the name. */
  icon: string;
  /** Tooltip text (without the shortcut). */
  hint: string;
}

export const PALETTE: readonly PaletteEntry[] = [
  { type: 'chord', key: 'C', name: 'chord', icon: '◆', hint: 'Glide to a chord' },
  { type: 'unison', key: 'U', name: 'unison', icon: '◇', hint: 'Converge on one pitch' },
  { type: 'split', key: 'S', name: 'split', icon: '⑂', hint: 'Bring in more voices' },
  { type: 'merge', key: 'M', name: 'merge', icon: '⋎', hint: 'Fold voices together' },
  { type: 'shift', key: 'T', name: 'shift', icon: '⇅', hint: 'Transpose by scale steps' },
  { type: 'spread', key: 'P', name: 'spread', icon: '⇔', hint: 'Widen or narrow the spacing' },
  { type: 'walk', key: 'W', name: 'walk', icon: '▭', hint: 'Random steps over a region' },
  { type: 'pin', key: 'I', name: 'pin', icon: '⊙', hint: 'Move one voice' },
  { type: 'key', key: 'K', name: 'key', icon: '♯', hint: 'Change key or scale' },
  { type: 'level', key: 'L', name: 'level', icon: '◢', hint: 'Fade voices' },
];

const BY_KEY: ReadonlyMap<string, MomentType> = new Map(
  PALETTE.map((e) => [e.key.toLowerCase(), e.type]),
);

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & {
  repeat?: boolean;
};

/** The moment type a key press adds, or null (any modifier or an auto-repeat disqualifies it). */
export function momentTypeForKey(e: KeyLike): MomentType | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return null;
  return BY_KEY.get(e.key.toLowerCase()) ?? null;
}

/** `t` rounded to the nearest beat of a `bpm` grid; unchanged with no grid. Never below 0. */
export function snapToGrid(t: Seconds, bpm?: number): Seconds {
  const s = Math.max(0, t);
  if (!bpm || !(bpm > 0)) return s;
  const beat = 60 / bpm;
  return Math.round(s / beat) * beat;
}

/** Adds a default `type` moment at the playhead (snapped to the piece's grid) and selects it. */
export function addAtPlayhead(type: MomentType): MomentId {
  return addMoment(type, snapToGrid(currentTime(), usePlayer.getState().piece.view.gridBpm));
}

/** Deletes the selected moments; false if nothing was selected. */
export function deleteSelection(): boolean {
  const sel = useEditor.getState().selection;
  return sel.length > 0 && deleteMoments(sel);
}

/** What an editor key does. */
export type EditorKey = { kind: 'add'; type: MomentType } | { kind: 'delete' } | { kind: 'escape' };

/** Input types that take no typed text, so letters and Delete stay global there. */
const NON_TEXT_INPUTS = new Set([
  'range',
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'color',
]);

/** True if `target` takes typed text (letters, Delete, Escape) itself. Duck-typed for tests. */
export function takesText(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown; type?: unknown };
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
  if (tag === 'textarea' || tag === 'select') return true;
  return tag === 'input' && !NON_TEXT_INPUTS.has(String(el.type));
}

/**
 * The editor action for a keydown, or null. Ignored in text fields, with ⌘/Ctrl/Alt held (Shift
 * too for letters), and on auto-repeat for letters. Dialog and layout checks are the caller's.
 */
export function editorKey(e: KeyLike & { target?: unknown }): EditorKey | null {
  if (takesText(e.target)) return null;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    return e.metaKey || e.ctrlKey || e.altKey ? null : { kind: 'delete' };
  }
  if (e.key === 'Escape') return e.metaKey || e.ctrlKey || e.altKey ? null : { kind: 'escape' };
  const type = momentTypeForKey(e);
  return type ? { kind: 'add', type } : null;
}

/** Clears the selection; false if it was already empty. */
export function clearSelection(): boolean {
  if (useEditor.getState().selection.length === 0) return false;
  select([]);
  return true;
}
