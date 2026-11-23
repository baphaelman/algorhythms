/**
 * Drag from the moment palette (PLAN.md §11.3 "click or drag"): palette buttons are HTML5 drag
 * sources; the score canvas and the moment lane are drop targets. A drop adds that moment at the
 * time under the pointer, snapped to a nearby note change (revision 7) and, with "Snap to beats",
 * to a beat (revision 9; Alt: free); one undo entry, the new moment selected.
 *
 * While a drag is over a target, the score previews the moment at the pointer's drop time
 * (../preview.ts, owner 2026-11-21): ghost lines from that time, updated as the pointer moves.
 * Leaving the target, Escape or ending the drag clears it; after Escape the drop is ignored.
 *
 * Shortcuts add at the same snapped time under a mouse or pen over the score, ruler or lane rows
 * (owner 2026-11-23; `trackPointer`, `shortcutTime`), else at the playhead.
 */

import type { MomentType, Seconds } from '../core/types';
import { xToTime, type View } from '../render';
import { addMoment } from './editor/actions';
import { PALETTE, playheadTime } from './editor/shortcuts';
import { beatStep, changePoints, snapTime, type SnapSet } from './editor/snap';
import { onScoreFrame } from './loop';
import { previewState, startPreview, stopPreview } from './preview';
import { usePlayer } from './store';

/** The drag data type carrying a moment type. */
export const MOMENT_MIME = 'application/x-algorhythms-moment';

const TYPES: ReadonlySet<string> = new Set(PALETTE.map((e) => e.type));

/** The moment type in a drag's data, or null. */
export function droppedType(data: string): MomentType | null {
  return TYPES.has(data) ? (data as MomentType) : null;
}

/** Drop time for `x` px from the target's left edge (aligned with the canvas), snapped. */
export function dropTime(view: View, x: number, snaps: SnapSet, alt = false): Seconds {
  return snapTime(xToTime(view, x), snaps, view.pps, alt);
}

/** The drop time `x` px from the canvas's left edge in the current piece, snapped (Alt: free). */
function snappedAt(view: View, x: number, alt: boolean): Seconds {
  const { compiled, piece } = usePlayer.getState();
  return dropTime(
    view,
    x,
    { points: changePoints(compiled, piece), grid: beatStep(piece.view) },
    alt,
  );
}

/** `clientX` as px from `el`'s content left edge (aligned with the canvas). */
const xIn = (el: HTMLElement, clientX: number): number =>
  clientX - el.getBoundingClientRect().left - el.clientLeft;

/**
 * The last mouse or pen position over a tracked area (score, ruler, lane rows): the area's
 * x-reference and the pointer's clientX; `box` null when the pointer is elsewhere. Written per
 * move without any render (§11.3a). `view` is the latest score camera.
 */
const hover = { box: null as HTMLElement | null, clientX: 0, view: null as View | null };

/**
 * Tracks the pointer over `el` for `shortcutTime`; `box` is the element whose left edge lines up
 * with the canvas (default `el`). Touch is ignored. Returns a function that removes the handlers.
 */
export function trackPointer(el: HTMLElement, box: HTMLElement = el): () => void {
  const off = onScoreFrame((v) => {
    hover.view = v;
  });
  const onMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return;
    hover.box = box;
    hover.clientX = e.clientX;
  };
  const onLeave = (): void => {
    if (hover.box === box) hover.box = null;
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerover', onMove);
  el.addEventListener('pointerleave', onLeave);
  return () => {
    off();
    onLeave();
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerover', onMove);
    el.removeEventListener('pointerleave', onLeave);
  };
}

/** The snapped time under the tracked pointer (Alt: free), or null when it is elsewhere. */
export function pointerTime(alt = false): Seconds | null {
  const { box, view } = hover;
  return box && view ? snappedAt(view, xIn(box, hover.clientX), alt) : null;
}

/** Where a moment shortcut adds: the time under the pointer, else the playhead. */
export function shortcutTime(alt = false): Seconds {
  return pointerTime(alt) ?? playheadTime();
}

/** The palette drag in progress: its type, and whether Escape cancelled it. */
const drag = { type: null as MomentType | null, cancelled: false, t: NaN as Seconds };

const onEscape = (e: KeyboardEvent): void => {
  if (e.key !== 'Escape' || drag.type === null) return;
  drag.cancelled = true;
  clearDragPreview();
};

function clearDragPreview(): void {
  drag.t = NaN;
  if (previewState.drag) stopPreview();
}

/** Starts a palette drag of `type` (call from the button's dragstart). */
export function startPaletteDrag(e: DragEvent, type: MomentType): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(MOMENT_MIME, type);
  e.dataTransfer.effectAllowed = 'copy';
  drag.type = type;
  drag.cancelled = false;
  drag.t = NaN;
  document.addEventListener('keydown', onEscape, true);
}

/** Ends the palette drag (call from the button's dragend): clears its preview. */
export function endPaletteDrag(): void {
  drag.type = null;
  drag.cancelled = false;
  clearDragPreview();
  document.removeEventListener('keydown', onEscape, true);
}

/** Shows (or moves) the drag preview at drop time `t`; recompiles only when `t` changes. */
function showDragPreview(type: MomentType, t: Seconds): void {
  if (drag.cancelled || (t === drag.t && previewState.drag)) return;
  drag.t = t;
  if (!startPreview(type, t, true)) clearDragPreview();
}

const carries = (e: DragEvent): boolean =>
  !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(MOMENT_MIME);

/**
 * Makes `el` (the canvas or the lane track, both horizontally aligned with the score view) accept
 * palette drops. Returns a function that removes the handlers.
 */
export function attachPaletteDrop(el: HTMLElement): () => void {
  let view: View | null = null;
  const off = onScoreFrame((v) => {
    view = v;
  });
  const setOver = (on: boolean): void => {
    if (on) el.dataset.paletteDrop = '';
    else delete el.dataset.paletteDrop;
  };
  /** The drop time under the pointer, snapped; null without a view. */
  const timeAt = (e: DragEvent): Seconds | null =>
    view ? snappedAt(view, xIn(el, e.clientX), e.altKey) : null;
  const onOver = (e: DragEvent): void => {
    if (!carries(e)) return;
    e.preventDefault();
    if (drag.cancelled) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      return;
    }
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    setOver(true);
    const t = drag.type ? timeAt(e) : null;
    if (drag.type && t !== null) showDragPreview(drag.type, t);
  };
  const onLeave = (e: DragEvent): void => {
    // Moving onto a child of the target is not leaving it.
    if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
    setOver(false);
    clearDragPreview();
  };
  const onDrop = (e: DragEvent): void => {
    setOver(false);
    clearDragPreview();
    if (!carries(e)) return;
    e.preventDefault();
    if (drag.cancelled) return;
    const type = droppedType(e.dataTransfer?.getData(MOMENT_MIME) ?? '');
    const t = timeAt(e);
    if (!type || t === null) return;
    addMoment(type, t);
  };
  el.addEventListener('dragenter', onOver);
  el.addEventListener('dragover', onOver);
  el.addEventListener('dragleave', onLeave);
  el.addEventListener('drop', onDrop);
  return () => {
    off();
    el.removeEventListener('dragenter', onOver);
    el.removeEventListener('dragover', onOver);
    el.removeEventListener('dragleave', onLeave);
    el.removeEventListener('drop', onDrop);
  };
}
