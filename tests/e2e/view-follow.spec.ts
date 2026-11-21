/**
 * M4.5 camera (PLAN.md §10 "Camera (revision 5)", §15 M4.5): the Follow toggle (Smooth holds the
 * playhead at 35 %, Page jumps at 92 % to 8 %, Off never moves), a pan during playback turns
 * Follow off, the zoom controls (−/+, Fit, keys) keep the playhead's x, and the future is dimmed.
 * Reads the loop's per-frame camera from `window.__algorhythms.frameStats`.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

async function openApp(page: Page): Promise<void> {
  await page.goto('./');
  await expect(page.getByTestId('play')).toBeVisible();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
}

const cam = (page: Page) =>
  page.evaluate(() => {
    const f = window.__algorhythms!.frameStats;
    const s = window.__algorhythms!.store.getState();
    return {
      start: f.start,
      window: f.window,
      head: f.head,
      ghost: f.ghost,
      follow: s.view.follow,
      duration: s.compiled.duration,
      status: s.transport.status,
    };
  });

/** Samples the per-frame camera for `ms` milliseconds. */
const sample = (page: Page, ms: number) =>
  page.evaluate(
    (dur) =>
      new Promise<{ start: number; head: number }[]>((resolve) => {
        const out: { start: number; head: number }[] = [];
        const t0 = performance.now();
        const tick = (): void => {
          const f = window.__algorhythms!.frameStats;
          out.push({ start: f.start, head: f.head });
          if (performance.now() - t0 < dur) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

async function playFrom(page: Page, t: number): Promise<void> {
  await seek(page, t);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  // The engine has started, so the time is advancing.
  await page.waitForFunction(() => window.__algorhythms?.engine()?.isPlaying === true, null, {
    timeout: 10_000,
  });
}

test('Follow: Smooth holds the playhead at 35 %, Page jumps at 92 % to 8 %, Off stays', async ({
  page,
}) => {
  await openApp(page);
  await expect(page.locator('[data-follow="smooth"]')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('window-slider').fill('150'); // a few seconds wide
  const { window: w } = await cam(page);
  expect(w).toBeLessThan(5);

  await playFrom(page, 40);
  await expect.poll(async () => (await cam(page)).head).toBeCloseTo(0.35, 2);
  for (const f of await sample(page, 600)) expect(Math.abs(f.head - 0.35)).toBeLessThan(0.01);

  await page.locator('[data-follow="page"]').click();
  await expect(page.locator('[data-follow="page"]')).toHaveAttribute('aria-pressed', 'true');
  const paged = await sample(page, w * 1000 * 1.5);
  const starts = new Set(paged.map((f) => f.start));
  // The view holds still between page turns, and turns at least once.
  expect(starts.size).toBeGreaterThan(1);
  expect(starts.size).toBeLessThan(6);
  for (const f of paged) expect(f.head).toBeLessThan(0.93);
  // Each turn lands the playhead near 8 %.
  for (let i = 1; i < paged.length; i++) {
    if (paged[i].start !== paged[i - 1].start) expect(paged[i].head).toBeLessThan(0.15);
  }

  await page.locator('[data-follow="off"]').click();
  const off = await sample(page, 800);
  expect(new Set(off.map((f) => f.start)).size).toBe(1);
  expect(off[off.length - 1].head).toBeGreaterThan(off[0].head);
});

test('a middle-button drag on the score during playback pans and turns Follow off', async ({
  page,
}) => {
  await openApp(page);
  await page.getByTestId('window-slider').fill('400');
  await playFrom(page, 30);
  const box = (await page.getByTestId('stage').boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 300, y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(box.x + 600, y, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  const c = await cam(page);
  expect(c.status).toBe('playing'); // a drag is not a click
  expect(c.follow).toBe('off');
  await expect(page.locator('[data-follow="off"]')).toHaveAttribute('aria-pressed', 'true');
  const still = await sample(page, 500);
  expect(new Set(still.map((f) => f.start)).size).toBe(1);
});

test('zoom: −/+, Fit and keys; the playhead keeps its x; the future is dimmed', async ({
  page,
}) => {
  await openApp(page);
  await seek(page, 60);
  await page.getByTestId('window-slider').fill('500');
  await frames(page);
  const a = await cam(page);
  expect(a.head).toBeCloseTo(0.35, 3); // a seek in Smooth puts the playhead at 35 %

  await page.getByTestId('zoom-in').click();
  await frames(page);
  const b = await cam(page);
  expect(b.window).toBeCloseTo(a.window * 0.8, 3);
  expect(b.head).toBeCloseTo(a.head, 3);

  await page.getByTestId('zoom-out').click();
  await page.getByTestId('zoom-out').click();
  await frames(page);
  const c = await cam(page);
  expect(c.window).toBeCloseTo(a.window * 1.25, 3);
  expect(c.head).toBeCloseTo(a.head, 3);

  await page.locator('body').click({ position: { x: 3, y: 3 } });
  await page.keyboard.press('=');
  await frames(page);
  const d = await cam(page);
  expect(d.window).toBeCloseTo(a.window, 3);
  expect(d.head).toBeCloseTo(a.head, 3);

  await page.getByTestId('zoom-fit').click();
  await frames(page);
  const fit = await cam(page);
  expect(fit.window).toBeCloseTo(fit.duration, 3);
  expect(fit.start).toBe(0);
  await expect(page.getByTestId('zoom-fit')).toHaveAttribute('aria-pressed', 'true');
  // The canvas is open-ended: zooming out past Fit is allowed.
  await expect(page.getByTestId('zoom-out')).toBeEnabled();

  // At Fit nothing scrolls during playback; the future is dimmed to 0.35.
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => (await cam(page)).ghost, { timeout: 3000 }).toBe(0.35);
  const still = await sample(page, 400);
  expect(new Set(still.map((f) => f.start))).toEqual(new Set([0]));
});
