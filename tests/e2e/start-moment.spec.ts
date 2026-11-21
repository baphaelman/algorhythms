/**
 * The start is a moment (PLAN.md §11.3 revision 7; schema v2, M4.5-27): New → Empty opens with one
 * chord at 0:00 (one dot at the start of its line); deleting it leaves silence, where the palette
 * greys out the transitional moments; adding a chord brings the sound back.
 */
import { expect, test, type Page } from '@playwright/test';
import './app-hook';

interface Score {
  voices: { lives: { born: number }[]; segments: { p0: number; momentId?: string }[] }[];
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
const select = (page: Page, ids: string[]) =>
  page.evaluate((i) => window.__algorhythms!.actions.select(i), ids);

test('New: one dot at 0:00; delete it for silence; a chord brings the sound back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.getByTestId('menu-button').click();
  await page.getByTestId('new-piece').click();

  // One chord at 0 with a single note: v1 on A3, held from the start.
  await expect
    .poll(async () => (await piece(page)).moments.map((m) => [m.type, m.at]))
    .toEqual([['chord', 0]]);
  expect((await piece(page)).version).toBe(2);
  expect(await sounding(page)).toEqual([57]);
  const [{ id }] = (await piece(page)).moments;
  await select(page, [id]);
  const dots = page.getByTestId('chord-dot');
  await expect(dots).toHaveCount(1);
  await expect(dots).toHaveAttribute('data-t', '0.000');
  await expect(dots).toHaveAttribute('data-pitch', '57');

  // Delete it: silence, and the transitional moments are greyed out at the playhead.
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await piece(page)).moments).toEqual([]);
  await expect.poll(() => sounding(page)).toEqual([]);
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

  // Add a chord at the playhead (0:00): its notes come in, with no glide.
  await palette.locator('[data-moment="chord"]').click();
  await expect.poll(async () => (await sounding(page)).length).toBe(3);
  const moved = await page.evaluate(() => {
    const s = window.__algorhythms!.store.getState().compiled as unknown as Score;
    return s.voices.some((v) => v.segments.some((g) => g.p0 !== (g as { p1?: number }).p1));
  });
  expect(moved).toBe(false);
  await expect(palette.locator('[data-moment="split"]')).not.toHaveAttribute('aria-disabled');
});
