/**
 * M4g Voices drawer (PLAN.md §11.3): open it, change the pool size, mute a voice, change a timbre,
 * and undo restores each change. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface VoiceLite {
  id: string;
  timbre: string;
  mute?: boolean;
}

const voices = (page: Page) =>
  page.evaluate(
    () => window.__algorhythms!.store.getState().piece.voices as unknown as VoiceLite[],
  );

const blurAndUndo = async (page: Page): Promise<void> => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+z');
};

test('voices drawer edits the pool, mute and timbre, and undo restores them', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('play')).toBeVisible();

  const before = await voices(page);
  const n = before.length;
  const first = before[0];
  const second = before[1];

  await page.getByTestId('voices-toggle').click();
  const drawer = page.getByTestId('voices-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('tbody tr')).toHaveCount(n);

  // Pool size: typed and committed with Enter.
  const pool = page.getByTestId('pool-size');
  await pool.fill(String(n + 2));
  await pool.press('Enter');
  await expect(drawer.locator('tbody tr')).toHaveCount(n + 2);
  expect((await voices(page)).length).toBe(n + 2);

  // Mute during playback: playback keeps going, and the compiled score carries the mute.
  await page.getByTestId('play').click();
  await page.getByTestId(`mute-${second.id}`).click();
  await expect(page.getByTestId(`mute-${second.id}`)).toHaveAttribute('aria-pressed', 'true');
  await page.waitForFunction((id) => {
    const c = window.__algorhythms!.store.getState().compiled as unknown as {
      voices: { id: string; mute: boolean }[];
    };
    return c.voices.some((v) => v.id === id && v.mute);
  }, second.id);
  expect(await page.evaluate(() => window.__algorhythms!.store.getState().transport.status)).toBe(
    'playing',
  );
  await page.getByTestId('play').click();

  // Timbre.
  const other = first.timbre === 'organ' ? 'reed' : 'organ';
  await page.getByTestId(`timbre-${first.id}`).selectOption(other);
  expect((await voices(page))[0].timbre).toBe(other);

  // Undo, newest first.
  await blurAndUndo(page);
  await expect(page.getByTestId(`timbre-${first.id}`)).toHaveValue(first.timbre);
  await blurAndUndo(page);
  await expect(page.getByTestId(`mute-${second.id}`)).toHaveAttribute('aria-pressed', 'false');
  expect((await voices(page))[1].mute).toBeFalsy();
  await blurAndUndo(page);
  await expect(drawer.locator('tbody tr')).toHaveCount(n);
  expect(await voices(page)).toEqual(before);

  // Close.
  await page.getByTestId('voices-toggle').click();
  await expect(drawer).toHaveCount(0);
});

test('All notes timbre sets every note at once, undoes in one step, and shows Mixed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('./');
  await expect(page.getByTestId('play')).toBeVisible();
  await page.getByTestId('voices-toggle').click();
  await expect(page.getByTestId('voices-drawer')).toBeVisible();

  const before = await voices(page);
  const all = page.getByTestId('timbre-all');
  const target = before.every((v) => v.timbre === 'reed') ? 'organ' : 'reed';
  await all.selectOption(target);
  for (const v of before) await expect(page.getByTestId(`timbre-${v.id}`)).toHaveValue(target);
  await expect(all).toHaveValue(target);

  await blurAndUndo(page);
  expect(await voices(page)).toEqual(before);
  for (const v of before) {
    await expect(page.getByTestId(`timbre-${v.id}`)).toHaveValue(v.timbre);
  }

  // Redo the pick, then change one note: the menu shows Mixed (a disabled placeholder).
  await all.selectOption(target);
  const other = target === 'organ' ? 'glass' : 'organ';
  await page.getByTestId(`timbre-${before[0].id}`).selectOption(other);
  await expect(all.locator('option:checked')).toHaveText('Mixed');
  await expect(all.locator('option', { hasText: 'Mixed' })).toBeDisabled();
});
