/**
 * Palette previews show on the lane too (owner 2026-11-21; M4.5-39): hovering a palette item
 * (at the playhead) or dragging it over the score or lane (at the drop time) draws the would-be
 * moment on the lane, ghosted, at that time; leaving, Escape and dropping clear it.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

const ghostAt = (page: Page): Promise<number> =>
  page.evaluate(() => window.__algorhythms!.frameStats.preview);

/** The ghost marker's centre x, and the x of time `t` from a real lane item's marker. */
const markerX = async (page: Page, sel: string): Promise<number> => {
  const b = (await page.locator(sel).boundingBox())!;
  return b.x + b.width / 2;
};

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.getByTestId('zoom-fit').click();
}

const escape = (page: Page) =>
  page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );

test('hovering a palette item shows a ghost lane item at the playhead; Escape clears it', async ({
  page,
}) => {
  await open(page);
  await seek(page, 50);
  const unison = page.getByTestId('palette').locator('[data-moment="unison"]');
  // The palette's effects follow the playhead within a poll.
  await expect(unison).not.toHaveAttribute('data-no-effect', /.*/);
  const ghost = page.getByTestId('lane-ghost');
  await expect(ghost).toBeHidden();
  const n0 = await page.getByTestId('lane').locator('[data-moment]').count();
  await unison.hover();
  await expect(ghost).toBeVisible();
  await expect(ghost).toHaveAttribute('data-type', 'unison');
  expect(Number(await ghost.getAttribute('data-at'))).toBeCloseTo(50, 3);
  await expect(ghost.locator('.lane-label')).toHaveText('unison');
  // Drawn at the playhead, on a sub-row, with its transition bar.
  const head = (await page.getByTestId('playhead').boundingBox())!;
  expect(
    Math.abs((await markerX(page, '[data-testid="lane-ghost"] .lane-marker')) - head.x),
  ).toBeLessThan(2);
  expect(Number(await ghost.getAttribute('data-row'))).toBeGreaterThanOrEqual(0);
  expect((await ghost.locator('.lane-bar').boundingBox())!.width).toBeGreaterThan(2);
  // Not a real moment: no item added, nothing selectable.
  expect(await page.getByTestId('lane').locator('[data-moment]').count()).toBe(n0);

  await escape(page);
  await expect(ghost).toBeHidden();
  expect(Number.isNaN(await ghostAt(page))).toBe(true);
});

test('level and pin ghosts land on the Level and Pins rows (dense lanes)', async ({ page }) => {
  await open(page);
  await seek(page, 50);
  const ghost = page.getByTestId('lane-ghost');
  const inRow = async (row: string): Promise<boolean> => {
    const r = await page.locator(`[data-row="${row}"]`).boundingBox();
    const m = await page.locator('[data-testid="lane-ghost"] .lane-marker').boundingBox();
    if (!r || !m) return false;
    const y = m.y + m.height / 2;
    return y >= r.y && y <= r.y + r.height;
  };
  // Tidewater Hymn has no pins: the Pins row appears only for the pin's ghost.
  await expect(page.locator('[data-row="pins"]')).toBeHidden();
  for (const [type, row] of [
    ['level', 'level'],
    ['pin', 'pins'],
  ] as const) {
    await page.getByTestId('palette').locator(`[data-moment="${type}"]`).hover();
    await expect(ghost).toHaveAttribute('data-type', type);
    await expect(ghost).toHaveAttribute('data-lane', row);
    await expect.poll(() => inRow(row)).toBe(true);
    await escape(page);
    await expect(ghost).toBeHidden();
  }
  await expect(page.locator('[data-row="pins"]')).toBeHidden();
});

test('dragging over the score and the lane moves the ghost to the drop time; Escape clears it', async ({
  page,
}) => {
  await open(page);
  const ghost = page.getByTestId('lane-ghost');
  const chord = page.getByTestId('palette').locator('[data-moment="chord"]');
  const score = (await page.locator('#score').boundingBox())!;
  const lane = (await page.locator('.lane-track').boundingBox())!;
  const cb = (await chord.boundingBox())!;
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  const x = score.x + score.width * 0.4;
  await page.mouse.move(x, score.y + score.height / 2, { steps: 8 });
  await page.mouse.move(x + 3, score.y + score.height / 2, { steps: 2 });
  await expect(ghost).toBeVisible();
  await expect(ghost).toHaveAttribute('data-type', 'chord');
  await expect.poll(() => ghostAt(page)).toBeGreaterThan(0);
  // The lane redraws on the next frame: poll until the ghost and the preview agree.
  await expect
    .poll(async () => Number(await ghost.getAttribute('data-at')) - (await ghostAt(page)))
    .toBeCloseTo(0, 6);
  const t1 = await ghostAt(page);
  // The marker sits under the pointer's drop time (snap may pull it a few px).
  expect(
    Math.abs((await markerX(page, '[data-testid="lane-ghost"] .lane-marker')) - (x + 3)),
  ).toBeLessThan(10);

  // Over the lane, further right: the ghost follows.
  const x2 = lane.x + lane.width * 0.7;
  await page.mouse.move(x2, lane.y + lane.height / 2, { steps: 6 });
  await expect.poll(() => ghostAt(page)).toBeGreaterThan(t1 + 1);
  await expect
    .poll(async () => Number(await ghost.getAttribute('data-at')))
    .toBeCloseTo(await ghostAt(page), 6);
  expect(
    Math.abs((await markerX(page, '[data-testid="lane-ghost"] .lane-marker')) - x2),
  ).toBeLessThan(10);

  await escape(page);
  await expect(ghost).toBeHidden();
  await page.mouse.up();
  await expect(ghost).toBeHidden();
});

test('a drop adds the moment and the ghost goes', async ({ page }) => {
  await open(page);
  const n0 = await page.getByTestId('lane').locator('[data-moment]').count();
  const score = (await page.locator('#score').boundingBox())!;
  await page
    .getByTestId('palette')
    .locator('[data-moment="unison"]')
    .dragTo(page.locator('#score'), {
      targetPosition: { x: score.width * 0.6, y: score.height / 2 },
    });
  await expect(page.getByTestId('lane').locator('[data-moment]')).toHaveCount(n0 + 1);
  await expect(page.getByTestId('lane-ghost')).toBeHidden();
});
