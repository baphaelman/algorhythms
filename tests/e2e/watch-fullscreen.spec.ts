/**
 * Full screen, as YouTube's (owner, 2026-11-27): the Video workspace's button (or F) at the
 * preview's bottom right opens the watch view at the same time, playing or not, in real
 * fullscreen (Chromium headless grants it on a click); leaving fullscreen returns to the
 * workspace. The watch view's bar, with the same button at its bottom right, shows whenever
 * the video is paused, on arrival too.
 */

import { expect, test, type Page } from '@playwright/test';
import { openVideoExport, seekPreview, videoWorkspace } from './export-open';

const watchView = (page: Page) => page.getByTestId('watch-view');
const t = async (page: Page) =>
  Number(await page.getByTestId('preview-canvas').getAttribute('data-t'));
const fsOn = (page: Page) => page.evaluate(() => document.fullscreenElement !== null);

async function workspaceAt(page: Page, at: number): Promise<void> {
  await page.goto('./#kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openVideoExport(page);
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-draws', /\d+/);
  await seekPreview(page, at);
  await expect.poll(() => t(page)).toBeCloseTo(at, 1);
}

/** The element's box sits in the bottom-right corner of the box `of`. */
async function bottomRight(
  page: Page,
  id: string,
  of: { x: number; y: number; w: number; h: number },
) {
  const b = (await page.getByTestId(id).boundingBox())!;
  expect(b.x + b.width, `${id} right`).toBeGreaterThan(of.x + of.w - 90);
  expect(b.y + b.height, `${id} bottom`).toBeGreaterThan(of.y + of.h - 90);
  expect(b.y + b.height).toBeLessThanOrEqual(of.y + of.h + 1);
}

test("the workspace's Full screen opens the watch view at the same time; leaving returns", async ({
  page,
  browserName,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await workspaceAt(page, 30);

  // At the preview's bottom right, on Play's row, right of it; YouTube's title.
  const btn = page.getByTestId('preview-fullscreen');
  await expect(btn).toHaveAttribute('title', 'Full screen (F)');
  const canvas = (await page.getByTestId('preview-canvas').boundingBox())!;
  const fb = (await btn.boundingBox())!;
  const play = (await page.getByTestId('preview-play').boundingBox())!;
  expect(fb.y).toBeGreaterThanOrEqual(canvas.y + canvas.height - 1);
  expect(fb.x).toBeGreaterThan(play.x + play.width - 1);
  expect(Math.abs(fb.y + fb.height / 2 - (play.y + play.height / 2))).toBeLessThan(4);
  expect(fb.x + fb.width).toBeGreaterThan(canvas.x + canvas.width * 0.85);
  await page.screenshot({ path: test.info().outputPath('workspace.png') });

  // Paused: the watch view, paused at 30, no large Play, the same button title there.
  await btn.click();
  await expect(watchView(page)).toBeVisible();
  await expect(page.getByTestId('watch-big-play')).toHaveCount(0);
  await expect(page.getByTestId('watch-play')).toHaveAttribute('data-playing', 'false');
  expect(await t(page)).toBeCloseTo(30, 1);
  if (browserName === 'chromium') {
    await expect.poll(() => fsOn(page)).toBe(true);
    await expect(page.getByTestId('watch-fullscreen')).toHaveAttribute(
      'title',
      'Exit full screen (F)',
    );
    // Its own button: back in the workspace, at the same time.
    await page.mouse.move(400, 400);
    await page.getByTestId('watch-fullscreen').click();
    await expect.poll(() => fsOn(page)).toBe(false);
  } else await page.keyboard.press('Escape');
  await expect(watchView(page)).toHaveCount(0);
  await expect(videoWorkspace(page)).toBeVisible();
  expect(await t(page)).toBeCloseTo(30, 1);

  // Playing, by F: it keeps playing in the watch view.
  await page.getByTestId('preview-play').click();
  await expect(page.getByTestId('preview-play')).toHaveAttribute('data-playing', 'true');
  await page.getByTestId('video-workspace').focus();
  await page.keyboard.press('f');
  await expect(watchView(page)).toBeVisible();
  await expect(page.getByTestId('watch-play')).toHaveAttribute('data-playing', 'true');
  await expect(page.getByTestId('watch-big-play')).toHaveCount(0);
  const at = await t(page);
  await expect.poll(() => t(page)).toBeGreaterThan(at + 0.3);
  if (browserName === 'chromium') {
    await expect.poll(() => fsOn(page)).toBe(true);
    // The browser's own way out (Escape): the workspace.
    await page.evaluate(() => document.exitFullscreen());
  } else await page.keyboard.press('Escape');
  await expect(watchView(page)).toHaveCount(0);
  await expect(videoWorkspace(page)).toBeVisible();

  // F while typing types.
  const desc = page.getByTestId('export-description').locator('textarea, input').first();
  if (await desc.isVisible()) {
    await desc.focus();
    await page.keyboard.press('f');
    await expect(watchView(page)).toHaveCount(0);
  }
});

for (const size of [
  { name: 'a laptop', width: 1440, height: 900, touch: false },
  { name: 'a phone', width: 390, height: 844, touch: true },
]) {
  test.describe(`on ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch });

    test('the bar and Full screen show at the bottom right whenever paused', async ({ page }) => {
      test.setTimeout(90_000);
      await page.goto('./#w&kite-day');
      await expect(watchView(page)).toBeVisible();
      await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-draws', /\d+/);
      // Arrival: paused on the first frame, the bar up with no pointer over it.
      await expect(watchView(page)).toHaveAttribute('data-controls', 'shown');
      const full = page.getByTestId('watch-fullscreen');
      await expect(full).toBeVisible();
      await expect(full).toHaveAttribute('title', 'Full screen (F)');
      const box = { x: 0, y: 0, w: size.width, h: size.height };
      await bottomRight(page, 'watch-fullscreen', box);
      await page.screenshot({ path: test.info().outputPath(`watch-${size.width}.png`) });

      // Still up after a rest while paused.
      await page.waitForTimeout(3_000);
      await expect(watchView(page)).toHaveAttribute('data-controls', 'shown');
      await expect(full).toBeVisible();

      // Playing, it hides after idle; pausing brings it back.
      if (size.touch) await page.getByTestId('watch-big-play').tap();
      else await page.getByTestId('watch-big-play').click();
      await expect(page.getByTestId('watch-play')).toHaveAttribute('data-playing', 'true');
      await expect(watchView(page)).toHaveAttribute('data-controls', 'hidden', { timeout: 8_000 });
      if (size.touch) await page.getByTestId('watch-surface').tap({ position: { x: 100, y: 300 } });
      else await page.mouse.move(300, 300);
      await expect(watchView(page)).toHaveAttribute('data-controls', 'shown');
      if (!size.touch && (await page.evaluate(() => document.fullscreenElement !== null))) {
        await page.evaluate(() => document.exitFullscreen());
        await expect(watchView(page)).toHaveCount(0);
        return;
      }
      await page.keyboard.press('Space');
      await expect(page.getByTestId('watch-play')).toHaveAttribute('data-playing', 'false');
      await page.waitForTimeout(3_000);
      await expect(watchView(page)).toHaveAttribute('data-controls', 'shown');
      await bottomRight(page, 'watch-fullscreen', box);
    });
  });
}
