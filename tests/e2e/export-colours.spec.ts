/**
 * Export colours (PLAN.md §12 "Exports you can shape" → Colours, §15 M11): schemes, a swatch
 * edit shows Custom, save / reapply / delete a scheme (remembered), the contrast warning, and a
 * gradient background in the preview, an exported video frame and a downloaded poster PNG.
 * $COLOURS_SHOTS_DIR gets two screenshots of the dialog for review.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { chooseSegment, clickExportForDownload, guarded, tap } from './export-diag';
import type * as ExportRun from '../../src/app/export-run';
import type * as VideoExport from '../../src/app/video-export';

interface HookWindow {
  __algorhythms: {
    store: { getState(): { piece: unknown } };
    exportRun(): Promise<typeof ExportRun>;
    videoExport(): Promise<typeof VideoExport>;
  };
}

const dialog = (page: Page) => page.getByTestId('export-dialog');

async function choose(page: Page, testId: string, label: string): Promise<void> {
  const input = dialog(page).getByTestId(testId).getByLabel(label, { exact: true });
  await guarded(page, `choose ${testId} ${label}`, () => input.click());
  await expect(input).toBeChecked();
}

async function openExport(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export').click();
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible();
  await expect(page.getByTestId('export-run')).toBeEnabled();
}

/** Types a swatch's hex (applied once valid). */
async function setHex(page: Page, swatch: string, hex: string): Promise<void> {
  const f = page.getByTestId(`${swatch}-hex`);
  await f.fill(hex);
  await f.press('Enter');
  await expect(page.getByTestId(swatch)).toHaveAttribute('data-set', 'yes');
}

const scheme = (page: Page) => page.getByTestId('colours-scheme');

type RGB = [number, number, number];
/** Mean colours of 5×5 patches near the top-left and bottom-left corners, read in the page. */
interface Ends {
  top: RGB;
  bottom: RGB;
}
/** In-page: the two patches of an RGBA image (passed as a function's source). */
const ENDS = `(d, W, H) => {
  const at = (fx, fy) => {
    const cx = Math.round(fx * (W - 1)), cy = Math.round(fy * (H - 1));
    const s = [0, 0, 0]; let n = 0;
    for (let y = Math.max(0, cy - 2); y <= Math.min(H - 1, cy + 2); y++)
      for (let x = Math.max(0, cx - 2); x <= Math.min(W - 1, cx + 2); x++) {
        const i = (y * W + x) * 4; s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; n++;
      }
    return s.map((v) => Math.round(v / n));
  };
  return { top: at(0.01, 0.005), bottom: at(0.01, 0.995) };
}`;

/** Red at the top, blue at the bottom (the vertical gradient set below), within 40. */
function expectRedToBlue({ top, bottom }: Ends, what: string) {
  expect(top[0], `${what} top ${top}`).toBeGreaterThan(215);
  expect(top[2], `${what} top ${top}`).toBeLessThan(40);
  expect(bottom[2], `${what} bottom ${bottom}`).toBeGreaterThan(215);
  expect(bottom[0], `${what} bottom ${bottom}`).toBeLessThan(40);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await choose(page, 'export-format', 'Video (MP4)');
});

test('schemes: pick, edit a swatch → Custom, save, reapply, delete; remembered', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await expect(scheme(page)).toHaveAttribute('data-value', 'theme');
  await tap(page, 'scheme-night');
  await expect(scheme(page)).toHaveAttribute('data-value', 'night');
  await expect(page.getByTestId('scheme-night')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('look-bg')).toHaveAttribute('data-value', 'gradient');
  await expect(page.getByTestId('look-colors')).toHaveAttribute('data-value', 'pitch');
  const shots = process.env.COLOURS_SHOTS_DIR;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await dialog(page).screenshot({ path: join(shots, 'export-colours-scheme.png') });
  }
  // The scheme reaches the export's Look.
  const look = () =>
    page.evaluate(async () => {
      const r = await (window as unknown as HookWindow).__algorhythms.exportRun();
      return r.lastPreviewRequest()!.options.look!;
    });
  await expect.poll(async () => (await look()).colours?.hud).toBe('#c8d2e8');

  await setHex(page, 'swatch-hud', '#ffffff');
  await expect(scheme(page)).toHaveAttribute('data-value', 'custom');
  await expect(page.getByTestId('scheme-custom')).toBeVisible();
  await expect.poll(async () => (await look()).colours?.hud).toBe('#ffffff');

  await page.getByTestId('colours-scheme-name').fill('Moonlit');
  await tap(page, 'colours-scheme-save');
  await expect(scheme(page)).toHaveAttribute('data-value', 'saved:Moonlit');

  await tap(page, 'scheme-paper');
  await expect(scheme(page)).toHaveAttribute('data-value', 'paper');
  await expect(page.getByTestId('look-bg')).toHaveAttribute('data-value', 'solid');
  await tap(page, 'scheme-saved-Moonlit');
  await expect(scheme(page)).toHaveAttribute('data-value', 'saved:Moonlit');
  await expect(page.getByTestId('swatch-hud-hex')).toHaveValue('#ffffff');

  // Remembered per viewer.
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await choose(page, 'export-format', 'Video (MP4)');
  await expect(scheme(page)).toHaveAttribute('data-value', 'saved:Moonlit');
  await tap(page, 'scheme-delete-Moonlit');
  await expect(page.getByTestId('scheme-saved-Moonlit')).toHaveCount(0);
  await expect(scheme(page)).toHaveAttribute('data-value', 'custom');
  // A swatch's Default button and Theme restore the theme's colours.
  await tap(page, 'swatch-hud-reset');
  await expect(page.getByTestId('swatch-hud')).toHaveAttribute('data-set', 'no');
  await tap(page, 'scheme-theme');
  await expect(scheme(page)).toHaveAttribute('data-value', 'theme');
  await expect.poll(async () => (await look()).colours).toBeUndefined();
});

test('swatches are labelled and keyboard reachable; low contrast warns', async ({ page }) => {
  const pick = dialog(page).getByLabel('HUD text', { exact: true });
  await expect(pick).toHaveAttribute('type', 'color');
  const hex = dialog(page).getByLabel('HUD text hex');
  await hex.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(pick).toBeFocused();
  await expect(page.getByTestId('colours-warning')).toHaveCount(0);
  await choose(page, 'export-vtheme', 'Light');
  await chooseSegment(page, 'look-bg', 'Solid');
  await setHex(page, 'swatch-bg', '#000000');
  await expect(page.getByTestId('colours-warning')).toContainText('Low contrast');
  await setHex(page, 'swatch-hud', '#f0f0f0');
  await setHex(page, 'swatch-labels', '#c0c0c0');
  await expect(page.getByTestId('colours-warning')).toHaveCount(0);
  // Escape in a half-typed hex field reverts it, and leaves the dialog open.
  await hex.fill('#12');
  await hex.press('Escape');
  await expect(hex).toHaveValue('#f0f0f0');
  await expect(dialog(page)).toBeVisible();
});

test('a gradient background: in the preview, a video frame and the poster PNG', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await chooseSegment(page, 'look-bg', 'Gradient');
  await setHex(page, 'swatch-bgFrom', '#ff0000');
  await setHex(page, 'swatch-bgTo', '#0000ff');
  await expect(page.getByTestId('look-bg-dir')).toHaveAttribute('data-value', 'vertical');
  const shots = process.env.COLOURS_SHOTS_DIR;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await dialog(page).screenshot({ path: join(shots, 'export-colours-gradient.png') });
  }
  const preview = () =>
    page.evaluate((src) => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid=preview-canvas]')!;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
      return (0, eval)(src)(d.data, c.width, c.height) as Ends;
    }, ENDS);
  await expect.poll(async () => (await preview()).top[0]).toBeGreaterThan(215);
  expectRedToBlue(await preview(), 'preview');

  const frame = await page.evaluate(async (src) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const req = (await h.exportRun()).lastPreviewRequest()!;
    if (req.kind !== 'video') throw new Error('not video');
    const piece = h.store.getState().piece as never;
    const f = (await h.videoExport()).referenceFrame(piece, req.options, 30);
    return (0, eval)(src)(f.data, f.width, f.height) as Ends;
  }, ENDS);
  expectRedToBlue(frame, 'video frame');

  await choose(page, 'export-format', 'Poster');
  await expect(page.getByTestId('look-bg')).toHaveAttribute('data-value', 'gradient');
  const dl = await clickExportForDownload(page);
  const png = readFileSync(await dl.path()).toString('base64');
  const poster = await page.evaluate(
    async ({ b64, src }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height);
      return (0, eval)(src)(d.data, bmp.width, bmp.height) as Ends;
    },
    { b64: png, src: ENDS },
  );
  expectRedToBlue(poster, 'poster PNG');
  // Transparent stays a poster-only fourth choice.
  await chooseSegment(page, 'look-bg', 'Transparent');
  await choose(page, 'export-format', 'Video (MP4)');
  await expect(page.getByTestId('look-bg')).toHaveAttribute('data-value', 'gradient');
  await expect(page.getByTestId('look-bg').getByLabel('Transparent', { exact: true })).toHaveCount(
    0,
  );
});
