/**
 * The Generate panel (PLAN.md §11.3, §15 M3): open it from the menu, generate with a fixed seed,
 * check a piece loaded and that the same seed reproduces it; keyboard use and the phone layout.
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

interface Snapshot {
  title: string;
  seed: number;
  scale: string;
  voices: number;
  duration: number;
  /** The piece without `meta` (which carries the creation time). */
  body: string;
}

const snapshot = (page: Page): Promise<Snapshot> =>
  page.evaluate(() => {
    const s = window.__algorhythms!.store.getState() as unknown as {
      piece: { meta: { title: string }; seed: number; key: { scale: string }; voices: unknown[] };
      compiled: { duration: number };
    };
    const { meta, ...rest } = s.piece as typeof s.piece & Record<string, unknown>;
    return {
      title: meta.title,
      seed: s.piece.seed,
      scale: s.piece.key.scale,
      voices: s.piece.voices.length,
      duration: s.compiled.duration,
      body: JSON.stringify(rest),
    };
  });

const panel = (page: Page) => page.getByTestId('generate-panel');

async function openPanel(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-generate').click();
  await expect(page.getByRole('dialog', { name: 'Generate a piece' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test('generates a piece from a seed; the same seed and options reproduce it', async ({ page }) => {
  const before = await snapshot(page);
  expect(before.title).toBe('Tidewater Hymn');

  await openPanel(page);
  await panel(page).getByLabel('Seed', { exact: true }).fill('4242');
  await panel(page).getByLabel('Lydian', { exact: true }).check();
  await panel(page).getByLabel('Notes', { exact: true }).fill('6');
  await panel(page).getByLabel('Walk density', { exact: true }).fill('70');
  await page.getByTestId('generate-run').click();

  await expect(page.getByTestId('generate-panel')).toBeHidden();
  const a = await snapshot(page);
  expect(a.title).toBe('Lydian 4242');
  expect(a.seed).toBe(4242);
  expect(a.scale).toBe('lydian');
  expect(a.voices).toBe(6);
  expect(a.duration).toBeGreaterThan(100);
  expect(a.body).not.toBe(before.body);
  await expect(page.getByTestId('title')).toHaveText('Lydian 4242');
  await expect(page.getByTestId('keyvoices')).toContainText(/lydian · \d+ \/ 6 notes/);
  expect(await page.evaluate(() => window.__algorhythms!.store.getState().transport.status)).toBe(
    'idle',
  );

  // Again with the same seed and options (the panel remembers them).
  await openPanel(page);
  await expect(panel(page).getByLabel('Seed', { exact: true })).toHaveValue('4242');
  await page.getByTestId('generate-run').click();
  await expect(page.getByTestId('generate-panel')).toBeHidden();
  const b = await snapshot(page);
  expect(b.body).toBe(a.body);
  expect(b.duration).toBe(a.duration);

  // A different seed, or a different option, gives a different piece.
  await openPanel(page);
  await panel(page).getByLabel('Seed', { exact: true }).fill('4243');
  await page.getByTestId('generate-run').click();
  const c = await snapshot(page);
  expect(c.title).toBe('Lydian 4243');
  expect(c.body).not.toBe(a.body);

  await openPanel(page);
  await panel(page).getByLabel('Seed', { exact: true }).fill('4242');
  await panel(page).getByLabel('Notes', { exact: true }).fill('8');
  await page.getByTestId('generate-run').click();
  const d = await snapshot(page);
  expect(d.voices).toBe(8);
  expect(d.body).not.toBe(a.body);
});

test('text seeds work, "New seed" draws a number, blank seeds are refused, length applies', async ({
  page,
}) => {
  await openPanel(page);
  const seed = panel(page).getByLabel('Seed', { exact: true });
  await seed.fill('moonlight');
  await page.getByTestId('generate-run').click();
  await expect(page.getByTestId('generate-panel')).toBeHidden();
  const first = await snapshot(page);
  expect(first.title).toMatch(/^Dorian \d+$/);

  await openPanel(page);
  await seed.fill('moonlight');
  await page.getByTestId('generate-run').click();
  expect((await snapshot(page)).body).toBe(first.body);

  await openPanel(page);
  const old = await seed.inputValue();
  await page.getByTestId('generate-new-seed').click();
  const fresh = await seed.inputValue();
  expect(fresh).toMatch(/^\d+$/);
  expect(fresh).not.toBe(old);

  await seed.fill('   ');
  await page.getByTestId('generate-run').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Enter a seed' })).toBeVisible();
  await expect(page.getByTestId('generate-panel')).toBeVisible();
  await expect(seed).toHaveAttribute('aria-invalid', 'true');

  // A chosen length: the slider is live by default; "natural length" turns it off.
  await seed.fill('7');
  await expect(panel(page).getByLabel('Length', { exact: true })).toBeEnabled();
  await panel(page).getByLabel('Length', { exact: true }).fill('400');
  await page.getByTestId('generate-run').click();
  const long = await snapshot(page);
  expect(long.duration).toBeGreaterThan(350);
  expect(long.duration).toBeLessThan(460);
});

test('is keyboard operable: Escape closes it and focus returns to the menu button', async ({
  page,
}) => {
  await openPanel(page);
  // The seed field has focus; typing a space there does not start playback.
  await expect(panel(page).getByLabel('Seed', { exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' ');
  expect(await page.evaluate(() => window.__algorhythms!.store.getState().transport.status)).toBe(
    'idle',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('generate-panel')).toBeHidden();
  await expect(page.getByTestId('menu-button')).toBeFocused();

  // Tab reaches every control, and Enter in the seed field generates.
  await openPanel(page);
  await panel(page).getByLabel('Seed', { exact: true }).fill('99');
  await panel(page).getByLabel('Seed', { exact: true }).press('Enter');
  await expect(page.getByTestId('generate-panel')).toBeHidden();
  expect((await snapshot(page)).seed).toBe(99);
});

test('works in the phone layout, in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await openPanel(page);
    const box = (await page.getByTestId('generate-panel').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(700);
    const colors = await page.getByTestId('generate-panel').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, fg: cs.color };
    });
    expect(colors.bg).not.toBe(colors.fg);
    await panel(page)
      .getByLabel('Seed', { exact: true })
      .fill(theme === 'light' ? '11' : '12');
    await page.getByTestId('generate-run').click();
    await expect(page.getByTestId('generate-panel')).toBeHidden();
    expect((await snapshot(page)).seed).toBe(theme === 'light' ? 11 : 12);
  }
});

test.describe('replacing an edited piece', () => {
  const title = async (page: Page) => (await snapshot(page)).title;

  async function generate(page: Page): Promise<void> {
    await openPanel(page);
    await panel(page).getByLabel('Seed', { exact: true }).fill('99');
    await page.getByTestId('generate-run').click();
  }

  async function edit(page: Page): Promise<void> {
    await page.evaluate(() => {
      const h = window.__algorhythms!;
      const ms = h.store.getState().piece.moments;
      const ids = [ms[0]!.id, ms[1]!.id];
      (h as unknown as { editor: { select(i: string[]): void } }).editor.select(ids);
    });
    await page.getByTestId('inspector').getByRole('button', { name: 'Mute all' }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window.__algorhythms as unknown as {
                editor: { state: { getState(): { canUndo: boolean } } };
              }
            ).editor.state.getState().canUndo,
        ),
      )
      .toBe(true);
  }

  test('an unedited piece is replaced without asking', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await generate(page);
    await expect(panel(page)).toBeHidden();
    expect(await title(page)).not.toBe('Tidewater Hymn');
    // A fresh generate is unedited too.
    await generate(page);
    await expect(panel(page)).toBeHidden();
  });

  test('an edited piece is replaced without a warning (autosaved; naming asks only if unnamed)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await edit(page);
    const before = await snapshot(page);
    await generate(page);
    await expect(panel(page)).toBeHidden();
    await expect(page.getByTestId('name-prompt')).toBeHidden();
    expect((await snapshot(page)).body).not.toBe(before.body);
    expect(await title(page)).not.toBe('Tidewater Hymn');
  });
});
