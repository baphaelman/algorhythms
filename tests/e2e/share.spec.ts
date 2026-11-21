/**
 * Share links (PLAN.md §11.4, M5): the menu's Share dialog gives a link that opens exactly the
 * same piece in a fresh page; a link over 2,000 characters warns and offers a file instead.
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

async function openExample(page: Page, id: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`./?example=${id}`);
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
}

async function shareLink(page: Page): Promise<string> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-share').click();
  const dialog = page.getByTestId('share-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('share-length')).toBeVisible();
  return dialog.getByTestId('share-link').inputValue();
}

const pieceOf = (page: Page) =>
  page.evaluate(() => JSON.parse(JSON.stringify(window.__algorhythms!.store.getState().piece)));

test('the Share dialog link opens exactly the same piece, and re-encodes to the same link', async ({
  page,
  context,
}) => {
  await openExample(page, 'seven-doors-in-fog');
  const link = await shareLink(page);
  expect(link).toMatch(/#p=2\.[A-Za-z0-9_-]+$/);
  expect(link.length).toBeLessThanOrEqual(2000);
  await expect(page.getByTestId('share-long')).toHaveCount(0);
  await expect(page.getByTestId('share-dialog').getByTestId('share-length')).toHaveText(
    `${link.length.toLocaleString('en')} characters`,
  );
  const original = await pieceOf(page);
  await page.getByTestId('share-close').click();
  await expect(page.getByTestId('share-dialog')).toBeHidden();

  const fresh = await context.newPage();
  await fresh.goto(link);
  await expect(fresh.getByTestId('title')).toHaveText('Seven Doors in Fog');
  expect(await pieceOf(fresh)).toEqual(original);
  expect(await fresh.evaluate(() => location.hash)).toBe(link.slice(link.indexOf('#')));
  const again = await fresh.evaluate(() => {
    const h = window.__algorhythms!;
    return h.encodeShareLink(h.store.getState().piece, location.href.split('#')[0]);
  });
  expect(again).toBe(link);
});

test('a link over 2,000 characters warns and offers the piece as a file', async ({ page }) => {
  await openExample(page, 'tidewater-hymn');
  // A long piece: 200 extra level moments with unrelated ids and times.
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      meta: { title: string };
      moments: unknown[];
    };
    p.meta.title = 'Long Piece';
    for (let i = 0; i < 200; i++) {
      p.moments.push({
        id: `x${((i * 7919) % 100000).toString(36)}q${i}`,
        type: 'level',
        at: ((i * 4111) % 97) + (i % 13) / 7,
        gain: ((i * 37) % 100) / 100,
        over: (i % 9) / 4,
      });
    }
    h.actions.loadPiece(p);
  });
  const link = await shareLink(page);
  expect(link.length).toBeGreaterThan(2000);
  const dialog = page.getByTestId('share-dialog');
  await expect(dialog.getByTestId('share-long')).toContainText('longer than 2,000 characters');
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByTestId('share-save-file').click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/\.algorhythms\.json$/);
  await expect(dialog).toBeHidden();
});
