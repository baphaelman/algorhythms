import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOUBLE_PX, isDoublePress } from '../../../src/app/editor/note-points';
import {
  DOUBLE_TAP_PX,
  LONG_PRESS_MS,
  TOUCH_SLOP,
  closeTouchMenu,
  freeOf,
  openTouchMenu,
  setTouchMod,
  slopFor,
  startLongPress,
  useTouchMenu,
} from '../../../src/app/touch';

const press = (pointerType: string, x = 0, y = 0) =>
  ({ pointerType, clientX: x, clientY: y }) as PointerEvent;

afterEach(() => {
  vi.useRealTimers();
  setTouchMod('free', false);
  closeTouchMenu();
});

describe('touch input (§11.3b)', () => {
  it('a finger needs more travel before a drag; mouse and pen keep theirs', () => {
    expect(slopFor('mouse', 3)).toBe(3);
    expect(slopFor('pen', 3)).toBe(3);
    expect(slopFor('touch', 3)).toBe(TOUCH_SLOP);
    expect(slopFor('touch', 20)).toBe(20);
  });

  it('a long press fires after the hold, never for a mouse, and moving cancels it', () => {
    vi.useFakeTimers();
    expect(startLongPress(press('mouse'), () => undefined)).toBeNull();
    const fire = vi.fn();
    const lp = startLongPress(press('touch', 100, 100), fire)!;
    lp.move(105, 104);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fire).toHaveBeenCalledOnce();
    expect(lp.fired).toBe(true);
    const moved = vi.fn();
    const lp2 = startLongPress(press('pen', 0, 0), moved)!;
    lp2.move(TOUCH_SLOP + 1, 0);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(moved).not.toHaveBeenCalled();
    expect(lp2.fired).toBe(false);
  });

  it('Snap off latches Alt', () => {
    expect(freeOf({ altKey: false })).toBe(false);
    expect(freeOf({ altKey: true })).toBe(true);
    setTouchMod('free', true);
    expect(freeOf({ altKey: false })).toBe(true);
  });

  it('the menu opens at a point on a moment and closes', () => {
    openTouchMenu(10, 20, 'abcdef');
    expect(useTouchMenu.getState().at).toEqual({ x: 10, y: 20, id: 'abcdef' });
    closeTouchMenu();
    expect(useTouchMenu.getState().at).toBeNull();
  });

  it('a double tap allows more distance than a double-click', () => {
    const a = { x: 0, y: 0, time: 0 };
    const b = { x: 15, y: 0, time: 200 };
    expect(isDoublePress(a, b)).toBe(false);
    expect(isDoublePress(a, b, DOUBLE_TAP_PX)).toBe(true);
    expect(DOUBLE_TAP_PX).toBeGreaterThan(DOUBLE_PX);
  });
});
