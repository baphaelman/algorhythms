/**
 * Poster in the Export dialog (PLAN.md §12 "Poster export", "Export look"): the format and its
 * defaults, PNG and SVG saves (download, or a stubbed save picker in Chromium), the PNG's size
 * and transparent background, Look and HUD choices reaching the export, Reset, remembered
 * choices and the phone layout; the live preview (matches a direct render, checkerboard).
 *
 * Interactions go through export-diag's guards (a hang logs the page's state).
 *
 * Owner samples: with LOOK_SAMPLES_DIR set, Chromium saves dialog-poster.png and
 * poster-default.png (the dialog's default poster of Little Round) there.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  chooseSegment,
  clickExportForDownload,
  expectUncovered,
  guarded,
  setHudOpen,
  setRange,
  setSwitch,
  tap,
} from './export-diag';
import type * as ExportRun from '../../src/app/export-run';
import type * as Poster from '../../src/app/poster-export';
import { EXPORT_LOOK } from '../../src/render/look';

interface HookWindow {
  __algorhythms: {
    exportRun(): Promise<typeof ExportRun>;
    poster(): Promise<typeof Poster>;
    store: { getState(): { piece: unknown } };
  };
}

const dialog = (page: Page) => page.getByTestId('export-dialog');
const SAMPLES = process.env.LOOK_SAMPLES_DIR;
/** Review screenshot: poster.png (Little Round, light, 1280×800). */
const PREVIEW_DIR = process.env.EXPORT_PREVIEW_DIR;

async function openExport(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export').click();
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible();
  await expect(page.getByTestId('export-run')).toBeEnabled();
}

/** Picks a radio by its label: a guarded click (not `check()`), then its state. */
async function choose(page: Page, testId: string, label: string): Promise<void> {
  const input = dialog(page).getByTestId(testId).getByLabel(label, { exact: true });
  await guarded(page, `choose ${testId} ${label}`, () => input.click());
  await expect(input).toBeChecked();
}

const pickPoster = (page: Page) => choose(page, 'export-format', 'Poster');

/** The Look section (always shown for video and poster). */
async function openLook(page: Page): Promise<void> {
  await expect(page.getByTestId('look-reset')).toBeAttached();
}

/** Expands the HUD's readout list. */
const openHud = (page: Page) => setHudOpen(page, true);

/** Look segments wider than their box or the dialog, or with an option's text wrapped or cut. */
const badSegments = (page: Page) =>
  dialog(page).evaluate((d) => {
    const bad: string[] = [];
    if (d.querySelector('.look select')) bad.push('a select');
    const right = d.getBoundingClientRect().right;
    for (const g of d.querySelectorAll<HTMLElement>('.look-seg')) {
      const r = g.getBoundingClientRect();
      if (g.scrollWidth > g.clientWidth + 1 || r.right > right + 0.5) bad.push(g.dataset.testid!);
      for (const l of g.querySelectorAll<HTMLElement>('label > span')) {
        if (l.getClientRects().length > 1 || l.scrollWidth > l.clientWidth + 1) {
          bad.push(`${g.dataset.testid}: ${l.textContent}`);
        }
      }
    }
    return bad;
  });

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
  const dl = await clickExportForDownload(page);
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
  for (const t of ['look-future', 'look-follow-at', 'look-playhead', 'look-heads']) {
    await expect(page.getByTestId(t)).toHaveCount(0);
  }
  await expect(page.getByTestId('look-background')).not.toBeChecked();
  await expect(page.getByTestId('look-background')).toHaveAttribute('role', 'switch');
  await expect(page.getByTestId('export-ptitle')).toHaveAttribute('role', 'switch');
  await expect(page.getByTestId('look-guides')).toHaveAttribute('data-value', 'off');
  await expect(page.getByTestId('look-moments')).toHaveAttribute('data-value', 'labels');
  await expect(page.getByTestId('look-width')).toHaveValue('1');
  await expect(dialog(page).locator('.look select')).toHaveCount(0);
  // A poster's HUD is off by default (it would show end-of-piece values).
  await expect(page.getByTestId('look-hud-button')).toHaveText(/None/);
  await openHud(page);
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
  expect(req.options).toMatchObject({
    size: { width: 3840, height: 2160 },
    rows: 1,
    title: true,
    transparent: false,
  });
  expect(req.options.look).toEqual({ ...EXPORT_LOOK, theme: 'light', hud: [] });
  const img = await decodePng(page, png.bytes);
  expect(img).toMatchObject({ width: 3840, height: 2160, cornerAlpha: 255 });

  // Transparent 1:1: an empty corner has alpha 0.
  await choose(page, 'export-psize', '1:1');
  await setSwitch(page, 'look-background', true);
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
  await setSwitch(page, 'export-ptitle', false);
  await choose(page, 'export-vtheme', 'Dark');
  await openLook(page);
  await chooseSegment(page, 'look-guides', 'Lines + labels');
  await setRange(page, 'look-width', 1.75);
  await expect(page.getByTestId('look-width-value')).toHaveText('1.75×');
  await chooseSegment(page, 'look-colors', 'Ink');
  await page.getByTestId('look-ink').fill('#336699');
  await openHud(page);
  await setSwitch(page, 'hud-title', true);
  await setSwitch(page, 'hud-key', true);
  // Expanded, and Export still gets the click (CI v61 WebKit: the old checklist covered it).
  await page.getByTestId('export-run').scrollIntoViewIfNeeded();
  await expectUncovered(page, 'export-run');
  await download(page);
  const req = (await lastRequest(page))!;
  expect(req.options).toMatchObject({
    size: { width: 2160, height: 2160 },
    title: false,
    theme: 'dark',
  });
  expect(req.options.look).toMatchObject({
    theme: 'dark',
    guides: true,
    lineWidth: 1.75,
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
  for (const l of ['1:1', 'Dark']) {
    await expect(d.getByLabel(l, { exact: true })).toBeChecked();
  }
  await expect(page.getByTestId('look-width')).toHaveValue('1.75');
  await expect(page.getByTestId('look-colors')).toHaveAttribute('data-value', 'ink');
  await expect(page.getByTestId('export-ptitle')).not.toBeChecked();
  await expect(page.getByTestId('look-ink')).toHaveValue('#336699');
  await openHud(page);
  await expect(page.getByTestId('hud-title')).toBeChecked();
  await setHudOpen(page, false);

  await tap(page, 'look-reset');
  await expect(d.getByLabel('Current', { exact: true })).toBeChecked();
  await expect(page.getByTestId('look-width')).toHaveValue('1');
  await expect(page.getByTestId('look-colors')).toHaveAttribute('data-value', 'app');
  await expect(page.getByTestId('look-guides')).toHaveAttribute('data-value', 'off');
  await expect(page.getByTestId('look-ink')).toHaveCount(0);
  await openHud(page);
  await expect(page.getByTestId('hud-title')).not.toBeChecked();
  // Default / None quick buttons: a poster's default HUD is none.
  await setSwitch(page, 'hud-chord', true);
  await tap(page, 'hud-default');
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
  for (const t of ['look-background', 'look-hud-button', 'look-reset', 'export-run']) {
    await page.getByTestId(t).scrollIntoViewIfNeeded();
    await expect(page.getByTestId(t)).toBeInViewport();
    await expect(page.getByTestId('preview-canvas')).toBeInViewport({ ratio: 1 });
  }
  await openHud(page);
  await page.getByTestId('hud-title').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('hud-title')).toBeInViewport();
});

/** Waits for a preview draw after `after` draws; returns the count. */
async function drawn(page: Page, after = 0): Promise<number> {
  const c = page.getByTestId('preview-canvas');
  await expect
    .poll(async () => Number((await c.getAttribute('data-draws')) ?? 0))
    .toBeGreaterThan(after);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  return Number(await c.getAttribute('data-draws'));
}

/** The preview against `referencePosterAt` at its size: pixels off by more than 16; alpha at (2, 2). */
async function comparePreview(page: Page) {
  return page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const c = document.querySelector<HTMLCanvasElement>('[data-testid=preview-canvas]')!;
    const a = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const req = (await h.exportRun()).lastPreviewRequest()!;
    if (req.kind !== 'poster') throw new Error('not a poster preview');
    const piece = h.store.getState().piece as never;
    const ref = (await h.poster()).referencePosterAt(
      piece,
      req.options,
      req.scale,
      c.width,
      c.height,
    );
    let bad = 0;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - ref.data[i]) > 16) {
        bad++;
        i += 3 - (i % 4);
      }
    }
    return {
      bad,
      total: a.length / 4,
      width: c.width,
      height: c.height,
      cornerAlpha: a[(2 * c.width + 2) * 4 + 3],
      title: req.options.title,
    };
  });
}

/** A hash of the preview's pixels. */
const previewHash = (page: Page) =>
  page.getByTestId('preview-canvas').evaluate((c: HTMLCanvasElement) => {
    const a = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let h = 0;
    for (let i = 0; i < a.length; i++) h = (Math.imul(h, 31) + a[i]) | 0;
    return h;
  });

test('Beat lines: Every beat draws more than Bars and beats; reaches the poster', async ({
  page,
}) => {
  await openExport(page);
  await pickPoster(page);
  let n = await drawn(page);
  await expect(page.getByTestId('look-beats')).toHaveAttribute('data-value', 'off');
  const off = await previewHash(page);
  await chooseSegment(page, 'look-beats', 'Bars and beats');
  n = await drawn(page, n);
  const auto = await previewHash(page);
  await chooseSegment(page, 'look-beats', 'Every beat');
  await drawn(page, n);
  const every = await previewHash(page);
  expect(new Set([off, auto, every]).size).toBe(3);
  const cmp = await comparePreview(page);
  expect(cmp.bad / cmp.total).toBeLessThan(0.002);
  await download(page);
  expect((await lastRequest(page))!.options.look!.beats).toBe('every');
});

test('the poster preview draws the export’s poster; transparent on a checkerboard; A4', async ({
  page,
}) => {
  await openExport(page);
  await pickPoster(page);
  let n = await drawn(page);
  const canvas = page.getByTestId('preview-canvas');
  await expect(canvas).toHaveAttribute('aria-label', 'Preview of the poster, 16:9');
  const first = await comparePreview(page);
  expect(first.bad / first.total).toBeLessThan(0.002);
  expect(first).toMatchObject({ cornerAlpha: 255, title: true });
  expect(first.width / first.height).toBeCloseTo(16 / 9, 1);

  await setSwitch(page, 'look-background', true);
  n = await drawn(page, n);
  const clear = await comparePreview(page);
  expect(clear.cornerAlpha).toBe(0);
  expect(clear.bad / clear.total).toBeLessThan(0.002);
  await expect(canvas).toHaveClass(/checker/);
  await expect(canvas).toHaveAttribute('aria-label', /transparent background/);
  expect(await canvas.evaluate((el) => getComputedStyle(el).backgroundImage)).toMatch(/gradient/);

  await choose(page, 'export-psize', 'A4 portrait');
  await drawn(page, n);
  const a4 = await comparePreview(page);
  expect(a4.height / a4.width).toBeCloseTo(3508 / 2480, 1);
  expect(a4.bad / a4.total).toBeLessThan(0.002);
});

test('Rows slider redraws the preview; Width/Height sliders and quick picks set the PNG size; cap', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openExport(page);
  await pickPoster(page);
  let n = await drawn(page);
  const canvas = page.getByTestId('preview-canvas');
  await expect(page.getByTestId('export-prows')).toHaveValue('1');
  const one = await previewHash(page);
  await setRange(page, 'export-prows', 4);
  await expect(page.getByTestId('export-prows-value')).toHaveText('4 rows');
  n = await drawn(page, n);
  expect(await previewHash(page)).not.toBe(one);
  await expect(canvas).toHaveAttribute('aria-label', 'Preview of the poster, 16:9, 4 rows');
  const rows = await comparePreview(page);
  expect(rows.bad / rows.total).toBeLessThan(0.002);

  // Width and Height: no quick pick matches; the preview takes the new aspect.
  await setRange(page, 'export-pwidth', 3000);
  await setRange(page, 'export-pheight', 1500);
  await expect(page.getByTestId('export-pwidth-value')).toHaveText('3000 px');
  await expect(page.getByTestId('export-size')).toHaveText('3000 × 1500 px, PNG');
  for (const l of ['16:9', '1:1', 'A4 portrait']) {
    await expect(dialog(page).getByLabel(l, { exact: true })).not.toBeChecked();
  }
  await drawn(page, n);
  const wide = await comparePreview(page);
  expect(wide.width / wide.height).toBeCloseTo(2, 1);
  const png = await download(page);
  expect(await decodePng(page, png.bytes)).toMatchObject({ width: 3000, height: 1500 });
  expect((await lastRequest(page))!.options).toMatchObject({
    size: { width: 3000, height: 1500 },
    rows: 4,
  });

  // Fixed ranges: the sliders never move each other; each number is its slider's value.
  const wEl = page.getByTestId('export-pwidth');
  const hEl = page.getByTestId('export-pheight');
  const labelsMatch = async () => {
    for (const el of [wEl, hEl]) {
      await expect(el).toHaveAttribute('max', '8000');
      await expect(el).toHaveAttribute('min', '1000');
    }
    const [w, h] = [await wEl.inputValue(), await hEl.inputValue()];
    await expect(page.getByTestId('export-pwidth-value')).toHaveText(`${w} px`);
    await expect(page.getByTestId('export-pheight-value')).toHaveText(`${h} px`);
  };
  await expect(page.getByTestId('export-pcap')).toHaveCount(0);
  await setRange(page, 'export-pheight', 4000);
  await labelsMatch();
  const thumbX = () =>
    hEl.evaluate((el) => {
      const i = el as HTMLInputElement;
      return (Number(i.value) - Number(i.min)) / (Number(i.max) - Number(i.min));
    });
  const hThumb = await thumbX();

  // Drag Width to the far right with the pointer: it stops at the cap; Height stays put.
  const box = (await wEl.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  for (const f of [0.5, 0.7, 0.9, 1.05]) {
    await page.mouse.move(box.x + box.width * f, y, { steps: 4 });
    await expect(hEl).toHaveValue('4000');
    await labelsMatch();
  }
  await page.mouse.up();
  await expect(wEl).toHaveValue('4194'); // 16,777,216 / 4000, floored
  await expect(page.getByTestId('export-pwidth-value')).toHaveText('4194 px');
  expect(await thumbX()).toBe(hThumb);
  await expect(page.getByTestId('export-pcap')).toContainText('16.8 million pixels');

  // Keyboard: a step past the cap stays at the cap; a step back is free, and the number follows.
  await wEl.focus();
  await page.keyboard.press('ArrowRight');
  await expect(wEl).toHaveValue('4194');
  await page.keyboard.press('ArrowLeft');
  await expect(wEl).toHaveValue('4193');
  await expect(hEl).toHaveValue('4000');
  await labelsMatch();
  await page.keyboard.press('End');
  await expect(wEl).toHaveValue('4194');
  await labelsMatch();

  // A quick pick sets both sliders.
  await choose(page, 'export-psize', '1:1');
  await expect(page.getByTestId('export-pwidth')).toHaveValue('2160');
  await expect(page.getByTestId('export-pheight')).toHaveValue('2160');
  await expect(page.getByTestId('export-pcap')).toHaveCount(0);
  const sq = await decodePng(page, (await download(page)).bytes);
  expect(sq).toMatchObject({ width: 2160, height: 2160 });

  // Remembered after reload.
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await pickPoster(page);
  await expect(page.getByTestId('export-prows')).toHaveValue('4');
  await expect(dialog(page).getByLabel('1:1', { exact: true })).toBeChecked();
  await labelsMatch();
});

test('the expanded HUD never covers the Export button (desktop and phone)', async ({ page }) => {
  for (const [w, h] of [
    [1280, 800],
    [375, 640],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    if (PREVIEW_DIR && w === 1280) {
      await page.goto('./?example=little-round');
      await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
      await openExport(page);
      await pickPoster(page);
      await drawn(page);
      await page.screenshot({ path: join(PREVIEW_DIR, 'poster.png') });
    } else {
      await openExport(page);
      await pickPoster(page);
    }
    await openHud(page);
    for (const t of ['look-hud', 'hud-title', 'look-reset', 'export-run']) {
      await page.getByTestId(t).scrollIntoViewIfNeeded();
      await expectUncovered(page, t, `${w}: ${t} not covered`);
    }
    // The row collapses it again; Escape closes the dialog (no popup to close first).
    await setHudOpen(page, false);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  }
});

test('the Look segments fit, one line each, at 375 and 1280 px; no dropdowns', async ({ page }) => {
  for (const [w, h] of [
    [375, 640],
    [1280, 800],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await openExport(page);
    await pickPoster(page);
    await openLook(page);
    expect(await badSegments(page), `${w}`).toEqual([]);
    await chooseSegment(page, 'look-guides', 'Lines + labels');
    await chooseSegment(page, 'look-moments', 'Both');
    await chooseSegment(page, 'look-colors', 'Custom');
    expect(await badSegments(page), `${w}`).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
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
