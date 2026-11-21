/**
 * M4.5-37 (PLAN.md "Space always plays and pauses"): after clicking any control, Space toggles
 * playback and the control does not act; text fields type the space. Chromium and Firefox (they
 * activate buttons and selects on Space differently).
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName === 'webkit', 'Chromium and Firefox are enough here');

/** "Drift", a degrees chord in Tidewater Hymn. */
const CHORD = 'Zd0uQh';

const status = (page: Page): Promise<string> =>
  page.evaluate(() => window.__algorhythms!.store.getState().transport.status);
const pieceJson = (page: Page): Promise<string> =>
  page.evaluate(() => JSON.stringify(window.__algorhythms!.store.getState().piece));

/** Presses Space twice: it plays then pauses, and the piece is unchanged by either press. */
async function spaceToggles(page: Page, check?: () => Promise<void>): Promise<void> {
  const before = await pieceJson(page);
  expect(await status(page)).not.toBe('playing');
  await page.keyboard.press('Space');
  await expect.poll(() => status(page)).toBe('playing');
  await check?.();
  await page.keyboard.press('Space');
  await expect.poll(() => status(page)).not.toBe('playing');
  await check?.();
  expect(await pieceJson(page)).toBe(before);
}

const pressed = (l: Locator, v: string) => async () => {
  await expect(l).toHaveAttribute('aria-pressed', v);
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await seek(page, 10);
});

test('Space toggles playback after clicking any control, and the control does not act', async ({
  page,
}) => {
  test.setTimeout(120_000); // many controls, each played and paused
  // Transport: a click would toggle a second time.
  const play = page.getByTestId('play');
  await play.click();
  await expect.poll(() => status(page)).toBe('playing');
  await play.click();
  await expect.poll(() => status(page)).not.toBe('playing');
  await spaceToggles(page);

  // Palette item: a click adds a moment; Space must not add another.
  const palette = page.getByTestId('palette');
  const level = palette.locator('button[data-moment="level"]');
  const count = () =>
    page.evaluate(() => window.__algorhythms!.store.getState().piece.moments.length);
  const n0 = await count();
  await level.click();
  expect(await count()).toBe(n0 + 1);
  await spaceToggles(page);
  expect(await count()).toBe(n0 + 1);

  // Slider.
  const slider = page.getByTestId('window-slider');
  await slider.click();
  const win = await slider.inputValue();
  await spaceToggles(page, async () => expect(await slider.inputValue()).toBe(win));

  // A chip (the inspector's degree picker) and a checkbox (Muted).
  await page.evaluate((id) => window.__algorhythms!.actions.select([id]), CHORD);
  const insp = page.getByTestId('inspector');
  const deg2 = insp.getByRole('button', { name: /^Degree 2 / });
  await deg2.click();
  await expect(deg2).toHaveAttribute('aria-pressed', 'true');
  await spaceToggles(page, pressed(deg2, 'true'));
  const mute = page.getByTestId('insp-mute');
  await mute.click();
  await expect(mute).toBeChecked();
  await spaceToggles(page, async () => expect(mute).toBeChecked());
  // Enter toggles the checkbox now that Space does not.
  await page.keyboard.press('Enter');
  await expect(mute).not.toBeChecked();

  // The Notes drawer's toggle, a mute chip inside it and its timbre select.
  const toggle = page.getByTestId('voices-toggle');
  await toggle.click();
  const drawer = page.getByTestId('voices-drawer');
  await expect(drawer).toBeVisible();
  await spaceToggles(page, async () => expect(drawer).toBeVisible());
  const first = await page.evaluate(
    () => (window.__algorhythms!.store.getState().piece.voices[0] as { id: string }).id,
  );
  const vmute = page.getByTestId(`mute-${first}`);
  await vmute.click();
  await expect(vmute).toHaveAttribute('aria-pressed', 'true');
  await spaceToggles(page, pressed(vmute, 'true'));
  const sel = page.getByTestId('timbre-all');
  const opts = await sel
    .locator('option:not([disabled])')
    .evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
  await sel.selectOption(opts[opts.length - 1]);
  await sel.focus();
  const tv = await sel.inputValue();
  await spaceToggles(page, async () => expect(await sel.inputValue()).toBe(tv));

  // The app menu.
  const menuButton = page.getByTestId('menu-button');
  await menuButton.click();
  await expect(page.getByTestId('menu-panel')).toBeVisible();
  await spaceToggles(page, async () => expect(page.getByTestId('menu-panel')).toBeVisible());
});

test('Space types in text fields and does not play', async ({ page }) => {
  await page.evaluate((id) => window.__algorhythms!.actions.select([id]), CHORD);
  const label = page.getByTestId('insp-label');
  await label.click();
  await label.fill('');
  await page.keyboard.type('a b');
  await page.keyboard.press('Space');
  await expect(label).toHaveValue('a b ');
  await page.waitForTimeout(200);
  expect(await status(page)).not.toBe('playing');
});

test('Enter selects a lane item; Space plays and does not select', async ({ page }) => {
  const item = page.locator(`[data-testid="lane"] [data-moment="${CHORD}"]`).first();
  await item.focus();
  await page.evaluate(() => window.__algorhythms!.actions.select([]));
  const selected = () =>
    page.evaluate(
      () =>
        (
          window.__algorhythms as unknown as {
            editor: { state: { getState(): { selection: string[] } } };
          }
        ).editor.state.getState().selection,
    );
  await spaceToggles(page);
  expect(await selected()).toEqual([]);
  await page.keyboard.press('Enter');
  await expect.poll(selected).toEqual([CHORD]);
});
