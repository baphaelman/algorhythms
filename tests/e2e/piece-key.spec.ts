/**
 * The piece's key is a fixed key moment at 0:00 (owner 2026-11-21; M4.5-39): the lane shows it on
 * the Key row; selecting it opens the key fields; editing writes `piece.key` (one undo entry) and
 * degree chords follow; Delete does nothing and the inspector's Delete is disabled; a drag does
 * not move it. The opening chord at 0 keeps its first sub-row.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

interface Key {
  tonic: string;
  scale: unknown;
}
const state = (page: Page) =>
  page.evaluate(() => {
    const s = window.__algorhythms!.store.getState() as unknown as {
      piece: { key: Key; moments: { id: string }[] };
    };
    return { key: s.piece.key, n: s.piece.moments.length };
  });
/** Pitch classes the compiled harmony gives a moment, sorted. */
const pcsOf = (page: Page, id: string) =>
  page.evaluate((id) => {
    const s = window.__algorhythms!.store.getState() as unknown as {
      compiled: { harmony: { momentId: string; pcs: number[] }[] };
    };
    return [...(s.compiled.harmony.find((h) => h.momentId === id)?.pcs ?? [])].sort(
      (a, b) => a - b,
    );
  }, id);
/** Degrees 0 2 4 6 of A lydian and of D lydian. */
const A_LYD = [9, 1, 4, 8];
const D_LYD = [2, 6, 9, 1];
const within = (pcs: number[], tones: number[]) => pcs.every((p) => tones.includes(p));
const undo = (page: Page) =>
  page.evaluate(() =>
    (window.__algorhythms as unknown as { editor: { undo(): boolean } }).editor.undo(),
  );

test('the key at 0:00 is edited, never deleted or moved', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=clockwork-heron');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.getByTestId('zoom-fit').click();
  await seek(page, 0);
  const lane = page.getByTestId('lane');
  const key = page.getByTestId('lane-piece-key');
  await expect(key).toHaveText('A lydian');

  // On its own row, next to the opening chord, which stays on the first sub-row.
  const kb = (await key.locator('.lane-marker').boundingBox())!;
  const open = (await lane.locator('[data-moment="start0"] .lane-marker').boundingBox())!;
  // Centres: dense rows draw a smaller marker (lane-dense).
  expect(Math.abs(kb.x + kb.width / 2 - (open.x + open.width / 2))).toBeLessThan(1.5);
  expect(open.y).toBeGreaterThan(kb.y + kb.height);
  // Blocks only: note and pin dots sit above them on the Chords row (PLAN §6.4).
  const ys = await lane
    .locator('[data-moment]:not([data-dot]) .lane-marker')
    .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().y));
  expect(Math.abs(open.y - Math.min(...ys))).toBeLessThan(1);

  const before = await state(page);
  // A degree chord (0 2 4 6 in A lydian).
  const pcs0 = await pcsOf(page, 'PxLoRH');
  expect(pcs0.length).toBeGreaterThan(2);
  expect(within(pcs0, A_LYD)).toBe(true);

  await key.click();
  const insp = page.getByTestId('inspector');
  await expect(insp.locator('[data-piece-key]')).toBeVisible();
  await expect(key).toHaveAttribute('aria-pressed', 'true');
  const del = insp.getByTestId('insp-delete');
  await expect(del).toBeDisabled();
  await expect(del).toHaveAttribute('title', /can't be deleted/);

  // Edit the tonic: piece.key changes, degree chords follow, the lane label too.
  await insp.getByLabel('Tonic').selectOption('D');
  await expect.poll(async () => (await state(page)).key).toEqual({ tonic: 'D', scale: 'lydian' });
  await expect.poll(async () => within(await pcsOf(page, 'PxLoRH'), D_LYD)).toBe(true);
  expect(await pcsOf(page, 'PxLoRH')).not.toEqual(pcs0);
  await expect(key).toHaveText('D lydian');
  // The carry-forward prompt is offered for the opening's fixed notes; Keep them.
  const banner = page.getByTestId('key-carry');
  await expect(banner).toContainText(/Move them to D lydian\?/);
  await banner.getByRole('button', { name: 'Keep' }).click();
  expect((await state(page)).n).toBe(before.n);

  // Delete and Backspace do nothing, on the lane item and globally.
  await key.focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await page.locator('#score').hover();
  await page.keyboard.press('Delete');
  expect(await state(page)).toEqual({ key: { tonic: 'D', scale: 'lydian' }, n: before.n });
  await expect(key).toBeVisible();

  // A drag doesn't move it (nor pan the view).
  const k0 = (await key.boundingBox())!;
  await page.mouse.move(k0.x + 6, k0.y + k0.height / 2);
  await page.mouse.down();
  await page.mouse.move(k0.x + 120, k0.y + k0.height / 2, { steps: 6 });
  await page.mouse.up();
  const k1 = (await key.boundingBox())!;
  expect(Math.abs(k1.x - k0.x)).toBeLessThan(1);
  expect(await state(page)).toEqual({ key: { tonic: 'D', scale: 'lydian' }, n: before.n });

  // One undo restores the key.
  await undo(page);
  await expect.poll(async () => (await state(page)).key).toEqual(before.key);
  await expect.poll(() => pcsOf(page, 'PxLoRH')).toEqual(pcs0);
  await expect(key).toHaveText('A lydian');
});
