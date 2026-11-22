/**
 * Video in the Export dialog (PLAN.md §12 "Video export", §15 M8; M8-d): the format and its
 * controls, the choices reaching `exportVideo` (with the editor's zoom window for Follow), a
 * download that plays, streaming to a (stubbed) picked file in Chromium, the unsupported message,
 * cancel and Escape, remembered choices and the phone layout; the live preview (matches a direct
 * render, redraws, time slider, stays in view) and the HUD picker.
 *
 * Owner samples: with VIDEO_SAMPLES_DIR set, the last test exports Little Round at 16:9 and 9:16
 * (720p30, Follow) through the dialog into that folder, plus dialog.png (Chromium only).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { clickExportForDownload, expectUncovered } from './export-diag';
import { formatBytes } from '../../src/app/export-options';
import { DEFAULT_HUD, HUD_ITEMS } from '../../src/render/hud';
import { EXPORT_LOOK } from '../../src/render/look';
import type * as VideoExport from '../../src/app/video-export';
import type * as ExportRun from '../../src/app/export-run';
import type * as Poster from '../../src/app/poster-export';

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
/** Review screenshots: HUD open (1280×800), phone Look (375×640). */
const PREVIEW_DIR = process.env.EXPORT_PREVIEW_DIR;

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

/** The Look section (always shown for video and poster). */
async function openLook(page: Page): Promise<void> {
  await expect(page.getByTestId('look-reset')).toBeAttached();
}

/** Opens the HUD checklist. */
async function openHud(page: Page): Promise<void> {
  const b = page.getByTestId('look-hud-button');
  if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
  await expect(page.getByTestId('look-hud')).toBeVisible();
}

const pick = (page: Page, testId: string, value: string) =>
  page.getByTestId(testId).selectOption(value);

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

/** Look selects whose chosen option's text does not fit (text + padding + arrow > width). */
const clippedSelects = (page: Page) =>
  dialog(page).evaluate((d) => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    return [...d.querySelectorAll<HTMLSelectElement>('.look select')]
      .filter((s) => {
        const cs = getComputedStyle(s);
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const text = ctx.measureText(s.selectedOptions[0]?.text ?? '').width;
        const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
        return text + pad + 18 > s.clientWidth;
      })
      .map((s) => `${s.dataset.testid}: ${s.selectedOptions[0]?.text}`);
  });

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
  await openHud(page);
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
  await openHud(page);
  await dialog(page).getByTestId('hud-none').click();
  await page.keyboard.press('Escape');
  const download = await clickExportForDownload(page);
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
  await clickExportForDownload(page);
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
  await openHud(page);
  await dialog(page).getByTestId('hud-none').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('look-thickness').uncheck();
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
  await expect(page.getByTestId('look-hud-button')).toHaveText(/None/);
  await openHud(page);
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
    for (const t of ['look-reset', 'look-hud-button', 'look-follow-at', 'export-run']) {
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
  const defaults: Record<string, string> = {
    'look-guides': 'off',
    'look-beats': 'off',
    'look-moments': 'labels',
    'look-future': 'hidden',
    'look-follow-at': '80',
    'look-heads': 'all',
    'look-colors': 'app',
    'look-width': 'normal',
  };
  /** Two-way choices: switches. */
  const switches: Record<string, boolean> = {
    'look-playhead': true,
    'look-level': true,
    'look-thickness': true,
    'look-pulse': true,
  };
  const expectDefaults = async () => {
    for (const [t, v] of Object.entries(defaults)) {
      await expect(page.getByTestId(t), t).toHaveValue(v);
    }
    for (const [t, on] of Object.entries(switches)) {
      await expect(page.getByTestId(t), t).toHaveAttribute('role', 'switch');
      await expect(page.getByTestId(t), t).toBeChecked({ checked: on });
    }
    await expect(page.getByTestId('look-hud-button')).toHaveText(/6 readouts/);
    await openHud(page);
    for (const it of HUD_ITEMS) {
      if (DEFAULT_HUD.includes(it)) await expect(page.getByTestId(`hud-${it}`)).toBeChecked();
      else await expect(page.getByTestId(`hud-${it}`)).not.toBeChecked();
    }
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('look-hud')).toHaveCount(0);
    await expect(page.getByTestId('look-background')).toHaveCount(0);
  };
  await expectDefaults();
  await openHud(page);
  await expect(d.getByTestId('look-hud')).toContainText('spread 19 st · octave + 5th');
  await page.keyboard.press('Escape');

  const exportNow = async () => {
    await clickExportForDownload(page);
    return (await lastRequest(page))!.options;
  };
  const def = await exportNow();
  expect(def.look).toEqual({ ...EXPORT_LOOK, theme: 'light' });
  expect(def.followAt).toBe(0.8);

  // The future shown: the playhead default moves to 35 % until Playhead at is chosen.
  await pick(page, 'look-future', 'dimmed:35');
  await expect(page.getByTestId('look-follow-at')).toHaveValue('35');
  await pick(page, 'look-future', 'dimmed:50');
  await pick(page, 'look-guides', 'labels');
  await pick(page, 'look-width', 'bold');
  await pick(page, 'look-moments', 'all');
  await pick(page, 'look-heads', 'dots');
  // Switches: a click toggles; so does Space.
  await page.getByTestId('look-playhead').click();
  await expect(page.getByTestId('look-playhead')).not.toBeChecked();
  await pick(page, 'look-beats', 'every');
  await page.getByTestId('look-pulse').focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('look-pulse')).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Pulse marks' })).not.toBeChecked();
  await openHud(page);
  await page.getByTestId('hud-none').click();
  await page.getByTestId('hud-spread').check();
  await page.getByTestId('hud-chord').check();
  await page.keyboard.press('Escape');
  await pick(page, 'look-follow-at', '65');
  await pick(page, 'look-future', 'hidden');
  await expect(page.getByTestId('look-follow-at')).toHaveValue('65');
  await pick(page, 'look-future', 'dimmed:50');
  const opts = await exportNow();
  expect(opts.look).toMatchObject({
    guides: true,
    guideLabels: true,
    markers: true,
    sections: true,
    beats: 'every',
    playhead: false,
    pulseMarks: false,
    dots: true,
    rings: false,
    hzLabels: false,
    future: 'dimmed',
    futureOpacity: 0.5,
    lineWidth: 'bold',
    hud: ['chord', 'spread'],
  });
  expect(opts.followAt).toBe(0.65);

  // Remembered after a reload.
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await pickVideo(page);
  await openLook(page);
  await expect(page.getByTestId('look-guides')).toHaveValue('labels');
  await expect(page.getByTestId('look-width')).toHaveValue('bold');
  await expect(page.getByTestId('look-future')).toHaveValue('dimmed:50');
  await expect(page.getByTestId('look-follow-at')).toHaveValue('65');
  await expect(page.getByTestId('look-beats')).toHaveValue('every');
  await expect(page.getByTestId('look-playhead')).not.toBeChecked();
  await expect(page.getByTestId('look-pulse')).not.toBeChecked();
  await expect(page.getByTestId('look-hud-button')).toHaveText(/2 readouts/);
  await openHud(page);
  await expect(page.getByTestId('hud-spread')).toBeChecked();
  await expect(page.getByTestId('hud-formula')).not.toBeChecked();
  await expect(d.getByLabel('720p', { exact: true })).toBeChecked();

  await page.keyboard.press('Escape');
  await page.getByTestId('look-reset').click();
  await expectDefaults();
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await pickVideo(page);
  await openLook(page);
  await expectDefaults();
});

test('line colours follow the app by default; By pitch overrides it', async ({ page }) => {
  test.setTimeout(90_000);
  await loadShortPiece(page, 2);
  await page.getByTestId('view-options').click();
  await page.getByRole('button', { name: 'Ink', exact: true }).click();
  await page.keyboard.press('Escape');
  await openExport(page);
  await pickVideo(page);
  await choose(page, 'export-vsize', '720p');
  await openLook(page);
  await expect(page.getByTestId('look-colors')).toHaveValue('app');
  await expect(page.getByTestId('look-ink')).toHaveCount(0);
  const exportNow = async () => {
    await clickExportForDownload(page);
    return (await lastRequest(page))!.options;
  };
  const app = await exportNow();
  expect(app.colors).toBe('ink');
  expect(app.look!.colors).toBe('ink');
  expect(app.look!.lineInk).toBeUndefined();
  await pick(page, 'look-colors', 'pitch');
  const pitch = await exportNow();
  expect(pitch.colors).toBe('pitch');
  expect(pitch.look!.colors).toBe('pitch');
});

// ---------------------------------------------------------------------------------------------
// Preview (PLAN.md §12 "Preview and layout")
// ---------------------------------------------------------------------------------------------

const canvasOf = (page: Page) => page.getByTestId('preview-canvas');

/** Waits for a preview draw after `after` draws; returns the count. */
async function drawn(page: Page, after = 0): Promise<number> {
  await expect
    .poll(async () => Number((await canvasOf(page).getAttribute('data-draws')) ?? 0))
    .toBeGreaterThan(after);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  return Number(await canvasOf(page).getAttribute('data-draws'));
}

/**
 * The preview canvas against a direct render of the same frame (or poster) at its size, from
 * the request the preview drew: pixels with a channel off by more than 16, and a pixel hash.
 */
async function comparePreview(
  page: Page,
): Promise<{ bad: number; total: number; hash: number; width: number; height: number }> {
  return page.evaluate(async () => {
    const h = (window as unknown as PreviewWindow).__algorhythms;
    const c = document.querySelector<HTMLCanvasElement>('[data-testid=preview-canvas]')!;
    const a = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const req = (await h.exportRun()).lastPreviewRequest()!;
    const piece = h.store.getState().piece as never;
    const ref =
      req.kind === 'video'
        ? (await h.videoExport()).referenceFrameAt(
            piece,
            req.options,
            req.t,
            req.scale,
            c.width,
            c.height,
          )
        : (await h.poster()).referencePosterAt(piece, req.options, req.scale, c.width, c.height);
    let bad = 0;
    let hash = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(
        Math.abs(a[i] - ref.data[i]),
        Math.abs(a[i + 1] - ref.data[i + 1]),
        Math.abs(a[i + 2] - ref.data[i + 2]),
        Math.abs(a[i + 3] - ref.data[i + 3]),
      );
      if (d > 16) bad++;
      hash = (Math.imul(hash, 31) + a[i] + a[i + 1] * 7 + a[i + 2] * 13 + a[i + 3] * 17) | 0;
    }
    return { bad, total: a.length / 4, hash, width: c.width, height: c.height };
  });
}

interface PreviewWindow {
  __algorhythms: HookWindow['__algorhythms'] & {
    poster(): Promise<typeof Poster>;
  };
}

const previewReq = (page: Page) =>
  page.evaluate(async () =>
    (await (window as unknown as HookWindow).__algorhythms.exportRun()).lastPreviewRequest(),
  );

test('the preview draws the export’s frame; redraws on changes; the time slider scrubs', async ({
  page,
}) => {
  await openExport(page);
  await pickVideo(page);
  let n = await drawn(page);
  // The playhead is at the start, so the preview starts a third into the piece.
  const duration = await page.evaluate(
    () =>
      (
        (window as unknown as HookWindow).__algorhythms.store.getState() as unknown as {
          compiled: { duration: number };
        }
      ).compiled.duration,
  );
  expect(Number(await canvasOf(page).getAttribute('data-t'))).toBeCloseTo(duration / 3, 2);
  await expect(canvasOf(page)).toHaveAttribute('aria-label', /^Preview of the video frame at /);
  const first = await comparePreview(page);
  expect(first.bad / first.total).toBeLessThan(0.002);
  expect(first.width / first.height).toBeCloseTo(16 / 9, 1);

  // An option redraws it with that option.
  await pick(page, 'look-guides', 'labels');
  n = await drawn(page, n);
  const guides = await comparePreview(page);
  expect(guides.hash).not.toBe(first.hash);
  expect(guides.bad / guides.total).toBeLessThan(0.002);
  const req = (await previewReq(page))!;
  expect(req.kind === 'video' && req.options.look!.guides).toBe(true);

  // The slider picks the frame.
  await page.getByTestId('preview-time').fill('5');
  n = await drawn(page, n);
  await expect(canvasOf(page)).toHaveAttribute('data-t', '5.000');
  const later = await comparePreview(page);
  expect(later.hash).not.toBe(guides.hash);
  expect(later.bad / later.total).toBeLessThan(0.002);
  expect((await previewReq(page))!).toMatchObject({ kind: 'video', t: 5 });

  // The aspect follows the export.
  await choose(page, 'export-aspect', '9:16');
  await drawn(page, n);
  const tall = await comparePreview(page);
  expect(tall.height / tall.width).toBeCloseTo(16 / 9, 1);
  expect(tall.bad / tall.total).toBeLessThan(0.002);
});

test('the preview starts at the editor’s playhead', async ({ page }) => {
  await page.evaluate(() =>
    (
      (window as unknown as HookWindow).__algorhythms as unknown as {
        actions: { seek(t: number): void };
      }
    ).actions.seek(12.5),
  );
  await openExport(page);
  await pickVideo(page);
  await drawn(page);
  await expect(canvasOf(page)).toHaveAttribute('data-t', '12.500');
  await expect(page.getByTestId('preview-time')).toHaveValue('12.5');
});

test('the preview stays in view while the options scroll (desktop and phone)', async ({ page }) => {
  for (const [w, h] of [
    [1280, 800],
    [375, 640],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await openExport(page);
    await pickVideo(page);
    await drawn(page);
    for (const t of ['look-reset', 'export-run', 'look-guides']) {
      await page.getByTestId(t).scrollIntoViewIfNeeded();
      await expect(canvasOf(page), `${w}: ${t}`).toBeInViewport({ ratio: 1 });
      await expect(page.getByTestId('preview-time')).toBeInViewport();
      // The control is not under the preview: it gets the clicks.
      await expectUncovered(page, t, `${w}: ${t} usable`);
    }
    if (w === 375) {
      // Small enough to leave the options most of the screen.
      const box = (await page.getByTestId('export-preview').boundingBox())!;
      expect(box.height).toBeLessThan(640 * 0.4);
    }
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  }
});

test('the open HUD checklist never covers the Export button (desktop and phone)', async ({
  page,
}) => {
  for (const [w, h] of [
    [1280, 800],
    [375, 640],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await openExport(page);
    await pickVideo(page);
    await openHud(page);
    for (const t of ['look-hud', 'look-reset', 'export-run']) {
      await page.getByTestId(t).scrollIntoViewIfNeeded();
      await expectUncovered(page, t, `${w}: ${t} not covered`);
    }
    if (PREVIEW_DIR && w === 1280) {
      await page.getByTestId('look-hud').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(PREVIEW_DIR, 'hud-open.png') });
    }
    // Escape still closes only the checklist and refocuses its button.
    await page.getByTestId('hud-none').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('look-hud')).toHaveCount(0);
    await expect(page.getByTestId('look-hud-button')).toBeFocused();
    // Also with nothing focused (macOS WebKit does not focus a clicked button or checkbox).
    await openHud(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('look-hud')).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByTestId('look-hud-button')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  }
});

test('phone: every Look dropdown shows its chosen option in full', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 640 });
  await openExport(page);
  await pickVideo(page);
  await openLook(page);
  expect(await clippedSelects(page)).toEqual([]);
  // The longest options too.
  for (const [t, v] of [
    ['look-heads', 'all'],
    ['look-guides', 'labels'],
    ['look-moments', 'all'],
    ['look-future', 'dimmed:35'],
  ] as const) {
    await pick(page, t, v);
  }
  expect(await clippedSelects(page)).toEqual([]);
  if (PREVIEW_DIR) {
    await page.getByTestId('look-level').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(PREVIEW_DIR, 'phone2.png') });
  }
});

test('HUD picker: opens, Escape closes it (not the dialog), choices reach the export', async ({
  page,
  browserName,
}) => {
  test.setTimeout(90_000);
  await loadShortPiece(page, 2);
  await openExport(page);
  await pickVideo(page);
  await choose(page, 'export-vsize', '720p');
  const button = page.getByTestId('look-hud-button');
  await expect(button).toHaveText(/6 readouts/);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toHaveAccessibleName(/HUD/);
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('look-hud')).toBeVisible();
  await page.getByTestId('hud-formula').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('look-hud')).toHaveCount(0);
  await expect(dialog(page)).toBeVisible();
  await expect(button).toBeFocused();

  // Keyboard: Enter opens, Tab reaches the checklist (macOS WebKit tabs to buttons with Alt).
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('look-hud')).toBeVisible();
  await page.keyboard.press(
    browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab',
  );
  await expect(page.getByTestId('hud-none')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(button).toHaveText(/None/);
  await page.getByTestId('hud-chord').check();
  await page.getByTestId('hud-names').check();
  await expect(button).toHaveText(/2 readouts/);
  // A click elsewhere closes it.
  await dialog(page).locator('h2').click();
  await expect(page.getByTestId('look-hud')).toHaveCount(0);
  await clickExportForDownload(page);
  const opts = (await lastRequest(page))!.options;
  expect(opts.look!.hud).toEqual(['chord', 'names']);
  expect(opts.hud).toBe(true);
  // Default restores today's list.
  await button.click();
  await page.getByTestId('hud-default').click();
  await expect(button).toHaveText(/6 readouts/);
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
  await pick(page, 'look-guides', 'labels');
  await expect(page.getByTestId('look-guides')).toHaveValue('labels');
  await expect(page.getByTestId('look-follow-at')).toHaveValue('80');
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
    const download = await clickExportForDownload(page, 590_000);
    await download.saveAs(join(SAMPLES!, `little-round-${aspect.replace(':', 'x')}-720p30.mp4`));
  }
});
