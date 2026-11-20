/**
 * My pieces (PLAN.md §11.4, §15 M4): autosave survives a reload and reopens, New, Save as file,
 * Download all, and the persistent-storage status. Chromium only (IndexedDB behaviour is the same
 * elsewhere; the file link is Chromium-only and not covered: it needs the native picker).
 */

import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { expect, test, type Download, type Page } from '@playwright/test';
import './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

const dialog = (page: Page) => page.getByTestId('my-pieces');

async function menu(page: Page, item: string): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId(item).click();
}

async function openMyPieces(page: Page): Promise<void> {
  await menu(page, 'open-my-pieces');
  await expect(page.getByRole('dialog', { name: 'My pieces' })).toBeVisible();
}

/** Titles stored in IndexedDB. */
function storedTitles(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const r = indexedDB.open('algorhythms', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('pieces', { keyPath: 'id' });
        r.onsuccess = () => {
          const g = r.result.transaction('pieces').objectStore('pieces').getAll();
          g.onsuccess = () => {
            resolve((g.result as { title: string }[]).map((e) => e.title).sort());
            r.result.close();
          };
        };
      }),
  );
}

/** Simulates an editor edit: a new title through `setPiece`. */
async function retitle(page: Page, title: string): Promise<void> {
  await page.evaluate((t) => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece);
    p.meta.title = t;
    h.actions.setPiece(p);
  }, title);
}

const title = (page: Page) =>
  page.evaluate(() => window.__algorhythms!.store.getState().piece.meta.title);

function read(d: Download): Promise<Buffer> {
  return d.path().then((p) => readFileSync(p));
}

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test('an opened example is not saved until edited; an edit survives a reload and reopens', async ({
  page,
}) => {
  await openMyPieces(page);
  await expect(page.getByTestId('my-pieces-empty')).toBeVisible();
  await expect(page.getByTestId('persist-status')).toHaveAttribute('data-state', 'unknown');
  await page.getByTestId('my-pieces-close').click();
  expect(await storedTitles(page)).toEqual([]);

  await retitle(page, 'Edited tide');
  await expect.poll(() => storedTitles(page)).toEqual(['Edited tide']);
  await retitle(page, 'Edited tide 2');
  await expect.poll(() => storedTitles(page)).toEqual(['Edited tide 2']);

  // Persistent storage was requested on the first save, and the answer is shown.
  await openMyPieces(page);
  await expect(page.getByTestId('persist-status')).toHaveAttribute('data-state', /granted|denied/);
  await expect(page.getByTestId('safari-note')).toHaveCount(0);
  await page.getByTestId('my-pieces-close').click();

  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  expect(await title(page)).toBe('Tidewater Hymn');

  await openMyPieces(page);
  const row = dialog(page).getByTestId('my-piece');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Edited tide 2');
  await expect(row).toContainText('not saved to a file');
  await row.getByTestId('my-piece-open').click();
  await expect(dialog(page)).toBeHidden();
  expect(await title(page)).toBe('Edited tide 2');

  // Editing the reopened piece updates the same entry.
  await retitle(page, 'Edited tide 3');
  await expect.poll(() => storedTitles(page)).toEqual(['Edited tide 3']);

  // Delete asks first.
  await openMyPieces(page);
  await dialog(page).getByTestId('my-piece-delete').click();
  await dialog(page).getByTestId('my-piece-delete-confirm').click();
  await expect(page.getByTestId('my-pieces-empty')).toBeVisible();
  expect(await storedTitles(page)).toEqual([]);
});

test('New opens the empty template and saves it', async ({ page }) => {
  await menu(page, 'new-piece');
  await expect.poll(() => title(page)).toBe('Untitled');
  const state = await page.evaluate(() => {
    const p = window.__algorhythms!.store.getState().piece as unknown as {
      voices: unknown[];
      moments: unknown[];
    };
    return { voices: p.voices.length, moments: p.moments.length };
  });
  expect(state).toEqual({ voices: 12, moments: 0 });
  await expect.poll(() => storedTitles(page)).toEqual(['Untitled']);
});

test('Save as file downloads the piece and marks it; Download all zips every piece', async ({
  page,
}) => {
  await retitle(page, 'First piece');
  await expect.poll(() => storedTitles(page)).toEqual(['First piece']);
  await menu(page, 'new-piece');
  await expect.poll(() => storedTitles(page)).toEqual(['First piece', 'Untitled']);
  await retitle(page, 'Second / piece');
  await expect.poll(() => storedTitles(page)).toEqual(['First piece', 'Second / piece']);

  const [file] = await Promise.all([page.waitForEvent('download'), menu(page, 'save-file')]);
  expect(file.suggestedFilename()).toBe('Second-piece.algorhythms.json');
  const saved = JSON.parse((await read(file)).toString('utf8'));
  expect(saved.format).toBe('algorhythms');
  expect(saved.meta.title).toBe('Second / piece');

  await openMyPieces(page);
  const rows = dialog(page).getByTestId('my-piece');
  await expect(rows.filter({ hasText: 'Second / piece' })).toContainText('saved to a file');
  await expect(rows.filter({ hasText: 'Second / piece' })).not.toContainText('not saved');
  await expect(rows.filter({ hasText: 'First piece' })).toContainText('not saved to a file');

  const [zip] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-all').click(),
  ]);
  expect(zip.suggestedFilename()).toBe('algorhythms-pieces.zip');
  const files = unzipSync(new Uint8Array(await read(zip)));
  expect(Object.keys(files).sort()).toEqual([
    'First-piece.algorhythms.json',
    'Second-piece.algorhythms.json',
  ]);
  expect(JSON.parse(strFromU8(files['First-piece.algorhythms.json'])).meta.title).toBe(
    'First piece',
  );
  await expect(page.getByTestId('my-pieces-message')).toHaveText('Downloaded 2 pieces as a zip.');
  await expect(rows.filter({ hasText: 'not saved' })).toHaveCount(0);
});
