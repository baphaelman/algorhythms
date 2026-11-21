/**
 * The moment lane (PLAN.md §11.3, §11.5): select, drag to move (one undo entry), Alt-drag to
 * duplicate, drag a span end, keyboard nudge and delete. Runs on a small piece with a 60 BPM grid
 * (1 s steps).
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

interface M {
  id: string;
  type: string;
  at: number;
  seed?: number;
  glide?: { length?: number; stagger?: number };
}

async function moments(page: Page): Promise<M[]> {
  return page.evaluate(
    () => (window.__algorhythms!.store.getState().piece as unknown as { moments: M[] }).moments,
  );
}

const item = (page: Page, id: string) => page.locator(`[data-moment="${id}"]`);

/** Centre of an item's marker (its time position) in page pixels. */
async function markerAt(page: Page, id: string): Promise<{ x: number; y: number }> {
  const box = await item(page, id).locator('.lane-marker').boundingBox();
  if (!box) throw new Error(`no marker for ${id}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Pixels per second on the lane, from two items' marker positions. */
async function pps(page: Page): Promise<number> {
  const a = await markerAt(page, 'aaaaaa');
  const b = await markerAt(page, 'bbbbbb');
  return (b.x - a.x) / 4;
}

async function drag(
  page: Page,
  from: { x: number; y: number },
  dx: number,
  mods: ('Alt' | 'Shift')[] = [],
): Promise<void> {
  for (const k of mods) await page.keyboard.down(k);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(from.x + (dx * i) / 6, from.y);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  for (const k of mods) await page.keyboard.up(k);
}

test.beforeEach(async ({ page }) => {
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as Record<string, unknown> & {
      view: Record<string, unknown>;
    };
    p.moments = [
      {
        id: 'aaaaaa',
        type: 'chord',
        at: 2,
        notes: { kind: 'degrees', degrees: [0, 2, 4] },
        voicing: 'even',
        assign: 'ordered',
        glide: { length: 1, stagger: 0 },
      },
      {
        id: 'bbbbbb',
        type: 'unison',
        at: 6,
        pitch: 'center',
        octaves: false,
        glide: { length: 2, stagger: 0 },
      },
      {
        id: 'cccccc',
        type: 'chord',
        at: 12,
        notes: { kind: 'degrees', degrees: [1, 3, 5] },
        voicing: 'even',
        assign: 'ordered',
        glide: { length: 1, stagger: 0 },
      },
    ];
    p.end = { at: 20, fade: 1 };
    // Beats are drawn, not snapped to, in these tests ("Snap to beats" is covered in snap-beats).
    p.view = { ...p.view, gridBpm: 60, snapBeats: false, window: 20 };
    h.actions.loadPiece(p);
  });
  await expect(page.getByTestId('lane').locator('[data-moment]')).toHaveCount(3);
});

test('click selects, Shift-click extends, empty click clears', async ({ page }) => {
  await item(page, 'aaaaaa').click();
  await expect(item(page, 'aaaaaa')).toHaveAttribute('aria-pressed', 'true');
  await item(page, 'bbbbbb').click({ modifiers: ['Shift'] });
  await expect(item(page, 'aaaaaa')).toHaveAttribute('aria-pressed', 'true');
  await expect(item(page, 'bbbbbb')).toHaveAttribute('aria-pressed', 'true');
  await item(page, 'cccccc').click();
  await expect(item(page, 'aaaaaa')).toHaveAttribute('aria-pressed', 'false');
  await expect(item(page, 'cccccc')).toHaveAttribute('aria-pressed', 'true');
  const track = await page.locator('.lane-track').boundingBox();
  await page.mouse.click(track!.x + track!.width - 4, track!.y + track!.height - 4);
  await expect(page.locator('[data-moment][aria-pressed="true"]')).toHaveCount(0);
});

test('drag moves a moment (free: no bar-grid snap); undo restores it in one step', async ({
  page,
}) => {
  const k = await pps(page);
  await drag(page, await markerAt(page, 'aaaaaa'), 1.8 * k);
  await expect
    .poll(async () => (await moments(page)).find((m) => m.id === 'aaaaaa')!.at)
    .toBeCloseTo(3.8, 1);
  // The item follows its new time.
  const a = await markerAt(page, 'aaaaaa');
  const b = await markerAt(page, 'bbbbbb');
  expect((b.x - a.x) / k).toBeCloseTo(2, 0);
  await expect(page.getByTestId('lane-live')).toContainText(/Moved chord to 3\.\d+ s/);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await moments(page)).find((m) => m.id === 'aaaaaa')!.at).toBe(2);
});

test('Escape during a drag cancels it', async ({ page }) => {
  const k = await pps(page);
  const from = await markerAt(page, 'aaaaaa');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + k * 3, from.y, { steps: 4 });
  await expect
    .poll(async () => (await moments(page)).find((m) => m.id === 'aaaaaa')!.at)
    .toBeCloseTo(5, 1);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(async () => (await moments(page)).find((m) => m.id === 'aaaaaa')!.at).toBe(2);
});

test('Alt-drag duplicates and the copy keeps the seed', async ({ page }) => {
  const k = await pps(page);
  await drag(page, await markerAt(page, 'bbbbbb'), 2.6 * k, ['Alt']);
  const ms = await moments(page);
  expect(ms).toHaveLength(4);
  const copy = ms.find((m) => !['aaaaaa', 'bbbbbb', 'cccccc'].includes(m.id))!;
  expect(copy.type).toBe('unison');
  expect(copy.at).toBeCloseTo(8.6, 1); // Alt held: no snapping
  expect(typeof copy.seed).toBe('number');
  expect(ms.find((m) => m.id === 'bbbbbb')!.at).toBe(6);
  await expect(item(page, copy.id)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await moments(page)).length).toBe(3);
});

test('dragging a span end changes the glide length; Shift changes the stagger', async ({
  page,
}) => {
  const k = await pps(page);
  const handle = item(page, 'bbbbbb').locator('.lane-end');
  const box = (await handle.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await drag(page, from, 1.5 * k);
  await expect
    .poll(async () => (await moments(page)).find((m) => m.id === 'bbbbbb')!.glide?.length ?? 0)
    .toBeCloseTo(3.5, 0);
  expect((await moments(page)).find((m) => m.id === 'bbbbbb')!.at).toBe(6);

  const box2 = (await handle.boundingBox())!;
  await drag(page, { x: box2.x + box2.width / 2, y: box2.y + box2.height / 2 }, 1 * k, ['Shift']);
  await expect
    .poll(async () => (await moments(page)).find((m) => m.id === 'bbbbbb')!.glide?.stagger ?? 0)
    .toBeCloseTo(1, 0);
});

test('keyboard: focus, nudge by grid steps, delete; global arrows untouched', async ({ page }) => {
  await item(page, 'aaaaaa').click();
  await expect(item(page, 'aaaaaa')).toBeFocused();
  const t0 = await page.evaluate(() => window.__algorhythms!.store.getState().transport.status);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await moments(page)).find((m) => m.id === 'aaaaaa')!.at).toBe(3);
  await expect(page.getByTestId('lane-live')).toContainText('Moved chord to 3 s');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await moments(page)).find((m) => m.id === 'aaaaaa')!.at).toBe(1);
  // The lane kept the arrows: the playhead did not seek.
  expect(await page.evaluate(() => window.__algorhythms!.store.getState().transport.status)).toBe(
    t0,
  );
  // Roving focus to the next moment, select it with Enter, delete it.
  await page.keyboard.press('ArrowDown');
  await expect(item(page, 'bbbbbb')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(item(page, 'bbbbbb')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Delete');
  await expect
    .poll(async () => (await moments(page)).map((m) => m.id))
    .toEqual(['aaaaaa', 'cccccc']);
  await expect(page.getByTestId('lane-live')).toContainText('Deleted unison');
  await expect(item(page, 'cccccc')).toBeFocused();
  // Only one lane item is in the tab order.
  await expect(page.locator('[data-moment][tabindex="0"]')).toHaveCount(1);
});
