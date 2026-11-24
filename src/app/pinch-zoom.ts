/**
 * Trackpad pinch and ⌘/Ctrl-scroll over the whole timeline (PLAN.md §11.4 "Zoom", owner
 * 2026-11-24): the score, the lanes, the ruler and everything drawn over them (arrival dots, the
 * piano ruler, the playhead, the loop region, row labels) zoom the editor, never the page.
 *
 * Chrome and Firefox report a pinch as a ctrl-wheel: the score canvas and the lane area zoom (and
 * pan) on their own wheel handlers; this catches the zoom wheels they leave unhandled (an element
 * over them was the target). Safari reports it as gesture events, handled here only. A touch pinch
 * (iPad) fires gesture events too, but its pointers already zoom, so they are ignored then.
 */

import { usePlayer, zoomBy } from './store';
import { wheelIntent } from './wheel';

type GestureEvent = Event & { scale?: number };

export function attachPinchZoom(el: HTMLElement): () => void {
  const touches = new Set<number>();
  let startWindow = 0;

  const onWheel = (e: WheelEvent): void => {
    if (e.defaultPrevented) return;
    const w = wheelIntent(e);
    if (w.kind !== 'zoom') return;
    e.preventDefault();
    zoomBy(w.factor);
  };
  const onGestureStart = (e: Event): void => {
    e.preventDefault();
    startWindow = usePlayer.getState().view.window;
  };
  const onGestureChange = (e: GestureEvent): void => {
    e.preventDefault();
    if (touches.size > 0 || !(startWindow > 0)) return;
    const scale = e.scale ?? 1;
    zoomBy(startWindow / Math.max(0.05, scale) / usePlayer.getState().view.window);
  };
  const onGestureEnd = (e: Event): void => e.preventDefault();
  const onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') touches.add(e.pointerId);
  };
  const onUp = (e: PointerEvent): void => {
    touches.delete(e.pointerId);
  };

  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('gesturestart', onGestureStart);
  el.addEventListener('gesturechange', onGestureChange);
  el.addEventListener('gestureend', onGestureEnd);
  el.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  return () => {
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('gesturestart', onGestureStart);
    el.removeEventListener('gesturechange', onGestureChange);
    el.removeEventListener('gestureend', onGestureEnd);
    el.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
  };
}
