/**
 * Dense pieces on the lane (owner bug 2026-11-21, Kite Day): the lane area is capped so the score
 * keeps ≥ 55 % of the timeline, and scrolls vertically inside itself; rows needing more than 3
 * sub-rows go compact (labels on hover or selection). A sparse piece is unchanged.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import './app-hook';

type Box = { x: number; y: number; width: number; height: number };

const box = async (l: Locator): Promise<Box> => (await l.boundingBox())!;

const selection = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__algorhythms!.editor.state.getState().selection);

/**
 * Lane items whose marker (or transition bar, at least 12 px wide) lies fully inside the lane
 * area's visible rectangle, uncovered; with the point to click.
 */
async function visibleItems(
  page: Page,
  part: '.lane-marker' | '.lane-bar',
  type?: string,
): Promise<{ id: string; x: number; y: number }[]> {
  return page.evaluate(
    ({ part, type }) => {
      const sc = document.querySelector('.lane-scroll')!.getBoundingClientRect();
      const out: { id: string; x: number; y: number }[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('.lane-item[data-moment]')) {
        if (type && el.dataset.type !== type) continue;
        const m = el.querySelector(part)!.getBoundingClientRect();
        if (part === '.lane-bar' && m.width < 12) continue;
        const x = m.left + m.width / 2;
        const y = m.top + m.height / 2;
        if (
          m.top < sc.top ||
          m.bottom > sc.bottom ||
          m.left < sc.left + 60 ||
          m.right > sc.right - 60
        )
          continue;
        if (document.elementFromPoint(x, y)?.closest('[data-moment]') !== el) continue;
        out.push({ id: el.dataset.moment!, x, y });
      }
      return out;
    },
    { part, type },
  );
}

async function open(page: Page, example: string, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`./?example=${example}`);
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await expect(page.locator('.lane-track')).toHaveAttribute('data-subrows', /\d+/);
}

for (const [width, height] of [
  [1024, 768],
  [1280, 720],
] as const) {
  test.describe(`Kite Day at ${width}×${height}`, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, 'kite-day', width, height);
    });

    test('the score keeps its share; dense rows go compact', async ({ page }) => {
      const timeline = await box(page.getByTestId('timeline'));
      const stage = await box(page.getByTestId('stage'));
      expect(stage.height / timeline.height).toBeGreaterThanOrEqual(0.5);
      // The lane area ends inside the timeline and the viewport.
      const lane = await box(page.getByTestId('lane'));
      expect(lane.y + lane.height).toBeLessThanOrEqual(timeline.y + timeline.height + 1);
      expect(lane.y + lane.height).toBeLessThanOrEqual(height);
      await expect(page.locator('.lane-track')).toHaveAttribute('data-compact', '');
    });

    test('the wheel scrolls the lane area to the Level row; a level item there selects', async ({
      page,
    }) => {
      const sc = page.getByTestId('lane-scroll');
      const scBox = await box(sc);
      const start = await page.evaluate(() => window.__algorhythms!.frameStats.start);
      await page.mouse.move(scBox.x + scBox.width / 2, scBox.y + scBox.height / 2);
      await page.mouse.wheel(0, 600);
      await expect
        .poll(async () => {
          const level = await box(page.locator('[data-row="level"]'));
          return level.y + level.height <= scBox.y + scBox.height + 1;
        })
        .toBe(true);
      const level = await box(page.locator('[data-row="level"]'));
      expect(level.y + level.height).toBeLessThanOrEqual(height);
      // A plain vertical wheel does not pan the time axis.
      expect(await page.evaluate(() => window.__algorhythms!.frameStats.start)).toBe(start);
      // A level ramp's transition bar, visible with the Level row.
      const items = await visibleItems(page, '.lane-bar', 'level');
      expect(items.length).toBeGreaterThan(0);
      const it = items.at(-1)!;
      await page.mouse.click(it.x, it.y);
      await expect.poll(() => selection(page)).toEqual([it.id]);
    });

    test('Shift-wheel over the lane area pans the time axis', async ({ page }) => {
      const scBox = await box(page.getByTestId('lane-scroll'));
      const start = await page.evaluate(() => window.__algorhythms!.frameStats.start);
      await page.mouse.move(scBox.x + scBox.width / 2, scBox.y + scBox.height / 2);
      await page.keyboard.down('Shift');
      await page.mouse.wheel(0, 300);
      await page.keyboard.up('Shift');
      await expect
        .poll(() => page.evaluate(() => window.__algorhythms!.frameStats.start))
        .toBeGreaterThan(start);
    });

    test('a compact item selects on click and shows its label', async ({ page }) => {
      const items = await visibleItems(page, '.lane-marker');
      expect(items.length).toBeGreaterThan(0);
      const it = items[Math.floor(items.length / 2)];
      await page.mouse.click(it.x, it.y);
      await expect.poll(() => selection(page)).toEqual([it.id]);
      const el = page.locator(`.lane-item[data-moment="${it.id}"]`);
      await expect(el.locator('.lane-label')).toBeVisible();
      await expect(el).toHaveAttribute('title', /.+/);
    });

    test('selecting a moment elsewhere scrolls its lane item into view', async ({ page }) => {
      const sc = page.getByTestId('lane-scroll');
      // Scrolled to the bottom (the Level row), the top sub-rows are out of view.
      await sc.evaluate((e) => (e.scrollTop = e.scrollHeight));
      const scBox = await box(sc);
      const hidden = await page.evaluate(() => {
        const r = document.querySelector('.lane-scroll')!.getBoundingClientRect();
        for (const el of document.querySelectorAll<HTMLElement>('.lane-item[data-moment]')) {
          const m = el.querySelector('.lane-marker')!.getBoundingClientRect();
          if (m.bottom < r.top && m.left > r.left && m.right < r.right) return el.dataset.moment!;
        }
        return null;
      });
      expect(hidden).not.toBeNull();
      await page.evaluate((id) => window.__algorhythms!.actions.select([id]), hidden!);
      await expect
        .poll(async () => {
          const m = await box(page.locator(`.lane-item[data-moment="${hidden}"] .lane-marker`));
          return m.y >= scBox.y - 1 && m.y + m.height <= scBox.y + scBox.height + 1;
        })
        .toBe(true);
    });
  });
}

test('a sparse piece keeps full rows and no lane scrolling', async ({ page }) => {
  await open(page, 'tidewater-hymn', 1024, 768);
  await expect(page.locator('.lane-track')).not.toHaveAttribute('data-compact');
  const sc = page.getByTestId('lane-scroll');
  expect(await sc.evaluate((e) => e.scrollHeight - e.clientHeight)).toBeLessThanOrEqual(0);
  await expect(page.getByTestId('lane')).not.toHaveAttribute('data-more-below');
  // Labels show as before.
  await expect(page.locator('.lane-item[data-moment] .lane-label').first()).toBeVisible();
});
