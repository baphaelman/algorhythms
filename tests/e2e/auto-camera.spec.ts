/**
 * The Auto camera (PLAN.md §15 M11.5 C2) on Crease: the preview's drawing is the export's frame
 * at the opening, a lean-in at the crossing and the pull-back, an Auto MP4's decoded frames match
 * the path, and Auto draws another picture than Follow. Crease has no camera, so the dialog opens
 * on Auto (C3) and its own preview is checked against the exported frame.
 */

import { expect, test, type Page } from '@playwright/test';
import { openVideoExport, seekPreview } from './export-open';
import { guarded } from './export-diag';
import type * as ExportRun from '../../src/app/export-run';
import type * as VideoExport from '../../src/app/video-export';

interface HookWindow {
  __algorhythms: {
    store: { getState(): { piece: unknown; compiled: unknown } };
    exportRun(): Promise<typeof ExportRun>;
    videoExport(): Promise<typeof VideoExport>;
  };
}

/** The workspace's Video mode (M15: the old Export dialog's place). */
const dialog = (page: Page) => page.getByTestId('video-workspace');

async function choose(page: Page, testId: string, label: string): Promise<void> {
  const input = dialog(page).getByTestId(testId).getByLabel(label, { exact: true });
  await guarded(page, `choose ${testId} ${label}`, () => input.click());
  await expect(input).toBeChecked();
}

/** Crease, the Export dialog open on Video, 720p, Auto (a piece without camera is Auto). */
async function openCrease(page: Page): Promise<void> {
  await page.goto('./?example=crease');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openVideoExport(page);
  await expect(page.getByTestId('export-codec')).not.toHaveText(/Checking/, { timeout: 20_000 });
  await choose(page, 'export-vsize', '720p');
  await expect(
    dialog(page).getByTestId('export-camera').getByLabel('Auto', { exact: true }),
  ).toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await (window as unknown as HookWindow).__algorhythms.exportRun()).lastPreviewRequest()
            ?.kind,
      ),
    )
    .toBe('video');
}

/** In-page PSNR (dB) of two RGBA images' colour channels. */
const PSNR = `(a, b) => {
  let se = 0;
  for (let i = 0; i < a.length; i += 4)
    for (let j = 0; j < 3; j++) { const d = a[i + j] - b[i + j]; se += d * d; }
  return 10 * Math.log10((255 * 255) / Math.max(se / ((a.length / 4) * 3), 1e-9));
}`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('Auto on Crease: the preview is the export frame; Auto is not Follow', async ({ page }) => {
  test.setTimeout(90_000);
  await openCrease(page);
  const r = await page.evaluate(
    async ({ src }) => {
      const psnr = (0, eval)(src) as (a: Uint8ClampedArray, b: Uint8ClampedArray) => number;
      const h = (window as unknown as HookWindow).__algorhythms;
      const req = (await h.exportRun()).lastPreviewRequest()!;
      if (req.kind !== 'video') throw new Error('not video');
      const piece = h.store.getState().piece as never;
      const compiled = h.store.getState().compiled as never;
      const m = await h.videoExport();
      if (req.options.camera !== 'auto') throw new Error(`dialog camera ${req.options.camera}`);
      const opts = req.options;
      const out: Record<string, { atExport: number; follow: number; keys: number }> = {};
      // The opening (blank paper), the bloom, the lean-in at the crossing (79.5 s), the pull-back.
      for (const t of [0.5, 20, 79.5, 114]) {
        const k = Math.round(t * opts.fps);
        const g = new OffscreenCanvas(1280, 720).getContext('2d', { alpha: false })!;
        m.previewVideoFrame(g as never, piece, compiled, opts, k / opts.fps, 1);
        const frame = m.referenceFrame(piece, opts, k).data;
        out[t] = {
          atExport: psnr(g.getImageData(0, 0, 1280, 720).data, frame),
          follow: psnr(frame, m.referenceFrame(piece, { ...opts, camera: 'follow' }, k).data),
          keys: m.frameOptions(piece, opts, compiled).keys?.length ?? 0,
        };
      }
      return out;
    },
    { src: PSNR },
  );
  console.log(`[auto-camera] preview ${JSON.stringify(r)}`);
  for (const [t, v] of Object.entries(r)) {
    expect(v.keys, 'auto keys').toBeGreaterThan(4);
    expect(v.atExport, `preview code vs frame at ${t} s`).toBeGreaterThan(45);
    expect(v.follow, `Auto vs Follow at ${t} s`).toBeLessThan(v.atExport - 15);
  }

  // The dialog's own Auto preview (its canvas) is the exported Auto frame.
  for (const t of [20, 79.5]) {
    await seekPreview(page, t);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const req = (
            await (window as unknown as HookWindow).__algorhythms.exportRun()
          ).lastPreviewRequest();
          return req?.kind === 'video' ? req.t : NaN;
        }),
      )
      .toBeCloseTo(t, 2);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))));
    const bad = await page.evaluate(async (t) => {
      const h = (window as unknown as HookWindow).__algorhythms;
      const req = (await h.exportRun()).lastPreviewRequest()!;
      if (req.kind !== 'video' || req.options.camera !== 'auto') throw new Error('not auto');
      const m = await h.videoExport();
      const c = document.querySelector<HTMLCanvasElement>('[data-testid=preview-canvas]')!;
      const live = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const piece = h.store.getState().piece as never;
      const ref = m.referenceFrameAt(piece, req.options, t, req.scale, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < live.length; i += 4)
        if (Math.max(...[0, 1, 2, 3].map((j) => Math.abs(live[i + j] - ref[i + j]))) > 16) n++;
      return n / (live.length / 4);
    }, t);
    expect(bad, `dialog preview vs Auto export frame at ${t} s`).toBeLessThan(0.002);
  }
});

test('Auto on Crease: the exported MP4 frames are the Auto path', async ({
  page,
  browserName,
}, info) => {
  test.skip(browserName !== 'chromium', 'Chromium (the export pipeline is covered per engine)');
  test.skip(info.project.name.endsWith('-prod'), 'once');
  test.setTimeout(180_000);
  await openCrease(page);
  const r = await page.evaluate(
    async ({ src }) => {
      const psnr = (0, eval)(src) as (a: Uint8ClampedArray, b: Uint8ClampedArray) => number;
      const h = (window as unknown as HookWindow).__algorhythms;
      const req = (await h.exportRun()).lastPreviewRequest()!;
      if (req.kind !== 'video') throw new Error('not video');
      const piece = h.store.getState().piece as never;
      const m = await h.videoExport();
      // The opening's first 6 s: tight on the first note, starting on blank paper.
      const opts = { ...req.options, camera: 'auto' as const, section: { start: 0, end: 6 } };
      delete (opts as { bookends?: unknown }).bookends;
      const sink = m.blobSink();
      await m.exportVideo(piece, opts, sink);
      const el = document.createElement('video');
      el.muted = true;
      el.preload = 'auto';
      const once = (type: string) =>
        new Promise<void>((resolve, reject) => {
          el.addEventListener(type, () => resolve(), { once: true });
          el.addEventListener('error', () => reject(new Error(el.error?.message ?? 'media')), {
            once: true,
          });
        });
      const url = URL.createObjectURL(sink.blob());
      const loaded = once('loadeddata');
      el.src = url;
      document.body.append(el);
      await loaded;
      const c = document.createElement('canvas');
      c.width = 1280;
      c.height = 720;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      const out: Record<string, { frame: number; follow: number }> = {};
      for (const k of [15, 75, 150]) {
        const seeked = once('seeked');
        el.currentTime = (k + 0.5) / opts.fps;
        await seeked;
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)));
        g.drawImage(el, 0, 0, 1280, 720);
        const got = g.getImageData(0, 0, 1280, 720).data;
        out[k] = {
          frame: psnr(got, m.referenceFrame(piece, opts, k).data),
          follow: psnr(got, m.referenceFrame(piece, { ...opts, camera: 'follow' }, k).data),
        };
      }
      el.remove();
      URL.revokeObjectURL(url);
      return { fps: opts.fps, out };
    },
    { src: PSNR },
  );
  console.log(`[auto-camera] mp4 ${JSON.stringify(r)}`);
  for (const [k, v] of Object.entries(r.out)) {
    expect(v.frame, `frame ${k} PSNR`).toBeGreaterThanOrEqual(37);
    expect(v.follow, `frame ${k} vs Follow`).toBeLessThanOrEqual(v.frame - 4);
  }
});
