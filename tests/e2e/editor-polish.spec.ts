/**
 * M4k editor polish (PLAN.md §11.3): dragging a palette item onto the lane or the score adds that
 * moment at the drop time (snapped, one undo entry); Escape with the menu open closes only the menu.
 * Runs on a small piece with a 60 BPM grid (1 s steps).
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

interface M {
  id: string;
  type: string;
  at: number;
}

const moments = (page: Page): Promise<M[]> =>
  page.evaluate(() =>
    (window.__algorhythms!.store.getState().piece as unknown as { moments: M[] }).moments.map(
      ({ id, type, at }) => ({ id, type, at }),
    ),
  );

const item = (page: Page, id: string) => page.locator(`[data-moment="${id}"]`);

/** Page x of an item's marker centre (its time). */
async function markerX(page: Page, id: string): Promise<number> {
  const box = await item(page, id).locator('.lane-marker').boundingBox();
  if (!box) throw new Error(`no marker for ${id}`);
  return box.x + box.width / 2;
}

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

test.beforeEach(async ({ page }) => {
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as Record<string, unknown> & {
      view: Record<string, unknown>;
    };
    p.moments = [
      ...(p.moments as { id: string }[]).filter((m) => m.id === 'start0'), // the opening (v2)
      {
        id: 'aaaaaa',
        type: 'chord',
        at: 2,
        notes: { kind: 'degrees', degrees: [0, 2, 4] },
        voicing: 'even',
        assign: 'ordered',
      },
      { id: 'bbbbbb', type: 'unison', at: 6, pitch: 'center', octaves: false },
    ];
    p.end = { at: 20, fade: 1 };
    p.view = { ...p.view, gridBpm: 60, window: 20 };
    h.actions.loadPiece(p);
  });
  await expect(page.getByTestId('lane').locator('[data-moment]')).toHaveCount(3); // + the opening
});

for (const target of ['lane', 'score'] as const) {
  test(`drag from the palette onto the ${target} adds at the drop time`, async ({ page }) => {
    const before = await moments(page);
    const a = await markerX(page, 'aaaaaa');
    const pps = ((await markerX(page, 'bbbbbb')) - a) / 4;
    // Drop at about 6.1 s, a few px from the unison at 6: snaps to it (revision 7: note
    // changes, not the bar grid).
    const x = a + 4.1 * pps;
    const el = target === 'lane' ? page.locator('.lane-track') : page.locator('#score');
    const box = (await el.boundingBox())!;
    await page
      .getByTestId('palette')
      .locator('[data-moment="walk"]')
      .dragTo(el, { targetPosition: { x: x - box.x, y: box.height / 2 } });

    const after = await moments(page);
    const added = after.filter((m) => !before.some((b) => b.id === m.id));
    expect(added).toHaveLength(1);
    expect(added[0].type).toBe('walk');
    expect(added[0].at).toBeCloseTo(6, 6);
    await expect(item(page, added[0].id)).toHaveAttribute('aria-pressed', 'true');

    // One undo entry.
    await page.keyboard.press('ControlOrMeta+z');
    expect(await moments(page)).toEqual(before);
  });
}

test('Escape with the menu open closes the menu and keeps the selection', async ({ page }) => {
  await item(page, 'aaaaaa').click();
  await expect(item(page, 'aaaaaa')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('menu-button').click();
  await expect(page.getByTestId('menu-panel')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('menu-panel')).toBeHidden();
  await expect(item(page, 'aaaaaa')).toHaveAttribute('aria-pressed', 'true');

  // With nothing open, Escape clears the selection.
  await page.keyboard.press('Escape');
  await expect(item(page, 'aaaaaa')).toHaveAttribute('aria-pressed', 'false');
});
