/**
 * M11 acceptance checks that no earlier spec covered in full (PLAN.md §15 M11; docs/m11-acceptance.md):
 * a video of a 45 s section of a 3-minute piece (length, first frame, audio, clean cuts); a HUD
 * layout made at 16:9 kept at 9:16 and 1:1; a solid background, every element's colour, glow,
 * vignette and guide notes drawing the same in the preview, the video frame and the poster (PNG
 * and SVG); a video exported at −14 LUFS measuring −14 ± 0.5 LUFS with a true peak ≤ −1 dBTP.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { clickExportForDownload, guarded } from './export-diag';
import type * as ExportRun from '../../src/app/export-run';
import type * as Poster from '../../src/app/poster-export';
import type * as VideoExport from '../../src/app/video-export';

interface HookWindow {
  __algorhythms: {
    store: { getState(): { piece: unknown; compiled: { duration: number } } };
    exportRun(): Promise<typeof ExportRun>;
    videoExport(): Promise<typeof VideoExport>;
    poster(): Promise<typeof Poster>;
  };
}

const dialog = (page: Page) => page.getByTestId('export-dialog');

async function load(page: Page, example: string): Promise<void> {
  await page.goto(`./?example=${example}`);
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
}

async function openExport(page: Page, format: 'Video (MP4)' | 'Poster'): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export').click();
  await expect(dialog(page)).toBeVisible();
  await choose(page, 'export-format', format);
  if (format === 'Video (MP4)') {
    await expect(page.getByTestId('export-codec')).not.toHaveText(/Checking/, { timeout: 20_000 });
  }
}

async function choose(page: Page, testId: string, label: string): Promise<void> {
  const input = dialog(page).getByTestId(testId).getByLabel(label, { exact: true });
  await guarded(page, `choose ${testId} ${label}`, () => input.click());
  await expect(input).toBeChecked();
}

/** Waits for the preview to draw after `act`. */
async function redrawn(page: Page, act: () => Promise<void>): Promise<void> {
  const canvas = page.getByTestId('preview-canvas');
  const before = Number(await canvas.getAttribute('data-draws'));
  await act();
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-draws')))
    .toBeGreaterThan(before);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.emulateMedia({ colorScheme: 'light' });
});

test('a video of a 45 s section of a 3-minute piece: length, first frame, audio, clean cuts', async ({
  page,
  browserName,
}, info) => {
  test.skip(browserName !== 'chromium', 'Chromium (the export pipeline is covered per engine)');
  test.skip(info.project.name.endsWith('-prod'), 'once');
  test.setTimeout(400_000);
  await load(page, 'the-cartographers-rain');
  await openExport(page, 'Video (MP4)');
  await choose(page, 'export-vsize', '720p');
  await choose(page, 'export-fps', '30 fps');
  await choose(page, 'export-camera', 'Whole piece');
  await choose(page, 'export-section', 'Custom');
  await page.getByTestId('section-start-text').fill('2:00');
  await page.getByTestId('section-start-text').press('Enter');
  await page.getByTestId('section-end-text').fill('2:45');
  await page.getByTestId('section-end-text').press('Enter');
  await expect(page.getByTestId('section-summary')).toContainText('2:00–2:45');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))));

  const r = await page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const run = await h.exportRun();
    const m = await h.videoExport();
    const opts = run.lastPreviewRequest()!.options as Parameters<typeof m.exportVideo>[1];
    const piece = h.store.getState().piece as Parameters<typeof m.exportVideo>[0];
    const sink = m.blobSink();
    const result = await m.exportVideo(piece, opts, sink);
    const blob = sink.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
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
    const url = URL.createObjectURL(blob);
    const loaded = once('loadeddata');
    el.src = url;
    document.body.append(el);
    await loaded;
    const W = 1280;
    const H = 720;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    const seeked = once('seeked');
    el.currentTime = 0.5 / 30;
    await seeked;
    await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 50)));
    g.drawImage(el, 0, 0, W, H);
    const got = g.getImageData(0, 0, W, H).data;
    const psnr = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let se = 0;
      for (let i = 0; i < a.length; i += 4) {
        for (let j = 0; j < 3; j++) se += (a[i + j] - b[i + j]) ** 2;
      }
      return 10 * Math.log10((255 * 255) / Math.max(se / ((a.length / 4) * 3), 1e-9));
    };
    const first = psnr(got, m.referenceFrame(piece, opts, 0).data);
    const later = psnr(got, m.referenceFrame(piece, opts, 60).data);
    const duration = el.duration;
    el.remove();
    URL.revokeObjectURL(url);

    // Audio: the decoded track against the span's offline render; the cuts' first and last 5 ms.
    const decoded = await new OfflineAudioContext(2, 48000, 48000).decodeAudioData(bytes.buffer);
    const [wl, wr] = await m.renderMix(piece, opts.section);
    const dl = decoded.getChannelData(0);
    const dr = decoded.getChannelData(1);
    const n = Math.min(dl.length, wl.length);
    const span = 2 * 48000;
    const a = new Float32Array(span);
    const b = new Float32Array(span + 960);
    const mid = Math.floor(n / 2);
    for (let i = 0; i < span; i++) a[i] = wl[mid + i] + wr[mid + i];
    for (let i = 0; i < span + 960; i++) b[i] = dl[mid - 480 + i] + dr[mid - 480 + i];
    const lag = m.xcorrLag(a, b, 0, 960) - 480;
    const rmsDb = (x: Float32Array, y: Float32Array, from: number, to: number) => {
      let e = 0;
      for (let i = from; i < to; i++) e += x[i] * x[i] + y[i] * y[i];
      return 10 * Math.log10(e / (2 * Math.max(1, to - from)) + 1e-20);
    };
    const end = Math.round(45 * 48000);
    return {
      frames: result.frames,
      duration,
      first,
      later,
      lag,
      wavSeconds: wl.length / 48000,
      // The render's own level at the cuts is 0 (the fade); the decoded track's too, up to AAC.
      startDb: rmsDb(dl, dr, 0, 240),
      endDb: rmsDb(dl, dr, end - 240, end),
      renderStartDb: rmsDb(wl, wr, 0, 240),
      renderEndDb: rmsDb(wl, wr, end - 240, end),
      bodyDb: rmsDb(dl, dr, 48000, n - 48000),
      renderStart: Math.max(Math.abs(wl[0]), Math.abs(wr[0])),
      renderEnd: Math.max(Math.abs(wl[end - 1] ?? 0), Math.abs(wr[end - 1] ?? 0)),
    };
  });
  console.log('[m11] 45 s section video', JSON.stringify(r));
  expect(r.frames).toBe(45 * 30);
  expect(Math.abs(r.duration - 45)).toBeLessThanOrEqual(1 / 30);
  expect(r.first).toBeGreaterThan(38);
  expect(r.later).toBeLessThan(r.first - 4);
  expect(r.lag).toBe(0);
  expect(r.wavSeconds).toBeCloseTo(45, 2);
  expect(r.renderStart).toBeLessThan(1e-6);
  expect(r.renderEnd).toBeLessThan(1e-3);
  // No click: the decoded cuts are as quiet as the render's own fades there (AAC aside).
  expect(r.startDb).toBeLessThan(Math.max(r.renderStartDb, -90) + 6);
  expect(r.endDb).toBeLessThan(Math.max(r.renderEndDb, -90) + 6);
  expect(r.startDb).toBeLessThan(r.bodyDb - 20);
  expect(r.endDb).toBeLessThan(r.bodyDb - 20);
});

test('a HUD layout made at 16:9 keeps each readout on its corner at 9:16 and 1:1', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await load(page, 'tidewater-hymn');
  await openExport(page, 'Video (MP4)');
  const box = (item: string) =>
    page.evaluate((it) => {
      const o = document.querySelector<HTMLElement>('[data-testid=hud-overlay]')!;
      const b = o.querySelector<HTMLElement>(`[data-testid=hud-box-${it}]`)!;
      const or = o.getBoundingClientRect();
      const r = b.getBoundingClientRect();
      return {
        left: (r.left - or.left) / or.width,
        right: (or.right - r.right) / or.width,
        top: (r.top - or.top) / or.height,
        bottom: (or.bottom - r.bottom) / or.height,
        anchor: b.dataset.anchor,
      };
    }, item);
  // Chord to the top-right corner, time up off the bottom edge, both by keys.
  const chordBox = page.getByTestId('hud-box-chord');
  await chordBox.focus();
  for (let i = 0; i < 40 && (await chordBox.getAttribute('data-anchor')) !== 'tr'; i++) {
    await page.keyboard.press('Shift+ArrowUp');
  }
  await page.getByTestId('hud-box-time').focus();
  for (let i = 0; i < 2; i++) await page.keyboard.press('Shift+ArrowUp');
  await expect(page.getByTestId('hud-box-chord')).toHaveAttribute('data-anchor', 'tr');
  await expect(page.getByTestId('hud-box-time')).toHaveAttribute('data-anchor', 'bl');
  const chord = await box('chord');
  const time = await box('time');
  for (const aspect of ['9:16', '1:1', '16:9']) {
    await redrawn(page, () => choose(page, 'export-aspect', aspect));
    await expect
      .poll(async () => {
        const c = await box('chord');
        const t = await box('time');
        return Math.max(
          Math.abs(c.right - chord.right),
          Math.abs(c.top - chord.top),
          Math.abs(t.left - time.left),
          Math.abs(t.bottom - time.bottom),
        );
      }, aspect)
      .toBeLessThan(0.005);
    expect((await box('chord')).anchor).toBe('tr');
    expect((await box('time')).anchor).toBe('bl');
  }
});

/** Every element's own colour, a solid background, glow, vignette and guide notes. */
const SWATCHES: [string, string][] = [
  ['heads', '#00e0c0'],
  ['playhead', '#ff40ff'],
  ['hud', '#ffffff'],
  ['markers', '#ff9020'],
  ['labels', '#a0ff80'],
  ['guides', '#8090ff'],
  ['beats', '#ff5050'],
  ['title', '#ffe070'],
  ['glow', '#40c0ff'],
];

async function setHex(page: Page, id: string, hex: string): Promise<void> {
  const f = page.getByTestId(`${id}-hex`);
  await f.fill(hex);
  await f.press('Enter');
  await expect(page.getByTestId(id)).toHaveAttribute('data-set', 'yes');
}

async function shapeLook(page: Page): Promise<void> {
  await choose(page, 'look-bg', 'Solid');
  await setHex(page, 'swatch-bg', '#14233a');
  await choose(page, 'look-colors', 'One');
  await setHex(page, 'swatch-one', '#ffd000');
  for (const [k, hex] of SWATCHES) await setHex(page, `swatch-${k}`, hex);
  await choose(page, 'look-guides', 'Lines + labels');
  await choose(page, 'look-moments', 'Both');
  await choose(page, 'look-beats', 'Bars and beats');
  for (const id of ['look-glow', 'look-vignette']) {
    await page.getByTestId(id).focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('PageUp');
  }
  await page.getByTestId('look-pitch-input').fill('E4, A3');
  await page.getByTestId('look-pitch-input').press('Enter');
  await expect(page.getByTestId('look-pitch-64')).toBeVisible();
}

/** PSNR (dB) of two images (data URLs) drawn at w × h, from the page. */
const COMPARE = `async (a, b, w, h) => {
  const px = async (u) => {
    const img = await createImageBitmap(await (await fetch(u)).blob());
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, w, h);
    return g.getImageData(0, 0, w, h).data;
  };
  const [x, y] = [await px(a), await px(b)];
  let se = 0;
  for (let i = 0; i < x.length; i += 4) for (let j = 0; j < 3; j++) se += (x[i + j] - y[i + j]) ** 2;
  return 10 * Math.log10((255 * 255) / Math.max(se / ((x.length / 4) * 3), 1e-9));
}`;

/** An ImageData as a PNG data URL (page side). */
const DATA_URL = `async (d) => {
  const c = new OffscreenCanvas(d.width, d.height);
  c.getContext('2d').putImageData(d, 0, 0);
  const b = await c.convertToBlob();
  return await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
}`;

test('colours, glow, vignette and guide notes: the preview, the video frame and the poster agree', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await load(page, 'kite-day');
  await openExport(page, 'Video (MP4)');
  await choose(page, 'export-camera', 'Whole piece');
  await shapeLook(page);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 80))));

  // Video. The live preview is the preview code at its scale; that code at the export's scale is
  // the export's frame (whose decoded MP4 frames video-bookends and video-youtube check).
  const video = await page.evaluate(
    async ({ COMPARE, DATA_URL }) => {
      const cmp = (0, eval)(COMPARE);
      const url = (0, eval)(DATA_URL);
      const h = (window as unknown as HookWindow).__algorhythms;
      const req = (await h.exportRun()).lastPreviewRequest()!;
      if (req.kind !== 'video') throw new Error('not video');
      const m = await h.videoExport();
      const piece = h.store.getState().piece as Parameters<typeof m.referenceFrame>[0];
      const { compiled } = h.store.getState() as unknown as {
        compiled: Parameters<typeof m.previewVideoFrame>[2];
      };
      const live = document.querySelector<HTMLCanvasElement>('[data-testid=preview-canvas]')!;
      const draw = (o: typeof req.options, scale: number, w: number, hh: number) => {
        const c = new OffscreenCanvas(w, hh);
        const g = c.getContext('2d')!;
        m.previewVideoFrame(g as never, piece, compiled, o, req.t, scale);
        return url(g.getImageData(0, 0, w, hh));
      };
      const k = Math.round(req.t * req.options.fps);
      const frame = await url(m.referenceFrame(piece, req.options, k));
      const full = await draw(req.options, 1, 1920, 1080);
      const { colours: _c, glow: _g, vignette: _v, pitchGuides: _p, ...plain } = req.options.look!;
      const noFx = { ...plain, colours: req.options.look!.colours };
      return {
        live: await cmp(
          live.toDataURL(),
          await draw(req.options, req.scale, live.width, live.height),
          live.width,
          live.height,
        ),
        atExport: await cmp(full, frame, 1920, 1080),
        // Controls: the default Look; the same colours without glow, vignette and guide notes.
        control: await cmp(
          full,
          await url(m.referenceFrame(piece, { ...req.options, look: plain }, k)),
          1920,
          1080,
        ),
        controlFx: await cmp(
          full,
          await url(m.referenceFrame(piece, { ...req.options, look: noFx }, k)),
          1920,
          1080,
        ),
        // Across scales (informational: antialiasing and downscaling differ per engine).
        across: await cmp(live.toDataURL(), frame, 640, 360),
        look: req.options.look,
      };
    },
    { COMPARE, DATA_URL },
  );
  const { look, ...db } = video;
  console.log('[m11] video PSNR', JSON.stringify(db));
  expect(look?.glow).toBeGreaterThan(0.5);
  expect(look?.vignette).toBeGreaterThan(0.5);
  expect(look?.pitchGuides?.pitches).toEqual([57, 64]);
  expect(video.live).toBeGreaterThan(60);
  expect(video.atExport).toBeGreaterThan(45);
  expect(video.control).toBeLessThan(video.atExport - 20);
  expect(video.controlFx).toBeLessThan(video.atExport - 10);

  // Poster: the same Look. The live preview is the poster code at its scale; at scale 1 it is the
  // downloaded PNG; the SVG rasterised is close (it may approximate the glow; text differs).
  await redrawn(page, () => choose(page, 'export-format', 'Poster'));
  await expect(page.getByTestId('swatch-hud')).toHaveAttribute('data-set', 'yes');
  const png = await clickExportForDownload(page);
  const pngUrl = `data:image/png;base64,${readFileSync(await png.path()).toString('base64')}`;
  await choose(page, 'export-pformat', 'SVG');
  const svg = await clickExportForDownload(page);
  const svgText = readFileSync(await svg.path(), 'utf8');
  const svgUrl = `data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}`;
  const poster = await page.evaluate(
    async ({ COMPARE, DATA_URL, pngUrl, svgUrl }) => {
      const cmp = (0, eval)(COMPARE);
      const url = (0, eval)(DATA_URL);
      const h = (window as unknown as HookWindow).__algorhythms;
      const req = (await h.exportRun()).lastPreviewRequest()!;
      if (req.kind !== 'poster') throw new Error('not poster');
      const m = await h.poster();
      const piece = h.store.getState().piece as Parameters<typeof m.referencePosterAt>[0];
      const live = document.querySelector<HTMLCanvasElement>('[data-testid=preview-canvas]')!;
      const img = new Image();
      img.src = pngUrl;
      await img.decode();
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const full = await url(m.referencePosterAt(piece, req.options, 1, W, H));
      const s = new Image();
      s.src = svgUrl;
      await s.decode();
      const c = document.createElement('canvas');
      c.width = W / 2;
      c.height = H / 2;
      c.getContext('2d')!.drawImage(s, 0, 0, W / 2, H / 2);
      return {
        live: await cmp(
          live.toDataURL(),
          await url(m.referencePosterAt(piece, req.options, req.scale, live.width, live.height)),
          live.width,
          live.height,
        ),
        png: await cmp(full, pngUrl, W / 2, H / 2),
        svg: await cmp(pngUrl, c.toDataURL(), W / 4, H / 4),
        across: await cmp(live.toDataURL(), pngUrl, 640, 360),
      };
    },
    { COMPARE, DATA_URL, pngUrl, svgUrl },
  );
  console.log('[m11] poster PSNR', JSON.stringify(poster));
  expect(svgText).toContain('#14233a');
  // The poster draws no heads, playhead or HUD (by default); every other swatch is in the SVG.
  const drawn = SWATCHES.filter(([k]) => !['heads', 'playhead', 'hud'].includes(k));
  const missing = drawn.filter(([, hex]) => !svgText.toLowerCase().includes(hex));
  expect(missing).toEqual([]);
  expect(poster.live).toBeGreaterThan(60);
  expect(poster.png).toBeGreaterThan(45);
  expect(poster.svg).toBeGreaterThan(24);
});

test('a video exported at −14 LUFS measures −14 ± 0.5 LUFS with a true peak ≤ −1 dBTP', async ({
  page,
  browserName,
}, info) => {
  test.skip(browserName === 'webkit', 'WebKit: no Web Audio playback here; Chromium and Firefox');
  test.skip(!info.project.name.endsWith('-dev'), 'imports the meter from the dev server');
  test.setTimeout(900_000);
  for (const example of ['crease', 'night-sleeper', 'clockwork-heron']) {
    await load(page, example);
    const r = await page.evaluate(async () => {
      const h = (window as unknown as HookWindow).__algorhythms;
      const m = await h.videoExport();
      const { measureLoudness } = await import('/src/dsp/loudness.ts' as string);
      const piece = h.store.getState().piece as Parameters<typeof m.exportVideo>[0];
      const opts: Parameters<typeof m.exportVideo>[1] = {
        aspect: '16:9',
        size: '720',
        fps: 30,
        camera: 'whole',
        theme: 'dark',
        hud: false,
        thickness: true,
        quality: 'standard',
        loudness: -14,
      };
      const sink = m.blobSink();
      const t0 = performance.now();
      const res = await m.exportVideo(piece, opts, sink);
      const ms = performance.now() - t0;
      const bytes = await sink.blob().arrayBuffer();
      const d = await new OfflineAudioContext(2, 48000, 48000).decodeAudioData(bytes);
      const ch = { left: d.getChannelData(0), right: d.getChannelData(1) };
      const meas = measureLoudness(ch, 48000) as { lufs: number; truePeakDb: number };
      return { audio: res.audio, seconds: d.duration, lufs: meas.lufs, tp: meas.truePeakDb, ms };
    });
    console.log(`[m11] ${example} video at −14`, JSON.stringify(r));
    expect(r.audio).toMatch(browserName === 'chromium' ? /mp4a/ : /mp4a|opus/);
    expect(Math.abs(r.lufs + 14), example).toBeLessThanOrEqual(0.5);
    expect(r.tp, example).toBeLessThanOrEqual(-1);
  }
});
