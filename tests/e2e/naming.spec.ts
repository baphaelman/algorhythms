/**
 * Name it before moving on (PLAN.md §11.4, owner 2026-11-21): opening another piece from an edited,
 * unnamed one first offers a name (Save name / Skip); it asks at most once per piece, and never
 * for a piece that was not edited.
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

const prompt = (page: Page) => page.getByTestId('name-prompt');

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

/** An edit through the inspector (one history entry), then the title put back to Untitled. */
async function editUnnamed(page: Page): Promise<void> {
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const ms = h.store.getState().piece.moments;
    h.actions.select([ms[0]!.id, ms[1]!.id]);
  });
  await page.getByTestId('inspector').getByRole('button', { name: 'Mute all' }).click();
  await expect(
    page.getByTestId('inspector').getByRole('button', { name: 'Mute all' }),
  ).toBeVisible();
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece);
    p.meta.title = 'Untitled';
    h.actions.setPiece(p);
  });
}

const title = (page: Page) =>
  page.evaluate(() => window.__algorhythms!.store.getState().piece.meta.title);

async function openExample(page: Page, id: string): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId(`example-${id}`).click();
}

async function myPieceTitles(page: Page): Promise<string[]> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-my-pieces').click();
  const list = page.getByTestId('my-pieces').locator('.piece-title');
  await expect(list.first()).toBeVisible();
  const titles = await list.allTextContents();
  await page.getByTestId('my-pieces-close').click();
  return titles;
}

test('an edited, unnamed piece asks; Save name stores the name and the next piece opens', async ({
  page,
}) => {
  await editUnnamed(page);
  expect(await title(page)).toBe('Untitled');
  await openExample(page, 'kite-day');
  await expect(prompt(page)).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Name this piece?' })).toBeVisible();
  await expect(page.getByTestId('name-prompt-input')).toBeFocused();
  // Space types in the field (it does not play or pause).
  await page.keyboard.type('Night tide');
  await expect(page.getByTestId('name-prompt-input')).toHaveValue('Night tide');
  await page.keyboard.press('Enter');
  await expect(prompt(page)).toBeHidden();
  await expect.poll(() => title(page)).toBe('Kite Day');
  await expect.poll(() => myPieceTitles(page)).toContain('Night tide');
});

test('Skip (or Escape) moves on unchanged, and the piece is not asked about again', async ({
  page,
}) => {
  await editUnnamed(page);
  await openExample(page, 'kite-day');
  await expect(prompt(page)).toBeVisible();
  await page.getByTestId('name-prompt-skip').click();
  await expect(prompt(page)).toBeHidden();
  await expect.poll(() => title(page)).toBe('Kite Day');
  await expect.poll(() => myPieceTitles(page)).toContain('Untitled');

  // Reopen the Untitled piece from My pieces, edit it, and leave: no second question.
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-my-pieces').click();
  await page.getByTestId('my-piece-open').filter({ hasText: 'Untitled' }).click();
  await expect.poll(() => title(page)).toBe('Untitled');
  await editUnnamed(page);
  await openExample(page, 'harbour-song');
  await expect(prompt(page)).toBeHidden();
  await expect.poll(() => title(page)).toBe('Harbour Song');
});

test('Escape skips and the next piece still opens', async ({ page }) => {
  await editUnnamed(page);
  await openExample(page, 'night-ferry');
  await expect(prompt(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(prompt(page)).toBeHidden();
  await expect.poll(() => title(page)).toBe('Night Ferry');
});

test('an unedited piece asks nothing', async ({ page }) => {
  await openExample(page, 'kite-day');
  await expect.poll(() => title(page)).toBe('Kite Day');
  await openExample(page, 'harbour-song');
  await expect.poll(() => title(page)).toBe('Harbour Song');
  await expect(prompt(page)).toBeHidden();
  // A fresh New is unedited as well.
  await page.getByTestId('menu-button').click();
  await page.getByTestId('new-piece').click();
  await expect.poll(() => title(page)).toBe('Untitled');
  await openExample(page, 'kite-day');
  await expect(prompt(page)).toBeHidden();
  await expect.poll(() => title(page)).toBe('Kite Day');
});

test('an edited piece that kept its Generate title asks; an untouched one does not', async ({
  page,
}) => {
  const generate = async (): Promise<void> => {
    await page.getByTestId('menu-button').click();
    await page.getByTestId('open-generate').click();
    await page.getByTestId('generate-panel').getByLabel('Seed', { exact: true }).fill('99');
    await page.getByTestId('generate-run').click();
    await expect(page.getByTestId('generate-panel')).toBeHidden();
  };
  await generate();
  expect(await title(page)).toBe('Bright F Major 99');
  // Untouched: no question.
  await openExample(page, 'kite-day');
  await expect(prompt(page)).toBeHidden();
  await generate();
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const ms = h.store.getState().piece.moments;
    h.actions.select([ms[0]!.id, ms[1]!.id]);
  });
  await page.getByTestId('inspector').getByRole('button', { name: 'Mute all' }).click();
  await openExample(page, 'harbour-song');
  await expect(prompt(page)).toBeVisible();
  await page.getByTestId('name-prompt-skip').click();
  await expect.poll(() => title(page)).toBe('Harbour Song');
});
