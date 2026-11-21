/**
 * Compact view bar (build-log "Compact view bar"): Add + Next on one row and the view controls on
 * a second at 1280 px (≤ 3 rows at 1024); Lines, Theme, HUD and Keep lines in order live in the
 * "View ▾" popover, the keys hint in "?". Chromium only (layout).
 */

import { expect, test, type Page } from '@playwright/test';
import './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

async function open(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
}

const barHeight = (page: Page) =>
  page.locator('.viewbar').evaluate((e) => e.getBoundingClientRect().height);

for (const [w, h, max] of [
  [1280, 800, 100],
  [1024, 768, 140],
] as const) {
  test(`${w}×${h}: the bar is at most ${max} px tall and the page does not scroll`, async ({
    page,
  }) => {
    await open(page, w, h);
    expect(await barHeight(page)).toBeLessThanOrEqual(max);
    const bar = (await page.locator('.viewbar').boundingBox())!;
    // Every control stays inside the bar and the window.
    for (const id of ['palette', 'suggestions', 'zoom-fit', 'voices-toggle', 'sound-toggle']) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.y, id).toBeGreaterThanOrEqual(bar.y - 1);
      expect(b.y + b.height, id).toBeLessThanOrEqual(bar.y + bar.height + 1);
      expect(b.x + b.width, id).toBeLessThanOrEqual(w);
    }
    await page.getByTestId('voices-toggle').click();
    await expect(page.locator('.voices-drawer')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(h);
  });
}

test('1280×800: Add and Next share a row; all suggestions show whole', async ({ page }) => {
  await open(page, 1280, 800);
  const a = (await page.getByTestId('palette').boundingBox())!;
  const n = (await page.getByTestId('suggestions').boundingBox())!;
  expect(Math.abs(a.y - n.y)).toBeLessThan(4);
  expect(n.x).toBeGreaterThanOrEqual(a.x + a.width);
  const hidden = await page.getByTestId('suggestions').evaluate((s) => {
    const r = s.getBoundingClientRect();
    return [...s.querySelectorAll('button')].filter(
      (b) => b.getBoundingClientRect().bottom > r.bottom,
    ).length;
  });
  expect(hidden).toBe(0);
});

test('View popover: opens, toggles theme and HUD, closes on Escape and outside press', async ({
  page,
}) => {
  await open(page, 1280, 800);
  const button = page.getByTestId('view-options');
  const panel = page.getByTestId('view-options-panel');
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('hud-toggle')).toBeHidden();

  // Keyboard: Enter opens, Tab reaches the panel's controls.
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).toBeVisible();
  // The panel opens upward and stays inside the window.
  const pb = (await panel.boundingBox())!;
  expect(pb.y).toBeGreaterThanOrEqual(0);
  expect(pb.x + pb.width).toBeLessThanOrEqual(1280);
  await page.keyboard.press('Tab');
  await expect(panel.locator('[data-color="ink"]')).toBeFocused();

  await panel.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const hud = page.getByTestId('hud-toggle');
  const before = await hud.getAttribute('aria-pressed');
  await hud.click();
  await expect(hud).not.toHaveAttribute('aria-pressed', before!);
  expect(await page.evaluate(() => window.__algorhythms!.store.getState().view.hud)).toBe(
    before !== 'true',
  );

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(button).toBeFocused();
  // A press outside closes it.
  await button.click();
  await expect(panel).toBeVisible();
  await page.locator('.stage canvas').click({ position: { x: 40, y: 40 } });
  await expect(panel).toBeHidden();
});

test('? shows the keys hint', async ({ page }) => {
  await open(page, 1280, 800);
  await expect(page.locator('.keys')).toBeHidden();
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.locator('.keys')).toBeVisible();
  await expect(page.locator('.keys')).toContainText('plays and pauses');
  await page.keyboard.press('Escape');
  await expect(page.locator('.keys')).toBeHidden();
});

test('390 px wide: the bar wraps without horizontal scroll', async ({ page }) => {
  await open(page, 390, 844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByTestId('view-options').click();
  const pb = (await page.getByTestId('view-options-panel').boundingBox())!;
  expect(pb.x).toBeGreaterThanOrEqual(0);
  expect(pb.x + pb.width).toBeLessThanOrEqual(390);
});
