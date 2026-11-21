/**
 * Compose for me (PLAN.md §11.3 "Compose in New piece", M4.5-28): New → Compose for me builds a
 * piece on screen; Skip shows all of it, Stop keeps a playable part, a seed change restarts the
 * build, and one undo goes back to the empty piece.
 */
import { expect, test, type Page } from '@playwright/test';
import { generate } from '../../src/core/generate';
import './app-hook';

interface Shown {
  title: string;
  moments: { id: string; at: number }[];
}
const piece = (page: Page): Promise<Shown> =>
  page.evaluate(() => {
    const p = window.__algorhythms!.store.getState().piece;
    return { title: p.meta.title, moments: p.moments };
  });
const count = async (page: Page): Promise<number> => (await piece(page)).moments.length;
const panel = (page: Page) => page.getByTestId('compose-panel');
const status = (page: Page) => panel(page).getAttribute('data-status');

async function compose(page: Page, seed: string): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('compose-piece').click();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId('inspector')).toBeHidden();
  // A fixed seed, so the result can be checked (this restarts the build).
  await page.getByTestId('compose-seed').fill(seed);
  await expect(panel(page)).toHaveAttribute('data-status', 'building');
}

/** The finished piece for `seed` with the panel's default inputs (Dorian, 2:30, 12 notes). */
const expected = (seed: number) =>
  generate(seed, { mode: 'dorian', length: 150, voices: 12, density: 0.45 }).moments;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test('New → Compose for me places moments over time, then shows the full piece', async ({
  page,
}) => {
  await compose(page, '4242');
  const all = expected(4242).length;
  const seen: number[] = [];
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(1500);
    seen.push(await count(page));
  }
  // Moments appear one by one over several seconds, not all at once.
  expect(seen[0]).toBeGreaterThan(0);
  expect(seen[3]).toBeGreaterThan(seen[0]);
  expect(seen[3]).toBeLessThan(all);
  expect(await status(page)).toBe('building');
  // The camera follows the composer's pen to the right.
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.frameStats.start))
    .toBeGreaterThan(5);
  await expect(panel(page)).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
  expect((await piece(page)).moments).toEqual(expected(4242));
});

test('Skip ends with the full piece; one undo empties back to before the compose', async ({
  page,
}) => {
  await compose(page, '77');
  await page.waitForTimeout(800);
  await page.getByTestId('compose-skip').click();
  await expect(panel(page)).toHaveAttribute('data-status', 'done');
  const done = await piece(page);
  expect(done.title).toBe('Dorian 77');
  expect(done.moments).toEqual(expected(77));

  // Undo from the keyboard (not in the seed field, which keeps its own text undo).
  await page.getByTestId('compose-close').click();
  await expect(panel(page)).toBeHidden();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await piece(page)).moments.length).toBe(1);
  expect((await piece(page)).title).toBe('Untitled');
  expect(await page.evaluate(() => window.__algorhythms!.editor.state.getState().canUndo)).toBe(
    false,
  );
});

test('Stop keeps a partial piece that plays', async ({ page }) => {
  await compose(page, '31');
  await page.waitForTimeout(5000);
  await page.getByTestId('compose-stop').click();
  await expect(panel(page)).toHaveAttribute('data-status', 'stopped');
  const kept = await count(page);
  expect(kept).toBeGreaterThan(2);
  expect(kept).toBeLessThan(expected(31).length);
  await page.waitForTimeout(1000);
  expect(await count(page)).toBe(kept);

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.engine()?.currentTime() ?? 0), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0.5);
  const errors = await page.evaluate(() =>
    (
      window.__algorhythms!.store.getState().compiled as unknown as {
        diagnostics: { level: string }[];
      }
    ).diagnostics.filter((d) => d.level === 'error'),
  );
  expect(errors).toEqual([]);
});

test('changing the seed mid-build restarts the build from it', async ({ page }) => {
  await compose(page, '100');
  await page.waitForTimeout(3000);
  expect(await count(page)).toBeGreaterThan(2);
  await page.getByTestId('compose-seed').fill('101');
  // The build starts over: the old moments go, the new seed's come in.
  await expect.poll(() => count(page), { timeout: 2000 }).toBeLessThan(3);
  expect((await piece(page)).title).toBe('Dorian 101');
  const firstSplit = expected(101)[1].id;
  await expect
    .poll(async () => (await piece(page)).moments.some((m) => m.id === firstSplit))
    .toBe(true);
  await page.getByTestId('compose-skip').click();
  expect((await piece(page)).moments).toEqual(expected(101));
});
