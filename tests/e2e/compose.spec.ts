/**
 * Compose for me (PLAN.md §11.3 "Compose in New piece", "Compose builds in play order"; M4.5-28,
 * M4.5-38): New → Compose for me builds a piece on screen, the camera and pen only moving forward;
 * Skip shows all of it, Stop keeps a playable part, a seed change restarts a build in progress,
 * inputs after the finish wait for Compose again, and one undo goes back to the empty piece.
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

interface Sample {
  start: number;
  pen: number;
  detail: boolean;
  status: string | null;
}

/** Records the camera, pen and phase every frame until the build ends. */
async function trace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const out: Sample[] = [];
    (window as unknown as { __trace: Sample[] }).__trace = out;
    const tick = (): void => {
      const status =
        document.querySelector('[data-testid="compose-panel"]')?.getAttribute('data-status') ??
        null;
      out.push({ start: h.frameStats.start, pen: h.compose.pen, detail: h.compose.detail, status });
      if (status === 'building') requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const traced = (page: Page): Promise<Sample[]> =>
  page.evaluate(() => (window as unknown as { __trace: Sample[] }).__trace);

test('New → Compose for me places moments over time, then shows the full piece', async ({
  page,
}) => {
  await compose(page, '4242');
  await trace(page);
  const all = expected(4242).length;
  await expect.poll(() => count(page), { timeout: 15_000 }).toBeGreaterThan(0);
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

  // In play order: the camera and pen never move back while the structure is placed; the detail
  // sweep then shows the whole piece (the camera still) and its pen also only moves forward.
  const samples = (await traced(page)).filter((s) => s.status === 'building');
  const structure = samples.filter((s) => !s.detail);
  const details = samples.filter((s) => s.detail);
  expect(structure.length).toBeGreaterThan(100);
  expect(details.length).toBeGreaterThan(5);
  expect(samples.findIndex((s) => s.detail)).toBe(structure.length);
  for (let i = 1; i < structure.length; i++) {
    expect(structure[i].start).toBeGreaterThanOrEqual(structure[i - 1].start - 1e-6);
    expect(structure[i].pen).toBeGreaterThanOrEqual(structure[i - 1].pen - 1e-6);
  }
  expect(structure.at(-1)!.pen).toBeGreaterThan(140);
  // The first detail frame may still show the last structural camera; from then on it holds.
  for (let i = 2; i < details.length; i++) {
    expect(details[i].start).toBe(details[1].start);
    expect(details[i].pen).toBeGreaterThanOrEqual(details[i - 1].pen);
  }
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

  // Undo from the keyboard (not in the seed field, which keeps its own text undo). The user's own
  // history change closes the panel, and the inspector returns.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await piece(page)).moments.length).toBe(1);
  await expect(panel(page)).toBeHidden();
  await expect(page.getByTestId('inspector')).toBeVisible();
  expect((await piece(page)).title).toBe('Untitled');
  expect(await page.evaluate(() => window.__algorhythms!.editor.state.getState().canUndo)).toBe(
    false,
  );
});

test('Stop keeps a partial piece that plays', async ({ page }) => {
  await compose(page, '31');
  await expect.poll(() => count(page), { timeout: 30_000 }).toBeGreaterThan(2);
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
  await expect.poll(() => count(page), { timeout: 30_000 }).toBeGreaterThan(2);
  await page.getByTestId('compose-seed').fill('101');
  // The build starts over: the old moments go, the new seed's come in.
  await expect.poll(() => count(page), { timeout: 10_000 }).toBeLessThan(3);
  expect((await piece(page)).title).toBe('Dorian 101');
  const firstSplit = expected(101)[1].id;
  await expect
    .poll(async () => (await piece(page)).moments.some((m) => m.id === firstSplit))
    .toBe(true);
  await page.getByTestId('compose-skip').click();
  expect((await piece(page)).moments).toEqual(expected(101));
});

test('after the finish, inputs wait for Compose again', async ({ page }) => {
  await compose(page, '55');
  await page.getByTestId('compose-skip').click();
  await expect(panel(page)).toHaveAttribute('data-status', 'done');
  const done = await piece(page);
  expect(done.moments).toEqual(expected(55));

  await page.getByTestId('compose-seed').fill('56');
  await page.waitForTimeout(1500);
  await expect(panel(page)).toHaveAttribute('data-status', 'done');
  expect(await piece(page)).toEqual(done);

  await page.getByTestId('compose-again').click();
  await expect(panel(page)).toHaveAttribute('data-status', 'building');
  await expect.poll(async () => (await piece(page)).title).toBe('Dorian 56');
  await page.getByTestId('compose-skip').click();
  expect((await piece(page)).moments).toEqual(expected(56));
  // Still one undo entry back to the empty piece.
  await page.getByTestId('compose-close').click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await piece(page)).moments.length).toBe(1);
  expect(await page.evaluate(() => window.__algorhythms!.editor.state.getState().canUndo)).toBe(
    false,
  );
});
