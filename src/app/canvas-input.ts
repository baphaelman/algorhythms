/**
 * Pointer, wheel and keyboard input for the score view (PLAN.md §10 camera, §11.5):
 * - a click or tap on the canvas plays or pauses;
 * - editor layout: double-clicking a line, or clicking it with `N` held, adds a note point there
 *   and dragging vertically sets its `to` (§11.3 Note points; one undo entry); on a line a walk
 *   drives there it inserts a walk step instead (freezing the walk). A double-click
 *   puts the transport back as it was before its first click;
 * - dragging pans the view (during playback this turns Follow off);
 * - pinch, ⌘/Ctrl/Alt-scroll and Safari's gesture events change the window;
 * - `−` / `=` change the window, Space plays and pauses, ←/→ seek;
 * - ⌘/Ctrl+Z undoes, ⇧⌘/Ctrl+Z and Ctrl+Y redo (outside text fields, which keep their own undo);
 * - wide layout only: C U S M T P W I K L add a moment at the playhead, Delete/Backspace delete
 *   the selection, Escape clears it (editor/shortcuts.ts), unless another handler already used
 *   the key (`defaultPrevented`, e.g. Escape closing the menu); ▲/▼ step a selected note
 *   point's `to` by a scale step.
 *
 * Handlers write the store (`setWindow`, `panBy`); the animation loop picks the change up on its
 * next frame, so no React render sits on the pointer path.
 */

import { keyAt } from '../core/query';
import type { Key, Pitch } from '../core/types';
import { HOVER_RADIUS_PX, nearestLine, xToTime, yToPitch, type View } from '../render';
import { addPointDrag, stepNote, type PitchDrag } from './editor/actions';
import { dragPitch } from './editor/chord-notes';
import { redo, undo, useEditor } from './editor/history';
import { isDoublePress, noteFrom, type Press } from './editor/note-points';
import { playheadEffect } from './editor/palette-effects';
import {
  addAtPlayhead,
  clearSelection,
  deleteSelection,
  editorKey,
  snapToGrid,
  takesText,
} from './editor/shortcuts';
import { clearHover, setHover } from './hover';
import { currentPps, onScoreFrame } from './loop';
import {
  currentTime,
  panBy,
  seekBy,
  seekTo,
  toggleLoop,
  togglePlay,
  usePlayer,
  zoomBy,
  type TransportStatus,
} from './store';

/** Pixels a pointer must travel before a press counts as a drag rather than a click. */
const DRAG_SLOP = 4;

interface PointerInfo {
  x: number;
  y: number;
}

/** Attaches the canvas handlers; returns a function that removes them. */
export function attachCanvasInput(canvas: HTMLCanvasElement): () => void {
  const pointers = new Map<number, PointerInfo>();
  let travelled = 0;
  let pinching = false;
  let pinchStart = 0;
  let pinchWindow = 0;

  // Note points (§11.3).
  let view: View | null = null;
  const stopFrames = onScoreFrame((v) => {
    view = v;
  });
  let nHeld = false;
  /** This press, and the last press that ended as a click (with the transport before it). */
  let press: Press | null = null;
  let lastClick: { press: Press; status: TransportStatus; t: number } | null = null;
  let note: { drag: PitchDrag; key: Key; last: Pitch } | null = null;

  const local = (e: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** Starts a note point on the line under (x, y); false if there is none. */
  const startNote = (x: number, y: number, exact: boolean): boolean => {
    const v = view;
    if (!v) return false;
    const { compiled, piece } = usePlayer.getState();
    const hit = nearestLine(compiled, v, x, y, HOVER_RADIUS_PX, true);
    if (!hit) return false;
    const t = xToTime(v, x);
    const at = exact ? Math.max(0, t) : snapToGrid(t, piece.view.gridBpm);
    const from = noteFrom(compiled, hit.voice, at, hit.pitch);
    if (from === null) return false;
    note = { drag: addPointDrag(at, hit.voice, from), key: keyAt(compiled, at), last: from };
    return true;
  };

  /** Undoes the play/pause of a double-click's first click. */
  const restoreTransport = (before: { status: TransportStatus; t: number }): void => {
    const was = before.status === 'playing';
    if ((usePlayer.getState().transport.status === 'playing') !== was) togglePlay();
    if (!was) seekTo(before.t);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'n' || e.key === 'N') nHeld = !takesText(e.target);
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === 'n' || e.key === 'N') nHeld = false;
  };
  const onBlur = (): void => {
    nHeld = false;
  };

  const distance = (): number => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    clearHover();
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      travelled = 0;
      pinching = false;
      const { x, y } = local(e);
      press = { x, y, time: performance.now() };
      const prev = lastClick;
      lastClick = null;
      const double = prev !== null && isDoublePress(prev.press, press);
      if ((double || nHeld) && editorLayout() && startNote(x, y, e.altKey)) {
        if (double && prev) restoreTransport(prev);
      }
    } else if (pointers.size === 2) {
      if (note) {
        note.drag.end(true);
        note = null;
      }
      pinching = true;
      pinchStart = Math.max(1, distance());
      pinchWindow = usePlayer.getState().view.window;
    }
  };

  const onMove = (e: PointerEvent): void => {
    const p = pointers.get(e.pointerId);
    if (!p) {
      // Hover readout: a mouse with no button down (not during pan or drag).
      if (e.pointerType === 'mouse' && pointers.size === 0) {
        const r = canvas.getBoundingClientRect();
        setHover(e.clientX - r.left, e.clientY - r.top);
      }
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size >= 2) {
      // Spreading the fingers zooms in (a shorter window).
      const s = usePlayer.getState();
      const target = pinchWindow * (pinchStart / Math.max(1, distance()));
      zoomBy(target / s.view.window);
      return;
    }
    travelled += Math.abs(dx) + Math.abs(dy);
    if (travelled <= DRAG_SLOP) return;
    if (note) {
      if (!view) return;
      const q = dragPitch(yToPitch(view, local(e).y), note.key, e.shiftKey);
      if (q !== note.last) {
        note.last = q;
        note.drag.to(q);
      }
      return;
    }
    // Dragging right shows earlier time.
    const pps = currentPps(canvas);
    if (pps > 0) panBy(-dx / pps);
  };

  const onUp = (e: PointerEvent): void => {
    if (!pointers.delete(e.pointerId)) return;
    if (note) {
      note.drag.end(e.type !== 'pointerup');
      note = null;
      press = null;
      return;
    }
    if (pointers.size === 0 && !pinching && travelled <= DRAG_SLOP && e.type === 'pointerup') {
      const status = usePlayer.getState().transport.status;
      if (press) lastClick = { press, status, t: currentTime() };
      togglePlay();
    }
    if (pointers.size === 0) pinching = false;
  };

  const onWheel = (e: WheelEvent): void => {
    const unit = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      zoomBy(Math.exp(Math.max(-60, Math.min(60, e.deltaY * unit)) * 0.01));
      return;
    }
    // Horizontal trackpad scroll pans.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const pps = currentPps(canvas);
      if (pps > 0) panBy((e.deltaX * unit) / pps);
    }
  };

  // Safari reports trackpad pinch as gesture events instead of ctrl-wheel.
  let gestureWindow = 0;
  const onGestureStart = (e: Event): void => {
    e.preventDefault();
    gestureWindow = usePlayer.getState().view.window;
  };
  const onGestureChange = (e: Event): void => {
    e.preventDefault();
    const scale = (e as Event & { scale?: number }).scale ?? 1;
    const s = usePlayer.getState();
    zoomBy(gestureWindow / Math.max(0.05, scale) / s.view.window);
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', clearHover);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('gesturestart', onGestureStart);
  canvas.addEventListener('gesturechange', onGestureChange);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  return () => {
    stopFrames();
    if (note) note.drag.end(true);
    note = null;
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('pointerleave', clearHover);
    clearHover();
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('gesturestart', onGestureStart);
    canvas.removeEventListener('gesturechange', onGestureChange);
  };
}

/** True for targets that handle Space or arrow keys themselves. */
function ownsKeys(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select' || target.isContentEditable) return true;
  if (tag === 'button' || tag === 'a' || tag === 'summary') return key === ' ';
  if (tag === 'input') {
    const type = (target as HTMLInputElement).type;
    // Range inputs use the arrows; Space does nothing there, so the player may take it.
    return type === 'range' ? key !== ' ' : true;
  }
  return false;
}

/** True when a native text-editing control has focus (it owns its own undo). */
function ownsTextUndo(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'textarea' || target.isContentEditable) return true;
  if (tag === 'input') {
    return !['range', 'checkbox', 'radio', 'color'].includes((target as HTMLInputElement).type);
  }
  return false; // select and everything else: undo passes through
}

/** True while the wide (editor) layout is shown (PLAN.md §11.5). */
function editorLayout(): boolean {
  return document.querySelector('.app[data-layout="full"]') !== null;
}

/** Installs the player's document-level keys; returns a function that removes them. */
export function attachKeys(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (k === 'z' || (k === 'y' && e.ctrlKey))) {
      if (ownsTextUndo(e.target)) return;
      e.preventDefault();
      if (k === 'z' && !e.shiftKey) undo();
      else redo();
      return;
    }
    // A key another handler already used (e.g. Escape closing a menu) is not an editor key.
    const ek = !e.defaultPrevented && editorLayout() ? editorKey(e) : null;
    if (ek) {
      if (ek.kind === 'loop') {
        if (toggleLoop()) e.preventDefault();
      } else if (ek.kind === 'add') {
        e.preventDefault();
        // Revision 6: a type with no effect at the playhead is not added (the palette greys it).
        if (playheadEffect(ek.type).effect) addAtPlayhead(ek.type);
      } else if (ek.kind === 'delete' ? deleteSelection() : clearSelection()) {
        e.preventDefault();
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '-' || e.key === '_') {
      zoomBy(1.25);
      e.preventDefault();
    } else if (e.key === '=' || e.key === '+') {
      zoomBy(0.8);
      e.preventDefault();
    } else if (e.code === 'Space' || e.key === ' ') {
      if (ownsKeys(e.target, ' ')) return;
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // ▲/▼ on a selected note point (§11.3); the lane's own arrows came first.
      if (e.defaultPrevented || e.shiftKey || ownsKeys(e.target, e.key) || !editorLayout()) return;
      const sel = useEditor.getState().selection;
      if (sel.length === 1 && stepNote(sel[0], e.key === 'ArrowUp' ? 1 : -1)) e.preventDefault();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (ownsKeys(e.target, e.key)) return;
      e.preventDefault();
      seekBy((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 15 : 5));
    }
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}
