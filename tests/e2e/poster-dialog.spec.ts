/**
 * Poster in the Export dialog (PLAN.md §12 "Poster export", "Export look"): the format and its
 * defaults, PNG and SVG saves (download, or a stubbed save picker in Chromium), the PNG's size
 * and transparent background, Look and HUD choices reaching the export, Reset, remembered
 * choices and the phone layout.
 *
 * Owner samples: with LOOK_SAMPLES_DIR set, Chromium saves dialog-poster.png and
 * poster-default.png (the dialog's default poster of Little Round) there.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type * as ExportRun from '../../src/app/export-run';
import { EXPORT_LOOK } from '../../src/render/look';

interface HookWindow {
  __algorhythms: { exportRun(): Promise<typeof ExportRun> };
}

const dialog = (page: Page) => page.getByTestId('export-dialog');
const SAMPLES = process.env.LOOK_SAMPLES_DIR;

async function openExport(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export').click();
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible();
  await expect(page.getByTestId('export-run')).toBeEnabled();
}

async function choose(page: Page, testId: string, label: string): Promise<void> {
  await dialog(page).getByTestId(testId).getByLabel(label, { exact: true }).check();
}

const pickPoster = (page: Page) => choose(page, 'export-format', 'Poster');

async function openLook(page: Page): Promise<void> {
  const look = page.getByTestId('look');
  if ((await look.getAttribute('open')) === null) await page.getByTestId('look-toggle').click();
  await expect(page.getByTestId('look-reset')).toBeVisible();
}

const lastRequest = (page: Page) =>
  page.evaluate(async () =>
    (await (window as unknown as HookWindow).__algorhythms.exportRun()).lastPosterRequest(),
  );

/** Decodes a PNG in the page: its size and the alpha of the pixel at (4, 4). */
async function decodePng(
  page: Page,
  bytes: Buffer,
): Promise<{ width: number; height: number; cornerAlpha: number; inked: number }> {
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let inked = 0;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) inked++;
    return {
      width: bmp.width,
      height: bmp.height,
      cornerAlpha: d[(4 * bmp.width + 4) * 4 + 3],
      inked,
    };
  }, bytes.toString('base64'));
}

async function download(page: Page) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByTestId('export-run').click(),
  ]);
  return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()), dl };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test('offers Poster: PNG 16:9 with the title, the pixel size, Look without video controls', async ({
  page,
}) => {
  await openExport(page);
  await pickPoster(page);
  const d = dialog(page);
  for (const l of ['PNG', '16:9', 'Current']) {
    await expect(d.getByLabel(l, { exact: true })).toBeChecked();
  }
  await expect(page.getByTestId('export-ptitle')).toBeChecked();
  await expect(page.getByTestId('export-size')).toHaveText('3840 × 2160 px, PNG');
  await choose(page, 'export-psize', 'A4 portrait');
  await choose(page, 'export-pformat', 'SVG');
  await expect(page.getByTestId('export-size')).toHaveText('2480 × 3508 px, SVG');
  await choose(page, 'export-psize', '1:1');
  await expect(page.getByTestId('export-size')).toHaveText('2160 × 2160 px, SVG');
  await expect(page.getByTestId('export-run')).toHaveText('Export poster');
  await expect(page.getByTestId('export-codec')).toHaveCount(0);
  await openLook(page);
  for (const t of ['look-future', 'look-follow-at', 'look-playhead', 'look-dots', 'look-rings']) {
    await expect(page.getByTestId(t)).toHaveCount(0);
  }
  await expect(page.getByTestId('look-transparent')).not.toBeChecked();
  await expect(page.getByTestId('look-guides')).not.toBeChecked();
  await expect(page.getByTestId('look-markers')).toBeChecked();
  await expect(page.getByTestId('look-sections')).toBeChecked();
  // A poster's HUD is off by default (it would show end-of-piece values).
  for (const box of await page.getByTestId('look-hud').locator('input').all()) {
    await expect(box).not.toBeChecked();
  }
});

test('PNG and SVG downloads: defaults are EXPORT_LOOK, no HUD; size and transparency', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openExport(page);
  await pickPoster(page);
  const png = await download(page);
  expect(png.name).toBe('Tidewater-Hymn.png');
  await expect(page.getByTestId('export-message')).toContainText(
    /^Saved Tidewater-Hymn\.png \(.+\) to your downloads\./,
  );
  const req = (await lastRequest(page))!;
  expect(req.format).toBe('png');
  expect(req.options).toMatchObject({ size: '16:9', title: true, transparent: false });
  expect(req.options.look).toEqual({ ...EXPORT_LOOK, theme: 'light', hud: [] });
  const img = await decodePng(page, png.bytes);
  expect(img).toMatchObject({ width: 3840, height: 2160, cornerAlpha: 255 });

  // Transparent 1:1: an empty corner has alpha 0.
  await choose(page, 'export-psize', '1:1');
  await openLook(page);
  await page.getByTestId('look-transparent').check();
  const clear = await decodePng(page, (await download(page)).bytes);
  expect(clear).toMatchObject({ width: 2160, height: 2160, cornerAlpha: 0 });
  expect(clear.inked).toBeGreaterThan(100);
  expect((await lastRequest(page))!.options.transparent).toBe(true);

  await choose(page, 'export-pformat', 'SVG');
  const svg = await download(page);
  expect(svg.name).toBe('Tidewater-Hymn.svg');
  const text = svg.bytes.toString('utf8');
  expect(text).toMatch(/<svg[^>]*width="2160"[^>]*height="2160"/);
  expect(text).toContain('</svg>');
  expect((await lastRequest(page))!.format).toBe('svg');
});

test('Look and HUD choices reach the poster; remembered after reload; Reset', async ({ page }) => {
  test.setTimeout(90_000);
  await openExport(page);
  await pickPoster(page);
  await choose(page, 'export-psize', '1:1');
  await page.getByTestId('export-ptitle').uncheck();
  await choose(page, 'export-vtheme', 'Dark');
  await openLook(page);
  await page.getByTestId('look-guides').check();
  await choose(page, 'look-width', 'Bold');
  await choose(page, 'look-colors', 'Ink');
  await page.getByTestId('look-ink').fill('#336699');
  await page.getByTestId('hud-title').check();
  await page.getByTestId('hud-key').check();
  await download(page);
  const req = (await lastRequest(page))!;
  expect(req.options).toMatchObject({ size: '1:1', title: false, theme: 'dark' });
  expect(req.options.look).toMatchObject({
    theme: 'dark',
    guides: true,
    lineWidth: 'bold',
    colors: 'ink',
    lineInk: '#336699',
    hud: ['key', 'title'],
  });

  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await pickPoster(page);
  await openLook(page);
  const d = dialog(page);
  for (const l of ['1:1', 'Dark', 'Bold', 'Ink']) {
    await expect(d.getByLabel(l, { exact: true })).toBeChecked();
  }
  await expect(page.getByTestId('export-ptitle')).not.toBeChecked();
  await expect(page.getByTestId('look-ink')).toHaveValue('#336699');
  await expect(page.getByTestId('hud-title')).toBeChecked();

  await page.getByTestId('look-reset').click();
  for (const l of ['Current', 'Normal', 'As in the app']) {
    await expect(d.getByLabel(l, { exact: true })).toBeChecked();
  }
  await expect(page.getByTestId('look-guides')).not.toBeChecked();
  await expect(page.getByTestId('hud-title')).not.toBeChecked();
  await expect(page.getByTestId('look-ink')).toHaveCount(0);
  // Default / None quick buttons: a poster's default HUD is none.
  await page.getByTestId('hud-chord').check();
  await page.getByTestId('hud-default').click();
  await expect(page.getByTestId('hud-chord')).not.toBeChecked();
  // Reset left the poster's other choices alone.
  await expect(d.getByLabel('1:1', { exact: true })).toBeChecked();
});

test('saves PNG and SVG to a file picked in the save dialog (Chromium)', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'File System Access API');
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__picked = [];
    w.showSaveFilePicker = async (o: { suggestedName: string }) => {
      if (!navigator.userActivation.isActive) throw new DOMException('no gesture', 'SecurityError');
      (w.__picked as unknown[]).push(o);
      return (await navigator.storage.getDirectory()).getFileHandle(o.suggestedName, {
        create: true,
      });
    };
  });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await pickPoster(page);
  await choose(page, 'export-psize', '1:1');
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByTestId('export-run').click();
  await expect(page.getByTestId('export-message')).toContainText(/^Saved Tidewater-Hymn\.png \(/);
  await choose(page, 'export-pformat', 'SVG');
  await page.getByTestId('export-run').click();
  await expect(page.getByTestId('export-message')).toContainText(/^Saved Tidewater-Hymn\.svg \(/);
  await expect(page.getByTestId('export-message')).not.toContainText('downloads');
  expect(downloads).toBe(0);
  const saved = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const png = await (await root.getFileHandle('Tidewater-Hymn.png')).getFile();
    const svg = await (await root.getFileHandle('Tidewater-Hymn.svg')).getFile();
    const bmp = await createImageBitmap(png);
    return {
      picked: (window as unknown as { __picked: unknown[] }).__picked,
      png: { width: bmp.width, height: bmp.height },
      svg: (await svg.text()).slice(0, 200),
    };
  });
  expect(saved.picked).toEqual([
    {
      suggestedName: 'Tidewater-Hymn.png',
      types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }],
    },
    {
      suggestedName: 'Tidewater-Hymn.svg',
      types: [{ description: 'SVG image', accept: { 'image/svg+xml': ['.svg'] } }],
    },
  ]);
  expect(saved.png).toEqual({ width: 2160, height: 2160 });
  expect(saved.svg).toContain('<svg');
});

test('fits a phone screen with Poster and the Look open', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 640 });
  await openExport(page);
  await pickPoster(page);
  await openLook(page);
  const box = (await dialog(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  expect(box.y + box.height).toBeLessThanOrEqual(640);
  expect(await dialog(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (const t of ['look-transparent', 'hud-title', 'look-reset', 'export-run']) {
    await page.getByTestId(t).scrollIntoViewIfNeeded();
    await expect(page.getByTestId(t)).toBeInViewport();
  }
});

test('owner samples: the Poster dialog and the default poster', async ({ page, browserName }) => {
  test.skip(!SAMPLES || browserName !== 'chromium', 'set LOOK_SAMPLES_DIR (Chromium)');
  test.setTimeout(60_000);
  mkdirSync(SAMPLES!, { recursive: true });
  await page.setViewportSize({ width: 900, height: 2200 });
  await page.goto('./?example=little-round');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await pickPoster(page);
  await openLook(page);
  await dialog(page).screenshot({ path: join(SAMPLES!, 'dialog-poster.png') });
  const { dl } = await download(page);
  await dl.saveAs(join(SAMPLES!, 'poster-default.png'));
});
