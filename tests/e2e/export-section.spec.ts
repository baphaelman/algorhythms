/**
 * The Export dialog's Section (PLAN.md §12 "Exports you can shape", rev 15; §15 M11): Whole /
 * Loop region / Custom, the two-handle range (pointer, bar snapping, Alt, keyboard, typed
 * times), memory per piece, the previews following it, and the exports: a poster of a 45 s
 * section of a 3-minute piece, and a short video section (length within a frame, first frame =
 * the section's start, audio = the offline render of the span).
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { clickExportForDownload, guarded, setSwitch } from './export-diag';
import type * as ExportRun from '../../src/app/export-run';
import type * as Poster from '../../src/app/poster-export';
import type * as VideoExport from '../../src/app/video-export';

interface HookWindow {
  __algorhythms: {
    store: { getState(): { piece: unknown; compiled: { duration: number } } };
    actions: { loadPiece(p: unknown): void };
    exportRun(): Promise<typeof ExportRun>;
    videoExport(): Promise<typeof VideoExport>;
    poster(): Promise<typeof Poster>;
  };
}

const dialog = (page: Page) => page.getByTestId('export-dialog');
/** Kite Day's grid: 100 bpm in 4/4. */
const BAR = 2.4;

async function openExport(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export').click();
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible();
  await expect(page.getByTestId('export-run')).toBeEnabled();
}

async function closeExport(page: Page): Promise<void> {
  await page.getByTestId('export-close').click();
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeHidden();
}

async function choose(page: Page, testId: string, label: string): Promise<void> {
  const input = dialog(page).getByTestId(testId).getByLabel(label, { exact: true });
  await guarded(page, `choose ${testId} ${label}`, () => input.click());
  await expect(input).toBeChecked();
}

/** Reloads the current piece with changes (same piece: same created time and seed). */
async function editPiece(
  page: Page,
  edit: { loop?: { start: number; end: number } | null; gridBpm?: number | null; created?: string },
): Promise<void> {
  await page.evaluate((e) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const p = structuredClone(h.store.getState().piece) as {
      view: { loop?: unknown; gridBpm?: number };
      meta: { created: string };
    };
    if (e.loop === null) delete p.view.loop;
    else if (e.loop) p.view.loop = { ...e.loop, on: true };
    if (e.gridBpm === null) delete p.view.gridBpm;
    else if (e.gridBpm !== undefined) p.view.gridBpm = e.gridBpm;
    if (e.created) p.meta.created = e.created;
    h.actions.loadPiece(p);
  }, edit);
}

/** A handle's time (aria-valuenow, 0.1 s) and exact span via the last preview's options. */
const handleValue = async (page: Page, h: 'start' | 'end') =>
  Number(await page.getByTestId(`section-${h}`).getAttribute('aria-valuenow'));

const lastPreview = (page: Page) =>
  page.evaluate(async () =>
    (await (window as unknown as HookWindow).__algorhythms.exportRun()).lastPreviewRequest(),
  );

/** The section the last preview drew (waits for a redraw after a change). */
async function previewSection(page: Page): Promise<{ start: number; end: number } | undefined> {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30))));
  const req = await lastPreview(page);
  return req?.options.section;
}

/** Drags a handle to time t (pointer), optionally with Alt held. */
async function dragHandle(page: Page, h: 'start' | 'end', t: number, alt = false): Promise<void> {
  const track = (await page.getByTestId('section-range').boundingBox())!;
  const handle = (await page.getByTestId(`section-${h}`).boundingBox())!;
  const D = await page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.store.getState().compiled.duration,
  );
  const x = track.x + (t / D) * track.width;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, y);
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move((handle.x + x) / 2, y, { steps: 3 });
  await page.mouse.move(x, y, { steps: 3 });
  await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
}

const onBar = (t: number) => Math.abs(t / BAR - Math.round(t / BAR)) < 1e-6;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test('Section: Whole by default; Loop only with a loop region; Custom shows the range', async ({
  page,
}) => {
  await openExport(page);
  // WAV, stems and MIDI have no Section.
  await expect(page.getByTestId('export-section')).toHaveCount(0);
  await choose(page, 'export-format', 'Poster');
  const sec = page.getByTestId('export-section');
  await expect(sec.getByLabel('Whole piece', { exact: true })).toBeChecked();
  await expect(sec.getByLabel('Loop region', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('section-range')).toHaveCount(0);
  expect(await previewSection(page)).toBeUndefined();
  await closeExport(page);

  await editPiece(page, { loop: { start: 12, end: 24 } });
  await openExport(page);
  await choose(page, 'export-section', 'Loop region');
  await expect(page.getByTestId('section-summary')).toHaveText(/^0:12–0:24 of \d:\d\d \(12 s\)/);
  expect(await previewSection(page)).toEqual({ start: 12, end: 24 });
  await expect(page.getByTestId('export-prange')).not.toBeChecked();

  // Custom starts at the loop region.
  await choose(page, 'export-section', 'Custom');
  await expect(page.getByTestId('section-range')).toBeVisible();
  await expect(page.getByTestId('section-overview')).toBeVisible();
  expect(await previewSection(page)).toEqual({ start: 12, end: 24 });
  await expect(page.getByTestId('section-start')).toHaveAttribute('aria-valuetext', '0:12.0');
  await expect(page.getByTestId('section-end')).toHaveAttribute('aria-valuetext', '0:24.0');
  await expect(page.getByTestId('section-start')).toHaveAttribute('role', 'slider');

  await choose(page, 'export-section', 'Whole piece');
  expect(await previewSection(page)).toBeUndefined();
});

test('Custom: handles snap to bars when dragged, Alt places freely; typed times', async ({
  page,
}) => {
  await openExport(page);
  await choose(page, 'export-format', 'Poster');
  await choose(page, 'export-section', 'Custom');
  await dragHandle(page, 'end', 50.3);
  let s = (await previewSection(page))!;
  expect(onBar(s.end), `end ${s.end} on a bar`).toBe(true);
  expect(Math.abs(s.end - 50.3)).toBeLessThanOrEqual(BAR / 2 + 0.3);
  await dragHandle(page, 'start', 21);
  s = (await previewSection(page))!;
  expect(onBar(s.start), `start ${s.start} on a bar`).toBe(true);
  expect(Math.abs(s.start - 21)).toBeLessThanOrEqual(BAR / 2 + 0.3);

  await dragHandle(page, 'end', 47.3, true);
  s = (await previewSection(page))!;
  expect(onBar(s.end), `Alt: end ${s.end} free`).toBe(false);
  expect(Math.abs(s.end - 47.3)).toBeLessThan(0.5);

  // The handles never cross: dragging the start past the end stops it 2 s before.
  await dragHandle(page, 'start', 80);
  s = (await previewSection(page))!;
  expect(s.end - s.start).toBeCloseTo(2, 6);

  // Typed times (exact, not snapped); a bad entry is dropped.
  const start = page.getByTestId('section-start-text');
  await start.fill('0:10.5');
  await start.press('Enter');
  const end = page.getByTestId('section-end-text');
  await end.fill('31');
  await end.press('Tab');
  expect(await previewSection(page)).toEqual({ start: 10.5, end: 31 });
  await start.fill('nonsense');
  await start.press('Enter');
  await expect(start).toHaveValue('0:10.5');
  await expect(page.getByTestId('section-summary')).toHaveText(/^0:11–0:31 of/);
});

test('Custom by keyboard: arrows step a bar, Shift four, Alt 0.1 s; without a tempo a second', async ({
  page,
}) => {
  await openExport(page);
  await choose(page, 'export-format', 'Poster');
  await choose(page, 'export-section', 'Custom');
  const start = page.getByTestId('section-start');
  await start.focus();
  await page.keyboard.press('Home');
  expect((await previewSection(page))!.start).toBe(0);
  await page.keyboard.press('ArrowRight');
  expect((await previewSection(page))!.start).toBeCloseTo(BAR, 6);
  await page.keyboard.press('Shift+ArrowRight');
  expect((await previewSection(page))!.start).toBeCloseTo(5 * BAR, 6);
  await page.keyboard.press('Alt+ArrowLeft');
  expect((await previewSection(page))!.start).toBeCloseTo(5 * BAR - 0.1, 6);
  // Off the grid, the next arrow lands on the bar line before.
  await page.keyboard.press('ArrowLeft');
  expect((await previewSection(page))!.start).toBeCloseTo(4 * BAR, 6);
  expect(await handleValue(page, 'start')).toBeCloseTo(9.6, 1);
  // Tab reaches the end handle; End puts it at the piece's end (the whole piece: no section).
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('section-end')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  const s = (await previewSection(page))!;
  expect(onBar(s.end)).toBe(true);
  await closeExport(page);

  // Without a tempo the arrows step a second.
  await editPiece(page, { gridBpm: null });
  await openExport(page);
  await page.getByTestId('section-start').focus();
  const before = (await previewSection(page))!.start;
  await page.keyboard.press('ArrowRight');
  expect((await previewSection(page))!.start).toBeCloseTo(before + 1, 6);
  await page.keyboard.press('Shift+ArrowRight');
  expect((await previewSection(page))!.start).toBeCloseTo(before + 11, 6);
});

test('the Section is remembered per piece for the session; another piece starts Whole', async ({
  page,
}) => {
  await openExport(page);
  await choose(page, 'export-format', 'Video (MP4)');
  await choose(page, 'export-section', 'Custom');
  const start = page.getByTestId('section-start-text');
  await start.fill('20');
  await start.press('Enter');
  const end = page.getByTestId('section-end-text');
  await end.fill('40');
  await end.press('Enter');
  await closeExport(page);
  await openExport(page);
  await expect(
    page.getByTestId('export-section').getByLabel('Custom', { exact: true }),
  ).toBeChecked();
  expect(await previewSection(page)).toEqual({ start: 20, end: 40 });
  await closeExport(page);

  // Edits keep it (the same piece); a different piece starts at Whole.
  await editPiece(page, { loop: { start: 4, end: 8 } });
  await openExport(page);
  expect(await previewSection(page)).toEqual({ start: 20, end: 40 });
  await closeExport(page);
  await editPiece(page, { created: '2001-01-01T00:00:00.000Z' });
  await openExport(page);
  await expect(
    page.getByTestId('export-section').getByLabel('Whole piece', { exact: true }),
  ).toBeChecked();
  expect(await previewSection(page)).toBeUndefined();
});

test('video preview: the time slider covers the section; playing stays inside it', async ({
  page,
}) => {
  await openExport(page);
  await choose(page, 'export-format', 'Video (MP4)');
  await choose(page, 'export-section', 'Custom');
  const start = page.getByTestId('section-start-text');
  await start.fill('20');
  await start.press('Enter');
  const end = page.getByTestId('section-end-text');
  await end.fill('23');
  await end.press('Enter');
  const slider = page.getByTestId('preview-time');
  await expect(slider).toHaveAttribute('min', '20');
  await expect(slider).toHaveAttribute('max', '23');
  const t = Number(await page.getByTestId('preview-canvas').getAttribute('data-t'));
  expect(t).toBeGreaterThanOrEqual(20);
  expect(t).toBeLessThanOrEqual(23);
  const req = await lastPreview(page);
  expect(req?.kind).toBe('video');
  expect(req && 'options' in req ? req.options.section : null).toEqual({ start: 20, end: 23 });

  // Size estimate follows the section (3 s, not the piece).
  const size = await page.getByTestId('export-size').textContent();
  await choose(page, 'export-section', 'Whole piece');
  const wholeSize = await page.getByTestId('export-size').textContent();
  expect(size).not.toBe(wholeSize);
  await choose(page, 'export-section', 'Custom');

  // Play from the end: it starts at the section's start and stops at its end.
  await slider.fill('23');
  await page.getByTestId('preview-play').click();
  await expect(page.getByTestId('preview-play')).toHaveAttribute('data-playing', 'true');
  await expect(page.getByTestId('preview-play')).toHaveAttribute('data-playing', 'false', {
    timeout: 8000,
  });
  const after = Number(await page.getByTestId('preview-canvas').getAttribute('data-t'));
  expect(after).toBeGreaterThan(22.5);
  expect(after).toBeLessThanOrEqual(23);
});

test('poster of a 45 s section of a 3-minute piece: only the section, fitted, rows, times', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('./?example=the-cartographers-rain');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await choose(page, 'export-format', 'Poster');
  await choose(page, 'export-section', 'Custom');
  await page.getByTestId('section-start-text').fill('2:00');
  await page.getByTestId('section-start-text').press('Enter');
  await page.getByTestId('section-end-text').fill('2:45');
  await page.getByTestId('section-end-text').press('Enter');
  const rows = page.getByTestId('export-prows');
  await rows.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('export-prows-value')).toHaveText('3 rows');
  await choose(page, 'export-pformat', 'SVG');
  const dl = await clickExportForDownload(page);
  const svg = readFileSync(await dl.path(), 'utf8');
  const req = (await page.evaluate(async () =>
    (await (window as unknown as HookWindow).__algorhythms.exportRun()).lastPosterRequest(),
  ))!;
  expect(req.options).toMatchObject({
    section: { start: 120, end: 165 },
    pieceRange: false,
    rows: 3,
  });
  expect(svg).toContain('0:45 · 2:00–2:45 of 2:56');
  expect(svg).toContain('>2:15<');
  expect(svg).toContain('>2:30<');

  // The pitch range: fitted to the section, or the piece's with the switch (the plot differs).
  const [fit, piece] = await page.evaluate(async (opts) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const m = await h.poster();
    const piece = h.store.getState().piece as Parameters<typeof m.renderPosterSvg>[0];
    return [
      m.renderPosterSvg(piece, opts),
      m.renderPosterSvg(piece, { ...opts, pieceRange: true }),
    ];
  }, req.options);
  expect(fit).toBe(svg);
  expect(piece).not.toBe(fit);
  await setSwitch(page, 'export-prange', true);
  await choose(page, 'export-pformat', 'PNG');
  const png = await clickExportForDownload(page);
  expect(
    readFileSync(await png.path())
      .subarray(1, 4)
      .toString(),
  ).toBe('PNG');
  expect(
    (await page.evaluate(async () =>
      (await (window as unknown as HookWindow).__algorhythms.exportRun()).lastPosterRequest(),
    ))!.options.pieceRange,
  ).toBe(true);
});

test('a short video section: its length to a frame, frame 0 = its start, the span’s audio', async ({
  page,
  browserName,
}, info) => {
  test.skip(browserName !== 'chromium', 'Chromium (the export pipeline is covered per engine)');
  test.skip(info.project.name.endsWith('-prod'), 'once');
  test.setTimeout(180_000);
  await openExport(page);
  await choose(page, 'export-format', 'Video (MP4)');
  await choose(page, 'export-vsize', '720p');
  await choose(page, 'export-camera', 'Whole piece');
  await choose(page, 'export-section', 'Custom');
  await page.getByTestId('section-start-text').fill('12');
  await page.getByTestId('section-start-text').press('Enter');
  await page.getByTestId('section-end-text').fill('15.5');
  await page.getByTestId('section-end-text').press('Enter');
  const dl = await clickExportForDownload(page, 120_000);
  const bytes = [...readFileSync(await dl.path())];
  const r = await page.evaluate(async (bytes) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const run = await h.exportRun();
    const m = await h.videoExport();
    const req = run.lastVideoRequest()!;
    const opts = req.options;
    const piece = h.store.getState().piece as Parameters<typeof m.exportVideo>[0];
    const blob = new Blob([new Uint8Array(bytes)], { type: 'video/mp4' });
    const el = document.createElement('video');
    el.muted = true;
    el.preload = 'auto';
    const once = (type: string) =>
      new Promise<void>((resolve, reject) => {
        el.addEventListener(type, () => resolve(), { once: true });
        el.addEventListener('error', () => reject(new Error(el.error?.message ?? 'media error')), {
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
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)));
    g.drawImage(el, 0, 0, W, H);
    const got = g.getImageData(0, 0, W, H).data;
    const psnr = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let se = 0;
      for (let i = 0; i < a.length; i += 4) {
        for (let j = 0; j < 3; j++) {
          const d = a[i + j] - b[i + j];
          se += d * d;
        }
      }
      return 10 * Math.log10((255 * 255) / Math.max(se / ((a.length / 4) * 3), 1e-9));
    };
    const first = psnr(got, m.referenceFrame(piece, opts, 0).data);
    // Controls: a frame 1 s into the section, and frame 0 of the whole piece.
    const later = psnr(got, m.referenceFrame(piece, opts, 30).data);
    const { section: _s, ...whole } = opts;
    const pieceStart = psnr(got, m.referenceFrame(piece, whole, 0).data);
    const duration = el.duration;
    el.remove();
    URL.revokeObjectURL(url);

    // Audio: the decoded track against the section's offline render (lag, level).
    const decoded = await new OfflineAudioContext(2, 48000, 48000).decodeAudioData(
      new Uint8Array(bytes).buffer,
    );
    const [wl, wr] = await m.renderMix(piece, opts.section);
    const dl = decoded.getChannelData(0);
    const dr = decoded.getChannelData(1);
    const len = Math.min(dl.length, wl.length);
    const span = Math.min(len - 960, 2 * 48000);
    const a = new Float32Array(span);
    const b = new Float32Array(span + 960);
    for (let i = 0; i < span; i++) a[i] = wl[i] + wr[i];
    for (let i = 0; i < span + 960 && i < len; i++) b[i] = dl[i] + dr[i];
    const lag = m.xcorrLag(a, b, -480, 480);
    let ew = 0;
    let ed = 0;
    for (let i = 0; i < len; i++) {
      ew += wl[i] * wl[i] + wr[i] * wr[i];
      ed += dl[i] * dl[i] + dr[i] * dr[i];
    }
    return {
      section: opts.section,
      frames: req.result!.frames,
      seconds: req.result!.duration,
      wavSeconds: wl.length / 48000,
      duration,
      first,
      later,
      pieceStart,
      lagMs: (lag / 48000) * 1000,
      rmsDb: 10 * Math.log10(ed / ew),
    };
  }, bytes);
  console.log(`video section: ${JSON.stringify(r)}`);
  expect(r.section).toEqual({ start: 12, end: 15.5 });
  expect(r.seconds).toBeCloseTo(3.5, 6);
  expect(r.wavSeconds).toBeCloseTo(3.5, 6);
  expect(r.frames).toBe(105);
  expect(Math.abs(r.duration - 3.5), 'duration').toBeLessThanOrEqual(1 / 30);
  expect(r.first, 'frame 0 PSNR').toBeGreaterThanOrEqual(37);
  expect(r.later).toBeLessThanOrEqual(r.first - 4);
  expect(r.pieceStart).toBeLessThanOrEqual(r.first - 4);
  expect(Math.abs(r.lagMs), 'audio lag (ms)').toBeLessThanOrEqual(1);
  expect(Math.abs(r.rmsDb), 'audio RMS (dB)').toBeLessThanOrEqual(1);
});
