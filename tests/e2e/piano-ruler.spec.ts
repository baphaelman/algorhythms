/**
 * The piano ruler (PLAN.md §11.3, M5): keys on the score's pitch axis, marked by the key in
 * effect; with a chord selected its notes are pressed and a key toggles a note (freezing the
 * chord, one undo entry); with a pin selected a key moves it; the keyboard reaches every key.
 * Nothing plays aloud (the e2e browsers are muted). Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';
import { byId, item, openFixture, select, undo, undoLabel } from './m5-fixture';
import { shot } from './shots';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

test.beforeEach(async ({ page }) => {
  await openFixture(page);
});

const ruler = (page: Page) => page.getByTestId('piano-ruler');
const key = (page: Page, p: number) => ruler(page).locator(`[data-pitch="${p}"]`);
const pressed = async (page: Page): Promise<number[]> =>
  (
    await ruler(page)
      .locator('[aria-pressed="true"]')
      .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-pitch'))))
  ).sort((a, b) => a - b);

test('shows keys on the pitch axis, marked by the key in effect', async ({ page }) => {
  await expect(ruler(page)).toBeVisible();
  const keys = ruler(page).locator('.piano-key');
  expect(await keys.count()).toBeGreaterThan(6);
  // Tidewater Hymn's key: its tonic keys are marked, black keys drawn as such.
  const tonic = ruler(page).locator('[data-role="tonic"]');
  expect(await tonic.count()).toBeGreaterThan(0);
  const anyBlack = ruler(page).locator('[data-black]');
  expect(await anyBlack.count()).toBeGreaterThan(0);
  // Keys stack top (high) to bottom (low) along the axis.
  const ps = await keys.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-pitch'))));
  const ys = await keys.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  for (let i = 1; i < ps.length; i++) {
    expect(ps[i]).toBe(ps[i - 1] - 1);
    expect(ys[i]).toBeGreaterThan(ys[i - 1]);
  }
  await shot(page, 'm5-piano-ruler.png');
});

test('toggles a selected chord’s notes, one undo entry each', async ({ page }) => {
  await item(page, 'aaaaaa').click();
  await expect.poll(async () => (await pressed(page)).length).toBeGreaterThan(0);
  const notes = await pressed(page);
  // A key in view that the chord does not use.
  const all = await ruler(page)
    .locator('.piano-key')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-pitch'))));
  const free = all.find((p) => !notes.includes(p))!;
  expect(free).toBeDefined();
  await key(page, free).click();
  await expect.poll(() => pressed(page)).toEqual([...notes, free].sort((a, b) => a - b));
  expect(await undoLabel(page)).toBe('Freeze chord and add note');
  const m = (await byId(page, 'aaaaaa'))!;
  expect(m.frozenFrom).toBeDefined();
  expect(m.count).toBe(notes.length + 1);
  await expect(page.getByTestId('insp-chord-frozen')).toBeVisible();
  await expect(page.getByTestId('lane-live')).toContainText('Added');

  await key(page, free).click();
  await expect.poll(() => pressed(page)).toEqual(notes);
  expect(await undoLabel(page)).toBe('Remove chord note');
  await undo(page);
  await undo(page);
  expect((await byId(page, 'aaaaaa'))!.frozenFrom).toBeUndefined();
  await expect.poll(() => pressed(page)).toEqual(notes);
});

test('keyboard: arrows move between keys, Enter presses', async ({ page }) => {
  await item(page, 'aaaaaa').click();
  await expect.poll(async () => (await pressed(page)).length).toBeGreaterThan(0);
  const notes = await pressed(page);
  // Focus the chord's lowest note, then step down to the key below it.
  await key(page, notes[0]).focus();
  await page.keyboard.press('ArrowDown');
  await expect(key(page, notes[0] - 1)).toBeFocused();
  await expect(key(page, notes[0] - 1)).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('Enter');
  await expect.poll(() => pressed(page)).toEqual([notes[0] - 1, ...notes]);
  // And back up.
  await page.keyboard.press('ArrowUp');
  await expect(key(page, notes[0])).toBeFocused();
});

test('moves a selected pin; with nothing selected a key edits nothing', async ({ page }) => {
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      voices: { id: string }[];
      moments: unknown[];
    };
    p.moments.push({ id: 'pppppp', type: 'pin', at: 4, voice: p.voices[0].id, pitch: 60 });
    h.actions.setPiece(p);
  });
  await select(page, ['pppppp']);
  await expect.poll(() => pressed(page)).toEqual([60]);
  await key(page, 62).click();
  await expect
    .poll(async () => (await byId(page, 'pppppp')) as unknown as { pitch: number })
    .toMatchObject({ pitch: 62 });
  expect(await undoLabel(page)).toBe('Move pin');

  await select(page, []);
  const label = await undoLabel(page);
  await key(page, 64).click();
  expect(await undoLabel(page)).toBe(label);
  await expect(ruler(page).locator('[aria-pressed]')).toHaveCount(0);
});
