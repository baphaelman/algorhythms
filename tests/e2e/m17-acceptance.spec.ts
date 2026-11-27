/**
 * M17 acceptance (PLAN.md §15 "Pieces that travel", Accept when; docs/m17-acceptance.md).
 * - A video edited in one browser (aspect, Follow window, a placed HUD readout, title and end
 *   cards, section, a poster edit) plays frame for frame the same in a fresh browser with other
 *   remembered options, opened from its watch link, a dropped PNG, SVG and MP4, and the watch
 *   link decoded from its poster's QR code; Escape lands in the Video workspace, Open the music
 *   in the editor; an SVG or MP4 without a piece is refused.
 * - Old pieces, files and links (made before M17) open in the editor with the viewer's options.
 * - The watch view plays by touch on a phone-sized WebKit (iPhone-like; WebKit projects only).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  chooseSegment,
  clickExportForDownload,
  setHudOpen,
  setRange,
  setSwitch,
} from './export-diag';
import { openVideoExport, seekPreview, surface, switchMode, videoWorkspace } from './export-open';
import type { Piece } from '../../src/core/types';
import type { PosterLayout, QrObject } from '../../src/render/poster-layout';
import type * as ExportRun from '../../src/app/export-run';
import type * as VideoExport from '../../src/app/video-export';

const SITE = 'https://baphaelman.github.io/algorhythms/';
const JSQR = createRequire(import.meta.url).resolve('jsqr/dist/jsQR.js');
const FIXTURES = new URL('./fixtures/', import.meta.url);

interface HookWindow {
  __algorhythms: {
    store: { getState(): { piece: Piece; transport: { status: string } } };
    posterWorkspace: {
      getState(): { layout: PosterLayout | null };
      setState(s: { selected: null }): void;
    };
    encodeWatchLink(p: Piece, o?: { base: string }): Promise<string>;
    context(): AudioContext | null;
    exportRun(): Promise<typeof ExportRun>;
    videoExport(): Promise<typeof VideoExport>;
  };
  jsQR(d: Uint8ClampedArray, w: number, h: number): { data: string } | null;
}

interface FileBytes {
  name: string;
  mime: string;
  bytes: Buffer;
}

/** The maker's remembered options: a small MP4 (a file setting) keeps the export quick. */
const MAKER_PREFS = { v: 4, videoSize: '720' };

/**
 * The watcher's: everything the maker's video sets, set otherwise; file settings other than
 * the size differ too (they stay the viewer's).
 */
const OTHER_PREFS = {
  v: 4,
  videoSize: '720',
  videoFps: 60,
  videoQuality: 'max',
  videoAspect: '1:1',
  videoCamera: 'whole',
  videoHud: [],
  videoTitleCard: false,
  videoEndCard: 0,
  videoFollowAt: 20,
  videoWindow: 4,
  look: { theme: 'light', guides: true, glow: 0.9 },
};

const pieceOf = (page: Page) =>
  page.evaluate(() => (window as unknown as HookWindow).__algorhythms.store.getState().piece);

const ready = (page: Page) => expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);

/** A fresh context (no storage shared) with the given remembered options and system theme. */
async function contextWith(
  browser: Browser,
  page: Page,
  prefs: object,
  colorScheme: 'light' | 'dark',
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    baseURL: new URL('./', page.url()).href,
    viewport: page.viewportSize(),
    colorScheme,
  });
  await ctx.addInitScript((prefs) => {
    localStorage.setItem('algorhythms.export', JSON.stringify(prefs));
    localStorage.setItem('algorhythms.exportMode', 'poster');
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  }, prefs);
  return ctx;
}

/** The canvas's pixels, once two reads a moment apart agree (fonts, the runtime). */
async function settledHash(page: Page): Promise<string> {
  const canvas = page.getByTestId('preview-canvas');
  await expect(canvas).toHaveAttribute('data-draws', /\d+/);
  let last = '';
  await expect
    .poll(async () => {
      const now = await canvas.evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let h = 2166136261;
        for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
        return `${c.width}x${c.height}:${h >>> 0}`;
      });
      const same = now === last;
      last = now;
      return same;
    })
    .toBe(true);
  return last;
}

/** The Video workspace's preview at each clock time. */
async function previewFrames(page: Page, ts: number[]): Promise<string[]> {
  const out: string[] = [];
  for (const t of ts) {
    await seekPreview(page, t);
    await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-t', t.toFixed(3));
    out.push(await settledHash(page));
  }
  return out;
}

/**
 * The export's own frames at each of `taus` (video seconds), with the options the preview last
 * drew with. Size and frame rate are file settings (the viewer's), so both are pinned.
 */
function exportFrames(page: Page, taus: number[]): Promise<string[]> {
  return page.evaluate(async (taus) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const req = (await h.exportRun()).lastPreviewRequest();
    if (req?.kind !== 'video') throw new Error('no video preview yet');
    const ve = await h.videoExport();
    const piece = h.store.getState().piece as Parameters<typeof ve.referenceFrame>[0];
    const o = { ...req.options, size: '720', fps: 30 } as Parameters<typeof ve.referenceFrame>[1];
    return taus.map((tau) => {
      const img = ve.referenceFrame(piece, o, Math.round(tau * 30));
      const d = img.data;
      let x = 2166136261;
      for (let i = 0; i < d.length; i++) x = Math.imul(x ^ d[i], 16777619);
      return `${img.width}x${img.height}:${x >>> 0}`;
    });
  }, taus);
}

async function download(page: Page, mime: string, timeout = 120_000): Promise<FileBytes> {
  const dl = await clickExportForDownload(page, timeout);
  return { name: dl.suggestedFilename(), mime, bytes: readFileSync(await dl.path()) };
}

/** Drops the file on the page, as the browser does for a file dragged in from the desktop. */
async function drop(page: Page, f: FileBytes): Promise<void> {
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
  await page.dispatchEvent('body', 'dragover', { dataTransfer: dt });
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
}

/** The QR code jsQR finds in the PNG round `box` (artboard px = PNG px), or null. */
async function decodePng(
  page: Page,
  png: Buffer,
  box: { x: number; y: number; w: number },
): Promise<string | null> {
  await page.addScriptTag({ path: JSQR });
  return page.evaluate(
    async ({ b64, box }) => {
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([u], { type: 'image/png' }));
      const pad = 60;
      const x = Math.max(0, Math.floor(box.x - pad));
      const y = Math.max(0, Math.floor(box.y - pad));
      const w = Math.min(bmp.width - x, Math.ceil(box.w + 2 * pad));
      const h = Math.min(bmp.height - y, Math.ceil(box.w + 2 * pad));
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d')!;
      g.drawImage(bmp, -x, -y);
      const img = g.getImageData(0, 0, w, h);
      return (window as unknown as HookWindow).jsQR(img.data, w, h)?.data ?? null;
    },
    { b64: png.toString('base64'), box },
  );
}

const qrObject = (page: Page) =>
  page.evaluate(() => {
    const L = (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().layout;
    const o = L?.objects.find((x) => x.type === 'qr') as QrObject | undefined;
    return o ? { box: o.box, state: o.state, link: o.link } : null;
  });

/** Clock times (score seconds; the section is 10–16 s) and video times compared. */
const CLOCK = [10, 13, 15.5];
const TAUS = [0.5, 4, 7, 12];

test('a video edited in one browser plays the same from its watch link, PNG, SVG, MP4 and QR code', async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('./');
  // The maker works in a context of their own, with known remembered options.
  const maker = await contextWith(browser, page, MAKER_PREFS, 'light');
  const m = await maker.newPage();
  await m.goto('./#kite-day');
  await ready(m);
  const here = new URL('./', m.url()).href;

  // Video: 9:16, Follow with a set window, a section, title and end cards, a readout moved.
  await openVideoExport(m);
  await chooseSegment(m, 'export-aspect', '9:16');
  await chooseSegment(m, 'export-camera', 'Follow');
  await setRange(m, 'export-window', 300);
  await chooseSegment(m, 'export-section', 'Custom');
  for (const [id, v] of [
    ['section-start-text', '10'],
    ['section-end-text', '16'],
  ] as const) {
    await m.getByTestId(id).fill(v);
    await m.getByTestId(id).press('Enter');
  }
  if ((await m.getByTestId('bookends-button').getAttribute('aria-expanded')) !== 'true') {
    await m.getByTestId('bookends-button').click();
  }
  const title = m.getByTestId('vb-title-card');
  if (!(await title.isChecked())) await title.click();
  await expect(title).toBeChecked();
  await chooseSegment(m, 'vb-end-card', '5 s');
  // One readout (the time), moved (six fit a QR code too since positions are canonical).
  await setHudOpen(m, true);
  for (const it of ['formula', 'notes', 'chord', 'key', 'hz'])
    await setSwitch(m, `hud-${it}`, false);
  await setSwitch(m, 'hud-time', true);
  await setHudOpen(m, false);
  const readout = m.getByTestId('hud-box-time');
  await expect(m.getByTestId('hud-overlay').locator('.hud-box')).toHaveCount(1);
  await readout.focus();
  await m.keyboard.press('Shift+ArrowUp');
  await m.keyboard.press('Shift+ArrowRight');
  await expect
    .poll(async () => (await pieceOf(m)).video)
    .toMatchObject({
      aspect: '9:16',
      section: { start: 10, end: 16 },
      titleCard: true,
      endCard: 5,
      window: expect.any(Number),
      hud: ['time'],
      hudLayout: { time: expect.any(Object) },
    });

  // A poster edit: the QR code (it holds the watch link); then PNG and SVG.
  await switchMode(m, 'Poster');
  await expect(m.getByTestId('export-run')).toBeEnabled();
  // The link with the code (and the poster settings it seeds) fits a code that scans easily.
  await expect(m.getByTestId('tool-qr')).toBeEnabled();
  await m.getByTestId('tool-qr').click();
  await expect.poll(async () => (await qrObject(m))?.state).toBe('ok');
  expect((await pieceOf(m)).poster?.qr).toEqual({});
  const code = (await qrObject(m))!;
  const png = await download(m, 'image/png');
  expect(png.name).toMatch(/\.png$/);
  // Nothing selected: the panel shows the file's settings again.
  await m.evaluate(() =>
    (window as unknown as HookWindow).__algorhythms.posterWorkspace.setState({ selected: null }),
  );
  const svgRadio = surface(m).getByTestId('export-pformat').getByLabel('SVG', { exact: true });
  await svgRadio.click({ timeout: 10_000 });
  await expect(svgRadio).toBeChecked();
  const svg = await download(m, 'image/svg+xml');
  expect(svg.name).toMatch(/\.svg$/);

  // MP4, then the maker's frames.
  // Back in Video (a poster setting rewrote the doc): the code stays.
  await switchMode(m, 'Video');
  expect((await pieceOf(m)).poster?.qr).toEqual({});
  const mp4 = await download(m, 'video/mp4', 240_000);
  expect(mp4.name).toMatch(/\.mp4$/);
  const made = await pieceOf(m);
  const want = { preview: await previewFrames(m, CLOCK), export: await exportFrames(m, TAUS) };
  expect(new Set(want.export).size).toBeGreaterThan(2);

  // The watch link, and the one in the poster's QR code (on the public site).
  const watch = await m.evaluate(
    (p) => (window as unknown as HookWindow).__algorhythms.encodeWatchLink(p),
    made,
  );
  expect(watch).toContain('#w&p=');
  const decoded = await decodePng(m, png.bytes, code.box);
  expect(decoded).toBe(code.link);
  expect(decoded!.startsWith(`${SITE}#w&p=`)).toBe(true);
  expect(decoded!.slice(SITE.length)).toBe(watch.slice(watch.indexOf('#')));
  await maker.close();

  const other = await contextWith(browser, m, OTHER_PREFS, 'dark');
  const sources: [string, (p: Page) => Promise<void>][] = [
    ['watch link', (p) => p.goto(watch).then(() => undefined)],
    ['PNG', (p) => drop(p, png)],
    ['SVG', (p) => drop(p, svg)],
    ['MP4', (p) => drop(p, mp4)],
    ['QR code', (p) => p.goto(decoded!.replace(SITE, here)).then(() => undefined)],
  ];
  let watchFirst: string | null = null;
  try {
    for (const [i, [what, open]] of sources.entries()) {
      const p = await other.newPage();
      if (what !== 'watch link' && what !== 'QR code') {
        await p.goto('./');
        await ready(p);
      }
      await open(p);
      await expect(p.getByTestId('watch-view'), what).toBeVisible();
      await expect(p.getByTestId('watch-big-play'), what).toBeVisible();
      await expect
        .poll(async () => (await pieceOf(p)).meta.title, { message: what })
        .toBe(made.meta.title);
      const got = await pieceOf(p);
      expect(got.video, what).toEqual(made.video);
      expect(got.poster, what).toEqual(made.poster);
      // The watch view's first frame is the same from every source.
      const first = await settledHash(p);
      watchFirst ??= first;
      expect(first, `${what}: first frame`).toBe(watchFirst);
      expect(await exportFrames(p, TAUS), `${what}: export frames`).toEqual(want.export);
      if (i < sources.length - 1) {
        // Escape: the Video workspace, whose preview is the maker's.
        await p.keyboard.press('Escape');
        await expect(p.getByTestId('watch-view')).toHaveCount(0);
        await expect(videoWorkspace(p)).toBeVisible();
        await expect(p.getByTestId('export-run')).toBeVisible();
        expect(await previewFrames(p, CLOCK), `${what}: preview`).toEqual(want.preview);
      } else {
        // Open the music: the editor.
        await p.mouse.move(300, 300);
        await p.getByTestId('watch-open-music').click();
        await expect(p.getByTestId('watch-view')).toHaveCount(0);
        await expect(videoWorkspace(p)).toHaveCount(0);
        await expect(p.getByTestId('timeline')).toBeVisible();
        await expect(p.getByTestId('menu-button')).toBeVisible();
      }
      await p.close();
    }

    // The same SVG and MP4 without their piece are refused with a message.
    const p = await other.newPage();
    await p.goto('./#kite-day');
    await ready(p);
    const bare = svg.bytes.toString('utf8').replace(/<metadata>[\s\S]*?<\/metadata>/, '');
    expect(bare).not.toContain('algorhythms:piece');
    const mp4Bare = Buffer.from(mp4.bytes);
    const at = mp4Bare.indexOf('algr', 0, 'latin1');
    expect(at).toBeGreaterThan(0);
    mp4Bare.write('free', at, 'latin1');
    for (const f of [
      { ...svg, name: 'bare.svg', bytes: Buffer.from(bare, 'utf8') },
      { ...mp4, name: 'bare.mp4', bytes: mp4Bare },
    ]) {
      await drop(p, f);
      await expect(p.getByTestId('notices')).toContainText(
        'This file has no AlgoRhythms piece in it',
      );
      await expect(p.getByTestId('watch-view')).toHaveCount(0);
      expect((await pieceOf(p)).meta.title).toBe('Kite Day');
      expect((await pieceOf(p)).video).toBeUndefined();
    }
  } finally {
    await other.close();
  }
});

test("the corner's Edit video lands in the Video workspace; the end screen's Open the music in the editor", async ({
  page,
}) => {
  await page.goto('./#w&kite-day');
  await expect(page.getByTestId('watch-big-play')).toBeVisible();
  await page.mouse.move(300, 300);
  await page.getByTestId('watch-edit-video').click();
  await expect(page.getByTestId('watch-view')).toHaveCount(0);
  await expect(videoWorkspace(page)).toBeVisible();
  await expect(page.getByTestId('export-run')).toBeVisible();

  await page.goto('./#w&kite-day');
  await expect(page.getByTestId('watch-big-play')).toBeVisible();
  // The end screen shows once the video has played.
  await page.getByTestId('watch-big-play').click();
  await expect(page.getByTestId('watch-play')).toHaveAttribute('data-playing', 'true');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('watch-play')).toHaveAttribute('data-playing', 'false');
  const seek = page.getByTestId('watch-seek');
  await seek.fill((await seek.getAttribute('max'))!);
  await expect(page.getByTestId('watch-end')).toBeVisible();
  await page.getByTestId('watch-end-music').click();
  await expect(page.getByTestId('watch-view')).toHaveCount(0);
  await expect(videoWorkspace(page)).toHaveCount(0);
  await expect(page.getByTestId('timeline')).toBeVisible();
});

test.describe('old pieces, files and links open as before M17', () => {
  /** In the editor, no record: Video shows the viewer's remembered options; it plays. */
  async function asBefore(p: Page, title: string): Promise<void> {
    await ready(p);
    await expect(p.getByTestId('watch-view')).toHaveCount(0);
    await expect(videoWorkspace(p)).toHaveCount(0);
    await expect(p.getByTestId('timeline')).toBeVisible();
    const piece = await pieceOf(p);
    expect(piece.meta.title).toBe(title);
    expect(piece.video).toBeUndefined();
    expect(piece.poster).toBeUndefined();
    await p.getByTestId('play').click();
    await expect
      .poll(() =>
        p.evaluate(
          () => (window as unknown as HookWindow).__algorhythms.store.getState().transport.status,
        ),
      )
      .toBe('playing');
    await expect(p.getByTestId('time')).not.toHaveText('00:00.0', { timeout: 10_000 });
    await p.getByTestId('play').click();
    await openVideoExport(p);
    await expect(p.getByTestId('export-aspect').getByLabel('1:1', { exact: true })).toBeChecked();
    await expect(p.getByTestId('vb-end-card')).toHaveAttribute('data-value', '0');
    expect((await pieceOf(p)).video).toBeUndefined();
  }

  test('an old .algorhythms.json, an old #p= link and an #<example-id> link', async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await page.goto('./');
    const ctx = await contextWith(browser, page, OTHER_PREFS, 'dark');
    try {
      // A file saved before M17 (examples/tidewater-hymn at f582c4a), by Menu → Open.
      const file = await ctx.newPage();
      await file.goto('./#kite-day');
      await ready(file);
      const json = readFileSync(new URL('pre-m17-tidewater-hymn.algorhythms.json', FIXTURES));
      expect(json.toString('utf8')).not.toMatch(/"(video|poster)"/);
      await file.getByTestId('file-input').setInputFiles({
        name: 'tidewater-hymn.algorhythms.json',
        mimeType: 'application/json',
        buffer: json,
      });
      await expect.poll(async () => (await pieceOf(file)).meta.title).toBe('Tidewater Hymn');
      await asBefore(file, 'Tidewater Hymn');
      await file.close();

      // A share link made by the code before M17 (f582c4a's encodeShareLink, same piece).
      const old = readFileSync(new URL('pre-m17-tidewater-hymn.link.txt', FIXTURES), 'utf8').trim();
      expect(old).toMatch(/^#p=2\./);
      const link = await ctx.newPage();
      await link.goto(`./${old}`);
      await asBefore(link, 'Tidewater Hymn');
      await link.close();

      const example = await ctx.newPage();
      await example.goto('./#kite-day');
      await asBefore(example, 'Kite Day');
      await example.close();
    } finally {
      await ctx.close();
    }
  });
});

test.describe('on a phone-sized WebKit', () => {
  // WebKit only (CI's macOS runner): an iPhone-like screen, touch, mobile viewport.
  test.skip(({ browserName }) => browserName !== 'webkit', 'WebKit projects only');
  test.use({
    viewport: { width: 390, height: 664 },
    screen: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });

  test('the watch view fills the window and plays by touch', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('./#w&kite-day');
    await expect(page.getByTestId('watch-view')).toBeVisible();
    await expect(page.getByTestId('watch-big-play')).toBeVisible();
    await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-draws', /\d+/);
    const vp = page.viewportSize()!;
    const box = await page.locator('.video-stage').boundingBox();
    expect(box).toMatchObject({ x: 0, y: 0, width: vp.width, height: vp.height });
    await expect(page.getByTestId('menu-button')).toBeHidden();
    await page.getByTestId('watch-big-play').tap();
    await expect(page.getByTestId('watch-play')).toHaveAttribute('data-playing', 'true');
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as HookWindow).__algorhythms.context()?.state),
      )
      .toBe('running');
    const tau = async () => Number(await page.getByTestId('preview-canvas').getAttribute('data-t'));
    await expect.poll(tau, { timeout: 15_000 }).toBeGreaterThan(0.3);
    await expect(page.getByTestId('watch-view')).toHaveAttribute('data-controls', 'hidden', {
      timeout: 8_000,
    });
    await page.getByTestId('watch-surface').tap({ position: { x: 195, y: 300 } });
    await expect(page.getByTestId('watch-view')).toHaveAttribute('data-controls', 'shown');
    await page.getByTestId('watch-play').tap();
    await expect(page.getByTestId('watch-play')).toHaveAttribute('data-playing', 'false');
    await page.getByTestId('watch-seek').fill('20');
    await expect.poll(tau).toBeCloseTo(20, 0);
  });
});
