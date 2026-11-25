/**
 * Opening the export surfaces (PLAN.md §15 M14 "Entry"): Menu → Export opens the workspace's
 * last mode (Poster, or Video = the video dialog until M15); Menu → Export audio… the audio
 * dialog. `surface(page)` is whichever is showing, so a spec can scope its controls the same way
 * on either.
 */

import { expect, type Page } from '@playwright/test';

export const workspace = (page: Page) => page.getByTestId('poster-workspace');

/** The open export dialog, or the poster workspace (only one shows at a time). */
export const surface = (page: Page) =>
  page.locator('dialog[data-testid="export-dialog"][open], [data-testid="poster-workspace"]');

/** Picks Poster or Video in the mode switch of whatever surface shows. */
export async function switchMode(page: Page, mode: 'Poster' | 'Video'): Promise<void> {
  const input = page.getByTestId('export-mode').getByLabel(mode, { exact: true });
  await input.click();
  if (mode === 'Poster') {
    await expect(workspace(page)).toBeVisible();
    await expect(page.getByTestId('export-dialog')).toBeHidden();
  } else {
    await expect(page.getByRole('dialog', { name: 'Export video' })).toBeVisible();
  }
}

async function menuExport(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export').click();
  await expect(surface(page)).toBeVisible();
}

/** Menu → Export, then Poster if Video was remembered; waits for the exporter. */
export async function openPoster(page: Page): Promise<void> {
  await menuExport(page);
  if (!(await workspace(page).isVisible())) await switchMode(page, 'Poster');
  await expect(page.getByTestId('export-run')).toBeEnabled();
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-draws', /\d+/);
}

/** Menu → Export, then Video if Poster was remembered: the video dialog. */
export async function openVideoExport(page: Page): Promise<void> {
  await menuExport(page);
  if (await workspace(page).isVisible()) await switchMode(page, 'Video');
  await expect(page.getByRole('dialog', { name: 'Export video' })).toBeVisible();
}

/** Menu → Export audio…: WAV, stems and MIDI; waits for the exporter. */
export async function openAudioExport(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export-audio').click();
  await expect(page.getByRole('dialog', { name: 'Export audio' })).toBeVisible();
  await expect(page.getByTestId('export-run')).toBeEnabled();
}

/** Back to music from the poster workspace. */
export async function backToMusic(page: Page): Promise<void> {
  await page.getByTestId('back-to-music').click();
  await expect(workspace(page)).toBeHidden();
}
