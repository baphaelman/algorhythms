/**
 * The export workspace's entry (PLAN.md §15 M14 "Entry"): Menu → Export opens the poster
 * workspace in place of the editor; Back to music and Escape (nothing focused or selected) return
 * with the playhead and zoom kept; Poster | Video is remembered per viewer (Video = today's dialog,
 * video options only, until M15); Menu → Export audio… is a small WAV / stems / MIDI dialog. The
 * editor's keys stand down while the workspace shows.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';
import {
  backToMusic,
  openAudioExport,
  openPoster,
  openVideoExport,
  switchMode,
  workspace,
} from './export-open';

/** The editor's playhead (the time readout) and zoom (window, s). */
const view = (page: Page) =>
  page.evaluate(() => {
    const h = window.__algorhythms!;
    return {
      window: h.store.getState().view.window,
      text: document.querySelector('[data-testid="time"]')?.textContent ?? '',
    };
  });

test.beforeEach(async ({ page }) => {
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test('Menu → Export opens the poster workspace; Back to music keeps the playhead and zoom', async ({
  page,
}) => {
  await seek(page, 41.5);
  const zoom0 = (await view(page)).window;
  await page.locator('body').press('=');
  await page.locator('body').press('=');
  const before = await view(page);
  expect(before.text).toBe('00:41.5');
  expect(before.window).toBeLessThan(zoom0);

  await openPoster(page);
  await expect(page.getByTestId('timeline')).toBeHidden();
  await expect(workspace(page).getByTestId('poster-artboard')).toBeVisible();
  await expect(page.getByTestId('export-mode').getByLabel('Poster', { exact: true })).toBeChecked();
  await expect(page.getByTestId('export-mode').getByLabel('Poster')).toBeFocused();
  // Every poster option, tools and layers, and the Export button.
  for (const id of [
    'export-psize',
    'export-pwidth',
    'export-pheight',
    'export-pformat',
    'export-section',
    'export-prows',
    'export-vtheme',
    'poster-margins',
    'label-line-toggles',
    'look',
    'look-hud-button',
    'look-reset',
    'poster-tools',
    'poster-layers',
  ]) {
    await expect(workspace(page).getByTestId(id).first(), id).toBeAttached();
  }
  await expect(page.getByTestId('export-run')).toHaveText('Export PNG');
  await expect(workspace(page).getByTestId('layer-part')).toHaveCount(4);
  // Editor keys stand down: = would zoom, C would add a chord.
  const moments = await page.evaluate(
    () => window.__algorhythms!.store.getState().piece.moments.length,
  );
  await workspace(page).focus();
  await page.keyboard.press('=');
  await page.keyboard.press('c');
  expect(
    await page.evaluate(() => window.__algorhythms!.store.getState().piece.moments.length),
  ).toBe(moments);

  await backToMusic(page);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('menu-button')).toBeFocused();
  const after = await view(page);
  expect(after.window).toBe(before.window);
  expect(after.text).toBe(before.text);
});

test('Escape: a focused control first lets go, then Escape returns to the music', async ({
  page,
}) => {
  await seek(page, 20);
  const before = await view(page);
  await openPoster(page);
  // The mode switch has focus: the first Escape blurs it, the second leaves.
  await page.keyboard.press('Escape');
  await expect(workspace(page)).toBeVisible();
  await expect(workspace(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(workspace(page)).toBeHidden();
  await expect(page.getByTestId('timeline')).toBeVisible();
  expect((await view(page)).window).toBe(before.window);
  expect((await view(page)).text).toBe('00:20.0');

  // Escape that closes the menu over the workspace does not leave it.
  await openPoster(page);
  await workspace(page).focus();
  await page.getByTestId('menu-button').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('menu-panel')).toBeHidden();
  await expect(workspace(page)).toBeVisible();
});

test('Poster | Video is remembered; Video is the dialog with video options only', async ({
  page,
}) => {
  await openPoster(page);
  await switchMode(page, 'Video');
  const d = page.getByRole('dialog', { name: 'Export video' });
  await expect(workspace(page)).toBeHidden();
  await expect(d.getByTestId('export-format')).toHaveCount(0);
  await expect(d.getByTestId('export-pformat')).toHaveCount(0);
  await expect(d.getByTestId('export-aspect')).toBeVisible();
  await expect(d.getByTestId('preview-canvas')).toBeVisible();
  await expect(d.getByTestId('export-run')).toHaveText('Export video');
  // Closing the video dialog goes back to the music.
  await page.keyboard.press('Escape');
  await expect(d).toBeHidden();
  await expect(page.getByTestId('timeline')).toBeVisible();

  // Menu → Export opens Video now, also after a reload.
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export').click();
  await expect(d).toBeVisible();
  await page.getByTestId('export-close').click();
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openVideoExport(page);
  await switchMode(page, 'Poster');
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export').click();
  await expect(workspace(page)).toBeVisible();
});

test('Menu → Export audio…: WAV, stems and MIDI only, and a WAV downloads', async ({ page }) => {
  test.setTimeout(60_000);
  await openAudioExport(page);
  const d = page.getByRole('dialog', { name: 'Export audio' });
  const format = d.getByTestId('export-format');
  await expect(format.getByRole('radio')).toHaveCount(3);
  for (const label of ['WAV', 'Stems', 'MIDI']) {
    await expect(format.getByLabel(label, { exact: true })).toBeAttached();
  }
  await expect(d.getByTestId('export-mode')).toHaveCount(0);
  await expect(d.getByTestId('preview-canvas')).toHaveCount(0);
  await format.getByLabel('MIDI', { exact: true }).check();
  await page.getByTestId('export-close').click();
  // The audio dialog reopens on the format used last, even after the poster.
  await openPoster(page);
  await backToMusic(page);
  await openAudioExport(page);
  await expect(format.getByLabel('MIDI', { exact: true })).toBeChecked();
  await format.getByLabel('WAV', { exact: true }).check();
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 45_000 }),
    page.getByTestId('export-run').click(),
  ]);
  expect(dl.suggestedFilename()).toMatch(/\.wav$/);
});
