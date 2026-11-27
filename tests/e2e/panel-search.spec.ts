/**
 * Search in the editors' side panels (owner, 2026-11-27): typing filters the panel's settings
 * with the matched words highlighted; collapsed sections holding a match open and close again;
 * no match says so with Clear; ⌘/Ctrl+F focuses the open editor's box; Escape clears, a second
 * lets go, and the editor's own Escape works after; switching editors clears the term.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import './app-hook';
import {
  backToMusic,
  openPoster,
  openVideoExport,
  switchMode,
  videoWorkspace,
  workspace,
} from './export-open';

test.skip(({ browserName }) => browserName === 'webkit', 'Chromium and Firefox are enough here');

const box = (page: Page, scope: string) => page.getByTestId(`panel-search-${scope}`);

/** The highlighted words (null where the browser has no CSS highlights). */
const highlighted = (page: Page) =>
  page.evaluate(() => {
    const reg = (globalThis.CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights;
    if (!reg) return null;
    return [...(reg.get('panel-search') ?? [])].map((r) => r.toString().toLowerCase());
  });

async function expectHighlights(page: Page, words: string[]): Promise<void> {
  await expect
    .poll(async () => {
      const h = await highlighted(page);
      return h === null ? words : [...new Set(h)].sort();
    })
    .toEqual([...words].sort());
}

const focused = (l: Locator) => l.evaluate((el) => el === document.activeElement);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test('Video: filters, opens Opening & ending, no match, keys', async ({ page }) => {
  await openVideoExport(page);
  const side = videoWorkspace(page).getByRole('complementary', { name: 'Video options' });
  const search = box(page, 'video');
  const bookends = page.getByTestId('bookends-button');
  await expect(bookends).toHaveAttribute('aria-expanded', 'false');

  // ⌘/Ctrl+F focuses the box, replacing the browser's find.
  await page.keyboard.press('ControlOrMeta+f');
  expect(await focused(search)).toBe(true);
  await page.keyboard.type('fade');
  await expect(page.getByTestId('vb-fade-in')).toBeVisible();
  await expect(page.getByTestId('vb-fade-out')).toBeVisible();
  await expect(bookends).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('export-aspect')).toBeHidden();
  await expect(page.getByTestId('export-camera')).toBeHidden();
  await expect(page.getByTestId('vb-lead-in')).toBeHidden();
  await expectHighlights(page, ['fade']);

  // A keyword: "bitrate" finds Quality, nothing highlighted.
  await search.fill('bitrate');
  await expect(page.getByTestId('export-quality')).toBeVisible();
  await expect(page.getByTestId('export-fps')).toBeHidden();
  await expect(bookends).toHaveAttribute('aria-expanded', 'false');
  await expectHighlights(page, []);

  // Several words must all match.
  await search.fill('frame ra');
  await expect(page.getByTestId('export-fps')).toBeVisible();
  await expect(page.getByTestId('video-frame')).toBeHidden();

  // No match: said, and Clear shows everything again.
  await search.fill('zzzq');
  const none = page.getByTestId('panel-search-video-none');
  await expect(none).toHaveText(/No settings match “zzzq”/);
  await expect(page.getByTestId('export-aspect')).toBeHidden();
  await none.getByRole('button', { name: 'Clear' }).click();
  await expect(search).toHaveValue('');
  await expect(none).toBeHidden();
  await expect(page.getByTestId('export-aspect')).toBeVisible();

  // Escape clears, a second lets go; the workspace's Escape (back to music) works after.
  await search.fill('fade');
  await expect(bookends).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(bookends).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('export-aspect')).toBeVisible();
  expect(await focused(search)).toBe(true);
  await page.keyboard.press('Escape');
  expect(await focused(search)).toBe(false);
  await expect(videoWorkspace(page)).toBeVisible();
  await expect(side).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(videoWorkspace(page)).toBeHidden();
});

test('Poster: filters the Look, opens the HUD, clears on switching editors', async ({ page }) => {
  await openPoster(page);
  const search = box(page, 'poster');
  await search.fill('gl');
  await expect(page.getByTestId('look-glow')).toBeVisible();
  await expect(page.getByTestId('look-vignette')).toBeHidden();
  await expect(page.getByTestId('export-pformat')).toBeHidden();
  await expectHighlights(page, ['gl']);
  // "gl" starts no word of "angle"-like labels: Moments, Line width stay hidden.
  await expect(page.getByTestId('look-width')).toBeHidden();

  // A readout inside the collapsed HUD: it opens while searching and closes after.
  const hud = page.getByTestId('look-hud-button');
  await expect(hud).toHaveAttribute('aria-expanded', 'false');
  await search.fill('chord');
  await expect(hud).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('hud-chord')).toBeVisible();
  await expect(page.getByTestId('hud-key')).toBeHidden();
  await search.fill('');
  await expect(hud).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('look-vignette')).toBeVisible();

  // Per editor: switching to Video and back clears it.
  await search.fill('glow');
  await switchMode(page, 'Video');
  await expect(box(page, 'video')).toHaveValue('');
  await switchMode(page, 'Poster');
  await expect(box(page, 'poster')).toHaveValue('');
  await expect(page.getByTestId('look-vignette')).toBeVisible();

  // ⌘/Ctrl+F focuses Poster's box; it's pinned while the options scroll.
  await page.keyboard.press('ControlOrMeta+f');
  expect(await focused(box(page, 'poster'))).toBe(true);
  const top = (await box(page, 'poster').boundingBox())!.y;
  await page.getByTestId('poster-options').evaluate((el) => el.scrollTo(0, 400));
  expect((await box(page, 'poster').boundingBox())!.y).toBe(top);

  await backToMusic(page);
  await expect(workspace(page)).toBeHidden();
});

test('Music: the inspector and the sound drawer', async ({ page }) => {
  // Drift, a chord in Tidewater Hymn.
  await page.evaluate(() =>
    (window.__algorhythms as unknown as { editor: { select(ids: string[]): void } }).editor.select([
      'Zd0uQh',
    ]),
  );
  const insp = page.getByTestId('inspector');
  await expect(insp.locator('[data-moment-id]')).toBeVisible();
  const search = box(page, 'inspector');

  await page.keyboard.press('ControlOrMeta+f');
  expect(await focused(search)).toBe(true);
  await page.keyboard.type('time');
  await expect(page.getByTestId('insp-at')).toBeVisible();
  await expect(page.getByTestId('insp-label')).toBeHidden();
  await expect(insp.getByRole('heading')).toContainText('Chord');
  await expectHighlights(page, ['time']);

  // Escape clears, a second lets go, and the editor's Escape clears the selection after.
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(page.getByTestId('insp-label')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await focused(search)).toBe(false);
  await expect(insp.locator('[data-moment-id]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(insp).toContainText('No moment selected');

  // The open sound drawer takes ⌘/Ctrl+F.
  await page.getByTestId('sound-toggle').click();
  await page.getByTestId('sound-tab-master').click();
  await expect(page.getByTestId('master')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+f');
  const sound = box(page, 'sound');
  expect(await focused(sound)).toBe(true);
  await page.keyboard.type('decay');
  await expect(page.getByTestId('mx-rev-decay')).toBeVisible();
  await expect(page.getByTestId('mx-rev-size')).toBeHidden();
  await expect(page.getByTestId('master')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mx-rev-size')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sound-drawer')).toBeVisible();

  // Opening the export workspace clears the music editor's terms.
  await sound.fill('decay');
  await openPoster(page);
  await backToMusic(page);
  if (!(await page.getByTestId('sound-drawer').isVisible()))
    await page.getByTestId('sound-toggle').click();
  await expect(box(page, 'sound')).toHaveValue('');
});
