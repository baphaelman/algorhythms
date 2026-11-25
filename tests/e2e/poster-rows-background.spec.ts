/**
 * Rows by sections and backgrounds in the poster workspace (PLAN.md §15 M14, the owner's notes;
 * M14 P5): By sections with edited row labels survives a reload and a share link; a placed
 * gradient and a picture show on the artboard and in the PNG; a share link leaves the picture
 * out and Share says so.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import './app-hook';
import { chooseSegment, clickExportForDownload, setRange } from './export-diag';
import { backToMusic, openPoster, workspace } from './export-open';

const posterOf = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(
      JSON.stringify(
        (window.__algorhythms!.store.getState().piece as { poster?: unknown }).poster ?? null,
      ),
    ),
  );

async function open(page: Page): Promise<void> {
  // Saves as downloads (no save picker).
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
}

async function shareLink(page: Page): Promise<string> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-share').click();
  const dialog = page.getByTestId('share-dialog');
  await expect(dialog.getByTestId('share-length')).toBeVisible();
  return dialog.getByTestId('share-link').inputValue();
}

/** The organize list's labels and New row switches. */
async function organize(page: Page) {
  const items = page.getByTestId('organize-item');
  const n = await items.count();
  const out: { label: string | null; newRow: boolean | null }[] = [];
  for (let i = 0; i < n; i++) {
    const label = page.getByTestId(`organize-label-${i}`);
    const sw = page.getByTestId(`organize-newrow-${i}`);
    out.push({
      label: (await label.count()) ? await label.inputValue() : null,
      newRow: (await sw.count()) ? await sw.isChecked() : null,
    });
  }
  return out;
}

test('rows by sections with edited row labels survive a reload and a share link', async ({
  page,
  context,
}) => {
  await open(page);
  await openPoster(page);
  await page.getByTestId('rows-by').getByLabel('By sections', { exact: true }).click();
  await expect(page.getByTestId('organize')).toBeVisible();
  await expect(page.getByTestId('export-prows')).toHaveCount(0);
  expect(await page.getByTestId('organize-item').count()).toBeGreaterThan(2);
  await page.getByTestId('organize-label-0').fill('A');
  await page.getByTestId('organize-label-1').fill('B');
  await page.getByTestId('organize-newrow-2').click();
  await expect(page.getByTestId('organize-newrow-2')).not.toBeChecked();
  const before = await organize(page);
  expect(before[0].label).toBe('A');
  expect(before[1].label).toBe('B');
  expect(before[2]).toEqual({ label: null, newRow: false });
  const doc = await posterOf(page);
  expect(doc.rowsBy).toBe('sections');

  // Undo takes the last change back, redo restores it.
  await workspace(page).getByTestId('undo').click();
  await expect(page.getByTestId('organize-newrow-2')).toBeChecked();
  await workspace(page).getByTestId('redo').click();
  await expect(page.getByTestId('organize-newrow-2')).not.toBeChecked();

  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#p=2\./);
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  expect(await posterOf(page)).toEqual(doc);
  await openPoster(page);
  expect(await organize(page)).toEqual(before);

  await backToMusic(page);
  const link = await shareLink(page);
  await expect(page.getByTestId('share-no-picture')).toHaveCount(0);
  const fresh = await context.newPage();
  await fresh.goto(link);
  await expect(fresh.getByTestId('title')).toHaveText('Kite Day');
  expect(await posterOf(fresh)).toEqual(doc);
});

/** The artboard's pixel (r, g, b) at fractions of its size. */
const artboardAt = (page: Page, fx: number, fy: number) =>
  page.getByTestId('preview-canvas').evaluate(
    (c: HTMLCanvasElement, [x, y]) => {
      const d = c
        .getContext('2d')!
        .getImageData(Math.round(x * (c.width - 1)), Math.round(y * (c.height - 1)), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [fx, fy],
  );

/** A PNG's pixels (r, g, b) at fractions of its size, decoded in the page. */
async function pngAt(page: Page, bytes: Buffer, points: [number, number][]) {
  return page.evaluate(
    async ([b64, pts]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      return pts.map(([x, y]) => {
        const d = g.getImageData(
          Math.round(x * (bmp.width - 1)),
          Math.round(y * (bmp.height - 1)),
          1,
          1,
        ).data;
        return [d[0], d[1], d[2]];
      });
    },
    [bytes.toString('base64'), points] as const,
  );
}

const reddish = ([r, g, b]: number[]) => r > 150 && r > g + 80 && r > b + 80;
const bluish = ([r, g, b]: number[]) => b > 150 && b > r + 80 && b > g + 80;
const greenish = ([r, g, b]: number[]) => g > 120 && g > r + 60 && g > b + 60;

async function exportPng(page: Page): Promise<Buffer> {
  const dl = await clickExportForDownload(page);
  expect(dl.suggestedFilename()).toMatch(/\.png$/);
  return readFileSync(await dl.path());
}

async function hex(page: Page, testId: string, value: string): Promise<void> {
  const f = page.getByTestId(`${testId}-hex`);
  await f.fill(value);
  await f.press('Enter');
}

test('a placed gradient and a picture show on the artboard and in the PNG; links drop the picture', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await open(page);
  await openPoster(page);
  await chooseSegment(page, 'look-bg', 'Gradient');
  await chooseSegment(page, 'bg-shape', 'Linear');
  await setRange(page, 'bg-angle', 45);
  await hex(page, 'bg-stop-0', '#ff0000');
  await hex(page, 'bg-stop-1', '#0000ff');
  // 45°: from the bottom left (red) to the top right (blue).
  await expect.poll(() => artboardAt(page, 0.003, 0.997).then(reddish)).toBe(true);
  await expect.poll(() => artboardAt(page, 0.997, 0.003).then(bluish)).toBe(true);
  let png = await exportPng(page);
  let px = await pngAt(page, png, [
    [0.001, 0.999],
    [0.999, 0.001],
  ]);
  expect(reddish(px[0]), String(px[0])).toBe(true);
  expect(bluish(px[1]), String(px[1])).toBe(true);

  // A picture: a green image made in the page, picked through the file input.
  const b64 = await page.evaluate(async () => {
    const c = new OffscreenCanvas(64, 36);
    const g = c.getContext('2d')!;
    g.fillStyle = '#00c800';
    g.fillRect(0, 0, 64, 36);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  await page.getByTestId('bg-picture-file').setInputFiles({
    name: 'green.png',
    mimeType: 'image/png',
    buffer: Buffer.from(b64, 'base64'),
  });
  await expect(page.getByTestId('bg-picture')).toHaveAttribute('data-set', 'yes');
  await expect.poll(() => artboardAt(page, 0.003, 0.997).then(greenish)).toBe(true);
  await expect.poll(() => artboardAt(page, 0.997, 0.003).then(greenish)).toBe(true);
  expect((await posterOf(page)).picture).toMatchObject({ w: 64, h: 36 });
  png = await exportPng(page);
  px = await pngAt(page, png, [
    [0.001, 0.999],
    [0.999, 0.001],
  ]);
  expect(px.every(greenish), String(px)).toBe(true);

  // Full dimming washes the gradient back over it.
  await setRange(page, 'bg-picture-dim', 100);
  await expect.poll(() => artboardAt(page, 0.003, 0.997).then(reddish)).toBe(true);

  // Share: the picture stays out of the link, and the dialog says so.
  await backToMusic(page);
  const link = await shareLink(page);
  await expect(page.getByTestId('share-no-picture')).toBeVisible();
  await page.getByTestId('share-close').click();
  const fresh = await context.newPage();
  await fresh.goto(link);
  await expect(fresh.getByTestId('title')).toHaveText('Kite Day');
  const shared = await posterOf(fresh);
  expect(shared?.picture).toBeUndefined();
  await expect(workspace(fresh)).toHaveCount(0);
});
