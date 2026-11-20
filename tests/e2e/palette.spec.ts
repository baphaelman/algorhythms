/**
 * M4f moment palette and editor keys (PLAN.md §11.3): palette clicks and the ten letters add at
 * the playhead, ⌘/Ctrl+letter does not, Delete removes the selection, undo restores it.
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

interface M {
  id: string;
  type: string;
  at: number;
}

const moments = (page: Page): Promise<M[]> =>
  page.evaluate(() => {
    const p = window.__algorhythms!.store.getState().piece as unknown as { moments: M[] };
    return p.moments.map(({ id, type, at }) => ({ id, type, at }));
  });

/** Opens the app on the default piece without a grid, playhead at 10 s. */
async function openNoGrid(page: Page): Promise<void> {
  await page.goto('./');
  await expect(page.getByTestId('play')).toBeVisible();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = h.store.getState().piece as unknown as { view: Record<string, unknown> };
    const view = { ...p.view };
    delete view.gridBpm;
    h.actions.loadPiece({ ...p, view });
  });
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('time')).toHaveText('00:10.0');
}

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

test('palette click adds a moment at the playhead', async ({ page }) => {
  await openNoGrid(page);
  const palette = page.getByTestId('palette');
  await expect(palette.getByRole('button')).toHaveCount(10);
  const before = await moments(page);
  await palette.locator('[data-moment="chord"]').click();
  const ms = (await moments(page)).filter((m) => !before.some((b) => b.id === m.id));
  expect(ms).toHaveLength(1);
  expect(ms[0].type).toBe('chord');
  expect(ms[0].at).toBeCloseTo(10, 3);
});

test('letters add each type; modified letters do not', async ({ page }) => {
  await openNoGrid(page);
  const keys: [string, string][] = [
    ['c', 'chord'],
    ['u', 'unison'],
    ['s', 'split'],
    ['m', 'merge'],
    ['t', 'shift'],
    ['p', 'spread'],
    ['w', 'walk'],
    ['i', 'pin'],
    ['k', 'key'],
    ['l', 'level'],
  ];
  for (const [k, type] of keys) {
    const before = await moments(page);
    await page.keyboard.press(k);
    const after = await moments(page);
    expect(after).toHaveLength(before.length + 1);
    const added = after.find((m) => !before.some((b) => b.id === m.id))!;
    expect(added.type).toBe(type);
    expect(added.at).toBeCloseTo(10, 3);
    // Delete it again, so the next type sees the same state (a spread on a unison does nothing).
    await page.keyboard.press('Delete');
    expect(await moments(page)).toHaveLength(before.length);
  }
  const n = (await moments(page)).length;
  for (const combo of ['Control+c', 'Meta+c', 'Alt+u', 'Shift+s']) {
    await page.keyboard.press(combo);
  }
  expect(await moments(page)).toHaveLength(n);
});

test('Delete removes the selection, undo restores it, Escape clears it', async ({ page }) => {
  await openNoGrid(page);
  const base = await moments(page);
  const added = async () =>
    (await moments(page)).filter((m) => !base.some((b) => b.id === m.id)).map((m) => m.type);
  await page.keyboard.press('c');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('l');
  expect(await added()).toEqual(['chord', 'level']);
  const two = await moments(page);

  await page.keyboard.press('Delete');
  expect(await added()).toEqual(['chord']);
  expect(await moments(page)).toHaveLength(two.length - 1);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await moments(page)).toEqual(two);

  // Undo restored the selection (the level); Escape clears it, so Backspace deletes nothing.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
  expect(await moments(page)).toEqual(two);
});
