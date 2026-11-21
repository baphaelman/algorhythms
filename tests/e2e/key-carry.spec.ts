/**
 * Key changes carry forward to fixed notes (PLAN.md §6.2 `key`, owner 2026-11-21): adding a key
 * asks inline; Move remaps the span's fixed notes and joins the key's undo entry. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface M {
  id: string;
  type: string;
  notes?: { kind: string; symbol?: string; pitches?: number[] };
  pitch?: number | string;
}

const moments = (page: Page): Promise<M[]> =>
  page.evaluate(
    () =>
      structuredClone(
        (window.__algorhythms!.store.getState().piece as unknown as { moments: M[] }).moments,
      ) as M[],
  );

const undo = (page: Page) =>
  page.evaluate(() =>
    (window.__algorhythms as unknown as { editor: { undo(): boolean } }).editor.undo(),
  );

test('adding a key offers to move fixed notes; Move and the key undo together', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.getByTestId('menu-button').click();
  await page.getByTestId('example-clockwork-heron').click();
  await expect(page.getByTestId('title')).toHaveText('Clockwork Heron');
  await seek(page, 70);
  const before = await moments(page);
  const find = (ms: M[], id: string) => ms.find((m) => m.id === id)!;

  // A lydian; the new key is a fifth up (E lydian), so fixed notes move a fourth down.
  await page.getByTestId('palette').locator('[data-moment="key"]').click();
  const banner = page.getByTestId('key-carry');
  await expect(banner).toContainText(
    /\d+ moments until the end use fixed notes\. Move them to E lydian\?/,
  );
  const added = await moments(page);
  expect(added).toHaveLength(before.length + 1);

  await banner.getByRole('button', { name: 'Move' }).click();
  await expect(banner).toBeHidden();
  const after = await moments(page);
  expect(find(after, 'CkFree').notes).toEqual({ kind: 'chord', symbol: 'Amaj7#11' });
  expect(find(after, 'KeKOs8').notes?.pitches).toEqual(
    find(before, 'KeKOs8').notes!.pitches!.map((p) => p - 5),
  );
  expect(find(after, 'bS4u8Y').pitch).toBe(52);
  // Degree chords follow the key by themselves: the remap leaves them as written.
  expect(find(after, 'ajNfhx')).toEqual(find(before, 'ajNfhx'));
  // Fixed notes after the key move; before it, nothing does.
  expect(find(after, 'skWxQ5').notes).not.toEqual(find(before, 'skWxQ5').notes);
  expect(find(after, 'I8F2uI')).toEqual(find(before, 'I8F2uI'));

  // One undo reverts the Move and the added key.
  await undo(page);
  expect(await moments(page)).toEqual(before);
});

test('Keep dismisses the prompt and leaves the notes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.getByTestId('menu-button').click();
  await page.getByTestId('example-clockwork-heron').click();
  await expect(page.getByTestId('title')).toHaveText('Clockwork Heron');
  await seek(page, 115);
  await page.getByTestId('palette').locator('[data-moment="key"]').click();
  const banner = page.getByTestId('key-carry');
  await expect(banner).toBeVisible();
  const added = await moments(page);
  await banner.getByRole('button', { name: 'Keep' }).click();
  await expect(banner).toBeHidden();
  expect(await moments(page)).toEqual(added);
});
