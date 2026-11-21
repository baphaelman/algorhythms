/**
 * Touch editing for tablets (PLAN.md §11.3b): drag thresholds per pointer type, long-press, the
 * latched modifiers that stand in for Alt and Shift, and the long-press menu's state. Pointer
 * Events throughout, so mouse input is unchanged (a mouse never long-presses, and its slop stays).
 *
 * Latched modifiers (toggled in the long-press menu, shown as chips while on; ./ui/TouchMenu):
 * - `free`: Alt held: no snapping (times off the grid, pitches chromatic);
 * - `stagger`: Shift on a span-end drag: it edits the stagger, not the glide length;
 * - `add`: Shift for selection: taps add or remove, a lane background drag draws the marquee.
 */

import { create } from 'zustand';
import type { MomentId } from '../core/types';

/** Finger travel (px) before a press becomes a drag. */
export const TOUCH_SLOP = 10;
/** Hold time (ms) before a still press opens the menu. */
export const LONG_PRESS_MS = 500;
/** Max px between two taps for a double-tap (a mouse double-click allows less). */
export const DOUBLE_TAP_PX = 24;

/** Drag threshold for this pointer type: `mouse` px for a mouse or pen, at least TOUCH_SLOP for a finger. */
export function slopFor(pointerType: string, mouse: number): number {
  return pointerType === 'touch' ? Math.max(mouse, TOUCH_SLOP) : mouse;
}

/** True for a pointer that can long-press (a finger or a pen; never a mouse). */
export function canLongPress(pointerType: string): boolean {
  return pointerType === 'touch' || pointerType === 'pen';
}

export interface LongPress {
  /** True once the hold fired. */
  readonly fired: boolean;
  /** Feeds a pointer position; moving past TOUCH_SLOP cancels the hold. */
  move(x: number, y: number): void;
  cancel(): void;
}

/**
 * Starts timing a long press at `e` (client px); `fire` runs once it is held still for
 * LONG_PRESS_MS. Null for a mouse.
 */
export function startLongPress(e: PointerEvent, fire: () => void): LongPress | null {
  if (!canLongPress(e.pointerType)) return null;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const lp = {
    fired: false,
    move(x: number, y: number): void {
      if (timer !== null && Math.hypot(x - x0, y - y0) > TOUCH_SLOP) lp.cancel();
    },
    cancel(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
  timer = setTimeout(() => {
    timer = null;
    lp.fired = true;
    fire();
  }, LONG_PRESS_MS);
  return lp;
}

export interface TouchMods {
  free: boolean;
  stagger: boolean;
  add: boolean;
}

export const useTouchMods = create<TouchMods>()(() => ({
  free: false,
  stagger: false,
  add: false,
}));

export function touchMods(): TouchMods {
  return useTouchMods.getState();
}

export function setTouchMod(k: keyof TouchMods, on: boolean): void {
  useTouchMods.setState({ [k]: on });
}

/** Alt held, or snapping latched off. */
export function freeOf(e: { altKey: boolean }): boolean {
  return e.altKey || touchMods().free;
}

/** What the long-press menu is open on: a moment (or the piece key), else the background. */
export interface TouchMenuAt {
  x: number;
  y: number;
  id: MomentId | null;
}

export const useTouchMenu = create<{ at: TouchMenuAt | null }>()(() => ({ at: null }));

export function openTouchMenu(x: number, y: number, id: MomentId | null): void {
  useTouchMenu.setState({ at: { x, y, id } });
}

export function closeTouchMenu(): void {
  if (useTouchMenu.getState().at) useTouchMenu.setState({ at: null });
}
