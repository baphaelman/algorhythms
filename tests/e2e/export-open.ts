/**
 * Opening the export surfaces (PLAN.md §15 M14 "Entry", M15): Menu → Export opens the
 * workspace's last mode (Poster or Video); Menu → Export audio… the audio dialog.
 * `surface(page)` is whichever is showing, so a spec can scope its controls the same way on any.
 */

import { expect, type Page } from '@playwright/test';

export const workspace = (page: Page) => page.getByTestId('poster-workspace');

/** The workspace in Video mode. */
export const videoWorkspace = (page: Page) => page.getByTestId('video-workspace');

/** The open audio dialog, or the workspace in either mode (only one shows at a time). */
export const surface = (page: Page) =>
  page.locator(
    'dialog[data-testid="export-dialog"][open], [data-testid="poster-workspace"], [data-testid="video-workspace"]',
  );

/** Picks Poster or Video in the mode switch of whatever surface shows. */
export async function switchMode(page: Page, mode: 'Poster' | 'Video'): Promise<void> {
  const input = page.getByTestId('export-mode').getByLabel(mode, { exact: true });
  await input.click();
  await expect(mode === 'Poster' ? workspace(page) : videoWorkspace(page)).toBeVisible();
  await expect(mode === 'Poster' ? videoWorkspace(page) : workspace(page)).toBeHidden();
}

/** Menu → Export: the workspace in its last mode. */
export async function openExport(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export').click();
  await expect(surface(page)).toBeVisible();
}

/** Menu → Export, then Poster if Video was remembered; waits for the exporter. */
export async function openPoster(page: Page): Promise<void> {
  await openExport(page);
  if (!(await workspace(page).isVisible())) await switchMode(page, 'Poster');
  await expect(page.getByTestId('export-run')).toBeEnabled();
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-draws', /\d+/);
}

/**
 * Slides the poster workspace's Layers list up (the bottom bar's caret), if it isn't up, and
 * waits until it has settled.
 */
export async function openLayers(page: Page): Promise<void> {
  const caret = page.getByTestId('layers-toggle');
  if ((await caret.getAttribute('aria-expanded')) !== 'true') await caret.click();
  await expect(caret).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('poster-layers')).toBeVisible();
  await expect
    .poll(() => page.getByTestId('poster-layers').evaluate((el) => el.getAnimations().length))
    .toBe(0);
}

/** Slides the Layers list back down (the caret), if it is up. */
export async function closeLayers(page: Page): Promise<void> {
  const caret = page.getByTestId('layers-toggle');
  if ((await caret.getAttribute('aria-expanded')) === 'true') await caret.click();
  await expect(page.getByTestId('poster-layers')).toBeHidden();
}

/** Menu → Export, then Video if Poster was remembered: the workspace's Video mode. */
export async function openVideoExport(page: Page): Promise<void> {
  await openExport(page);
  if (await workspace(page).isVisible()) await switchMode(page, 'Video');
  await expect(videoWorkspace(page)).toBeVisible();
}

/** Menu → Export audio…: WAV, stems and MIDI; waits for the exporter. */
export async function openAudioExport(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export-audio').click();
  await expect(page.getByRole('dialog', { name: 'Export audio' })).toBeVisible();
  await expect(page.getByTestId('export-run')).toBeEnabled();
}

/** Back to music from the workspace (either mode). */
export async function backToMusic(page: Page): Promise<void> {
  await page.getByTestId('back-to-music').click();
  await expect(workspace(page)).toBeHidden();
  await expect(videoWorkspace(page)).toBeHidden();
}

/** Leaves whichever surface shows: Back to music, or the audio dialog's Close. */
export async function closeExport(page: Page): Promise<void> {
  if ((await workspace(page).isVisible()) || (await videoWorkspace(page).isVisible())) {
    await backToMusic(page);
  } else {
    await page.getByTestId('export-close').click();
    await expect(page.getByTestId('export-dialog')).toBeHidden();
  }
}

/**
 * Waits until the address bar (the piece's share link) holds still for 700 ms: poster edits
 * live in the piece, and the address follows an edit after a debounce (400 ms + idle), so a
 * reload right after an edit would reopen the piece as it was before it.
 */
export async function addressSettled(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const a = await page.evaluate(() => location.hash);
        await page.waitForTimeout(700);
        return a === (await page.evaluate(() => location.hash));
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

/**
 * Leaves the workspace by keyboard: Escape leaves a focused control first (it goes to the
 * workspace), then the next Escape leaves the workspace; focus returns to Menu.
 */
export async function escapeOut(page: Page): Promise<void> {
  const shown = () => surface(page).isVisible();
  for (let i = 0; i < 2 && (await shown()); i++) await page.keyboard.press('Escape');
  await expect(workspace(page)).toBeHidden();
  await expect(videoWorkspace(page)).toBeHidden();
}

/**
 * Moves the video preview to time t (on the preview's clock), as a press on the timeline's strip
 * does, but exactly (M15: the preview has no slider of its own).
 */
export async function seekPreview(page: Page, t: number): Promise<void> {
  await page.evaluate(
    (t) =>
      (
        window as unknown as { __algorhythms: { previewSeek(t: number): void } }
      ).__algorhythms.previewSeek(t),
    t,
  );
}
