/**
 * Pictures that open (PLAN.md §15 M17): a poster PNG and SVG, and an MP4, exported from the
 * workspace carry the whole piece (its background picture too). Each opens in a fresh browser
 * by Menu → Open and by dropping it on the page, into the Video workspace. A plain picture is
 * refused with a notice; picking a background picture in the Poster workspace still works.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { clickExportForDownload } from './export-diag';
import { openPoster, openVideoExport, surface, videoWorkspace } from './export-open';

interface Piece {
  meta: { title: string };
  voices: unknown[];
  poster?: { picture?: { src: string; w: number; h: number } };
  end?: { at: number; fade: number };
}
interface HookWindow {
  __algorhythms: {
    store: { getState(): { piece: Piece } };
    actions: { loadPiece(p: unknown): void };
  };
}

interface FileBytes {
  name: string;
  mime: string;
  bytes: Buffer;
}

const pieceOf = (page: Page) =>
  page.evaluate(() => (window as unknown as HookWindow).__algorhythms.store.getState().piece);

async function ready(page: Page, url: string): Promise<void> {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(url);
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
}

/** A new browser context (no storage shared with the maker's) on the app's start page. */
async function freshPage(browser: Browser, url: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await ready(page, url);
  return page;
}

async function download(page: Page, mime: string): Promise<FileBytes> {
  const dl = await clickExportForDownload(page, 180_000);
  return { name: dl.suggestedFilename(), mime, bytes: readFileSync(await dl.path()) };
}

async function openByMenu(page: Page, f: FileBytes): Promise<void> {
  await page.getByTestId('file-input').setInputFiles({
    name: f.name,
    mimeType: f.mime,
    buffer: f.bytes,
  });
}

/** Drops the file on the page, as the browser does for a file dragged in from the desktop. */
async function drop(page: Page, f: FileBytes, on = 'body'): Promise<void> {
  const dt = await page.evaluateHandle(
    ({ name, mime, b64 }) => {
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const t = new DataTransfer();
      t.items.add(new File([u], name, { type: mime }));
      return t;
    },
    { name: f.name, mime: f.mime, b64: f.bytes.toString('base64') },
  );
  await page.dispatchEvent(on, 'dragover', { dataTransfer: dt });
  await page.dispatchEvent(on, 'drop', { dataTransfer: dt });
}

/** The piece opened in the Video workspace, the same as the maker's, picture included. */
async function expectOpened(page: Page, made: Piece): Promise<void> {
  await expect(videoWorkspace(page)).toBeVisible();
  await expect.poll(async () => (await pieceOf(page)).meta.title).toBe(made.meta.title);
  const got = await pieceOf(page);
  expect(got.voices.length).toBe(made.voices.length);
  expect(got.poster?.picture?.src).toBe(made.poster?.picture?.src);
  expect(got.poster?.picture).toMatchObject({ w: 64, h: 36 });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await ready(page, './?example=little-round');
});

test('poster PNG and SVG carry the piece; each opens by Menu → Open and by a drop', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const start = new URL('./', page.url()).href;
  await openPoster(page);
  // A background picture, picked through its file input (as before M17).
  const green = await page.evaluate(async () => {
    const c = new OffscreenCanvas(64, 36);
    const g = c.getContext('2d')!;
    g.fillStyle = '#00c800';
    g.fillRect(0, 0, 64, 36);
    const bytes = new Uint8Array(
      await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer(),
    );
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  await page.getByTestId('bg-picture-file').setInputFiles({
    name: 'green.png',
    mimeType: 'image/png',
    buffer: Buffer.from(green, 'base64'),
  });
  await expect(page.getByTestId('bg-picture')).toHaveAttribute('data-set', 'yes');
  const made = await pieceOf(page);
  expect(made.poster?.picture).toMatchObject({ w: 64, h: 36 });

  const png = await download(page, 'image/png');
  expect(png.name).toMatch(/\.png$/);
  // Still a picture the browser decodes, its pixels the poster's.
  const decoded = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u], { type: 'image/png' }));
    return { w: bmp.width, h: bmp.height };
  }, png.bytes.toString('base64'));
  expect(decoded).toEqual({ w: 3840, h: 2160 });

  const svgRadio = surface(page).getByTestId('export-pformat').getByLabel('SVG', { exact: true });
  await svgRadio.click();
  await expect(svgRadio).toBeChecked();
  const svg = await download(page, 'image/svg+xml');
  expect(svg.name).toMatch(/\.svg$/);
  const text = svg.bytes.toString('utf8');
  expect(text).toContain('<metadata><algorhythms:piece');
  const parsed = await page.evaluate(
    (t) => new DOMParser().parseFromString(t, 'image/svg+xml').querySelector('parsererror'),
    text,
  );
  expect(parsed).toBeNull();

  for (const f of [png, svg]) {
    const viaMenu = await freshPage(browser, start);
    await openByMenu(viaMenu, f);
    await expectOpened(viaMenu, made);
    await viaMenu.context().close();

    const viaDrop = await freshPage(browser, start);
    await drop(viaDrop, f);
    await expectOpened(viaDrop, made);
    await viaDrop.context().close();
  }
});

test('an MP4 carries the piece and opens by a drop', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const start = new URL('./', page.url()).href;
  // A short piece keeps the export quick.
  await page.evaluate(() => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const p = structuredClone(h.store.getState().piece);
    p.end = { at: 3, fade: 1 };
    h.actions.loadPiece(p);
  });
  const made = await pieceOf(page);
  await openVideoExport(page);
  const mp4 = await download(page, 'video/mp4');
  expect(mp4.name).toMatch(/\.mp4$/);
  expect(mp4.bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
  // Still a file the browser plays.
  const duration = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const el = document.createElement('video');
    el.muted = true;
    el.src = URL.createObjectURL(new Blob([u], { type: 'video/mp4' }));
    await new Promise((resolve, reject) => {
      el.onloadedmetadata = resolve;
      el.onerror = () => reject(new Error(`video error ${el.error?.code}`));
    });
    return el.duration;
  }, mp4.bytes.toString('base64'));
  expect(duration).toBeGreaterThan(2);

  const other = await freshPage(browser, start);
  await drop(other, mp4);
  await expect(videoWorkspace(other)).toBeVisible();
  await expect.poll(async () => (await pieceOf(other)).end?.at).toBe(3);
  expect((await pieceOf(other)).meta.title).toBe(made.meta.title);
  await other.context().close();
});

test('a picture without a piece is refused with a notice', async ({ page }) => {
  const before = await pieceOf(page);
  const plain = await page.evaluate(async () => {
    const c = new OffscreenCanvas(8, 8);
    c.getContext('2d')!.fillRect(0, 0, 4, 4);
    const bytes = new Uint8Array(
      await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer(),
    );
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  const f = { name: 'plain.png', mime: 'image/png', bytes: Buffer.from(plain, 'base64') };
  await drop(page, f);
  await expect(page.getByTestId('notices')).toContainText(
    'This file has no AlgoRhythms piece in it',
  );
  await openByMenu(page, f);
  await expect(page.getByTestId('notices')).toContainText('plain.png');
  expect((await pieceOf(page)).meta.title).toBe(before.meta.title);
  await expect(videoWorkspace(page)).toBeHidden();
});
