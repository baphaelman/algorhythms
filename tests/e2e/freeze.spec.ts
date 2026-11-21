/**
 * Freeze (PLAN.md §11.3 inspector, M5): the inspector's Freeze button bakes a chord's or walk's
 * result into fixed notes with an explicit seed, as one undo entry; Unfreeze brings the chord
 * back; several selected moments freeze together. Chromium only.
 */

import { expect, test } from '@playwright/test';
import { byId, item, openFixture, select, undo, undoLabel } from './m5-fixture';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

test.beforeEach(async ({ page }) => {
  await openFixture(page);
});

test('freezes a chord, keeping its sound; Unfreeze restores it', async ({ page }) => {
  await item(page, 'aaaaaa').click();
  const freeze = page.getByTestId('insp-freeze');
  await expect(freeze).toBeVisible();
  const notesBefore = await page
    .getByTestId('chord-note')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-pitch')));
  await freeze.click();
  expect(await undoLabel(page)).toBe('Freeze moment');
  const m = (await byId(page, 'aaaaaa'))!;
  expect(m.notes?.kind).toBe('pitches');
  expect(m.frozenFrom).toBeDefined();
  expect(typeof m.seed).toBe('number');
  await expect(page.getByTestId('insp-chord-frozen')).toBeVisible();
  await expect(freeze).toHaveCount(0);
  expect(
    await page
      .getByTestId('chord-note')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-pitch'))),
  ).toEqual(notesBefore);
  await page.getByTestId('insp-chord-unfreeze').click();
  expect((await byId(page, 'aaaaaa'))!.notes?.kind).toBe('degrees');
  await expect(page.getByTestId('insp-freeze')).toBeVisible();
});

test('freezes a walk into fixed steps; undo restores it', async ({ page }) => {
  await item(page, 'cccccc').click();
  await page.getByTestId('insp-freeze').click();
  const w = (await byId(page, 'cccccc'))!;
  expect(w.fixed?.length).toBeGreaterThan(0);
  await expect(page.getByTestId('insp-walk-frozen')).toBeVisible();
  await undo(page);
  expect((await byId(page, 'cccccc'))!.fixed).toBeUndefined();
});

test('several selected moments freeze together as one undo entry', async ({ page }) => {
  await select(page, ['aaaaaa', 'bbbbbb', 'cccccc']);
  const freeze = page.getByTestId('insp-freeze');
  // The unison has nothing to freeze.
  await expect(freeze).toHaveText('Freeze 2');
  await freeze.click();
  expect(await undoLabel(page)).toBe('Freeze moments');
  expect((await byId(page, 'aaaaaa'))!.frozenFrom).toBeDefined();
  expect((await byId(page, 'cccccc'))!.fixed).toBeDefined();
  await expect(freeze).toHaveCount(0);
  await undo(page);
  expect((await byId(page, 'aaaaaa'))!.frozenFrom).toBeUndefined();
  expect((await byId(page, 'cccccc'))!.fixed).toBeUndefined();
});
