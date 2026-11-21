import type { Page } from '@playwright/test';

/**
 * Touch gestures for the e2e specs (PLAN.md §11.3b). Playwright only taps, so:
 * - Chromium: real touches through CDP `Input.dispatchTouchEvent` (the browser makes the pointer
 *   events, honouring `touch-action`, as on a tablet);
 * - Firefox and WebKit: synthetic `PointerEvent`s with `pointerType: 'touch'`, sent to the element
 *   under the first point and then to the same element (a touch's implicit capture). Pointer
 *   capture on those made-up pointer ids is a no-op (`installTouch`).
 * Button taps use `locator.tap` (a real tap and click in every engine). `fingerTap` taps a point
 * for the pointer handlers: a real tap, except on WebKit, whose emulated taps may not make pointer
 * events (synthetic there).
 */

export interface Pt {
  x: number;
  y: number;
}

/** Call before `page.goto`: lets the synthetic pointers' capture calls pass. */
export async function installTouch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proto = Element.prototype;
    const set = proto.setPointerCapture;
    const release = proto.releasePointerCapture;
    proto.setPointerCapture = function (id: number) {
      try {
        set.call(this, id);
      } catch {
        // A synthetic pointer (tests): implicit capture is emulated by the sender.
      }
    };
    proto.releasePointerCapture = function (id: number) {
      try {
        release.call(this, id);
      } catch {
        // As above.
      }
    };
  });
}

const cdp = new WeakMap<Page, Promise<import('@playwright/test').CDPSession>>();
const session = (page: Page) => {
  let s = cdp.get(page);
  if (!s) {
    s = page.context().newCDPSession(page);
    cdp.set(page, s);
  }
  return s;
};
const isChromium = (page: Page): boolean =>
  page.context().browser()?.browserType().name() === 'chromium';

type Phase = 'down' | 'move' | 'up';

/**
 * One step of a gesture: every finger's position (index = finger). A `down` presses the fingers
 * from `from` on (the others are already down).
 */
async function send(page: Page, phase: Phase, pts: Pt[], from = 0): Promise<void> {
  if (isChromium(page)) {
    const s = await session(page);
    const type = phase === 'down' ? 'touchStart' : phase === 'move' ? 'touchMove' : 'touchEnd';
    await s.send('Input.dispatchTouchEvent', {
      type,
      touchPoints:
        phase === 'up'
          ? []
          : pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1, radiusX: 4, radiusY: 4 })),
    });
    return;
  }
  await page.evaluate(
    ({ phase, pts, from }) => {
      const w = window as unknown as { __touchTargets?: Map<number, EventTarget> };
      const targets = (w.__touchTargets ??= new Map());
      pts.forEach((p, i) => {
        if (phase === 'down' && i < from) return;
        const id = 101 + i;
        if (phase === 'down') targets.set(id, document.elementFromPoint(p.x, p.y) ?? document.body);
        const t = targets.get(id);
        if (!t) return;
        const type =
          phase === 'down' ? 'pointerdown' : phase === 'move' ? 'pointermove' : 'pointerup';
        t.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: 'touch',
            isPrimary: i === 0,
            clientX: p.x,
            clientY: p.y,
            button: phase === 'move' ? -1 : 0,
            buttons: phase === 'up' ? 0 : 1,
            width: 8,
            height: 8,
            pressure: phase === 'up' ? 0 : 0.5,
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
        if (phase === 'up') targets.delete(id);
      });
    },
    { phase, pts, from },
  );
}

/** Interpolates each finger from `from[i]` to `to[i]` in `steps` moves. */
async function glide(page: Page, from: Pt[], to: Pt[], steps: number): Promise<void> {
  for (let k = 1; k <= steps; k++) {
    const f = k / steps;
    await send(
      page,
      'move',
      from.map((p, i) => ({ x: p.x + (to[i].x - p.x) * f, y: p.y + (to[i].y - p.y) * f })),
    );
    await page.waitForTimeout(16);
  }
}

/** One finger: down at `from`, drag to `to`, lift. */
export async function touchDrag(page: Page, from: Pt, to: Pt, steps = 8): Promise<void> {
  await send(page, 'down', [from]);
  await page.waitForTimeout(30);
  await glide(page, [from], [to], steps);
  await send(page, 'up', [to]);
}

/** One finger held still at `p` for `ms` (a long press), then lifted. */
export async function longPress(page: Page, p: Pt, ms = 750): Promise<void> {
  await send(page, 'down', [p]);
  await page.waitForTimeout(ms);
  await send(page, 'up', [p]);
}

/** Two fingers: from `a0`/`b0` to `a1`/`b1` (pinch and two-finger pan). */
export async function twoFinger(
  page: Page,
  a0: Pt,
  b0: Pt,
  a1: Pt,
  b1: Pt,
  steps = 8,
): Promise<void> {
  await send(page, 'down', [a0]);
  await send(page, 'down', [a0, b0], 1);
  await page.waitForTimeout(30);
  await glide(page, [a0, b0], [a1, b1], steps);
  await send(page, 'up', [a1, b1]);
}

/** A tap at `p` that the pointer handlers see (lane items, the score). */
export async function fingerTap(page: Page, p: Pt): Promise<void> {
  if (page.context().browser()?.browserType().name() !== 'webkit') {
    await page.touchscreen.tap(p.x, p.y);
    return;
  }
  await send(page, 'down', [p]);
  await send(page, 'up', [p]);
}
