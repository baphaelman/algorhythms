/**
 * Trackpad pinch on Mac (PLAN.md §11.4 "Zoom", owner 2026-11-24): a pinch (ctrl-wheel in Chrome
 * and Firefox) anywhere over the score or the lanes, including over a hovered line's dots and
 * readout, zooms the editor and prevents the page zoom; outside the editor it is left alone.
 * Safari's gesture events: tests/unit/app/pinch-zoom.test.ts, plus a dispatched gesturechange here.
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

const viewWindow = (page: Page): Promise<number> =>
  page.evaluate(() => window.__algorhythms!.store.getState().view.window);

/** Dispatches a pinch-out ctrl-wheel on `target` (or the element at x, y): what it hit, and prevented. */
function pinchOn(
  page: Page,
  at: { x: number; y: number } | { selector: string },
): Promise<{ target: string; prevented: boolean }> {
  return page.evaluate((at) => {
    const t =
      'selector' in at
        ? document.querySelector(at.selector)!
        : document.elementFromPoint(at.x, at.y)!;
    const r = t.getBoundingClientRect();
    const e = new WheelEvent('wheel', {
      deltaY: -30,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      clientX: 'x' in at ? at.x : r.left + r.width / 2,
      clientY: 'y' in at ? at.y : r.top + r.height / 2,
    });
    t.dispatchEvent(e);
    return {
      target: `${t.tagName.toLowerCase()}${t.className ? `.${String(t.className).split(' ')[0]}` : ''}`,
      prevented: e.defaultPrevented,
    };
  }, at);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test('a pinch over a hovered line, its dots and readout zooms the editor, not the page', async ({
  page,
}) => {
  const canvas = page.locator('#score');
  const tip = page.getByTestId('score-hover');
  const box = (await canvas.boundingBox())!;
  // Hover a line: walk a column until the readout shows.
  let at: { x: number; y: number } | null = null;
  for (const fx of [0.3, 0.5, 0.7]) {
    const x = box.x + box.width * fx;
    for (let y = box.y + 20; y < box.y + box.height - 20 && !at; y += 3) {
      await page.mouse.move(x, y);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      if (await tip.isVisible()) at = { x, y };
    }
    if (at) break;
  }
  expect(at).not.toBeNull();

  const before = await viewWindow(page);
  const hit = await pinchOn(page, at!);
  expect(hit.prevented, hit.target).toBe(true);
  await expect.poll(() => viewWindow(page)).toBeLessThan(before);

  // Everything drawn over the score and the lanes zooms too, never the page.
  for (const selector of [
    '[data-testid="score-hover"]',
    '.walk-dot',
    '[data-testid="piano-ruler"]',
    '[data-testid="ruler"]',
    '[data-testid="playhead"]',
    '[data-testid="lane"] .lane-label',
    '[data-testid="lane-scroll"]',
  ]) {
    const w = await viewWindow(page);
    const r = await pinchOn(page, { selector });
    expect(r.prevented, selector).toBe(true);
    await expect.poll(() => viewWindow(page), { message: selector }).toBeLessThan(w);
  }

  // Safari's pinch: gesture events over the lanes zoom too (out: the window is near its 2 s floor).
  const w = await viewWindow(page);
  const gesture = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="lane"] .lane-label')!;
    const fire = (type: string, scale: number) => {
      const e = Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale });
      t.dispatchEvent(e);
      return e.defaultPrevented;
    };
    return [fire('gesturestart', 1), fire('gesturechange', 0.5), fire('gestureend', 0.5)];
  });
  expect(gesture).toEqual([true, true, true]);
  await expect.poll(() => viewWindow(page)).toBeGreaterThan(w * 1.6);

  // Outside the editor the browser keeps its page zoom.
  const outside = await pinchOn(page, { selector: '[data-testid="inspector"]' });
  expect(outside.prevented).toBe(false);
});

test("a pinch with the pointer on a line's hover dot zooms the editor", async ({ page }) => {
  // Kite Day's walk shows hover dots on its line; find one with nothing drawn over it.
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  const dot = await page.evaluate(async () => {
    const c = document.getElementById('score')!;
    const r = c.getBoundingClientRect();
    const frame = () => new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(d)));
    for (let x = r.left + 60; x < r.right - 20; x += 12)
      for (let y = r.top + 10; y < r.bottom - 10; y += 8) {
        c.dispatchEvent(
          new PointerEvent('pointermove', { clientX: x, clientY: y, pointerType: 'mouse' }),
        );
        await frame();
        for (const d of document.querySelectorAll<HTMLElement>('.walk-dot.hover-dot')) {
          if (d.hidden) continue;
          const b = d.getBoundingClientRect();
          const at = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
          if (document.elementFromPoint(at.x, at.y) === d) return at;
        }
      }
    return null;
  });
  expect(dot).not.toBeNull();
  await page.mouse.move(dot!.x, dot!.y);
  const before = await viewWindow(page);
  const hit = await pinchOn(page, dot!);
  expect(hit.target).toBe('button.walk-dot');
  expect(hit.prevented).toBe(true);
  await expect.poll(() => viewWindow(page)).toBeLessThan(before);
});
