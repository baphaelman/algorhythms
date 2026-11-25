/**
 * ⌘/Ctrl+C, X, V and A in the editor (PLAN.md §11.3 "Select several …; copy and paste").
 *
 * Copy and cut put the selected moments on the system clipboard as JSON text (./editor/clipboard)
 * through the `copy`/`cut` event, and keep the same text in the page (the in-app fallback). Paste
 * reads the `paste` event's text: a clip pastes at the playhead (snapped to a beat when Snap to
 * beats is on), with new ids, selected, as one undo entry; other text is ignored. When a browser
 * fires no clipboard event for the shortcut (nothing selected on the page, in some engines), the
 * key handler falls back after the event would have come: copy writes `navigator.clipboard` when
 * it may, paste uses the in-app clip. Text fields, a text selection on the page and open dialogs
 * keep the native behaviour. ⌘/Ctrl+A selects every moment (not the piece key).
 */

import { clipOfSelection, cutMoments, pasteClipAt } from './editor/actions';
import { clipText, parseClip } from './editor/clipboard';
import { select, useEditor } from './editor/history';
import { allMomentIds } from './editor/selection';
import { playheadTime, takesText } from './editor/shortcuts';
import { announce, momentsText } from './announce';
import { usePlayer } from './store';
import { workspaceShown } from './export-surface';

/** The last copied clip's text: pasted when the system clipboard gives nothing. */
let inApp: string | null = null;
/** A shortcut waiting for its clipboard event (cleared by the event, else the fallback runs). */
let expect: 'copy' | 'cut' | 'paste' | null = null;

/** The in-app clip's text (tests). */
export function inAppClip(): string | null {
  return inApp;
}

function editorLayout(): boolean {
  return document.querySelector('.app[data-layout="full"]') !== null;
}

/** True if the page has selected text (the native copy should win). */
function textSelected(): boolean {
  const s = typeof window.getSelection === 'function' ? window.getSelection() : null;
  return !!s && !s.isCollapsed && s.toString().trim() !== '';
}

/** True when a clipboard shortcut or event at `target` is the editor's. */
function ours(target: EventTarget | null): boolean {
  return (
    editorLayout() &&
    !workspaceShown() &&
    !takesText(target) &&
    document.querySelector('dialog[open]') === null
  );
}

/** Copies (and with `cut`, deletes) the selected moments; false when none is selected. */
function copyNow(data: DataTransfer | null, cut: boolean): boolean {
  const clip = clipOfSelection();
  if (!clip) return false;
  const text = clipText(clip);
  inApp = text;
  if (data) data.setData('text/plain', text);
  else void navigator.clipboard?.writeText(text).catch(() => undefined);
  const n = clip.moments.length;
  if (cut) {
    const ids = useEditor.getState().selection;
    cutMoments(ids);
  }
  announce(`${cut ? 'Cut' : 'Copied'} ${momentsText(n)}`);
  return true;
}

/** Pastes clipboard `text` (else the in-app clip when `text` is empty); false if nothing pasted. */
function pasteNow(text: string | null): boolean {
  const fallback = text === null || text.trim() === '';
  const clip = parseClip(fallback ? inApp : text);
  if (!clip) {
    if (!fallback || inApp !== null) announce('The clipboard holds no moments');
    return false;
  }
  const ids = pasteClipAt(clip, playheadTime());
  if (!ids) {
    announce('Those moments cannot be pasted into this piece');
    return false;
  }
  const at = usePlayer.getState().piece.moments.find((m) => m.id === ids[0])?.at ?? 0;
  announce(`Pasted ${momentsText(ids.length)} at ${at.toFixed(2)} s`);
  return true;
}

/** Copies the selection (the touch menu, §11.3b); false when nothing is selected. */
export function copySelection(): boolean {
  return copyNow(null, false);
}

/** Pastes the last copied moments at the playhead (the touch menu); false if none. */
export function pasteHere(): boolean {
  return pasteNow(null);
}

/** True when moments were copied in this page (the touch menu's Paste is enabled). */
export function hasClip(): boolean {
  return inApp !== null;
}

/** The clipboard shortcut of a keydown, or null. */
export function clipboardKey(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): 'copy' | 'cut' | 'paste' | 'all' | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return null;
  switch (e.key.toLowerCase()) {
    case 'c':
      return 'copy';
    case 'x':
      return 'cut';
    case 'v':
      return 'paste';
    case 'a':
      return 'all';
    default:
      return null;
  }
}

/**
 * Handles a clipboard shortcut on keydown (call before other key handling); true if it was one.
 * Copy, cut and paste wait for their clipboard event and fall back after it would have come.
 */
export function onClipboardKey(e: KeyboardEvent): boolean {
  const k = clipboardKey(e);
  if (!k || !ours(e.target)) return false;
  if (k === 'all') {
    e.preventDefault();
    const ids = allMomentIds(usePlayer.getState().piece);
    select(ids);
    announce(`Selected ${momentsText(ids.length)}`);
    return true;
  }
  if (k !== 'paste' && (textSelected() || !clipOfSelection())) return false;
  expect = k;
  setTimeout(() => {
    if (expect !== k) return;
    expect = null;
    if (k === 'paste') pasteNow(null);
    else copyNow(null, k === 'cut');
  }, 0);
  return true;
}

/** Installs the `copy`, `cut` and `paste` listeners; returns a function that removes them. */
export function attachClipboard(): () => void {
  const onCopy = (e: ClipboardEvent): void => {
    const cut = e.type === 'cut';
    if (!ours(e.target) || textSelected()) return;
    if (copyNow(e.clipboardData, cut)) {
      e.preventDefault();
      expect = null;
    }
  };
  const onPaste = (e: ClipboardEvent): void => {
    if (!ours(e.target)) return;
    expect = null;
    const text = e.clipboardData?.getData('text/plain') ?? null;
    if (pasteNow(text)) e.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCopy);
  document.addEventListener('paste', onPaste);
  return () => {
    document.removeEventListener('copy', onCopy);
    document.removeEventListener('cut', onCopy);
    document.removeEventListener('paste', onPaste);
  };
}
