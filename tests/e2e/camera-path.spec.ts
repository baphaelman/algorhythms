/**
 * The camera path (PLAN.md §15 M11.5 C1): a piece with three camera keys. The Export dialog's
 * preview is the export's frame at a key and between keys, and the exported MP4's decoded frames
 * match; an opening starting at −2 s shows blank paper with the first notes at the playhead's
 * place.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openVideoExport } from './export-open';
import { clickExportForDownload, guarded } from './export-diag';
import type * as ExportRun from '../../src/app/export-run';
import type * as VideoExport from '../../src/app/video-export';
import type { CameraKey } from '../../src/core/types';

interface HookWindow {
  __algorhythms: {
    store: { getState(): { piece: unknown; compiled: unknown } };
    actions: { loadPiece(p: unknown): void };
    exportRun(): Promise<typeof ExportRun>;
    videoExport(): Promise<typeof VideoExport>;
  };
}

const KEYS: CameraKey[] = [
  { at: 0, window: 8, place: 0.25, pitch: 62, range: 30 },
  { at: 2.5, window: 20, place: 0.5, pitch: 66, range: 20, ease: 'linear' },
  { at: 5, window: 6, place: 0.7, pitch: 60, range: 36 },
];

/** The workspace's Video mode (M15: the old Export dialog's place). */
const dialog = (page: Page) => page.getByTestId('video-workspace');

async function choose(page: Page, testId: string, label: string): Promise<void> {
  const input = dialog(page).getByTestId(testId).getByLabel(label, { exact: true });
  await guarded(page, `choose ${testId} ${label}`, () => input.click());
  await expect(input).toBeChecked();
}

/** Kite Day (lines from 0) with these camera keys, the Export dialog open on Video, Keys. */
async function openWithKeys(page: Page, keys: CameraKey[]): Promise<void> {
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate((keys) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const p = structuredClone(h.store.getState().piece) as Record<string, unknown>;
    p.camera = { mode: 'keys', keys };
    h.actions.loadPiece(p);
  }, keys);
  await openVideoExport(page);
  await expect(page.getByTestId('export-codec')).not.toHaveText(/Checking/, { timeout: 20_000 });
  await choose(page, 'export-vsize', '720p');
  await choose(page, 'export-camera', 'Keys');
}

/** Sets the preview's time and waits until it has drawn there. */
async function previewAt(page: Page, t: number): Promise<void> {
  await page.getByTestId('preview-time').fill(String(t));
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const req = (
          await (window as unknown as HookWindow).__algorhythms.exportRun()
        ).lastPreviewRequest();
        return req?.kind === 'video' ? req.t : NaN;
      }),
    )
    .toBeCloseTo(t, 3);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))));
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

test('three keys: the preview is the export frame at a key and between keys', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithKeys(page, KEYS);
  for (const t of [2.5, 1.2, 4]) {
    await previewAt(page, t);
    const r = await page.evaluate(
      async ({ t, src }) => {
        const psnr = (0, eval)(src) as (a: Uint8ClampedArray, b: Uint8ClampedArray) => number;
        const h = (window as unknown as HookWindow).__algorhythms;
        const req = (await h.exportRun()).lastPreviewRequest()!;
        if (req.kind !== 'video') throw new Error('not video');
        const piece = h.store.getState().piece as never;
        const compiled = h.store.getState().compiled as never;
        const m = await h.videoExport();
        const c = document.querySelector<HTMLCanvasElement>('[data-testid=preview-canvas]')!;
        const live = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        const at = (o: typeof req.options) =>
          m.referenceFrameAt(piece, o, t, req.scale, c.width, c.height).data;
        let bad = 0;
        const ref = at(req.options);
        for (let i = 0; i < live.length; i += 4)
          if (Math.max(...[0, 1, 2, 3].map((j) => Math.abs(live[i + j] - ref[i + j]))) > 16) bad++;
        // The preview code at the export's scale against the export's frame k.
        const k = Math.round(t * req.options.fps);
        const full = new OffscreenCanvas(1280, 720);
        const g = full.getContext('2d', { alpha: false })!;
        m.previewVideoFrame(g as never, piece, compiled, req.options, k / req.options.fps, 1);
        const frame = m.referenceFrame(piece, req.options, k).data;
        return {
          camera: req.options.camera,
          bad: bad / (live.length / 4),
          atExport: psnr(g.getImageData(0, 0, 1280, 720).data, frame),
          // Control: Follow at the same time draws another picture.
          follow: psnr(
            frame,
            m.referenceFrame(piece, { ...req.options, camera: 'follow' }, k).data,
          ),
        };
      },
      { t, src: PSNR },
    );
    console.log(`[camera-path] t=${t} ${JSON.stringify(r)}`);
    expect(r.camera).toBe('keys');
    expect(r.bad, `preview vs export frame at ${t} s`).toBeLessThan(0.002);
    expect(r.atExport, `preview code vs frame at ${t} s`).toBeGreaterThan(45);
    expect(r.follow).toBeLessThan(r.atExport - 15);
  }
});

test('three keys: the exported MP4 frames are the camera path at a key and between', async ({
  page,
  browserName,
}, info) => {
  test.skip(browserName !== 'chromium', 'Chromium (the export pipeline is covered per engine)');
  test.skip(info.project.name.endsWith('-prod'), 'once');
  test.setTimeout(180_000);
  await openWithKeys(page, KEYS);
  await choose(page, 'export-section', 'Custom');
  await page.getByTestId('section-start-text').fill('0');
  await page.getByTestId('section-start-text').press('Enter');
  await page.getByTestId('section-end-text').fill('6');
  await page.getByTestId('section-end-text').press('Enter');
  const dl = await clickExportForDownload(page, 120_000);
  const bytes = [...readFileSync(await dl.path())];
  const r = await page.evaluate(
    async ({ bytes, src }) => {
      const psnr = (0, eval)(src) as (a: Uint8ClampedArray, b: Uint8ClampedArray) => number;
      const h = (window as unknown as HookWindow).__algorhythms;
      const run = await h.exportRun();
      const m = await h.videoExport();
      const opts = run.lastVideoRequest()!.options;
      const piece = h.store.getState().piece as never;
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
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }));
      const loaded = once('loadeddata');
      el.src = url;
      document.body.append(el);
      await loaded;
      const c = document.createElement('canvas');
      c.width = 1280;
      c.height = 720;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      const out: Record<string, { frame: number; follow: number }> = {};
      for (const k of [75, 36, 120]) {
        const seeked = once('seeked');
        el.currentTime = (k + 0.5) / 30;
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
      return { camera: opts.camera, out };
    },
    { bytes, src: PSNR },
  );
  console.log(`[camera-path] mp4 ${JSON.stringify(r)}`);
  expect(r.camera).toBe('keys');
  for (const [k, v] of Object.entries(r.out)) {
    expect(v.frame, `frame ${k} PSNR`).toBeGreaterThanOrEqual(37);
    expect(v.follow, `frame ${k} vs Follow`).toBeLessThanOrEqual(v.frame - 4);
  }
});

test('an opening from −2 s: blank paper before 0, the first notes at the playhead place', async ({
  page,
}) => {
  test.setTimeout(90_000);
  // One key: held, so the playhead stays at 25 % of an 8 s window (start −2 s at 0).
  await openWithKeys(page, [KEYS[0]]);
  await previewAt(page, 0);
  const r = await page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const req = (await h.exportRun()).lastPreviewRequest()!;
    if (req.kind !== 'video') throw new Error('not video');
    const piece = h.store.getState().piece as never;
    const m = await h.videoExport();
    // Guide labels, HUD and vignette off, so blank paper is one colour per row; every beat drawn
    // (none may fall before 0).
    const look = {
      ...req.options.look!,
      guideLabels: false,
      hud: [],
      vignette: 0,
      beats: 'every' as const,
    };
    const opts = { ...req.options, look };
    const W = 1280;
    const H = 720;
    /** The first column (from x = 2) that differs from column 2 in the plot's rows. */
    const firstInk = (d: Uint8ClampedArray) => {
      for (let x = 3; x < W; x++) {
        let n = 0;
        for (let y = Math.round(H * 0.06); y < H * 0.85; y++) {
          const i = (y * W + x) * 4;
          const j = (y * W + 2) * 4;
          if (
            Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]) >
            24
          )
            n++;
        }
        if (n >= 2) return x;
      }
      return W;
    };
    return {
      at0: firstInk(m.referenceFrame(piece, opts, 0).data),
      at1: firstInk(m.referenceFrame(piece, opts, 30).data),
      W,
    };
  });
  console.log(`[camera-path] opening ${JSON.stringify(r)}`);
  // t = 0: the heads at the playhead, 25 % across; nothing to their left but their radius.
  expect(r.at0).toBeGreaterThan(r.W * 0.25 - 16);
  expect(r.at0).toBeLessThanOrEqual(r.W * 0.25 + 1);
  // t = 1 s: the view starts at −1 s, so 0 s (where the lines begin) is at 12.5 %.
  expect(Math.abs(r.at1 - r.W * 0.125), 'first line at x(0)').toBeLessThanOrEqual(4);
});
