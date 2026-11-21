/**
 * M4.5 ruler and playhead (PLAN.md §10 "Camera (revision 5)", Drawing rules 5; §11.2; §15 M4.5):
 * clicking or dragging the ruler seeks; one DOM playhead spans the ruler, score and lane; ruler
 * ticks and the playhead sit on the score's axis within 1 px at several zooms while following;
 * the scrubber exists only in the player layout.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

async function openApp(page: Page): Promise<void> {
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('play')).toBeVisible();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
}

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

const state = (page: Page) =>
  page.evaluate(() => {
    const s = window.__algorhythms!.store.getState();
    const f = window.__algorhythms!.frameStats;
    return {
      status: s.transport.status,
      scrubbing: s.transport.scrubbing,
      start: f.start,
      window: f.window,
    };
  });

const shownTime = async (page: Page): Promise<number> => {
  const [m, s] = (await page.getByTestId('time').textContent())!.split(':');
  return Number(m) * 60 + Number(s);
};

/** One frame's geometry, read right after the loop drew it. */
const geometry = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{
        start: number;
        window: number;
        head: number;
        canvasLeft: number;
        width: number;
        ticks: { t: number; x: number }[];
        playheadX: number;
      }>((resolve) =>
        requestAnimationFrame(() => {
          const f = window.__algorhythms!.frameStats;
          const c = document.querySelector('#score')!.getBoundingClientRect();
          const ticks = [
            ...document.querySelectorAll<HTMLElement>('.ruler-tick:not([hidden])'),
          ].map((el) => ({ t: Number(el.dataset.t), x: el.getBoundingClientRect().left }));
          const p = document.querySelector('[data-testid=playhead]')!.getBoundingClientRect();
          resolve({
            start: f.start,
            window: f.window,
            head: f.head,
            canvasLeft: c.left,
            width: c.width,
            ticks,
            playheadX: p.left + p.width / 2,
          });
        }),
      ),
  );

test('the editor has a ruler and playhead and no scrubber; the player keeps its scrubber', async ({
  page,
}) => {
  await openApp(page);
  await expect(page.getByTestId('ruler')).toBeVisible();
  await expect(page.getByTestId('playhead')).toBeVisible();
  await expect(page.getByTestId('scrubber')).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.app')).toHaveAttribute('data-layout', 'player');
  await expect(page.getByTestId('scrubber')).toBeVisible();
  await expect(page.getByTestId('ruler')).toHaveCount(0);
  await expect(page.getByTestId('playhead')).toHaveCount(0);
});

test('clicking and dragging the ruler seeks; the view holds still', async ({ page }) => {
  await openApp(page);
  await seek(page, 60);
  await page.getByTestId('window-slider').fill('400');
  await frames(page);
  const ruler = (await page.getByTestId('ruler').boundingBox())!;
  const canvas = (await page.locator('#score').boundingBox())!;
  const y = ruler.y + ruler.height / 2;
  const a = await state(page);
  const timeAt = (x: number) => a.start + ((x - canvas.x) / canvas.width) * a.window;

  // Click.
  const x1 = canvas.x + canvas.width * 0.7;
  await page.mouse.click(x1, y);
  await frames(page);
  expect(await shownTime(page)).toBeCloseTo(timeAt(x1), 0);
  const b = await state(page);
  expect(b.status).toBe('paused');
  expect(b.scrubbing).toBe(false);
  expect(b.start).toBe(a.start);

  // Drag: silent scrub while held, seeks to the release point.
  const x2 = canvas.x + canvas.width * 0.2;
  await page.mouse.move(x1, y);
  await page.mouse.down();
  await page.mouse.move(x2, y, { steps: 6 });
  expect((await state(page)).scrubbing).toBe(true);
  await page.mouse.up();
  await frames(page);
  expect(await shownTime(page)).toBeCloseTo(timeAt(x2), 0);
  expect((await state(page)).start).toBe(a.start);

  // Clicking while playing keeps playing from the new point.
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => window.__algorhythms?.engine()?.isPlaying === true);
  await page.mouse.click(x1, y);
  await expect.poll(async () => (await state(page)).status).toBe('playing');
  await expect.poll(() => shownTime(page), { timeout: 10_000 }).toBeGreaterThan(timeAt(x1));
});

test('the playhead line spans the ruler, the score and the lane', async ({ page }) => {
  await openApp(page);
  await seek(page, 30);
  await page.getByTestId('window-slider').fill('500');
  await frames(page);
  const head = (await page.getByTestId('playhead').boundingBox())!;
  const ruler = (await page.getByTestId('ruler').boundingBox())!;
  const lane = (await page.getByTestId('lane').boundingBox())!;
  const stage = (await page.getByTestId('stage').boundingBox())!;
  expect(head.y).toBeLessThanOrEqual(ruler.y + 1);
  expect(head.y + head.height).toBeGreaterThanOrEqual(lane.y + lane.height - 1);
  expect(stage.y).toBeGreaterThan(ruler.y);
  expect(lane.y).toBeGreaterThan(stage.y);
  const g = await geometry(page);
  expect(Math.abs(g.playheadX - (g.canvasLeft + g.head * g.width))).toBeLessThan(1);
});

test('ruler ticks and the playhead sit on the score axis within 1 px while following', async ({
  page,
}) => {
  await openApp(page);
  await seek(page, 40);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => window.__algorhythms?.engine()?.isPlaying === true, null, {
    timeout: 10_000,
  });
  for (const zoom of ['120', '400', '700', '1000']) {
    await page.getByTestId('window-slider').fill(zoom);
    await frames(page);
    for (let i = 0; i < 3; i++) {
      const g = await geometry(page);
      expect(g.ticks.length).toBeGreaterThan(1);
      const pps = g.width / g.window;
      for (const tk of g.ticks) {
        expect(
          Math.abs(tk.x - (g.canvasLeft + (tk.t - g.start) * pps)),
          `tick ${tk.t}`,
        ).toBeLessThan(1);
      }
      expect(Math.abs(g.playheadX - (g.canvasLeft + g.head * g.width))).toBeLessThan(1);
    }
  }
  expect((await state(page)).status).toBe('playing');
});
