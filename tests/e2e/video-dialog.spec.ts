/**
 * Video in the Export dialog (PLAN.md §12 "Video export", §15 M8; M8-d): the format and its
 * controls, the choices reaching `exportVideo` (with the editor's zoom window for Follow), a
 * download that plays, streaming to a (stubbed) picked file in Chromium, the unsupported message,
 * cancel and Escape, remembered choices and the phone layout.
 *
 * Owner samples: with VIDEO_SAMPLES_DIR set, the last test exports Little Round at 16:9 and 9:16
 * (720p30, Follow) through the dialog into that folder, plus dialog.png (Chromium only).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { formatBytes } from '../../src/app/export-options';
import { DEFAULT_HUD, HUD_ITEMS } from '../../src/render/hud';
import { EXPORT_LOOK } from '../../src/render/look';
import type * as VideoExport from '../../src/app/video-export';
import type * as ExportRun from '../../src/app/export-run';

interface HookWindow {
  __algorhythms: {
    store: {
      getState(): { piece: unknown; view: { window: number; colors: string } };
      setState(f: (s: { view: object }) => object): void;
    };
    actions: { loadPiece(p: unknown): void };
    exportRun(): Promise<typeof ExportRun>;
    videoExport(): Promise<typeof VideoExport>;
  };
}

const dialog = (page: Page) => page.getByTestId('export-dialog');
const SAMPLES = process.env.VIDEO_SAMPLES_DIR;
/** Owner review images of the Look (dialog, default frame). */
const LOOK_SAMPLES = process.env.LOOK_SAMPLES_DIR;

async function openExport(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export').click();
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible();
  await expect(page.getByTestId('export-run')).toBeEnabled();
}

async function choose(page: Page, testId: string, label: string): Promise<void> {
  await dialog(page).getByTestId(testId).getByLabel(label, { exact: true }).check();
}

const pickVideo = (page: Page) => choose(page, 'export-format', 'Video (MP4)');

/** Opens the Look section (it stays open for the session). */
async function openLook(page: Page): Promise<void> {
  const look = page.getByTestId('look');
  if ((await look.getAttribute('open')) === null) await page.getByTestId('look-toggle').click();
  await expect(page.getByTestId('look-reset')).toBeVisible();
}

async function loadShortPiece(page: Page, seconds: number): Promise<void> {
  await page.evaluate((at) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const p = structuredClone(h.store.getState().piece) as { end: { at: number; fade: number } };
    p.end = { at, fade: 1 };
    h.actions.loadPiece(p);
  }, seconds);
}

/** Sets the editor's zoom window (s). */
async function setZoom(page: Page, seconds: number): Promise<void> {
  await page.evaluate((w) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    h.store.setState((s) => ({ view: { ...s.view, window: w } }));
  }, seconds);
}

const lastRequest = (page: Page) =>
  page.evaluate(async () =>
    (await (window as unknown as HookWindow).__algorhythms.exportRun()).lastVideoRequest(),
  );

/** Plays `bytes` (or the OPFS file `opfs`) in a `<video>`: duration and picture size. */
async function probeInPage(
  page: Page,
  src: { bytes?: number[]; opfs?: string },
): Promise<{ duration: number; width: number; height: number }> {
  return page.evaluate(async ({ bytes, opfs }) => {
    const blob = opfs
      ? await (await (await navigator.storage.getDirectory()).getFileHandle(opfs)).getFile()
      : new Blob([new Uint8Array(bytes!)], { type: 'video/mp4' });
    const el = document.createElement('video');
    el.muted = true;
    el.preload = 'auto';
    const loaded = new Promise<void>((resolve, reject) => {
      el.addEventListener('loadedmetadata', () => resolve(), { once: true });
      el.addEventListener('error', () => reject(new Error(el.error?.message ?? 'media error')));
    });
    el.src = URL.createObjectURL(blob);
    await loaded;
    return { duration: el.duration, width: el.videoWidth, height: el.videoHeight };
  }, src);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test('offers Video (MP4) with its options, the codecs and the size', async ({ page }) => {
  await openExport(page);
  await pickVideo(page);
  const d = dialog(page);
  for (const label of ['16:9', '1080p', '30 fps', 'Follow', 'Current']) {
    await expect(d.getByLabel(label, { exact: true })).toBeChecked();
  }
  for (const label of ['9:16', '1:1', '720p', '60 fps', 'Whole piece', 'Light', 'Dark']) {
    await expect(d.getByLabel(label, { exact: true })).not.toBeChecked();
  }
  await openLook(page);
  for (const it of DEFAULT_HUD) await expect(page.getByTestId(`hud-${it}`)).toBeChecked();
  await expect(page.getByTestId('look-thickness')).toBeChecked();
  await expect(page.getByTestId('export-depth')).toHaveCount(0);
  await expect(page.getByTestId('export-codec')).toHaveText(/^(H\.264|VP9) \+ (AAC|Opus)$/);
  const big = Number(
    /Up to ([\d.]+) MB/.exec(await page.getByTestId('export-size').innerText())![1],
  );
  await choose(page, 'export-vsize', '720p');
  const small = Number(
    /Up to ([\d.]+) MB/.exec(await page.getByTestId('export-size').innerText())![1],
  );
  expect(small).toBeLessThan(big * 0.6);
  await expect(page.getByTestId('export-run')).toHaveText('Export video');
  await expect(page.getByTestId('export-run')).toBeEnabled();
});

test('the choices reach exportVideo; the download plays at the WAV length', async ({ page }) => {
  await loadShortPiece(page, 3);
  await setZoom(page, 5);
  await openExport(page);
  await pickVideo(page);
  await choose(page, 'export-aspect', '9:16');
  await choose(page, 'export-vsize', '720p');
  await choose(page, 'export-vtheme', 'Dark');
  await openLook(page);
  await dialog(page).getByTestId('hud-none').click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByTestId('export-run').click(),
  ]);
  expect(download.suggestedFilename()).toBe('Tidewater-Hymn.mp4');
  await expect(page.getByTestId('export-message')).toContainText(
    /^Saved Tidewater-Hymn\.mp4 \(.+\) to your downloads\./,
  );
  const req = (await lastRequest(page))!;
  expect(req.options).toMatchObject({
    aspect: '9:16',
    size: '720',
    fps: 30,
    camera: 'follow',
    window: 5,
    theme: 'dark',
    hud: false,
    thickness: true,
    colors: 'pitch',
  });
  expect(req.options.look!.hud).toEqual([]);
  const bytes = [...readFileSync(await download.path())];
  const played = await probeInPage(page, { bytes });
  expect(played).toMatchObject({ width: 720, height: 1280 });
  expect(Math.abs(played.duration - req.result!.duration)).toBeLessThanOrEqual(1 / 30);

  // Whole piece sends no window; Light is passed as is.
  await choose(page, 'export-camera', 'Whole piece');
  await choose(page, 'export-vtheme', 'Light');
  await choose(page, 'export-fps', '60 fps');
  await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByTestId('export-run').click(),
  ]);
  const whole = (await lastRequest(page))!.options;
  expect(whole).toMatchObject({ camera: 'whole', theme: 'light', fps: 60 });
  expect('window' in whole).toBe(false);
});

test('streams the MP4 to a file picked in the save dialog (Chromium)', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'File System Access API');
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).showSaveFilePicker = async (o: {
      suggestedName: string;
      types: { accept: Record<string, string[]> }[];
    }) => {
      if (!navigator.userActivation.isActive) throw new DOMException('no gesture', 'SecurityError');
      (window as unknown as Record<string, unknown>).__picked = o;
      const root = await navigator.storage.getDirectory();
      return root.getFileHandle(o.suggestedName, { create: true });
    };
  });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await loadShortPiece(page, 3);
  await openExport(page);
  await pickVideo(page);
  await choose(page, 'export-vsize', '720p');
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByTestId('export-run').click();
  await expect(page.getByTestId('export-message')).toContainText(/^Saved Tidewater-Hymn\.mp4/, {
    timeout: 60_000,
  });
  await expect(page.getByTestId('export-message')).not.toContainText('downloads');
  expect(downloads).toBe(0);
  const saved = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const f = await (await root.getFileHandle('Tidewater-Hymn.mp4')).getFile();
    const head = new Uint8Array(await f.slice(4, 8).arrayBuffer());
    return {
      picked: (window as unknown as { __picked: { suggestedName: string; types: unknown } })
        .__picked,
      size: f.size,
      ftyp: String.fromCharCode(...head),
    };
  });
  expect(saved.picked.suggestedName).toBe('Tidewater-Hymn.mp4');
  expect(saved.picked.types).toEqual([
    { description: 'Video (MP4)', accept: { 'video/mp4': ['.mp4'] } },
  ]);
  expect(saved.ftyp).toBe('ftyp');
  expect(saved.size).toBeGreaterThan(20_000);
  // The size in the message is the file's.
  await expect(page.getByTestId('export-message')).toContainText(`(${formatBytes(saved.size)})`);
  const played = await probeInPage(page, { opfs: 'Tidewater-Hymn.mp4' });
  const req = (await lastRequest(page))!;
  expect(played).toMatchObject({ width: 1280, height: 720 });
  expect(Math.abs(played.duration - req.result!.duration)).toBeLessThanOrEqual(1 / 30);
});

test('without WebCodecs it says why and disables Export for video only', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { VideoEncoder?: unknown }).VideoEncoder;
  });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await pickVideo(page);
  await expect(page.getByTestId('export-unsupported')).toContainText('no video encoder');
  await expect(page.getByTestId('export-run')).toBeDisabled();
  await expect(page.getByTestId('export-size')).toHaveCount(0);
  await choose(page, 'export-format', 'WAV');
  await expect(page.getByTestId('export-unsupported')).toHaveCount(0);
  await expect(page.getByTestId('export-run')).toBeEnabled();
});

test('Cancel stops a video export; the picked file is left empty (Chromium)', async ({
  page,
  browserName,
}) => {
  if (browserName === 'chromium') {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).showSaveFilePicker = async (o: {
        suggestedName: string;
      }) =>
        (await navigator.storage.getDirectory()).getFileHandle(o.suggestedName, { create: true });
    });
    await page.goto('./?example=tidewater-hymn');
    await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  }
  await openExport(page);
  await pickVideo(page);
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByTestId('export-run').click();
  await expect(page.getByTestId('export-progress')).toBeVisible();
  await expect(page.getByTestId('export-run')).toBeDisabled();
  await expect(page.getByTestId('export-status')).toContainText(
    /[1-9]\d*%\. Drawing and encoding/,
    {
      timeout: 30_000,
    },
  );
  const t0 = Date.now();
  await page.getByTestId('export-cancel').click();
  await expect(page.getByTestId('export-message')).toHaveText('Export cancelled.');
  expect(Date.now() - t0).toBeLessThan(1500);
  await expect(page.getByTestId('export-run')).toBeEnabled();
  await page.waitForTimeout(500);
  expect(downloads).toBe(0);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { __algorhythms: { store: { getState(): { notices: unknown[] } } } }
        ).__algorhythms.store.getState().notices.length,
    ),
  ).toBe(0);
  if (browserName === 'chromium') {
    const size = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      return (await (await root.getFileHandle('Tidewater-Hymn.mp4')).getFile()).size;
    });
    expect(size).toBe(0);
  }
});

test('Escape cancels a running video export and closes the dialog', async ({ page }) => {
  await openExport(page);
  await pickVideo(page);
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByTestId('export-run').click();
  await expect(page.getByTestId('export-status')).toContainText(/\d+%/, { timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByTestId('menu-button')).toBeFocused();
  await page.waitForTimeout(800);
  expect(downloads).toBe(0);
  await openExport(page);
  await expect(page.getByTestId('export-progress')).toHaveCount(0);
  await expect(page.getByTestId('export-run')).toHaveText('Export video');
});

test('remembers the video choices across closing and other formats', async ({ page }) => {
  await openExport(page);
  await pickVideo(page);
  await choose(page, 'export-aspect', '1:1');
  await choose(page, 'export-vsize', '720p');
  await choose(page, 'export-fps', '60 fps');
  await choose(page, 'export-camera', 'Whole piece');
  await choose(page, 'export-vtheme', 'Light');
  await openLook(page);
  await dialog(page).getByTestId('hud-none').click();
  await dialog(page).getByTestId('look-thickness').uncheck();
  await page.getByTestId('export-close').click();
  await expect(dialog(page)).toBeHidden();
  await openExport(page);
  await expect(dialog(page).getByLabel('Video (MP4)', { exact: true })).toBeChecked();
  await choose(page, 'export-format', 'MIDI');
  await pickVideo(page);
  const d = dialog(page);
  for (const label of ['1:1', '720p', '60 fps', 'Whole piece', 'Light']) {
    await expect(d.getByLabel(label, { exact: true })).toBeChecked();
  }
  for (const it of DEFAULT_HUD) await expect(page.getByTestId(`hud-${it}`)).not.toBeChecked();
  await expect(page.getByTestId('look-thickness')).not.toBeChecked();
});

test('fits a phone screen with Video selected, in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 640 });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await openExport(page);
    await pickVideo(page);
    await expect(page.getByTestId('export-codec')).toBeVisible();
    await openLook(page);
    const box = (await dialog(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(640);
    expect(await dialog(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // Every control is reachable (the dialog scrolls vertically).
    for (const t of ['look-reset', 'hud-title', 'look-follow-at', 'export-run']) {
      await page.getByTestId(t).scrollIntoViewIfNeeded();
      await expect(page.getByTestId(t)).toBeInViewport();
    }
    const wide = await dialog(page).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [...el.querySelectorAll('label, button, input, small')].filter((c) => {
        const b = c.getBoundingClientRect();
        return b.width > 0 && (b.left < r.left - 0.5 || b.right > r.right + 0.5);
      }).length;
    });
    expect(wide).toBe(0);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  }
});

test('Look: defaults are EXPORT_LOOK; the controls reach exportVideo; remembered; Reset', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: 'light' });
  await loadShortPiece(page, 2);
  await openExport(page);
  await pickVideo(page);
  await choose(page, 'export-vsize', '720p');
  await openLook(page);
  const d = dialog(page);
  const checked: Record<string, boolean> = {
    'look-guides': false,
    'look-beats': false,
    'look-markers': true,
    'look-sections': true,
    'look-level': true,
    'look-thickness': true,
    'look-pulse': true,
    'look-dots': true,
    'look-rings': true,
    'look-hz': true,
    'look-playhead': true,
  };
  const expectDefaults = async () => {
    for (const [t, on] of Object.entries(checked)) {
      if (on) await expect(page.getByTestId(t), t).toBeChecked();
      else await expect(page.getByTestId(t), t).not.toBeChecked();
    }
    await expect(page.getByTestId('look-guide-labels')).toBeDisabled();
    for (const l of ['Hidden', 'By pitch', 'Normal']) {
      await expect(d.getByLabel(l, { exact: true })).toBeChecked();
    }
    await expect(page.getByTestId('look-follow-at-value')).toHaveText('80 %');
    for (const it of HUD_ITEMS) {
      if (DEFAULT_HUD.includes(it)) await expect(page.getByTestId(`hud-${it}`)).toBeChecked();
      else await expect(page.getByTestId(`hud-${it}`)).not.toBeChecked();
    }
    await expect(page.getByTestId('look-transparent')).toHaveCount(0);
  };
  await expectDefaults();
  await expect(d.getByTestId('look-hud')).toContainText('spread 19 st · octave + 5th');

  const exportNow = async () => {
    await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.getByTestId('export-run').click(),
    ]);
    return (await lastRequest(page))!.options;
  };
  const def = await exportNow();
  expect(def.look).toEqual({ ...EXPORT_LOOK, theme: 'light' });
  expect(def.followAt).toBe(0.8);

  // The future shown: the playhead default moves to 35 % until the slider is moved.
  await choose(page, 'look-future', 'Dimmed');
  await expect(page.getByTestId('look-follow-at-value')).toHaveText('35 %');
  await page.getByTestId('look-future-opacity').fill('50');
  await page.getByTestId('look-guides').check();
  await choose(page, 'look-width', 'Bold');
  await page.getByTestId('hud-none').click();
  await page.getByTestId('hud-spread').check();
  await page.getByTestId('hud-chord').check();
  await page.getByTestId('look-follow-at').fill('60');
  await expect(page.getByTestId('look-follow-at-value')).toHaveText('60 %');
  const opts = await exportNow();
  expect(opts.look).toMatchObject({
    guides: true,
    guideLabels: true,
    future: 'dimmed',
    futureOpacity: 0.5,
    lineWidth: 'bold',
    hud: ['chord', 'spread'],
  });
  expect(opts.followAt).toBe(0.6);

  // Remembered after a reload.
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await pickVideo(page);
  await openLook(page);
  await expect(page.getByTestId('look-guides')).toBeChecked();
  await expect(d.getByLabel('Bold', { exact: true })).toBeChecked();
  await expect(d.getByLabel('Dimmed', { exact: true })).toBeChecked();
  await expect(page.getByTestId('look-follow-at-value')).toHaveText('60 %');
  await expect(page.getByTestId('hud-spread')).toBeChecked();
  await expect(page.getByTestId('hud-formula')).not.toBeChecked();
  await expect(d.getByLabel('720p', { exact: true })).toBeChecked();

  await page.getByTestId('look-reset').click();
  await expectDefaults();
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await pickVideo(page);
  await openLook(page);
  await expectDefaults();
});

test('renders without storage (localStorage throws)', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
  });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await pickVideo(page);
  await openLook(page);
  await page.getByTestId('look-guides').check();
  await expect(page.getByTestId('look-guides')).toBeChecked();
  await expect(page.getByTestId('look-follow-at-value')).toHaveText('80 %');
});

test('owner look samples: the dialog with the Look open, a default frame', async ({
  page,
  browserName,
}) => {
  test.skip(!LOOK_SAMPLES || browserName !== 'chromium', 'set LOOK_SAMPLES_DIR (Chromium)');
  test.setTimeout(120_000);
  mkdirSync(LOOK_SAMPLES!, { recursive: true });
  await page.setViewportSize({ width: 900, height: 2200 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('./?example=little-round');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await pickVideo(page);
  await openLook(page);
  await expect(page.getByTestId('export-codec')).toHaveText(/\+/);
  await dialog(page).screenshot({ path: join(LOOK_SAMPLES!, 'dialog-video.png') });
  // The export's own options (started, then cancelled), drawn by its frame code at mid-piece.
  await page.getByTestId('export-run').click();
  await page.getByTestId('export-cancel').click();
  await expect(page.getByTestId('export-message')).toHaveText('Export cancelled.');
  const opts = (await lastRequest(page))!.options;
  expect(opts).toMatchObject({ aspect: '16:9', camera: 'follow', followAt: 0.8 });
  expect(opts.look).toMatchObject({ future: 'hidden' });
  const b64 = await page.evaluate(async (o) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const m = await h.videoExport();
    const piece = h.store.getState().piece as Parameters<typeof m.referenceFrame>[0];
    const k = Math.round(
      (h.store.getState() as unknown as { compiled: { duration: number } }).compiled.duration *
        0.5 *
        o.fps,
    );
    const img = m.referenceFrame(piece, o, k);
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext('2d')!.putImageData(img, 0, 0);
    const bytes = new Uint8Array(
      await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer(),
    );
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, opts);
  writeFileSync(join(LOOK_SAMPLES!, 'frame-default.png'), Buffer.from(b64, 'base64'));
});

test('owner samples: Little Round at 16:9 and 9:16, 720p30 Follow', async ({
  page,
  browserName,
}) => {
  test.skip(!SAMPLES || browserName !== 'chromium', 'set VIDEO_SAMPLES_DIR (Chromium)');
  test.setTimeout(600_000);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('./?example=little-round');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await pickVideo(page);
  await choose(page, 'export-vsize', '720p');
  await expect(page.getByTestId('export-codec')).toBeVisible();
  await dialog(page).screenshot({ path: join(SAMPLES!, 'dialog.png') });
  for (const aspect of ['16:9', '9:16'] as const) {
    await choose(page, 'export-aspect', aspect);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 590_000 }),
      page.getByTestId('export-run').click(),
    ]);
    await download.saveAs(join(SAMPLES!, `little-round-${aspect.replace(':', 'x')}-720p30.mp4`));
  }
});
