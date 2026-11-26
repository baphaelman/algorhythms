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
 * - editor layout, a tune selected (owner, 2026-11-21): a double-click (double-tap) anywhere on the
 *   score adds a note to that tune at its time and pitch instead (key-snapped, Alt chromatic and
 *   free in time; beats with Snap to beats): it splits the note there, or appends or prepends;
 * - player layout: a click or tap plays or pauses; dragging pans (during playback this turns
 *   Follow off);
 * - panning: wheel/trackpad, middle-button drag, or Space-drag (editor: Space then plays or
 *   pauses on release only when it did not pan);
 * - pinch, ⌘/Ctrl/Alt-scroll change the window (Safari's gesture events, and wheels over
 *   whatever is drawn on the score: ./pinch-zoom); two fingers also pan;
 * - touch (§11.3b, ./touch): a larger drag slop and double-tap reach; a tap on a line also shows its
 *   readout (no hover); in the editor a long press opens the touch menu on the line's moment (or
 *   the background); the menu's latched Snap off / Select more act as Alt / Shift;
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
import type { Key, MomentId, Pitch, Seconds } from '../core/types';
import { HOVER_RADIUS_PX, nearestLine, pitchToY, timeToX, xToTime, type View } from '../render';
import { auditionMoment, auditionTuneAfterEdit, holdNote, stopAudition } from './audition';
import {
  addMoment,
  addPointDrag,
  octaveDots,
  stepNote,
  updateMoment,
  type PitchDrag,
} from './editor/actions';
import { cachedArrivals } from './editor/arrival-points';
import { dragPitch } from './editor/chord-notes';
import { clearDots, currentDots, selectDots } from './editor/dot-selection';
import { edgePitch, inRange } from './editor/drag-edge';
import { dotsInRect } from './editor/group-move';
import { OCTAVE, octaveGuides, octaveSnap, octaveSpan } from './editor/octave-drag';
import { beatStep, changePoints, snapTime } from './editor/snap';
import { redo, select, undo, useEditor } from './editor/history';
import { isDoublePress, noteFrom, type Press } from './editor/note-points';
import { playheadEffect } from './editor/palette-effects';
import { insertTuneNote, tuneBeat, tuneNoteStarts, tuneShiftIn } from './editor/tune';
import { sectionOwner } from './editor/section';
import { clearSelection, deleteSelection, editorKey, takesText } from './editor/shortcuts';
import { attachClipboard, onClipboardKey } from './clipboard';
import { shortcutTime } from './palette-drop';
import { clearHover, setHover } from './hover';
import {
  DOUBLE_TAP_PX,
  freeOf,
  openTouchMenu,
  slopFor,
  startLongPress,
  touchMods,
  type LongPress,
} from './touch';
import { currentPps, onScoreFrame } from './loop';
import { marquee } from './marquee';
import { hideOctaves, showOctaves } from './octave-guide';
import { dialogSpace, isSpace, spaceHold, spaceKey } from './space-key';
import { workspaceShown } from './export-surface';
import { wheelIntent } from './wheel';
import { camera, panBy, seekBy, seekTo, toggleLoop, togglePlay, usePlayer, zoomBy } from './store';

/** Pixels a pointer must travel before a press counts as a drag rather than a click. */
const DRAG_SLOP = 4;

/** Space held (editor layout): a drag pans, and the release plays/pauses only if none did. */
const space = spaceHold;

interface PointerInfo {
  x: number;
  y: number;
}

/** What the current press does once it moves past the slop, or on release. */
type Mode = 'press' | 'pan' | 'marquee' | 'note' | 'menu' | 'done';

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
  /** This press's drag threshold (larger for a finger), and its long-press timer. */
  let slop = DRAG_SLOP;
  let hold: LongPress | null = null;
  const endHold = (): void => {
    hold?.cancel();
    hold = null;
  };

  let view: View | null = null;
  const stopFrames = onScoreFrame((v) => {
    view = v;
  });
  let nHeld = false;
  /** This press, and the last press that ended as a click (for double-clicks). */
  let press: Press | null = null;
  let lastClick: Press | null = null;
  /** The tune selected when `lastClick` was pressed (its double-click adds a note to it). */
  let lastClickTune: MomentId | null = null;
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
    // Revision 7: snapped to a nearby note change; revision 9: and to a beat (Snap to beats).
    // Alt: exact.
    const t = xToTime(v, x);
    const at = snapTime(
      t,
      { points: changePoints(compiled, piece), grid: beatStep(piece.view) },
      v.pps,
      exact,
    );
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

  /** The selected moment when it is the only one and a tune, else null. */
  const selectedTune = (): MomentId | null => {
    const sel = useEditor.getState().selection;
    if (sel.length !== 1) return null;
    const m = usePlayer.getState().piece.moments.find((x) => x.id === sel[0]);
    return m?.type === 'tune' ? m.id : null;
  };

  /**
   * A double-click with tune `id` selected: a note at (x, y) inserted into it (`insertTuneNote`;
   * pitch snapped to the key, time to beats with Snap to beats; `exact`: chromatic and free),
   * one undo entry, sounded. The tune stays selected. False if nothing was added.
   */
  const addTuneNoteAt = (id: MomentId, x: number, y: number, exact: boolean): boolean => {
    const v = view;
    if (!v) return false;
    const { compiled, piece } = usePlayer.getState();
    const m = piece.moments.find((q) => q.id === id);
    if (m?.type !== 'tune') return false;
    const t = snapTime(xToTime(v, x), { points: [], grid: beatStep(piece.view) }, v.pps, exact);
    const pitch = dragPitch(edgePitch(v, y), keyAt(compiled, t), exact);
    // The score shows sounding pitches (revision 10): insert the un-transposed one.
    const r = insertTuneNote(m, t, pitch - tuneShiftIn(compiled, m), tuneBeat(piece.view) ?? 0.5);
    if (!r) return false;
    clearDots();
    select([id]);
    if (!updateMoment(id, { at: r.at, notes: r.notes }, 'Add tune note')) return false;
    const start = tuneNoteStarts(r)[r.index];
    auditionTuneAfterEdit(id, pitch, start + r.notes[r.index].len / 2);
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

  /** A long press at (x, y): selects the line's moment (keeping a selection that holds it). */
  const menuOwner = (x: number, y: number): MomentId | null => {
    const v = view;
    if (!v) return null;
    const { compiled } = usePlayer.getState();
    const hit = nearestLine(compiled, v, x, y, HOVER_RADIUS_PX, true);
    const owner = hit ? sectionOwner(compiled, hit.voice, hit.t) : null;
    if (owner && !useEditor.getState().selection.includes(owner)) {
      clearDots();
      select([owner]);
    }
    return owner;
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
    if (!note || travelled <= slop || (e.key !== 'Shift' && e.key !== 'Alt')) return;
    if (note.shift === e.shiftKey && note.alt === freeOf(e)) return;
    note.shift = e.shiftKey;
    note.alt = freeOf(e);
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
      shift = e.shiftKey || e.metaKey || e.ctrlKey || touchMods().add;
      slop = slopFor(e.pointerType, DRAG_SLOP);
      const { x, y } = local(e);
      press = { x, y, time: performance.now() };
      const prev = lastClick;
      const prevTune = lastClickTune;
      lastClick = null;
      lastClickTune = null;
      const editor = editorLayout();
      const double =
        prev !== null &&
        isDoublePress(prev, press, e.pointerType === 'touch' ? DOUBLE_TAP_PX : undefined);
      mode = 'press';
      if (middle || (editor && space.down)) mode = 'pan';
      else if (editor && double && prevTune !== null && addTuneNoteAt(prevTune, x, y, freeOf(e))) {
        mode = 'done';
      } else if (editor && (nHeld || double) && startNote(x, y, freeOf(e))) {
        mode = 'note';
      }
      endHold();
      if (editor && mode === 'press') {
        const cx = e.clientX;
        const cy = e.clientY;
        hold = startLongPress(e, () => {
          hold = null;
          if (mode !== 'press' || pointers.size !== 1 || travelled > slop) return;
          mode = 'menu';
          lastClick = null;
          openTouchMenu(cx, cy, menuOwner(x, y));
        });
      }
    } else if (pointers.size === 2) {
      endHold();
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
      // Spreading the fingers zooms in (a shorter window); moving them together pans (§11.3b).
      const s = usePlayer.getState();
      const target = pinchWindow * (pinchStart / Math.max(1, distance()));
      zoomBy(target / s.view.window);
      const pps = currentPps(canvas);
      if (pps > 0 && dx !== 0) panBy(-dx / pointers.size / pps);
      return;
    }
    travelled += Math.abs(dx) + Math.abs(dy);
    hold?.move(e.clientX, e.clientY);
    if (mode === 'menu' || mode === 'done' || travelled <= slop) return;
    endHold();
    if (mode === 'note') {
      if (!note) return;
      note.y = local(e).y;
      note.shift = e.shiftKey;
      note.alt = freeOf(e);
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
    endHold();
    if (mode === 'menu' || mode === 'done') {
      if (pointers.size === 0) mode = 'press';
      press = null;
      return;
    }
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
    if (pointers.size === 0 && !pinching && travelled <= slop && up && mode === 'press') {
      if (editorLayout()) {
        if (press) {
          lastClick = press;
          lastClickTune = selectedTune();
          clickAt(press.x, press.y, e.shiftKey || e.metaKey || e.ctrlKey || touchMods().add);
          // No hover on touch: a tap shows the line's voice, note and Hz (§11.3b).
          if (e.pointerType !== 'mouse') setHover(press.x, press.y);
        }
      } else togglePlay();
    }
    if (pointers.size === 0) {
      pinching = false;
      mode = 'press';
    }
  };

  const onWheel = (e: WheelEvent): void => {
    const w = wheelIntent(e);
    if (w.kind === 'zoom') {
      e.preventDefault();
      zoomBy(w.factor);
    } else if (w.kind === 'pan') {
      // Horizontal trackpad scroll, or Shift-wheel, pans.
      e.preventDefault();
      const pps = currentPps(canvas);
      if (pps > 0) panBy(w.px / pps);
    }
  };

  // Middle-button clicks would paste or open links on some systems.
  const onAux = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault();
  };
  // A finger leaving the canvas (after every tap) keeps the tap's readout; a mouse clears it.
  const onLeave = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') clearHover();
  };
  // A long press is the touch menu, not the browser's.
  const onContext = (e: MouseEvent): void => {
    const pt = (e as MouseEvent & { pointerType?: string }).pointerType;
    if (hold || mode === 'menu' || (pt !== undefined && pt !== 'mouse')) e.preventDefault();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('contextmenu', onContext);
  canvas.addEventListener('auxclick', onAux);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  return () => {
    stopFrames();
    endHold();
    if (note) endNote(true);
    endMarquee();
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('contextmenu', onContext);
    canvas.removeEventListener('auxclick', onAux);
    clearHover();
    canvas.removeEventListener('wheel', onWheel);
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
    // The poster workspace (M14) has no editor under it: only undo and redo reach here.
    if (workspaceShown()) return;
    // ⌘/Ctrl+C, X, V, A (./clipboard).
    if (!e.defaultPrevented && onClipboardKey(e)) return;
    // A key another handler already used (e.g. Escape closing a menu) is not an editor key.
    const ek = !e.defaultPrevented && editorLayout() ? editorKey(e) : null;
    if (ek) {
      if (ek.kind === 'loop') {
        if (toggleLoop()) e.preventDefault();
      } else if (ek.kind === 'add') {
        e.preventDefault();
        // At the pointer's time or the playhead (§11.3). Revision 6: a type with no effect there
        // is not added.
        const t = shortcutTime(e.altKey);
        if (playheadEffect(ek.type, t).effect) addMoment(ek.type, t);
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
    // The poster workspace (M14) takes Space as a dialog does: its controls keep it.
    const modal = document.querySelector('dialog[open]') !== null;
    const dialog = modal || workspaceShown();
    const own = dialog ? dialogSpace() : null;
    // The poster artboard pans on Space-drag (its release plays only if it didn't pan).
    const pan = !modal && workspaceShown() && document.querySelector('.artboard') !== null;
    const out = spaceKey(e, space, {
      editor: editorLayout(),
      dialog,
      dialogPlay: own !== null,
      pan,
    });
    if (!out.consume) return;
    e.preventDefault();
    e.stopPropagation();
    if (out.toggle) (own ?? togglePlay)();
  };
  const onBlur = (): void => {
    space.down = false;
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('keydown', onSpace, true);
  window.addEventListener('keyup', onSpace, true);
  window.addEventListener('blur', onBlur);
  const detachClipboard = attachClipboard();
  return () => {
    detachClipboard();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('keydown', onSpace, true);
    window.removeEventListener('keyup', onSpace, true);
    window.removeEventListener('blur', onBlur);
  };
}
