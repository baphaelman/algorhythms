import { beforeEach, describe, expect, it, vi } from 'vitest';

// The timeline's pinch (PLAN §11.4 "Zoom", owner 2026-11-24): Safari's gesture events and the
// ctrl-wheels nothing under the pointer handled zoom the editor and never the page.
const h = vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = new EventTarget();
  return { view: { window: 20 }, zoomBy: vi.fn() };
});
vi.mock('../../../src/app/store', () => ({
  usePlayer: { getState: () => ({ view: h.view }) },
  zoomBy: (f: number) => {
    h.zoomBy(f);
    h.view.window *= f;
  },
}));

import { attachPinchZoom } from '../../../src/app/pinch-zoom';

function ev(type: string, props: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(type, { cancelable: true, bubbles: true }), props);
}
const wheel = (props: Record<string, unknown>) =>
  ev('wheel', {
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...props,
  });

describe('pinch zoom over the timeline', () => {
  let el: EventTarget;
  beforeEach(() => {
    h.view.window = 20;
    h.zoomBy.mockClear();
    el = new EventTarget();
    attachPinchZoom(el as unknown as HTMLElement);
  });

  it("Safari's gesture pinch zooms the editor and prevents the page zoom", () => {
    const start = ev('gesturestart', { scale: 1 });
    el.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(true);
    const change = ev('gesturechange', { scale: 2 });
    el.dispatchEvent(change);
    expect(change.defaultPrevented).toBe(true);
    expect(h.view.window).toBeCloseTo(10);
    // Scale is relative to the gesture's start.
    el.dispatchEvent(ev('gesturechange', { scale: 0.5 }));
    expect(h.view.window).toBeCloseTo(40);
    const end = ev('gestureend', { scale: 0.5 });
    el.dispatchEvent(end);
    expect(end.defaultPrevented).toBe(true);
  });

  it('a touch pinch (iPad) leaves the zoom to its pointers', () => {
    el.dispatchEvent(ev('pointerdown', { pointerType: 'touch', pointerId: 1 }));
    el.dispatchEvent(ev('gesturestart', { scale: 1 }));
    const change = ev('gesturechange', { scale: 2 });
    el.dispatchEvent(change);
    expect(change.defaultPrevented).toBe(true);
    expect(h.zoomBy).not.toHaveBeenCalled();
    window.dispatchEvent(ev('pointerup', { pointerType: 'touch', pointerId: 1 }));
    el.dispatchEvent(ev('gesturechange', { scale: 2 }));
    expect(h.view.window).toBeCloseTo(10);
  });

  it('ctrl- and ⌘-wheels zoom unless a handler under the pointer already did', () => {
    const pinch = wheel({ ctrlKey: true, deltaY: -10 });
    el.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(true);
    expect(h.zoomBy).toHaveBeenCalledTimes(1);
    expect(h.view.window).toBeLessThan(20);
    el.dispatchEvent(wheel({ metaKey: true, deltaY: 10 }));
    expect(h.zoomBy).toHaveBeenCalledTimes(2);

    const handled = wheel({ ctrlKey: true, deltaY: -10 });
    handled.preventDefault();
    el.dispatchEvent(handled);
    expect(h.zoomBy).toHaveBeenCalledTimes(2);

    // A plain wheel is left alone (it scrolls the page or the lanes).
    const plain = wheel({ deltaY: 40 });
    el.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(h.zoomBy).toHaveBeenCalledTimes(2);
  });
});
