/**
 * Minimum line opacity (PLAN.md §12 "Ready for YouTube", revision 17; §15 M11): the Look slider
 * reaches the preview, an exported video frame and the poster PNG, and each draws Kite Day's
 * pulsed lines (pulse floor 0.5, 48–86 s) brighter between hits; the preview is the export's
 * frame. M15: the slider is the poster's (Poster mode); the video reads it.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openExport, switchMode } from './export-open';
import { clickExportForDownload } from './export-diag';
import type * as ExportRun from '../../src/app/export-run';
import type * as VideoExport from '../../src/app/video-export';

interface HookWindow {
  __algorhythms: {
    store: { getState(): { piece: unknown } };
    exportRun(): Promise<typeof ExportRun>;
    videoExport(): Promise<typeof VideoExport>;
  };
}

/** In-page: total distance (0..255 per channel) of an RGBA image's pixels from its corner's. */
const INK = `(d) => {
  let s = 0;
  for (let i = 0; i < d.length; i += 4)
    s += Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]);
  return s;
}`;

/** Ink of a downloaded PNG. */
async function pngInk(page: Page, path: string): Promise<number> {
  const b64 = readFileSync(path).toString('base64');
  return page.evaluate(
    async ({ b64, src }) => {
      const bmp = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${b64}`)).blob(),
      );
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      return (0, eval)(src)(g.getImageData(0, 0, bmp.width, bmp.height).data) as number;
    },
    { b64, src: INK },
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
});

test('the preview, a video frame and the poster PNG draw gated lines at the minimum', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const slider = page.getByTestId('look-min-opacity');
  await switchMode(page, 'Poster');
  await expect(slider).toHaveValue('0');
  await expect(page.getByTestId('look-min-opacity-value')).toHaveText('Off');
  await switchMode(page, 'Video');
  const canvas = page.getByTestId('preview-canvas');
  const previewInk = () =>
    canvas.evaluate(
      (c: HTMLCanvasElement, src) =>
        (0, eval)(src)(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data) as number,
      INK,
    );
  /** The preview has drawn at 60 s with this minimum. */
  const drawnAt60 = async (min: number | undefined) => {
    await page.getByTestId('preview-time').fill('60');
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const h = (window as unknown as HookWindow).__algorhythms;
          const req = (await h.exportRun()).lastPreviewRequest();
          return req?.kind === 'video' ? [req.t, req.options.look?.minLineOpacity ?? 0] : null;
        }),
      )
      .toEqual([expect.closeTo(60, 3), min ?? 0]);
    await expect(canvas).toHaveAttribute('data-draws', /\d+/);
    await page.waitForTimeout(200);
  };
  await drawnAt60(0);
  const plain = await previewInk();
  // Set in Poster; the video's preview reads it.
  await switchMode(page, 'Poster');
  await slider.fill('90');
  await expect(page.getByTestId('look-min-opacity-value')).toHaveText('90 %');
  await switchMode(page, 'Video');
  await expect(slider).toHaveCount(0);
  // One row (the edit gave the piece a poster, whose frame is Over the poster).
  const row = page.getByTestId('video-frame').getByLabel('One row', { exact: true });
  await row.click();
  await expect(row).toBeChecked();
  await drawnAt60(0.9);
  const lifted = await previewInk();
  expect(lifted, 'preview').toBeGreaterThan(plain * 1.05);

  // The preview is the export's frame at its time; a frame of the export is lifted the same.
  const r = await page.evaluate(async (src) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const req = (await h.exportRun()).lastPreviewRequest()!;
    if (req.kind !== 'video') throw new Error('not video');
    const piece = h.store.getState().piece as Parameters<typeof VideoExport.referenceFrame>[0];
    const v = await h.videoExport();
    const c = document.querySelector<HTMLCanvasElement>('[data-testid=preview-canvas]')!;
    const a = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const ref = v.referenceFrameAt(piece, req.options, req.t, req.scale, c.width, c.height).data;
    let bad = 0;
    for (let i = 0; i < a.length; i += 4)
      if (Math.max(...[0, 1, 2, 3].map((j) => Math.abs(a[i + j] - ref[i + j]))) > 16) bad++;
    const { minLineOpacity: _m, ...off } = req.options.look!;
    const k = Math.round(60 * req.options.fps);
    const ink = (0, eval)(src) as (d: Uint8ClampedArray) => number;
    return {
      min: req.options.look!.minLineOpacity,
      bad: bad / (a.length / 4),
      on: ink(v.referenceFrame(piece, req.options, k).data),
      // Without the doc, whose look would put the minimum back.
      off: ink(
        v.referenceFrame({ ...piece, poster: undefined }, { ...req.options, look: off }, k).data,
      ),
    };
  }, INK);
  expect(r.min).toBe(0.9);
  expect(r.bad, 'preview vs export frame').toBeLessThan(0.002);
  expect(r.on, 'video frame').toBeGreaterThan(r.off * 1.05);

  // The poster: the same slider; brighter than at 0.
  await switchMode(page, 'Poster');
  await expect(slider).toHaveValue('90');
  const on = await pngInk(page, (await (await clickExportForDownload(page)).path())!);
  await slider.fill('0');
  await expect(page.getByTestId('look-min-opacity-value')).toHaveText('Off');
  const off = await pngInk(page, (await (await clickExportForDownload(page)).path())!);
  expect(on, 'poster PNG').toBeGreaterThan(off * 1.05);
});
