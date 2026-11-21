/**
 * M4f moment palette and editor keys (PLAN.md §11.3): palette clicks and the ten letters add at
 * the playhead, ⌘/Ctrl+letter does not, Delete removes the selection, undo restores it.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

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
  await page.goto('./?example=tidewater-hymn');
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
  await expect(palette.getByRole('button')).toHaveCount(14);
  const before = await moments(page);
  await palette.locator('[data-moment="chord"]').click();
  const ms = (await moments(page)).filter((m) => !before.some((b) => b.id === m.id));
  expect(ms).toHaveLength(1);
  expect(ms[0].type).toBe('chord');
  expect(ms[0].at).toBeCloseTo(10, 3);
});

test('Add is exactly at the playhead line, not snapped to the bar grid (revision 7)', async ({
  page,
}) => {
  await openNoGrid(page);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      view: Record<string, unknown>;
    };
    p.view = { ...p.view, gridBpm: 60 };
    h.actions.loadPiece(p);
  });
  await seek(page, 3.3);
  const before = await moments(page);
  await page.getByTestId('palette').locator('[data-moment="chord"]').click();
  const added = (await moments(page)).filter((m) => !before.some((b) => b.id === m.id));
  expect(added).toHaveLength(1);
  expect(added[0].at).toBeCloseTo(3.3, 3);
});

test('Add and Next are separate, labelled groups with their own styles', async ({ page }) => {
  await openNoGrid(page);
  const add = page.getByTestId('palette');
  const next = page.getByTestId('suggestions');
  await expect(add).toContainText(/Add\s*at playhead/i);
  await expect(next).toContainText(/Next\s*at end/i);
  const style = (sel: string) =>
    page.evaluate((q) => {
      const cs = getComputedStyle(document.querySelector(q)!);
      return { border: cs.borderTopStyle, bg: cs.backgroundColor };
    }, sel);
  const a = await style('[data-testid="palette"]');
  const n = await style('[data-testid="suggestions"]');
  expect(a.border).toBe('solid');
  expect(n.border).toBe('dashed');
  expect(n.bg).not.toBe(a.bg);
  // Side by side when they fit (build-log "Compact view bar"), else Next below; never overlapping.
  const ab = (await add.boundingBox())!;
  const nb = (await next.boundingBox())!;
  expect(nb.x >= ab.x + ab.width - 1 || nb.y >= ab.y + ab.height - 1).toBe(true);
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
    ['b', 'timbre'],
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
