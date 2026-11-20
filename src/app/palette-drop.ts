/**
 * Drag from the moment palette (PLAN.md §11.3 "click or drag"): palette buttons are HTML5 drag
 * sources; the score canvas and the moment lane are drop targets. A drop adds that moment at the
 * time under the pointer, snapped like other adds (one undo entry, the new moment selected).
 */

import type { MomentType, Seconds } from '../core/types';
import { xToTime, type View } from '../render';
import { addMoment } from './editor/actions';
import { PALETTE, snapToGrid } from './editor/shortcuts';
import { onScoreFrame } from './loop';
import { usePlayer } from './store';

/** The drag data type carrying a moment type. */
export const MOMENT_MIME = 'application/x-algorhythms-moment';

const TYPES: ReadonlySet<string> = new Set(PALETTE.map((e) => e.type));

/** The moment type in a drag's data, or null. */
export function droppedType(data: string): MomentType | null {
  return TYPES.has(data) ? (data as MomentType) : null;
}

/** Drop time for `x` px from the target's left edge (aligned with the canvas), snapped. */
export function dropTime(view: View, x: number, gridBpm?: number): Seconds {
  return snapToGrid(xToTime(view, x), gridBpm);
}

/** Starts a palette drag of `type` (call from the button's dragstart). */
export function startPaletteDrag(e: DragEvent, type: MomentType): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(MOMENT_MIME, type);
  e.dataTransfer.effectAllowed = 'copy';
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
  const onOver = (e: DragEvent): void => {
    if (!carries(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    setOver(true);
  };
  const onLeave = (): void => setOver(false);
  const onDrop = (e: DragEvent): void => {
    setOver(false);
    if (!carries(e)) return;
    e.preventDefault();
    const type = droppedType(e.dataTransfer?.getData(MOMENT_MIME) ?? '');
    if (!type || !view) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left - el.clientLeft;
    addMoment(type, dropTime(view, x, usePlayer.getState().piece.view.gridBpm));
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
