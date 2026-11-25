/**
 * Which export surface is showing (PLAN.md §15 M14 "Entry"): the poster workspace (in place of
 * the editor), the video dialog (until M15) or the audio dialog. Menu → Export opens the
 * workspace's mode used last (Poster or Video), remembered per viewer. A standalone store, so
 * the editor's key handlers can ask `posterShown()` without importing the export UI.
 */

import { create } from 'zustand';

export type ExportMode = 'poster' | 'video';
export type ExportSurface = ExportMode | 'audio';

export const EXPORT_MODE_KEY = 'algorhythms.exportMode';

export const EXPORT_MODES: readonly { id: ExportMode; label: string }[] = [
  { id: 'poster', label: 'Poster' },
  { id: 'video', label: 'Video' },
];

/** Storage as the mode uses it (localStorage, or a stub in tests). */
export type ModeStorage = Pick<Storage, 'getItem' | 'setItem'>;

const storageOf = (s?: ModeStorage | null): ModeStorage | null =>
  s !== undefined ? s : (globalThis.localStorage ?? null);

/** The mode used last; Poster when none is stored, it is invalid or storage throws. */
export function loadExportMode(storage?: ModeStorage | null): ExportMode {
  try {
    const v = storageOf(storage)?.getItem(EXPORT_MODE_KEY);
    return v === 'video' ? 'video' : 'poster';
  } catch {
    return 'poster';
  }
}

/** Remembers the mode; false when storage is missing or throws. */
export function saveExportMode(mode: ExportMode, storage?: ModeStorage | null): boolean {
  try {
    const st = storageOf(storage);
    if (!st) return false;
    st.setItem(EXPORT_MODE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

export const useExportSurface = create<{ surface: ExportSurface | null }>()(() => ({
  surface: null,
}));

/** The poster workspace is showing (the editor's keys stand down). */
export function posterShown(): boolean {
  return useExportSurface.getState().surface === 'poster';
}

/** Something a key event's target may be (DOM-free, for tests). */
interface KeyTarget {
  tagName?: string;
  isContentEditable?: boolean;
}

/**
 * What Escape does in the workspace: 'leave' (back to music) when nothing is focused or
 * selected, 'blur' when a control has focus (a second Escape then leaves), else nothing (a
 * selection is P3's to clear; a key already used, e.g. by the menu or a text field, is not ours).
 */
export function workspaceEscape(e: {
  key: string;
  defaultPrevented: boolean;
  /** document.activeElement, or null. */
  focused: KeyTarget | null;
  /** The workspace's own root (focusing it counts as nothing focused). */
  root: unknown;
  /** P3: an object on the artboard is selected. */
  selected: boolean;
  /** A modal dialog is open. */
  dialog: boolean;
}): 'leave' | 'blur' | null {
  if (e.key !== 'Escape' || e.defaultPrevented || e.dialog || e.selected) return null;
  const f = e.focused;
  const tag = f?.tagName?.toLowerCase();
  if (!f || f === e.root || tag === 'body' || tag === 'html') return 'leave';
  return 'blur';
}
