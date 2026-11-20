/**
 * Pointer, wheel and keyboard input for the score view (PLAN.md §10 camera, §11.5):
 * - a click or tap on the canvas plays or pauses;
 * - dragging pans the view while paused;
 * - pinch, ⌘/Ctrl/Alt-scroll and Safari's gesture events change the window;
 * - `−` / `=` change the window, Space plays and pauses, ←/→ seek;
 * - ⌘/Ctrl+Z undoes, ⇧⌘/Ctrl+Z and Ctrl+Y redo (outside text fields, which keep their own undo);
 * - wide layout only: C U S M T P W I K L add a moment at the playhead, Delete/Backspace delete
 *   the selection, Escape clears it (editor/shortcuts.ts).
 *
 * Handlers write the store (`setWindow`, `panBy`); the animation loop picks the change up on its
 * next frame, so no React render sits on the pointer path.
 */

import { redo, undo } from './editor/history';
import { addAtPlayhead, clearSelection, deleteSelection, editorKey } from './editor/shortcuts';
import { currentPps } from './loop';
import { currentTime, panBy, seekBy, togglePlay, usePlayer, zoomBy } from './store';

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

  const distance = (): number => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      travelled = 0;
      pinching = false;
    } else if (pointers.size === 2) {
      pinching = true;
      pinchStart = Math.max(1, distance());
      pinchWindow = usePlayer.getState().view.window;
    }
  };

  const onMove = (e: PointerEvent): void => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
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
    const s = usePlayer.getState();
    if (s.transport.status === 'playing') return;
    // Dragging right shows earlier time: the view centre moves left of the playhead.
    const pps = currentPps(canvas, s, currentTime());
    if (pps > 0) panBy(-dx / pps);
  };

  const onUp = (e: PointerEvent): void => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 0 && !pinching && travelled <= DRAG_SLOP && e.type === 'pointerup') {
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
    // Horizontal trackpad scroll pans while paused.
    const s = usePlayer.getState();
    if (s.transport.status !== 'playing' && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const pps = currentPps(canvas, s, currentTime());
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
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('gesturestart', onGestureStart);
  canvas.addEventListener('gesturechange', onGestureChange);
  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
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
      if (ownsKeys(e.target, e.key)) return;
      e.preventDefault();
      if (k === 'z' && !e.shiftKey) undo();
      else redo();
      return;
    }
    const ek = editorLayout() ? editorKey(e) : null;
    if (ek) {
      if (ek.kind === 'add') {
        e.preventDefault();
        addAtPlayhead(ek.type);
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
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (ownsKeys(e.target, e.key)) return;
      e.preventDefault();
      seekBy((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 15 : 5));
    }
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}
