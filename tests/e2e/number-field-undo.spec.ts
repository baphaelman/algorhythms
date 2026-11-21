/**
 * A number field holding an uncommitted draft must not re-commit it on blur after an outside
 * undo. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough');

interface EditorHook {
  editor: { select(ids: string[]): void; undo(): boolean };
  store: {
    getState(): { piece: { moments: { id: string; glide?: { length?: number } }[] } };
  };
}

const CHORD = 'Zd0uQh';

const glideLength = (page: Page): Promise<number | undefined> =>
  page.evaluate((id) => {
    const h = window.__algorhythms as unknown as EditorHook;
    return h.store.getState().piece.moments.find((m) => m.id === id)?.glide?.length;
  }, CHORD);

test('an outside undo drops a typed draft; blur does not overwrite it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate((id) => {
    (window.__algorhythms as unknown as EditorHook).editor.select([id]);
  }, CHORD);

  const length = page.getByTestId('inspector').getByTestId('insp-glide-length');
  await expect(length).toHaveValue('3.1');
  await length.fill('5.5');
  await length.press('Enter');
  expect(await glideLength(page)).toBe(5.5);

  // Type without committing, then undo from elsewhere (the app has no Undo button, and a real
  // click would blur the field first).
  await length.focus();
  await length.fill('7.5');
  await page.evaluate(() => (window.__algorhythms as unknown as EditorHook).editor.undo());
  await expect(length).toHaveValue('3.1');
  await length.blur();
  expect(await glideLength(page)).toBe(3.1);
  await expect(length).toHaveValue('3.1');

  // A draft with nothing external changing still commits on blur.
  await length.focus();
  await length.fill('6.5');
  await length.blur();
  expect(await glideLength(page)).toBe(6.5);
});

test('chord-symbol field: an outside undo drops a typed draft; blur does not overwrite it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate((id) => {
    (window.__algorhythms as unknown as EditorHook).editor.select([id]);
  }, CHORD);

  await page.getByTestId('inspector').getByTestId('insp-notes-kind').selectOption('chord');
  const field = page.getByTestId('inspector').getByTestId('insp-chord');
  await expect(field).toBeVisible();
  const original = await field.inputValue();
  await field.fill('Gmaj7');
  await field.press('Enter');
  await expect(field).toHaveValue('Gmaj7');

  await field.focus();
  await field.fill('Dm7');
  await page.evaluate(() => (window.__algorhythms as unknown as EditorHook).editor.undo());
  await expect(field).toHaveValue(original);
  await field.blur();
  await expect(field).toHaveValue(original);
});
