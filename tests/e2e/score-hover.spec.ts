/**
 * M4h selection feedback (PLAN.md §11.3): selecting a moment changes the drawn score, and hovering
 * a line with the mouse shows its voice, note name and Hz.
 */

import { expect, test } from '@playwright/test';
import './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough');

test('selection highlights and hover reads out a line', async ({ page }) => {
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('play')).toBeVisible();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  const canvas = page.locator('#score');
  const tip = page.getByTestId('score-hover');
  await expect(tip).toBeHidden();

  /** The canvas after two more frames. */
  const frame = () =>
    page.evaluate(
      () =>
        new Promise<string>((done) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              done((document.getElementById('score') as HTMLCanvasElement).toDataURL()),
            ),
          ),
        ),
    );

  // Selecting a moment redraws the score (others dimmed, its segments emphasised).
  const before = await frame();
  const id = await page.evaluate(() => {
    const h = window.__algorhythms!;
    const ms = h.store.getState().piece.moments;
    const m = ms[Math.floor(ms.length / 2)];
    h.actions.select([m.id]);
    return m.id;
  });
  expect(id).toBeTruthy();
  expect(await frame()).not.toBe(before);

  // Find a line: walk a column with the mouse until the readout appears.
  const box = (await canvas.boundingBox())!;
  const x = box.x + box.width * 0.5;
  let found = false;
  for (let y = box.y + 10; y < box.y + box.height - 10; y += 4) {
    await page.mouse.move(x, y);
    await frame();
    if (await tip.isVisible()) {
      found = true;
      break;
    }
  }
  expect(found).toBe(true);
  await expect(tip).toHaveText(/^.+ · [A-G][♯♭]?-?\d( [+−]\d+¢)? · \d+\.\d\d Hz$/);

  // Leaving the canvas hides it.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 40);
  await expect(tip).toBeHidden();
});
