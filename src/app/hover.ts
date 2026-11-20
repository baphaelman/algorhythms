/**
 * Pointer position for the score view's hover readout (PLAN.md §11.3). canvas-input writes it,
 * the animation loop hit-tests it against the frame it drew. Mouse only: nothing essential
 * depends on hover.
 */

export const hoverPointer = {
  /** Pointer position in canvas CSS px. */
  x: 0,
  y: 0,
  /** False when the pointer is off the canvas, pressed, or not a mouse. */
  on: false,
  /** Bumped on every change, so the loop re-tests without redrawing. */
  version: 0,
};

export function setHover(x: number, y: number): void {
  hoverPointer.x = x;
  hoverPointer.y = y;
  hoverPointer.on = true;
  hoverPointer.version++;
}

export function clearHover(): void {
  if (!hoverPointer.on) return;
  hoverPointer.on = false;
  hoverPointer.version++;
}
