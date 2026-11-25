/**
 * The Export dialog (PLAN.md §12, §15 M3): WAV, MIDI (one file and a zip) and stems, from the menu
 * to the downloaded file, with the files' headers checked; stems streamed to a (stubbed, user-
 * activation-checking) save picker; cancel; keyboard use; the phone layout.
 */

import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { expect, test, type Download, type Page } from '@playwright/test';
import { openAudioExport } from './export-open';
import { clickExportForDownload } from './export-diag';
import { parseWavHeader } from '../../src/audio/wav';
import { generate } from '../../src/core/generate';
import './app-hook';

/** The workspace's Video mode (M15: the old Export dialog's place). */
const dialog = (page: Page) => page.getByTestId('video-workspace');

/** Menu → Export audio… (M14); the exporter loads on demand, the button is enabled once it has. */
const openExport = openAudioExport;

async function pickFormat(page: Page, label: 'WAV' | 'Stems' | 'MIDI'): Promise<void> {
  await dialog(page).getByTestId('export-format').getByLabel(label, { exact: true }).check();
}

async function choose(page: Page, testId: string, label: string): Promise<void> {
  await dialog(page).getByTestId(testId).getByLabel(label, { exact: true }).check();
}

/** Loads a short version of the featured piece, so renders are quick. */
async function loadShortPiece(page: Page, seconds = 6): Promise<void> {
  await page.evaluate((at) => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      end: { at: number; fade: number };
    };
    p.end = { at, fade: 1 };
    h.actions.loadPiece(p);
  }, seconds);
}

/** Opens a fixture piece with many voices (the old Generate's dorian 2:30 piece, seed 77). */
async function openManyVoices(page: Page, voices: number): Promise<void> {
  const piece = generate(77, { mode: 'dorian', voices, density: 0.45, length: 150 });
  await page.evaluate((p) => window.__algorhythms!.actions.loadPiece(p), piece);
  await expect(page.getByTestId('keyvoices')).toContainText(`/ ${voices} notes`);
}

async function exportAndDownload(page: Page): Promise<{ name: string; bytes: Uint8Array }> {
  const download = await clickExportForDownload(page);
  return read(download);
}

async function read(d: Download): Promise<{ name: string; bytes: Uint8Array }> {
  const path = await d.path();
  return { name: d.suggestedFilename(), bytes: new Uint8Array(readFileSync(path)) };
}

/** Index of the first occurrence of `needle` in `hay`, or -1. */
function findBytes(hay: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const ascii = (b: Uint8Array, from: number, n: number): string =>
  String.fromCharCode(...b.subarray(from, from + n));

test.beforeEach(async ({ page }) => {
  // Download path everywhere: the real picker would open a native dialog.
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test('is a live menu item that opens a labelled dialog', async ({ page }) => {
  await page.getByTestId('menu-button').click();
  await expect(page.getByTestId('open-export-audio')).toBeEnabled();
  await page.getByTestId('open-export-audio').click();
  const d = page.getByRole('dialog', { name: 'Export audio' });
  await expect(d).toBeVisible();
  for (const label of [
    'WAV',
    'Stems',
    'MIDI',
    '16-bit',
    '24-bit',
    '32-bit float',
    '44.1 kHz',
    '48 kHz',
  ]) {
    await expect(d.getByLabel(label, { exact: true })).toBeVisible();
  }
  // Defaults: WAV, 32-bit float, 48 kHz; the exact size is shown.
  await expect(d.getByLabel('WAV', { exact: true })).toBeChecked();
  await expect(d.getByLabel('32-bit float', { exact: true })).toBeChecked();
  await expect(page.getByTestId('export-size')).toContainText(/About \d+(\.\d+)? MB/);
});

test('exports a WAV with the chosen depth and rate', async ({ page }) => {
  await loadShortPiece(page);
  await openExport(page);
  await choose(page, 'export-depth', '16-bit');
  await choose(page, 'export-rate', '44.1 kHz');
  const sizeText = await page.getByTestId('export-size').innerText();

  const { name, bytes } = await exportAndDownload(page);
  expect(name).toBe('Tidewater-Hymn.wav');
  const info = parseWavHeader(bytes);
  expect(info).toMatchObject({ channels: 2, sampleRate: 44100, bitDepth: 16, formatTag: 1 });
  expect(info.frames / info.sampleRate).toBeGreaterThan(6);
  // The size shown beforehand is the file's size (to the displayed precision).
  const shown = Number(/About ([\d.]+) MB/.exec(sizeText)![1]);
  expect(Math.abs(bytes.byteLength / 1e6 - shown)).toBeLessThan(0.06);
  await expect(page.getByTestId('export-message')).toContainText(/Saved Tidewater-Hymn\.wav/);

  // 32-bit float has its own format tag.
  await choose(page, 'export-depth', '32-bit float');
  await choose(page, 'export-rate', '48 kHz');
  const f = await exportAndDownload(page);
  expect(parseWavHeader(f.bytes)).toMatchObject({ sampleRate: 48000, bitDepth: 32, formatTag: 3 });
});

test('exports one MIDI file, and a zip when MPE needs several', async ({ page }) => {
  await loadShortPiece(page);
  await openExport(page);
  await pickFormat(page, 'MIDI');
  // No size line for MIDI; the bend range is ±24 by default.
  await expect(dialog(page).getByLabel('±24', { exact: true })).toBeChecked();
  await choose(page, 'export-bend', '±12');
  await dialog(page).getByTestId('export-cc11').check();
  const one = await exportAndDownload(page);
  expect(one.name).toBe('Tidewater-Hymn.mid');
  expect(ascii(one.bytes, 0, 4)).toBe('MThd');
  expect((one.bytes[8] << 8) | one.bytes[9]).toBe(1); // type-1
  expect((one.bytes[12] << 8) | one.bytes[13]).toBe(960); // PPQ
  // RPN 0 (CC 101 = 0, CC 100 = 0) then data entry CC 6 = 12 semitones opens a track.
  const at = findBytes(one.bytes, [0x65, 0x00]);
  expect(at).toBeGreaterThan(0);
  expect(findBytes(one.bytes.subarray(at, at + 16), [0x06, 0x0c])).toBeGreaterThan(0);

  // Notes only: its own file name.
  await choose(page, 'export-midi-mode', 'Notes only');
  await expect(dialog(page).getByTestId('export-bend').getByLabel('±12')).toBeDisabled();
  expect((await exportAndDownload(page)).name).toBe('Tidewater-Hymn-notes.mid');

  // MPE with more than 15 voices: several files, zipped.
  await page.keyboard.press('Escape');
  await openManyVoices(page, 20);
  await openExport(page);
  await pickFormat(page, 'MIDI');
  await choose(page, 'export-midi-mode', 'MPE');
  await expect(dialog(page).getByLabel('±48', { exact: true })).toBeChecked();
  const zipped = await exportAndDownload(page);
  expect(zipped.name).toMatch(/-midi\.zip$/);
  expect(ascii(zipped.bytes, 0, 2)).toBe('PK');
  const files = unzipSync(zipped.bytes);
  const names = Object.keys(files).sort();
  expect(names.length).toBe(2);
  for (const n of names) {
    expect(n).toMatch(/-mpe-\d\.mid$/);
    expect(ascii(files[n], 0, 4)).toBe('MThd');
  }
});

test('exports stems as a zip download, with the size shown beforehand', async ({ page }) => {
  await loadShortPiece(page);
  await openExport(page);
  await pickFormat(page, 'Stems');
  await choose(page, 'export-depth', '16-bit');
  await choose(page, 'export-rate', '44.1 kHz');
  await dialog(page).getByTestId('export-mono').check();
  const sizeText = await page.getByTestId('export-size').innerText();
  const m = /(\d+) files, ([\d.]+) MB zipped/.exec(sizeText);
  expect(m, sizeText).not.toBeNull();
  await expect(page.getByTestId('export-large')).toHaveCount(0);

  const { name, bytes } = await exportAndDownload(page);
  expect(name).toBe('Tidewater-Hymn-stems.zip');
  expect(Math.abs(bytes.byteLength / 1e6 - Number(m![2]))).toBeLessThan(0.06);
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  expect(names).toHaveLength(Number(m![1]));
  expect(names[0]).toBe('mix.wav');
  expect(names.at(-1)).toBe('fx-returns.wav');
  expect(names.length).toBeGreaterThanOrEqual(3);
  expect(parseWavHeader(files['mix.wav'])).toMatchObject({
    channels: 2,
    bitDepth: 16,
    sampleRate: 44100,
  });
  for (const n of names.slice(1)) {
    expect(parseWavHeader(files[n])).toMatchObject({
      channels: 1,
      bitDepth: 16,
      sampleRate: 44100,
    });
  }
  await expect(page.getByTestId('export-message')).toContainText('to your downloads');
});

test('streams stems straight to a file picked in the save dialog (Chromium)', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'File System Access API');
  // A picker stub backed by OPFS that, like the real one, needs a user gesture.
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).showSaveFilePicker = async (o: {
      suggestedName: string;
    }) => {
      if (!navigator.userActivation.isActive) throw new DOMException('no gesture', 'SecurityError');
      (window as unknown as Record<string, unknown>).__picked = o.suggestedName;
      const root = await navigator.storage.getDirectory();
      return root.getFileHandle(o.suggestedName, { create: true });
    };
  });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await loadShortPiece(page);
  await openExport(page);
  await pickFormat(page, 'Stems');
  await choose(page, 'export-depth', '16-bit');
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByTestId('export-run').click();
  await expect(page.getByTestId('export-message')).toContainText(
    /^Saved Tidewater-Hymn-stems\.zip/,
    {
      timeout: 60_000,
    },
  );
  await expect(page.getByTestId('export-message')).not.toContainText('downloads');
  expect(downloads).toBe(0);
  const saved = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const f = await (await root.getFileHandle('Tidewater-Hymn-stems.zip')).getFile();
    const head = new Uint8Array(await f.slice(0, 2).arrayBuffer());
    return {
      picked: (window as unknown as { __picked: string }).__picked,
      size: f.size,
      head: [...head],
    };
  });
  expect(saved.picked).toBe('Tidewater-Hymn-stems.zip');
  expect(saved.head).toEqual([0x50, 0x4b]);
  expect(saved.size).toBeGreaterThan(100_000);
});

test('cancel stops a running stems export and leaves the dialog usable', async ({ page }) => {
  await openManyVoices(page, 24); // a long piece: many files, so it is still running when cancelled
  await openExport(page);
  await pickFormat(page, 'Stems');
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByTestId('export-run').click();
  await expect(page.getByTestId('export-progress')).toBeVisible();
  await expect(page.getByTestId('export-run')).toBeDisabled();
  await expect(page.getByTestId('export-cancel')).toBeVisible();
  await expect(page.getByTestId('export-status')).toContainText(/\d+%/, { timeout: 30_000 });
  await page.getByTestId('export-cancel').click();
  await expect(page.getByTestId('export-message')).toHaveText('Export cancelled.');
  await expect(page.getByTestId('export-progress')).toHaveCount(0);
  await expect(page.getByTestId('export-run')).toBeEnabled();
  await page.waitForTimeout(500);
  expect(downloads).toBe(0);
  expect(await page.evaluate(() => window.__algorhythms!.store.getState().notices.length)).toBe(0);

  // And a MIDI export still works afterwards.
  await pickFormat(page, 'MIDI');
  expect((await exportAndDownload(page)).name).toMatch(/\.mid$/);
});

test('Escape cancels a running export; the dialog is keyboard operable', async ({ page }) => {
  await openManyVoices(page, 24);
  await openExport(page);
  // Arrow keys move through a radio group; focus starts inside the dialog.
  await dialog(page).getByLabel('WAV', { exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog(page).getByLabel('Stems', { exact: true })).toBeChecked();
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByTestId('export-run').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('export-progress')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('export-dialog')).toBeHidden();
  await expect(page.getByTestId('menu-button')).toBeFocused();
  await page.waitForTimeout(500);
  expect(downloads).toBe(0);
  // Reopening shows a clean, enabled dialog.
  await openExport(page);
  await expect(page.getByTestId('export-run')).toBeEnabled();
  await expect(page.getByTestId('export-progress')).toHaveCount(0);
});

test('warns above 1 GB and says how to shrink it', async ({ page }) => {
  await openManyVoices(page, 32);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      end: { at: number; fade: number };
    };
    p.end = { at: 200, fade: 4 };
    h.actions.loadPiece(p);
  });
  await openExport(page);
  await pickFormat(page, 'Stems');
  await expect(page.getByTestId('export-large')).toBeVisible();
  await expect(page.getByTestId('export-large')).toContainText(/over 1 GB/);
  await expect(page.getByTestId('export-large')).toContainText(/memory/);
  await dialog(page).getByTestId('export-mono').check();
  await choose(page, 'export-depth', '16-bit');
  await choose(page, 'export-rate', '44.1 kHz');
  await expect(page.getByTestId('export-large')).toHaveCount(0);
});

test('fits a phone screen in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 640 });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await openExport(page);
    await pickFormat(page, 'MIDI');
    const box = (await dialog(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(640);
    const noOverflow = await dialog(page).evaluate((el) => el.scrollWidth <= el.clientWidth);
    expect(noOverflow).toBe(true);
    const colors = await dialog(page).evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, fg: cs.color };
    });
    expect(colors.bg).not.toBe(colors.fg);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  }
});
