/**
 * M17 W2 (PLAN.md §15 "Watch view", "Phones", "Share"): a watch link or a dropped poster opens the
 * Video workspace filling the window, paused on the first frame with a large Play. Play plays
 * (and asks for fullscreen), the controls and keys work, Escape and leaving fullscreen land in
 * the Video workspace at the same time, Open the music in the editor, the end screen replays.
 * On a phone-sized touch screen it works by taps. Share's Opens to gives a watch link.
 * Fullscreen can't happen headless: `requestFullscreen` is stubbed and counted.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { clickExportForDownload } from './export-diag';
import { openPoster, openVideoExport, videoWorkspace } from './export-open';

interface HookWindow {
  __algorhythms: {
    store: { getState(): { piece: { meta: { title: string }; video?: unknown } } };
    encodeWatchLink(piece: unknown): Promise<string>;
  };
  __fsRequests?: number;
}

const watchView = (page: Page) => page.getByTestId('watch-view');
const canvas = (page: Page) => page.getByTestId('preview-canvas');
/** Seconds into the video (the preview's clock less its lead-in; the score's time without bookends). */
const tau = async (page: Page) => {
  const c = canvas(page);
  return Number((await c.getAttribute('data-tau')) ?? (await c.getAttribute('data-t')));
};

/** Before any page script: a counted `requestFullscreen`, and fullscreen offered. */
async function stubFullscreen(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => true });
    Element.prototype.requestFullscreen = function () {
      const w = window as unknown as { __fsRequests?: number };
      w.__fsRequests = (w.__fsRequests ?? 0) + 1;
      return Promise.resolve();
    };
  });
}

const fsRequests = (page: Page) =>
  page.evaluate(() => (window as unknown as HookWindow).__fsRequests ?? 0);

/**
 * A watch link for Kite Day with a short video: 10–20 s, a 2 s lead-in and a title card, so the
 * first frame is the lead-in's start (score time 8, data-tau 0).
 */
async function shortWatchLink(page: Page): Promise<string> {
  await page.goto('./#kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  return page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const p = structuredClone(h.store.getState().piece);
    p.video = { section: { start: 10, end: 20 }, leadIn: 2, titleCard: true };
    return h.encodeWatchLink(p);
  });
}

/** The watch view is up, paused on its first frame, drawn. */
async function expectFirstFrame(page: Page, t: string): Promise<void> {
  await expect(watchView(page)).toBeVisible();
  await expect(page.getByTestId('watch-big-play')).toBeVisible();
  await expect(canvas(page)).toHaveAttribute('data-draws', /\d+/);
  await expect(canvas(page)).toHaveAttribute('data-t', t);
  await expect(page.getByTestId('watch-play')).toHaveAttribute('data-playing', 'false');
}

async function freshContext(browser: Browser, page: Page, o = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin, ...o });
  await stubFullscreen(ctx);
  return ctx;
}

test('a watch link opens the watch view: play, controls, keys, Escape, Open the music, Replay', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const link = await shortWatchLink(page);
  expect(link).toContain('#w&p=');
  const ctx = await freshContext(browser, page, { viewport: page.viewportSize() });
  try {
    const w = await ctx.newPage();
    await w.goto(link);
    await expectFirstFrame(w, '10.000');
    await expect(canvas(w)).toHaveAttribute('data-tau', '0.000');
    await expect(w.getByTestId('watch-title')).toHaveText(/\S/);
    // The editor's chrome is hidden under it; the time reads from 0.
    await expect(w.getByTestId('menu-button')).toBeHidden();
    await expect(w.getByTestId('watch-time')).toHaveText(/^0:00 \/ 0:1\d$/);
    await expect(w.getByTestId('watch-big-play')).toBeFocused();
    await expect(w.getByRole('button', { name: 'Play the video' })).toBeVisible();
    await expect(w.getByRole('slider', { name: 'Seek' })).toBeVisible();
    await expect(w.getByRole('button', { name: 'Full screen' })).toBeVisible();

    // Play: the sound and fullscreen (asked once); the time moves.
    await w.getByTestId('watch-big-play').click();
    await expect(w.getByTestId('watch-play')).toHaveAttribute('data-playing', 'true');
    await expect(w.getByTestId('watch-big-play')).toHaveCount(0);
    await expect.poll(() => fsRequests(w)).toBe(1);
    await expect.poll(() => tau(w), { timeout: 15_000 }).toBeGreaterThan(0.5);

    // The controls hide while playing once the pointer rests; moving it shows them.
    await expect(watchView(w)).toHaveAttribute('data-controls', 'hidden', { timeout: 8_000 });
    await w.mouse.move(200, 200);
    await w.mouse.move(220, 210);
    await expect(watchView(w)).toHaveAttribute('data-controls', 'shown');

    // Space pauses; →/← seek 5 s.
    await w.keyboard.press('Space');
    await expect(w.getByTestId('watch-play')).toHaveAttribute('data-playing', 'false');
    const at = await tau(w);
    await w.keyboard.press('ArrowRight');
    await expect.poll(() => tau(w)).toBeCloseTo(at + 5, 1);
    await w.keyboard.press('ArrowLeft');
    await expect.poll(() => tau(w)).toBeCloseTo(at, 1);
    // The seek bar.
    await w.getByTestId('watch-seek').fill('3');
    await expect.poll(() => tau(w)).toBeCloseTo(3, 1);
    // F asks for fullscreen.
    await w.keyboard.press('f');
    await expect.poll(() => fsRequests(w)).toBe(2);

    // Escape: the Video workspace, at the same time.
    await w.keyboard.press('Escape');
    await expect(watchView(w)).toHaveCount(0);
    await expect(videoWorkspace(w)).toBeVisible();
    await expect(w.getByTestId('export-run')).toBeVisible();
    await expect(w.getByTestId('preview-play')).toBeVisible();
    expect(await tau(w)).toBeCloseTo(3, 1);
    await w.close();

    // The end screen: Replay plays from the start; Open the music opens the editor.
    const e = await ctx.newPage();
    await e.goto(link);
    await expectFirstFrame(e, '10.000');
    await e.getByTestId('watch-big-play').click();
    await expect(e.getByTestId('watch-play')).toHaveAttribute('data-playing', 'true');
    await e.keyboard.press('Space');
    await expect(e.getByTestId('watch-play')).toHaveAttribute('data-playing', 'false');
    for (let i = 0; i < 4; i++) await e.keyboard.press('ArrowRight');
    await expect(e.getByTestId('watch-end')).toBeVisible();
    await expect(e.getByTestId('watch-replay')).toBeFocused();
    await e.getByTestId('watch-replay').click();
    await expect(e.getByTestId('watch-end')).toHaveCount(0);
    await expect(e.getByTestId('watch-play')).toHaveAttribute('data-playing', 'true');
    expect(await tau(e)).toBeLessThan(3);
    await e.mouse.move(300, 300);
    await e.getByTestId('watch-open-music').click();
    await expect(videoWorkspace(e)).toHaveCount(0);
    await expect(e.getByTestId('timeline')).toBeVisible();
    await expect(e.getByTestId('menu-button')).toBeVisible();
    await e.close();

    // Leaving fullscreen (the browser's Escape) leaves the watch view.
    const f = await ctx.newPage();
    await f.goto('./#w&kite-day');
    await expectFirstFrame(f, '0.000');
    await f.getByTestId('watch-big-play').click();
    await expect.poll(() => fsRequests(f)).toBe(1);
    await f.evaluate(() => document.dispatchEvent(new Event('fullscreenchange')));
    await expect(watchView(f)).toHaveCount(0);
    await expect(videoWorkspace(f)).toBeVisible();
    await expect(f.getByTestId('preview-play')).toHaveAttribute('data-playing', 'false');
    await f.close();
  } finally {
    await ctx.close();
  }
});

test('a dropped poster PNG opens the watch view on the first frame', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.goto('./#kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openPoster(page);
  const dl = await clickExportForDownload(page, 120_000);
  const bytes = readFileSync(await dl.path());

  const ctx = await freshContext(browser, page);
  try {
    const other = await ctx.newPage();
    await other.goto('./');
    await expect(other.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
    const dt = await other.evaluateHandle((b64) => {
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const t = new DataTransfer();
      t.items.add(new File([u], 'kite-day.png', { type: 'image/png' }));
      return t;
    }, bytes.toString('base64'));
    await other.dispatchEvent('body', 'dragover', { dataTransfer: dt });
    await other.dispatchEvent('body', 'drop', { dataTransfer: dt });
    await expectFirstFrame(other, '0.000');
    await expect(other.getByTestId('watch-title')).toHaveText('Kite Day');
  } finally {
    await ctx.close();
  }
});

test.describe('on a phone', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('fills the window and plays by touch', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('./#w&kite-day');
    await expectFirstFrame(page, '0.000');
    // The stage fills the window; the video is as wide as the screen; no editor chrome.
    const box = await page.locator('.video-stage').boundingBox();
    expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
    expect((await canvas(page).boundingBox())?.width).toBeCloseTo(390, 0);
    await expect(page.getByTestId('menu-button')).toBeHidden();
    await expect(page.getByTestId('export-run')).toBeHidden();

    await page.getByTestId('watch-big-play').tap();
    await expect(page.getByTestId('watch-play')).toHaveAttribute('data-playing', 'true');
    await expect.poll(() => tau(page), { timeout: 15_000 }).toBeGreaterThan(0.3);
    // The controls go while playing; a tap brings them back, another hides them.
    await expect(watchView(page)).toHaveAttribute('data-controls', 'hidden', { timeout: 8_000 });
    await page.getByTestId('watch-surface').tap({ position: { x: 195, y: 300 } });
    await expect(watchView(page)).toHaveAttribute('data-controls', 'shown');
    await page.getByTestId('watch-play').tap();
    await expect(page.getByTestId('watch-play')).toHaveAttribute('data-playing', 'false');
    await page.getByTestId('watch-seek').fill('20');
    await expect.poll(() => tau(page)).toBeCloseTo(20, 1);
  });
});

test("Share's Opens to gives a watch link that opens the watch view", async ({ page, browser }) => {
  await page.goto('./#kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  const share = async () => {
    await page.getByTestId('menu-button').click();
    await page.getByTestId('open-share').click();
    const d = page.getByTestId('share-dialog');
    await expect(d.getByTestId('share-length')).toBeVisible();
    return d;
  };
  const opens = (label: string) =>
    page.getByTestId('share-opens-to').getByLabel(label, { exact: true });

  // From the editor: Music by default.
  let d = await share();
  await expect(opens('Music')).toBeChecked();
  const music = await d.getByTestId('share-link').inputValue();
  expect(music).toContain('#p=');
  await opens('Video').check();
  await expect(d.getByTestId('share-link')).toHaveValue(music.replace('#p=', '#w&p='));
  await d.getByTestId('share-close').click();

  // From the Video workspace: Video by default.
  await openVideoExport(page);
  d = await share();
  await expect(opens('Video')).toBeChecked();
  const watch = await d.getByTestId('share-link').inputValue();
  expect(watch).toContain('#w&p=');
  await d.getByTestId('share-close').click();

  const ctx = await freshContext(browser, page, { viewport: page.viewportSize() });
  try {
    const p = await ctx.newPage();
    await p.goto(watch);
    await expect(watchView(p)).toBeVisible();
    await expect(p.getByTestId('watch-big-play')).toBeVisible();
  } finally {
    await ctx.close();
  }
});
