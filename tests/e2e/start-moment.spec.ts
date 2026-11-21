/**
 * New → Empty (owner 2026-11-21; the start is a moment, M4.5-27): the piece opens silent, with no
 * moments, the piece key at 0:00 selected and its Tonic focused. From silence the palette greys out
 * the transitional moments. The first moment always goes at 0:00, whatever the playhead (palette
 * click, Next); later ones go where asked.
 */
import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';

interface Score {
  voices: { lives: { born: number }[]; segments: { p0: number; p1: number }[] }[];
}
const piece = (page: Page) =>
  page.evaluate(
    () =>
      window.__algorhythms!.store.getState().piece as unknown as {
        version: number;
        moments: { id: string; type: string; at: number }[];
      },
  );
const sounding = (page: Page) =>
  page.evaluate(() => {
    const s = window.__algorhythms!.store.getState().compiled as unknown as Score;
    return s.voices.filter((v) => v.lives.length > 0).map((v) => v.segments[0].p0);
  });

async function openEmpty(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.getByTestId('menu-button').click();
  await page.getByTestId('new-piece').click();
  await expect.poll(async () => (await piece(page)).moments).toEqual([]);
}

test('New → Empty: silent, the key selected with its Tonic focused; first chord at 0:00', async ({
  page,
}) => {
  await openEmpty(page);
  await expect(page.getByTestId('new-piece')).toBeHidden();
  expect((await piece(page)).version).toBe(2);
  expect(await sounding(page)).toEqual([]);

  // The piece key is selected, the inspector shows it and the Tonic control has focus.
  const inspector = page.getByTestId('inspector');
  await expect(inspector.locator('[data-piece-key]')).toBeVisible();
  await expect(page.getByTestId('insp-tonic')).toBeFocused();
  await expect(page.getByTestId('insp-tonic')).toHaveValue('A');
  await page.getByTestId('insp-tonic').selectOption('D');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window.__algorhythms!.store.getState().piece as unknown as { key: object }).key,
      ),
    )
    .toEqual({ tonic: 'D', scale: 'dorian' });

  // Silence: the transitional moments are greyed out at the playhead.
  const palette = page.getByTestId('palette');
  for (const type of ['shift', 'split', 'merge', 'walk', 'note']) {
    const b = palette.locator(`[data-moment="${type}"]`);
    await expect(b, type).toHaveAttribute('aria-disabled', 'true');
    await expect(b, type).toHaveAttribute(
      'title',
      /No effect here: no note is sounding; start with a chord or a unison/,
    );
  }
  for (const type of ['chord', 'unison'])
    await expect(palette.locator(`[data-moment="${type}"]`), type).not.toHaveAttribute(
      'aria-disabled',
    );

  // With the playhead at 0:05, a palette chord still lands at 0:00: its notes come in, no glide.
  await seek(page, 5);
  await palette.locator('[data-moment="chord"]').click();
  await expect
    .poll(async () => (await piece(page)).moments.map((m) => [m.type, m.at]))
    .toEqual([['chord', 0]]);
  await expect.poll(async () => (await sounding(page)).length).toBe(3);
  const moved = await page.evaluate(() => {
    const s = window.__algorhythms!.store.getState().compiled as unknown as Score;
    return s.voices.some((v) => v.segments.some((g) => g.p0 !== g.p1));
  });
  expect(moved).toBe(false);

  // The second goes at the playhead.
  await seek(page, 5);
  await expect(palette.locator('[data-moment="split"]')).not.toHaveAttribute('aria-disabled');
  await palette.locator('[data-moment="split"]').click();
  await expect
    .poll(async () => (await piece(page)).moments.map((m) => [m.type, m.at]))
    .toEqual([
      ['chord', 0],
      ['split', 5],
    ]);
});

test('New → Empty: Next starts at 0:00', async ({ page }) => {
  await openEmpty(page);
  await seek(page, 5);
  const strip = page.getByTestId('suggestions');
  await expect(strip).toHaveAttribute('data-t', '0');
  await strip.locator('[data-suggestion="0"]').click();
  await expect.poll(async () => (await piece(page)).moments.map((m) => m.at)).toEqual([0]);
  await expect.poll(async () => (await sounding(page)).length).toBeGreaterThan(0);
});
