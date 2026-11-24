/**
 * The address bar is the share link (PLAN.md §11.4, owner 2026-11-24): an unedited example reads
 * `#<id>`, anything else `#p=…` kept current as you edit; a reload reopens the same piece with no
 * copy in My pieces.
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

const hashOf = (page: Page) => page.evaluate(() => location.hash);
const title = (page: Page) =>
  page.evaluate(() => window.__algorhythms!.store.getState().piece.meta.title);
const pieceOf = (page: Page) =>
  page.evaluate(() => JSON.parse(JSON.stringify(window.__algorhythms!.store.getState().piece)));

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
}

/** A stand-in for an editor edit: a new title through `setPiece`. */
async function retitle(page: Page, t: string): Promise<void> {
  await page.evaluate((t) => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece);
    p.meta.title = t;
    h.actions.setPiece(p);
  }, t);
}

/** Titles stored in My pieces (IndexedDB). */
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

test('an example from the menu reads #<id>; an edit turns it into a #p= link that reopens it', async ({
  page,
  context,
}) => {
  await page.goto('./');
  await ready(page);
  expect(await hashOf(page)).toBe('#kite-day');

  await page.getByTestId('menu-button').click();
  await page.getByTestId('example-tidewater-hymn').click();
  await expect(page.getByTestId('title')).toHaveText('Tidewater Hymn');
  expect(await hashOf(page)).toBe('#tidewater-hymn');

  const entries = await page.evaluate(() => history.length);
  await retitle(page, 'Tide, edited');
  await expect.poll(() => hashOf(page)).toMatch(/^#p=2\.[A-Za-z0-9_-]+$/);
  const edited = await pieceOf(page);
  expect(await page.evaluate(() => history.length)).toBe(entries); // replaceState only

  const fresh = await context.newPage();
  await fresh.goto(page.url());
  await expect(fresh.getByTestId('title')).toHaveText('Tide, edited');
  expect(await pieceOf(fresh)).toEqual(edited);
  await fresh.close();

  // Reload: the same piece, still saving to the same My pieces entry, with no notice.
  await expect.poll(() => storedTitles(page)).toEqual(['Tide, edited']);
  const url = page.url();
  await page.reload();
  await ready(page);
  expect(await title(page)).toBe('Tide, edited');
  expect(page.url()).toBe(url);
  await expect(page.locator('.notice')).toHaveCount(0);
  await retitle(page, 'Tide, edited again');
  await expect.poll(() => storedTitles(page)).toEqual(['Tide, edited again']);
});

test('#kite-day opens Kite Day; an unknown name falls back to the featured piece', async ({
  page,
}) => {
  await page.goto('./?example=tidewater-hymn#kite-day');
  await ready(page);
  expect(await title(page)).toBe('Kite Day');
  expect(await hashOf(page)).toBe('#kite-day');

  await page.goto('about:blank');
  await page.goto('./#no-such-piece');
  await ready(page);
  expect(await title(page)).toBe('Kite Day');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await hashOf(page)).toBe('#kite-day');

  // Typing another example's name into the address bar opens it.
  await page.evaluate(() => (location.hash = 'tidewater-hymn'));
  await expect(page.getByTestId('title')).toHaveText('Tidewater Hymn');
});

test('a generated piece gets a #p= link that reopens the same piece', async ({ page, context }) => {
  await page.goto('./?example=tidewater-hymn');
  await ready(page);
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-generate').click();
  const panel = page.getByTestId('generate-panel');
  await panel.getByLabel('Seed', { exact: true }).fill('4242');
  await page.getByTestId('generate-run').click();
  await expect(panel).toBeHidden();
  await expect.poll(() => hashOf(page)).toMatch(/^#p=2\./);
  const generated = await pieceOf(page);

  const fresh = await context.newPage();
  await fresh.goto(page.url());
  await ready(fresh);
  expect(await pieceOf(fresh)).toEqual(generated);
});
