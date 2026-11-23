/**
 * Video in the Export dialog (PLAN.md §12 "Video export", §15 M8; M8-d): the format and its
 * controls, the choices reaching `exportVideo` (with the editor's zoom window for Follow), a
 * download that plays, streaming to a (stubbed) picked file in Chromium, the unsupported message,
 * cancel and Escape, remembered choices and the phone layout; the live preview (matches a direct
 * render, redraws, time slider, stays in view); the Look's sliders, switches and segments and the
 * inline HUD. Interactions go through export-diag's guards (a hang logs the page's state).
 *
 * Owner samples: with VIDEO_SAMPLES_DIR set, the last test exports Little Round at 16:9 and 9:16
 * (720p30, Follow) through the dialog into that folder, plus dialog.png (Chromium only).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
/** Review screenshots (Little Round, light, HUD expanded): video.png (1280×800), phone.png (375×640). */
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

const pickVideo = (page: Page) => choose(page, 'export-format', 'Video (MP4)');

/** The Look section (always shown for video and poster). */
async function openLook(page: Page): Promise<void> {
  await expect(page.getByTestId('look-reset')).toBeAttached();
}

/** Expands the HUD's readout list. */
const openHud = (page: Page) => setHudOpen(page, true);

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

/**
 * Look segments that do not fit: a bar wider than its box or the dialog, or an option's text
 * wrapped or cut. No `<select>` is left in the Look.
 */
const badSegments = (page: Page) =>
  dialog(page).evaluate((d) => {
    const bad: string[] = [];
    if (d.querySelector('.look select')) bad.push('a select');
    const right = d.getBoundingClientRect().right;
    for (const g of d.querySelectorAll<HTMLElement>('.look-seg')) {
      const r = g.getBoundingClientRect();
      if (g.scrollWidth > g.clientWidth + 1 || r.right > right + 0.5) bad.push(g.dataset.testid!);
      for (const l of g.querySelectorAll<HTMLElement>('label > span')) {
        const lines = l.getClientRects().length;
        if (lines > 1 || l.scrollWidth > l.clientWidth + 1)
          bad.push(`${g.dataset.testid}: ${l.textContent}`);
      }
    }
    return bad;
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
  await tap(page, 'hud-none');
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
  await tap(page, 'hud-none');
  await setSwitch(page, 'look-thickness', false);
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
  await expect(d.locator('.look select')).toHaveCount(0);
  /** Segmented controls: the selected value. */
  const segments: Record<string, string> = {
    'look-guides': 'off',
    'look-beats': 'off',
    'look-moments': 'labels',
    'look-colors': 'app',
  };
  /** Sliders: the value and its text. */
  const sliders: Record<string, [string, string]> = {
    'look-future': ['0', 'Hidden'],
    'look-follow-at': ['80', '80 %'],
    'look-width': ['1', '1×'],
  };
  /** Yes/no choices: switches. */
  const switches: Record<string, boolean> = {
    'look-playhead': true,
    'look-level': true,
    'look-thickness': true,
    'look-pulse': true,
    'look-heads-dots': true,
    'look-heads-rings': true,
    'look-heads-hz': true,
  };
  const expectDefaults = async () => {
    for (const [t, v] of Object.entries(segments)) {
      await expect(page.getByTestId(t), t).toHaveAttribute('data-value', v);
    }
    for (const [t, [v, text]] of Object.entries(sliders)) {
      await expect(page.getByTestId(t), t).toHaveAttribute('type', 'range');
      await expect(page.getByTestId(t), t).toHaveValue(v);
      await expect(page.getByTestId(`${t}-value`), t).toHaveText(text);
    }
    for (const [t, on] of Object.entries(switches)) {
      await expect(page.getByTestId(t), t).toBeChecked({ checked: on });
    }
    for (const t of ['look-playhead', 'look-level', 'look-thickness', 'look-pulse']) {
      await expect(page.getByTestId(t), t).toHaveAttribute('role', 'switch');
    }
    await expect(page.getByTestId('look-hud-button')).toHaveText(/HUD · 6 readouts/);
    await openHud(page);
    for (const it of HUD_ITEMS) {
      await expect(page.getByTestId(`hud-${it}`)).toBeChecked({
        checked: DEFAULT_HUD.includes(it),
      });
    }
    await setHudOpen(page, false);
    await expect(page.getByTestId('look-background')).toHaveCount(0);
  };
  await expectDefaults();
  await openHud(page);
  await expect(d.getByTestId('look-hud')).toContainText('spread 19 st · octave + 5th');
  await setHudOpen(page, false);

  const exportNow = async () => {
    await clickExportForDownload(page);
    return (await lastRequest(page))!.options;
  };
  const def = await exportNow();
  expect(def.look).toEqual({ ...EXPORT_LOOK, theme: 'light', hudLayout: {} });
  expect(def.followAt).toBe(0.8);

  // Ahead: 0 hidden, 100 full, between dimmed at that opacity. The playhead default moves to
  // 35 % while anything is drawn ahead, until Playhead at is moved.
  await setRange(page, 'look-future', 100);
  await expect(page.getByTestId('look-future-value')).toHaveText('Full');
  await expect(page.getByTestId('look-follow-at')).toHaveValue('35');
  expect((await exportNow()).look).toMatchObject({ future: 'full' });
  await setRange(page, 'look-future', 0);
  await expect(page.getByTestId('look-follow-at')).toHaveValue('80');
  expect((await exportNow()).look).toMatchObject({ future: 'hidden' });
  await setRange(page, 'look-future', 50);
  await expect(page.getByTestId('look-future-value')).toHaveText('50 %');
  await chooseSegment(page, 'look-guides', 'Lines + labels');
  await setRange(page, 'look-width', 1.5);
  await expect(page.getByTestId('look-width-value')).toHaveText('1.5×');
  await chooseSegment(page, 'look-moments', 'Both');
  await setSwitch(page, 'look-heads-rings', false);
  await setSwitch(page, 'look-heads-hz', false);
  // Switches: a click toggles; so does Enter (Space plays the video preview).
  await setSwitch(page, 'look-playhead', false);
  await chooseSegment(page, 'look-beats', 'Every beat');
  await page.getByTestId('look-pulse').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('look-pulse')).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Pulse marks' })).not.toBeChecked();
  await openHud(page);
  await tap(page, 'hud-none');
  await setSwitch(page, 'hud-spread', true);
  await setSwitch(page, 'hud-chord', true);
  await setHudOpen(page, false);
  await setRange(page, 'look-follow-at', 62);
  await expect(page.getByTestId('look-follow-at-value')).toHaveText('62 %');
  await setRange(page, 'look-future', 0);
  await expect(page.getByTestId('look-follow-at')).toHaveValue('62');
  await setRange(page, 'look-future', 50);
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
    lineWidth: 1.5,
    hud: ['chord', 'spread'],
  });
  expect(opts.followAt).toBe(0.62);

  // Remembered after a reload.
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await pickVideo(page);
  await openLook(page);
  await expect(page.getByTestId('look-guides')).toHaveAttribute('data-value', 'labels');
  await expect(page.getByTestId('look-width')).toHaveValue('1.5');
  await expect(page.getByTestId('look-future')).toHaveValue('50');
  await expect(page.getByTestId('look-follow-at')).toHaveValue('62');
  await expect(page.getByTestId('look-beats')).toHaveAttribute('data-value', 'every');
  await expect(page.getByTestId('look-playhead')).not.toBeChecked();
  await expect(page.getByTestId('look-pulse')).not.toBeChecked();
  await expect(page.getByTestId('look-heads-rings')).not.toBeChecked();
  await expect(page.getByTestId('look-hud-button')).toHaveText(/2 readouts/);
  await openHud(page);
  await expect(page.getByTestId('hud-spread')).toBeChecked();
  await expect(page.getByTestId('hud-formula')).not.toBeChecked();
  await expect(d.getByLabel('720p', { exact: true })).toBeChecked();
  await setHudOpen(page, false);

  await tap(page, 'look-reset');
  await expectDefaults();
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await pickVideo(page);
  await openLook(page);
  await expectDefaults();
});

test('Look sliders work from the keyboard (focused, arrows / Home / End)', async ({ page }) => {
  await openExport(page);
  await pickVideo(page);
  const future = page.getByTestId('look-future');
  await guarded(page, 'focus look-future', () => future.focus());
  await page.keyboard.press('End');
  await expect(future).toHaveValue('100');
  await expect(page.getByTestId('look-future-value')).toHaveText('Full');
  await page.keyboard.press('ArrowLeft');
  await expect(future).toHaveValue('99');
  await expect(future).toHaveAttribute('aria-valuetext', '99 %');
  await page.keyboard.press('Home');
  await expect(page.getByTestId('look-future-value')).toHaveText('Hidden');
  const at = page.getByTestId('look-follow-at');
  await at.focus();
  await page.keyboard.press('ArrowRight');
  await expect(at).toHaveValue('81');
  // Whole piece: Playhead at does not apply.
  await choose(page, 'export-camera', 'Whole piece');
  await expect(at).toBeDisabled();
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
  await expect(page.getByTestId('look-colors')).toHaveAttribute('data-value', 'app');
  await expect(page.getByTestId('look-ink')).toHaveCount(0);
  const exportNow = async () => {
    await clickExportForDownload(page);
    return (await lastRequest(page))!.options;
  };
  const app = await exportNow();
  expect(app.colors).toBe('ink');
  expect(app.look!.colors).toBe('ink');
  expect(app.look!.lineInk).toBeUndefined();
  await chooseSegment(page, 'look-colors', 'By pitch');
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
  await chooseSegment(page, 'look-guides', 'Lines + labels');
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

/** The player's transport status and playhead (s). */
const transport = (page: Page) =>
  page.evaluate(() => {
    const h = (window as unknown as HookWindow).__algorhythms as unknown as {
      store: { getState(): { transport: { status: string } } };
    };
    return { status: h.store.getState().transport.status };
  });
const previewT = async (page: Page) => Number(await canvasOf(page).getAttribute('data-t'));
const playBtn = (page: Page) => page.getByTestId('preview-play');
const seekEditor = (page: Page, t: number) =>
  page.evaluate(
    (at) =>
      (
        (window as unknown as HookWindow).__algorhythms as unknown as {
          actions: { seek(t: number): void };
        }
      ).actions.seek(at),
    t,
  );

test('the preview plays: the time follows the playhead and redraws; the slider seeks', async ({
  page,
}) => {
  await seekEditor(page, 4);
  await openExport(page);
  await pickVideo(page);
  const n = await drawn(page);
  await expect(playBtn(page)).toHaveAccessibleName('Play preview');
  await expect(playBtn(page)).toHaveAttribute('aria-keyshortcuts', 'Space');
  await expect(playBtn(page)).toHaveAttribute('title', /Space/);
  await tap(page, 'preview-play');
  await expect(playBtn(page)).toHaveAccessibleName('Pause preview');
  await expect.poll(async () => (await transport(page)).status).toBe('playing');
  // The time moves on from 4 s and the canvas redraws with it.
  await expect.poll(() => previewT(page), { timeout: 10_000 }).toBeGreaterThan(4.3);
  await expect
    .poll(async () => Number(await canvasOf(page).getAttribute('data-draws')))
    .toBeGreaterThan(n + 5);
  const ms = await page.evaluate(
    () =>
      (
        (window as unknown as HookWindow).__algorhythms as unknown as {
          exportPreview: { lastMs: number; maxMs: number };
        }
      ).exportPreview,
  );
  console.log(
    `preview redraw while playing: last ${ms.lastMs.toFixed(2)} ms, max ${ms.maxMs.toFixed(2)} ms`,
  );

  // Dragging the slider seeks the player.
  await page.getByTestId('preview-time').fill('20');
  await expect.poll(() => previewT(page)).toBeGreaterThanOrEqual(20);
  await expect.poll(() => previewT(page), { timeout: 10_000 }).toBeGreaterThan(20.2);
  await expect.poll(() => previewT(page)).toBeLessThan(30);

  await tap(page, 'preview-play');
  await expect(playBtn(page)).toHaveAccessibleName('Play preview');
  await expect.poll(async () => (await transport(page)).status).not.toBe('playing');
  const stopped = await previewT(page);
  await page.waitForTimeout(300);
  expect(await previewT(page)).toBe(stopped);
});

test('the preview stops at the piece’s end', async ({ page }) => {
  await loadShortPiece(page, 2);
  await openExport(page);
  await pickVideo(page);
  await drawn(page);
  await page.getByTestId('preview-time').fill('1.5');
  await tap(page, 'preview-play');
  await expect(playBtn(page)).toHaveAccessibleName('Play preview', { timeout: 10_000 });
  await expect.poll(async () => (await transport(page)).status).not.toBe('playing');
});

test('Space anywhere in the dialog plays and pauses the preview; the control does not act', async ({
  page,
}) => {
  await openExport(page);
  await pickVideo(page);
  await drawn(page);
  const playing = () => playBtn(page).getAttribute('data-playing');
  const spaceToggles = async () => {
    await page.keyboard.press('Space');
    await expect.poll(playing).toBe('true');
    await expect.poll(async () => (await transport(page)).status).toBe('playing');
    await page.keyboard.press('Space');
    await expect.poll(playing).toBe('false');
    await expect.poll(async () => (await transport(page)).status).not.toBe('playing');
  };
  // A switch keeps its state.
  const sw = page.getByTestId('look-thickness');
  await sw.focus();
  const on = await sw.isChecked();
  await spaceToggles();
  expect(await sw.isChecked()).toBe(on);
  await expect(sw).toBeFocused();
  // A segment (radio) keeps its choice.
  const seg = dialog(page).getByTestId('export-aspect').getByLabel('9:16', { exact: true });
  await seg.focus();
  await spaceToggles();
  await expect(seg).not.toBeChecked();
  // The Play button toggles once per press.
  await playBtn(page).focus();
  await spaceToggles();
  // A slider.
  await page.getByTestId('preview-time').focus();
  await spaceToggles();
  // Other formats: Space keeps the browser's (a focused switch toggles; nothing plays).
  await choose(page, 'export-format', 'Stems');
  const mono = page.getByTestId('export-mono');
  await mono.focus();
  const was = await mono.isChecked();
  await page.keyboard.press('Space');
  await expect.poll(() => mono.isChecked()).toBe(!was);
  expect((await transport(page)).status).not.toBe('playing');
});

test('closing the dialog stops the preview and returns the editor’s playhead', async ({ page }) => {
  await seekEditor(page, 7);
  await expect(page.getByTestId('time')).toHaveText(/^00:07\.0/);
  for (const close of ['Escape', 'button'] as const) {
    await openExport(page);
    await pickVideo(page);
    await drawn(page);
    await page.getByTestId('preview-time').fill('30');
    await tap(page, 'preview-play');
    await expect.poll(async () => (await transport(page)).status).toBe('playing');
    await expect.poll(() => previewT(page)).toBeGreaterThan(30);
    if (close === 'Escape') await page.keyboard.press('Escape');
    else await tap(page, 'export-close');
    await expect(dialog(page)).toBeHidden();
    await expect.poll(async () => (await transport(page)).status).not.toBe('playing');
    await expect(page.getByTestId('time')).toHaveText(/^00:07\.0/);
  }
});

test('Follow’s Window slider sets the seconds shown; the preview and the export use it', async ({
  page,
}) => {
  await setZoom(page, 10);
  await openExport(page);
  await pickVideo(page);
  let n = await drawn(page);
  const slider = page.getByTestId('export-window');
  const value = page.getByTestId('export-window-value');
  // Starts at the editor's zoom (10 s at 16:9), on its tick; no button.
  await expect(value).toHaveText('10 s');
  await expect(page.getByTestId('export-window-tick')).toHaveAttribute(
    'aria-label',
    'Editor’s zoom (10 s)',
  );
  await expect(page.getByTestId('export-window-reset')).toHaveCount(0);
  const before = (await previewReq(page))!;
  expect(before.kind === 'video' && before.options.window).toBe(10);

  await guarded(page, 'fill export-window', () => slider.fill('0'));
  await expect(value).toHaveText('2.0 s');
  n = await drawn(page, n);
  const narrow = (await previewReq(page))!;
  expect(narrow.kind === 'video' && narrow.options.window).toBeCloseTo(2, 6);

  // At 9:16 the label is what that frame shows; the renderer gets the 16:9 equivalent.
  await guarded(page, 'fill export-window', () => slider.fill('600'));
  const shown = await value.innerText();
  await choose(page, 'export-aspect', '9:16');
  await expect(value).toHaveText(shown);
  await drawn(page, n);
  const req = (await previewReq(page))!;
  const w16 = req.kind === 'video' ? req.options.window! : 0;
  const secs = Number(/[\d.]+/.exec(shown)![0]);
  expect(w16).toBeGreaterThan(secs * 1.5); // a 9:16 frame shows about 0.47× the 16:9 window

  // Hidden with Whole piece; back to the editor's zoom.
  await choose(page, 'export-camera', 'Whole piece');
  await expect(slider).toHaveCount(0);
  await choose(page, 'export-camera', 'Follow');
  const tick = Math.round(
    Number(await page.getByTestId('export-window-tick').getAttribute('data-at')) * 1000,
  );
  await guarded(page, 'fill export-window', () => slider.fill(String(tick)));
  await choose(page, 'export-aspect', '16:9');
  await expect(value).toHaveText('10 s');
});

/** The Window slider's value and its editor-zoom tick's track position (0..1000). */
async function windowState(page: Page): Promise<{ value: number; tick: number; text: string }> {
  const tick = Number(await page.getByTestId('export-window-tick').getAttribute('data-at'));
  return {
    value: Number(await page.getByTestId('export-window').inputValue()),
    tick: Math.round(tick * 1000),
    text: await page.getByTestId('export-window-value').innerText(),
  };
}

test('Window: the editor’s zoom is a tick the slider snaps to when dragged close', async ({
  page,
}) => {
  await setZoom(page, 20);
  await openExport(page);
  await pickVideo(page);
  const slider = page.getByTestId('export-window');
  const tickEl = page.getByTestId('export-window-tick');
  const value = page.getByTestId('export-window-value');
  for (const aspect of ['16:9', '9:16', '1:1'] as const) {
    await choose(page, 'export-aspect', aspect);
    const s0 = await windowState(page);
    expect(s0.value).toBe(s0.tick); // starts on the tick
    await expect(tickEl).toHaveAttribute('aria-label', `Editor’s zoom (${s0.text})`);
    await expect(tickEl).toHaveAttribute('title', `Editor’s zoom (${s0.text})`);
    // The tick sits under the thumb's place for that value (thumb centre ≈ 8 px from each end).
    const sb = (await slider.boundingBox())!;
    const tb = (await tickEl.boundingBox())!;
    const expectX = sb.x + 8 + (sb.width - 16) * (s0.tick / 1000);
    expect(Math.abs(tb.x + tb.width / 2 - expectX)).toBeLessThan(3);
    expect(tb.y).toBeGreaterThanOrEqual(sb.y + sb.height / 2);

    // Free away from the tick.
    const far = s0.tick > 500 ? s0.tick - 200 : s0.tick + 200;
    const dir = Math.sign(s0.tick - far);
    await guarded(page, 'fill export-window', () => slider.fill(String(far)));
    await expect(slider).toHaveValue(String(far));
    const near = s0.tick - dir * 50; // 5 %: still free
    await guarded(page, 'fill export-window', () => slider.fill(String(near)));
    await expect(slider).toHaveValue(String(near));
    // Within 3 %, moving toward it: snaps.
    await guarded(page, 'fill export-window', () => slider.fill(String(s0.tick - dir * 20)));
    await expect(slider).toHaveValue(String(s0.tick));
    await expect(value).toHaveText(s0.text);
    // A keyboard step leaves the tick; a step back snaps onto it.
    await slider.focus();
    await page.keyboard.press(dir > 0 ? 'ArrowRight' : 'ArrowLeft');
    await expect(slider).toHaveValue(String(s0.tick + dir));
    await page.keyboard.press(dir > 0 ? 'ArrowLeft' : 'ArrowRight');
    await expect(slider).toHaveValue(String(s0.tick));
  }

  // Back at 16:9, still on the tick: the form holds no window of its own.
  await choose(page, 'export-aspect', '16:9');
  await expect(value).toHaveText('20 s');
  const on = await windowState(page);
  expect(on.value).toBe(on.tick);

  // A pointer drag near the tick snaps too; dragged far it stays free.
  const sb = (await slider.boundingBox())!;
  const y = sb.y + sb.height / 2;
  const xAt = (v: number) => sb.x + 8 + (sb.width - 16) * (v / 1000);
  await page.mouse.move(xAt(on.tick), y);
  await page.mouse.down();
  await page.mouse.move(xAt(on.tick - 250), y, { steps: 5 });
  const away = await windowState(page);
  expect(Math.abs(away.value - (on.tick - 250))).toBeLessThan(15);
  await page.mouse.move(xAt(on.tick - 15), y, { steps: 5 });
  await page.mouse.up();
  await expect(slider).toHaveValue(String(on.tick));
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

test('the expanded HUD never covers the Export button (desktop and phone)', async ({ page }) => {
  for (const [w, h] of [
    [1280, 800],
    [375, 640],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ colorScheme: 'light' });
    if (PREVIEW_DIR) {
      await page.goto('./?example=little-round');
      await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
    }
    await openExport(page);
    await pickVideo(page);
    await openHud(page);
    for (const t of ['look-hud', 'hud-title', 'look-reset', 'export-run']) {
      await page.getByTestId(t).scrollIntoViewIfNeeded();
      await expectUncovered(page, t, `${w}: ${t} not covered`);
    }
    if (PREVIEW_DIR) {
      await page.getByTestId('look-hud-button').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(PREVIEW_DIR, w === 1280 ? 'video.png' : 'phone.png') });
    }
    // Escape closes the dialog (no popup to close first).
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  }
});

test('phone: the Look segments fit, one line each; no dropdowns', async ({ page }) => {
  for (const [w, h] of [
    [375, 640],
    [1280, 800],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await openExport(page);
    await pickVideo(page);
    await openLook(page);
    expect(await badSegments(page), `${w}`).toEqual([]);
    // Every choice selected in turn still fits.
    await chooseSegment(page, 'look-moments', 'Both');
    await chooseSegment(page, 'look-guides', 'Lines + labels');
    await chooseSegment(page, 'look-colors', 'By pitch');
    expect(await badSegments(page), `${w}`).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  }
});

test('HUD: expands in place, one switch per readout; each reaches the export; keyboard', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await loadShortPiece(page, 1);
  await openExport(page);
  await pickVideo(page);
  await choose(page, 'export-vsize', '720p');
  const button = page.getByTestId('look-hud-button');
  const list = page.getByTestId('look-hud');
  await expect(button).toHaveText(/HUD · 6 readouts/);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(list).toBeHidden();
  // Collapsed, the readouts are out of reach (inert), not just out of sight.
  expect(await list.evaluate((el) => (el as HTMLElement & { inert: boolean }).inert)).toBe(true);
  await expect(page.getByRole('switch', { name: /^Chord/ })).toHaveCount(0);

  // Expands in place: the rows below move down, nothing is overlaid.
  const below = async () =>
    (await page.getByTestId('look-reset').boundingBox())!.y - (await button.boundingBox())!.y;
  const gap = await below();
  await tap(page, 'look-hud-button');
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(list).toBeVisible();
  await expect.poll(below).toBeGreaterThan(gap + 200);
  const rows = list.locator('.hud-item');
  await expect(rows).toHaveCount(HUD_ITEMS.length);
  for (const it of HUD_ITEMS) {
    await expect(page.getByTestId(`hud-${it}`)).toHaveAttribute('role', 'switch');
  }
  await expect(page.getByRole('switch', { name: /^Chord/ })).toBeChecked();
  await expect(list).toContainText('Dm7');
  // The rows each sit on their own line.
  const ys = await rows.evaluateAll((els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().y)),
  );
  expect(new Set(ys).size).toBe(HUD_ITEMS.length);

  // Keyboard, without Tab (macOS WebKit does not tab to buttons): focus + Enter (Space plays the
  // video preview).
  await tap(page, 'hud-none');
  await expect(button).toHaveText(/None/);
  await page.getByTestId('hud-chord').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('hud-chord')).toBeChecked();
  await setSwitch(page, 'hud-names', true);
  await expect(button).toHaveText(/2 readouts/);
  await clickExportForDownload(page);
  let opts = (await lastRequest(page))!.options;
  expect(opts.look!.hud).toEqual(['chord', 'names']);
  expect(opts.hud).toBe(true);

  // Each readout alone reaches the export.
  for (const it of HUD_ITEMS) {
    await tap(page, 'hud-none');
    await setSwitch(page, `hud-${it}`, true);
    await expect(button).toHaveText(/1 readout$/);
    await clickExportForDownload(page);
    opts = (await lastRequest(page))!.options;
    expect(opts.look!.hud, it).toEqual([it]);
  }

  // The row collapses it (Enter on the focused row), and expands it again.
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(list).toBeHidden();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(list).toBeVisible();
  // Default restores today's list.
  await tap(page, 'hud-default');
  await expect(button).toHaveText(/6 readouts/);
  await tap(page, 'look-hud-button');
  await expect(list).toBeHidden();
  await expect(button).toHaveText(/HUD · 6 readouts/);
});

test('HUD: reduced motion opens it at once; otherwise it animates its height', async ({ page }) => {
  await openExport(page);
  await pickVideo(page);
  const heights = () =>
    page.getByTestId('look-hud').evaluate(async (el) => {
      const out: number[] = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 400) {
        out.push(Math.round(el.getBoundingClientRect().height));
        await new Promise((r) => requestAnimationFrame(r));
      }
      return out;
    });
  await tap(page, 'look-hud-button');
  const swoop = await heights();
  // In between heights on the way to the full one.
  const full = swoop[swoop.length - 1];
  expect(full).toBeGreaterThan(200);
  expect(
    swoop.some((y) => y > 0 && y < full),
    String(swoop),
  ).toBe(true);
  await tap(page, 'look-hud-button');
  await expect(page.getByTestId('look-hud')).toBeHidden();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await tap(page, 'look-hud-button');
  const instant = await heights();
  expect(instant, `full ${full}`).toEqual(instant.map(() => full));
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
  await chooseSegment(page, 'look-guides', 'Lines + labels');
  await expect(page.getByTestId('look-guides')).toHaveAttribute('data-value', 'labels');
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
