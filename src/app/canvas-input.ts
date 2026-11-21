/**
 * Pointer, wheel and keyboard input for the score view (PLAN.md §10 camera, §11.5):
 * - editor layout (§11.3 revision 7 "Score selection"): clicking a line selects the moment that
 *   owns that section (Shift adds or removes it); dragging on the background (or a line) draws a
 *   selection rectangle that selects the arrival dots inside (Shift extends); a click on empty
 *   background places the playhead there. There is no click-to-play on the score;
 * - editor layout: double-clicking a line, or clicking it with `N` held, adds a note point there
 *   and dragging vertically sets its `to` (§11.3 Note points; one undo entry; snapped to the key,
 *   Shift: whole octaves from `from`, Alt: chromatic); on a line a walk drives there it inserts a
 *   walk step instead (freezing the walk);
 * - player layout: a click or tap plays or pauses; dragging pans (during playback this turns
 *   Follow off);
 * - panning: wheel/trackpad, middle-button drag, or Space-drag (editor: Space then plays or
 *   pauses on release only when it did not pan);
 * - pinch, ⌘/Ctrl/Alt-scroll and Safari's gesture events change the window;
 * - `−` / `=` change the window, ←/→ seek; Space plays and pauses whatever has focus, except in
 *   a text field (space-key.ts; a window capture handler, so focused controls never take it);
 * - ⌘/Ctrl+Z undoes, ⇧⌘/Ctrl+Z and Ctrl+Y redo (outside text fields, which keep their own undo);
 * - wide layout only: C U S M T P W I K L add a moment at the playhead, Delete/Backspace delete
 *   the selection, Escape clears it and the dot selection (editor/shortcuts.ts), unless another
 *   handler already used the key (`defaultPrevented`, e.g. Escape closing the menu); ▲/▼ step a
 *   selected note point's `to` by a scale step, Shift+▲/▼ by an octave (also the selected dots).
 *
 * Handlers write the store (`setWindow`, `panBy`); the animation loop picks the change up on its
 * next frame, so no React render sits on the pointer path.
 */

import { keyAt } from '../core/query';
import type { Key, Pitch, Seconds } from '../core/types';
import { HOVER_RADIUS_PX, nearestLine, pitchToY, timeToX, xToTime, type View } from '../render';
import { auditionMoment, holdNote, stopAudition } from './audition';
import { addPointDrag, octaveDots, stepNote, type PitchDrag } from './editor/actions';
import { cachedArrivals } from './editor/arrival-points';
import { dragPitch } from './editor/chord-notes';
import { clearDots, currentDots, selectDots } from './editor/dot-selection';
import { edgePitch, inRange } from './editor/drag-edge';
import { dotsInRect } from './editor/group-move';
import { OCTAVE, octaveGuides, octaveSnap, octaveSpan } from './editor/octave-drag';
import { changePoints, snapTime } from './editor/snap';
import { redo, select, undo, useEditor } from './editor/history';
import { isDoublePress, noteFrom, type Press } from './editor/note-points';
import { playheadEffect } from './editor/palette-effects';
import { sectionOwner } from './editor/section';
import {
  addAtPlayhead,
  clearSelection,
  deleteSelection,
  editorKey,
  takesText,
} from './editor/shortcuts';
import { clearHover, setHover } from './hover';
import { currentPps, onScoreFrame } from './loop';
import { marquee } from './marquee';
import { hideOctaves, showOctaves } from './octave-guide';
import { isSpace, spaceKey, type SpaceHeld } from './space-key';
import { camera, panBy, seekBy, seekTo, toggleLoop, togglePlay, usePlayer, zoomBy } from './store';

/** Pixels a pointer must travel before a press counts as a drag rather than a click. */
const DRAG_SLOP = 4;

/** Space held (editor layout): a drag pans, and the release plays/pauses only if none did. */
const space: SpaceHeld = { down: false, panned: false };

interface PointerInfo {
  x: number;
  y: number;
}

/** What the current press does once it moves past the slop, or on release. */
type Mode = 'press' | 'pan' | 'marquee' | 'note';

/** Attaches the canvas handlers; returns a function that removes them. */
export function attachCanvasInput(canvas: HTMLCanvasElement): () => void {
  const pointers = new Map<number, PointerInfo>();
  let travelled = 0;
  let pinching = false;
  let pinchStart = 0;
  let pinchWindow = 0;
  let mode: Mode = 'press';
  /** Shift at the press (the marquee extends the selection). */
  let shift = false;

  let view: View | null = null;
  const stopFrames = onScoreFrame((v) => {
    view = v;
  });
  let nHeld = false;
  /** This press, and the last press that ended as a click (for double-clicks). */
  let press: Press | null = null;
  let lastClick: Press | null = null;
  let note: {
    drag: PitchDrag;
    /** The pool voice of the line (its timbre and level are auditioned). */
    voice: number;
    key: Key;
    at: Seconds;
    from: Pitch;
    last: Pitch;
    range?: [Pitch, Pitch];
    /** The last pointer y (canvas px) and modifiers, re-applied when Shift or Alt changes. */
    y: number;
    shift: boolean;
    alt: boolean;
  } | null = null;
  /** Ends the note drag (and releases the held pitch range). */
  const endNote = (cancel: boolean): void => {
    note?.drag.end(cancel);
    note = null;
    stopAudition();
    camera.pitch = null;
    hideOctaves();
  };
  /**
   * Sets the note's `to` from the pointer: snapped to the key; Shift: whole octaves from `from`
   * (with the guides and label); Alt: chromatic.
   */
  const applyNote = (): void => {
    if (!view || !note) return;
    const raw = edgePitch(view, note.y);
    let q: Pitch;
    if (note.shift && !note.alt) {
      const span = octaveSpan([{ pitch: note.from, range: note.range }]);
      const k = octaveSnap(note.from, raw, span);
      q = note.from + k * OCTAVE;
      showOctaves(k, note.at, q, octaveGuides(note.from, span));
    } else {
      q = inRange(dragPitch(raw, note.key, note.alt), note.range);
      hideOctaves();
    }
    if (q !== note.last) {
      note.last = q;
      note.drag.to(q);
    }
    // Sounds the note at its snapped pitch while it moves (§11.3 auditioning).
    holdNote(note.voice, q, note.at);
  };
  const endMarquee = (): void => {
    marquee.on = false;
  };

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
    // Revision 7: snapped to a nearby note change (not the bar grid); Alt: exact.
    const t = xToTime(v, x);
    const at = snapTime(t, { points: changePoints(compiled, piece) }, v.pps, exact);
    const from = noteFrom(compiled, hit.voice, at, hit.pitch);
    if (from === null) return false;
    note = {
      drag: addPointDrag(at, hit.voice, from),
      voice: hit.voice,
      key: keyAt(compiled, at),
      at,
      from,
      last: from,
      range: piece.voices[hit.voice]?.range,
      y,
      shift: false,
      alt: false,
    };
    camera.pitch = [v.pLo, v.pHi];
    return true;
  };

  /** A click in the editor: a line's section selects its moment; empty background seeks. */
  const clickAt = (x: number, y: number, add: boolean): void => {
    const v = view;
    if (!v) return;
    const { compiled } = usePlayer.getState();
    const hit = nearestLine(compiled, v, x, y, HOVER_RADIUS_PX, true);
    const owner = hit && sectionOwner(compiled, hit.voice, hit.t);
    if (owner) {
      clearDots();
      const sel = useEditor.getState().selection;
      if (!add) {
        select([owner]);
        // Plays what the moment moves to (§11.3 auditioning; stopped transport only).
        auditionMoment(owner);
      } else select(sel.includes(owner) ? sel.filter((id) => id !== owner) : [...sel, owner]);
      return;
    }
    clearDots();
    // As on the ruler, the seek never scrolls the view: a double-click's second press must land
    // where the first one did.
    camera.hold = camera.release = true;
    seekTo(Math.max(0, xToTime(v, x)));
  };

  /** Ends the marquee: selects the dots inside (`add`: added to the dot selection). */
  const finishMarquee = (): void => {
    const v = view;
    endMarquee();
    if (!v) return;
    const { compiled, piece } = usePlayer.getState();
    const inside = dotsInRect(
      cachedArrivals(piece, compiled),
      marquee,
      (t) => timeToX(v, t),
      (p) => pitchToY(v, p),
    );
    if (!shift) {
      selectDots(inside);
      return;
    }
    const cur = currentDots();
    const fresh = inside.filter(
      (d) => !cur.some((s) => s.momentId === d.momentId && s.t === d.t && s.pitch === d.pitch),
    );
    selectDots([...cur, ...fresh], true);
  };

  /** Shift or Alt pressed or released during a note drag (past the slop) switches live. */
  const noteKeys = (e: KeyboardEvent): void => {
    if (!note || travelled <= DRAG_SLOP || (e.key !== 'Shift' && e.key !== 'Alt')) return;
    if (note.shift === e.shiftKey && note.alt === e.altKey) return;
    note.shift = e.shiftKey;
    note.alt = e.altKey;
    applyNote();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'n' || e.key === 'N') nHeld = !takesText(e.target);
    noteKeys(e);
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === 'n' || e.key === 'N') nHeld = false;
    noteKeys(e);
  };
  const onBlur = (): void => {
    nHeld = false;
  };

  const distance = (): number => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onDown = (e: PointerEvent): void => {
    const middle = e.pointerType === 'mouse' && e.button === 1;
    if (e.pointerType === 'mouse' && e.button !== 0 && !middle) return;
    if (middle) e.preventDefault(); // no autoscroll
    clearHover();
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      travelled = 0;
      pinching = false;
      shift = e.shiftKey;
      const { x, y } = local(e);
      press = { x, y, time: performance.now() };
      const prev = lastClick;
      lastClick = null;
      const editor = editorLayout();
      mode = 'press';
      if (middle || (editor && space.down)) mode = 'pan';
      else if (
        editor &&
        (nHeld || (prev !== null && isDoublePress(prev, press))) &&
        startNote(x, y, e.altKey)
      ) {
        mode = 'note';
      }
    } else if (pointers.size === 2) {
      if (note) endNote(true);
      if (marquee.on) endMarquee();
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
    if (mode === 'note') {
      if (!note) return;
      note.y = local(e).y;
      note.shift = e.shiftKey;
      note.alt = e.altKey;
      applyNote();
      return;
    }
    if (mode === 'press') {
      if (editorLayout() && press) {
        mode = 'marquee';
        Object.assign(marquee, { on: true, x0: press.x, y0: press.y });
      } else mode = 'pan';
    }
    if (mode === 'marquee') {
      const { x, y } = local(e);
      marquee.x1 = x;
      marquee.y1 = y;
      return;
    }
    // Pan: dragging right shows earlier time.
    if (space.down) space.panned = true;
    const pps = currentPps(canvas);
    if (pps > 0) panBy(-dx / pps);
  };

  const onUp = (e: PointerEvent): void => {
    if (!pointers.delete(e.pointerId)) return;
    const up = e.type === 'pointerup';
    if (mode === 'note' && note) {
      endNote(!up);
      press = null;
      mode = 'press';
      return;
    }
    if (mode === 'marquee') {
      if (up && pointers.size === 0 && !pinching) finishMarquee();
      else endMarquee();
      mode = 'press';
      if (pointers.size === 0) pinching = false;
      return;
    }
    if (pointers.size === 0 && !pinching && travelled <= DRAG_SLOP && up && mode === 'press') {
      if (editorLayout()) {
        if (press) {
          lastClick = press;
          clickAt(press.x, press.y, e.shiftKey);
        }
      } else togglePlay();
    }
    if (pointers.size === 0) {
      pinching = false;
      mode = 'press';
    }
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
  // Middle-button clicks would paste or open links on some systems.
  const onAux = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', clearHover);
  canvas.addEventListener('auxclick', onAux);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('gesturestart', onGestureStart);
  canvas.addEventListener('gesturechange', onGestureChange);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  return () => {
    stopFrames();
    if (note) endNote(true);
    endMarquee();
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('pointerleave', clearHover);
    canvas.removeEventListener('auxclick', onAux);
    clearHover();
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('gesturestart', onGestureStart);
    canvas.removeEventListener('gesturechange', onGestureChange);
  };
}

/** True for targets that handle the arrow keys themselves. */
function ownsArrows(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'textarea' || tag === 'select' || tag === 'input' || target.isContentEditable;
}

/** True for a focused checkbox or radio: Enter toggles it, since Space no longer does. */
function isToggleInput(target: EventTarget | null): target is HTMLInputElement {
  if (!(target instanceof HTMLElement) || target.tagName.toLowerCase() !== 'input') return false;
  const type = (target as HTMLInputElement).type;
  return type === 'checkbox' || type === 'radio';
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
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // ▲/▼ on a selected note point (§11.3); Shift+▲/▼ an octave, also on selected dots. The
      // lane's own arrows came first.
      if (e.defaultPrevented || ownsArrows(e.target) || !editorLayout()) return;
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      if (e.shiftKey) {
        const dots = currentDots();
        if (dots.length > 0) {
          e.preventDefault();
          const landed = octaveDots(dots, dir);
          if (landed) selectDots(landed);
          return;
        }
      }
      const sel = useEditor.getState().selection;
      if (sel.length === 1 && stepNote(sel[0], dir, undefined, e.shiftKey)) e.preventDefault();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (ownsArrows(e.target)) return;
      e.preventDefault();
      seekBy((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 15 : 5));
    }
  };
  // Window, capture phase: runs before any control, React handler or document listener sees the
  // key. Browsers activate buttons and checkboxes on Space keyup, so keyup is cancelled too.
  const onSpace = (e: KeyboardEvent): void => {
    if (e.type === 'keydown' && e.key === 'Enter' && isToggleInput(e.target)) {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      e.target.click();
      return;
    }
    if (!isSpace(e)) return;
    // ⌘/Ctrl/Alt+Space belong to the system; a release always ends the hold.
    if (e.type === 'keydown' && (e.metaKey || e.ctrlKey || e.altKey)) return;
    const dialog = document.querySelector('dialog[open]') !== null;
    const out = spaceKey(e, space, { editor: editorLayout(), dialog });
    if (!out.consume) return;
    e.preventDefault();
    e.stopPropagation();
    if (out.toggle) togglePlay();
  };
  const onBlur = (): void => {
    space.down = false;
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('keydown', onSpace, true);
  window.addEventListener('keyup', onSpace, true);
  window.addEventListener('blur', onBlur);
  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('keydown', onSpace, true);
    window.removeEventListener('keyup', onSpace, true);
    window.removeEventListener('blur', onBlur);
  };
}
