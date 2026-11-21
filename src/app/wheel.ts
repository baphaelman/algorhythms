/**
 * What a wheel event does on the time axis (score and lane rows): Ctrl/Cmd/Alt zooms; a
 * horizontal trackpad scroll, or the wheel with Shift, pans; a plain vertical wheel is left to
 * the browser (it scrolls the lane area when that overflows).
 */

export type WheelIntent =
  | { kind: 'zoom'; factor: number }
  /** Pan by `px` pixels of the time axis (positive: later). */
  | { kind: 'pan'; px: number }
  | { kind: 'none' };

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function wheelIntent(e: WheelLike): WheelIntent {
  const unit = e.deltaMode === 1 ? 16 : 1;
  if (e.ctrlKey || e.metaKey || e.altKey) {
    return { kind: 'zoom', factor: Math.exp(Math.max(-60, Math.min(60, e.deltaY * unit)) * 0.01) };
  }
  const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
  if (horizontal) return { kind: 'pan', px: e.deltaX * unit };
  if (e.shiftKey && e.deltaY !== 0) return { kind: 'pan', px: e.deltaY * unit };
  return { kind: 'none' };
}
