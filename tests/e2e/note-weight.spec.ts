/**
 * Per-note weight in the inspector's chord note list (revision 8 "Distinct notes", M4.5-29b):
 * typing, arrow keys and a scrub drag write `overrides[].weight`, one undo entry each; the chord
 * does not freeze. Chromium only, like the other inspector tests.
 */

import { expect, test, type Page } from '@playwright/test';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough for the inspector');

interface M {
  id: string;
  frozenFrom?: unknown;
  overrides?: { voice: number; weight?: number; pitch?: number }[];
}

interface Hook {
  editor: {
    select(ids: string[]): void;
    undo(): boolean;
    state: { getState(): { undoLabel: string } };
  };
  store: { getState(): { piece: { moments: M[] } } };
}

/** "Drift", a degrees chord in the featured example (Tidewater Hymn). */
const CHORD = 'Zd0uQh';

const chord = (page: Page): Promise<M | undefined> =>
  page.evaluate(
    (id) =>
      (window.__algorhythms as unknown as Hook).store
        .getState()
        .piece.moments.find((m) => m.id === id),
    CHORD,
  );
const undo = (page: Page) =>
  page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.undo());
const undoLabel = (page: Page): Promise<string> =>
  page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.state.getState().undoLabel);
const weights = async (page: Page): Promise<number[]> =>
  ((await chord(page))?.overrides ?? []).flatMap((o) => (o.weight === undefined ? [] : [o.weight]));

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate((id) => (window.__algorhythms as unknown as Hook).editor.select([id]), CHORD);
});

test('typing a note weight writes an override; undo removes it; the chord stays live', async ({
  page,
}) => {
  const insp = page.getByTestId('inspector');
  const box = insp.getByTestId('chord-note').first().getByTestId('chord-note-weight');
  await expect(box).toHaveValue('1');
  await box.fill('3');
  await box.press('Enter');
  await expect.poll(() => weights(page)).toEqual([3]);
  expect(await undoLabel(page)).toBe('Edit note weight');
  expect((await chord(page))?.frozenFrom).toBeUndefined();
  await expect(box).toHaveValue('3');
  // The Overrides list names it.
  await expect(insp.getByTestId('insp-override')).toContainText('weight 3');

  // ↑ is one entry of +0.25.
  await box.focus();
  await box.press('ArrowUp');
  await expect.poll(() => weights(page)).toEqual([3.25]);
  await undo(page);
  await expect.poll(() => weights(page)).toEqual([3]);
  await undo(page);
  await expect.poll(() => weights(page)).toEqual([]);
  await expect(box).toHaveValue('1');
});

test('a scrub drag on × is one undo entry', async ({ page }) => {
  const row = page.getByTestId('inspector').getByTestId('chord-note').nth(1);
  const label = row.locator('.weight-box .scrub-label');
  await label.scrollIntoViewIfNeeded();
  const b = (await label.boundingBox())!;
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + b.width / 2, y);
  await page.mouse.down();
  // 8 steps of 6 px: +2.
  for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width / 2 + i * 6, y);
  await page.mouse.up();
  await expect.poll(() => weights(page)).toEqual([3]);
  await expect(row.getByTestId('chord-note-weight')).toHaveValue('3');
  expect(await undoLabel(page)).toBe('Edit note weight');
  await undo(page);
  await expect.poll(() => weights(page)).toEqual([]);
});
