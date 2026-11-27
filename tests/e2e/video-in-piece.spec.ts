/**
 * M17 W1 (PLAN.md §15 "The video in the piece"): a video edited in the Video workspace is stored
 * in the piece, so its share link and its watch link show the maker's video in a fresh browser
 * whose remembered options differ; each video edit is one undo step.
 */

import { expect, test, type Page } from '@playwright/test';
import { chooseSegment, setHudOpen, setSwitch } from './export-diag';
import { openVideoExport, seekPreview, videoWorkspace } from './export-open';
import type { PieceVideo } from '../../src/core/types';

interface HookWindow {
  __algorhythms: {
    store: { getState(): { piece: { video?: PieceVideo } } };
    editor: { undo(): boolean; redo(): boolean };
    encodeShareLink(piece: unknown): Promise<string>;
    encodeWatchLink(piece: unknown): Promise<string>;
  };
}

const video = (page: Page) =>
  page.evaluate(() => (window as unknown as HookWindow).__algorhythms.store.getState().piece.video);

/** Another viewer's remembered options: everything the maker's video sets, set otherwise. */
const OTHER_PREFS = {
  v: 4,
  videoAspect: '1:1',
  videoHud: [],
  videoTitleCard: false,
  videoEndCard: 0,
  videoFollowAt: 20,
  videoWindow: 4,
  look: { theme: 'light', guides: true, glow: 0.9 },
};

/** The preview canvas at clock time t, once it has drawn. */
async function previewAt(page: Page, t: number): Promise<string> {
  await seekPreview(page, t);
  const canvas = page.getByTestId('preview-canvas');
  await expect(canvas).toHaveAttribute('data-draws', /\d+/);
  let last = '';
  // Settled: two reads a moment apart agree (fonts, the runtime).
  await expect
    .poll(async () => {
      // The pixels (Firefox's PNGs carry a per-call text chunk, so not toDataURL).
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

async function makeVideo(page: Page): Promise<void> {
  await page.goto('./#kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openVideoExport(page);
  await chooseSegment(page, 'export-aspect', '9:16');
  await setHudOpen(page, true);
  await setSwitch(page, 'hud-spread', true);
  await setHudOpen(page, false);
  if ((await page.getByTestId('bookends-button').getAttribute('aria-expanded')) !== 'true') {
    await page.getByTestId('bookends-button').click();
  }
  await setSwitch(page, 'vb-title-card', true);
  await chooseSegment(page, 'vb-end-card', '10 s');
  await expect
    .poll(() => video(page))
    .toMatchObject({ aspect: '9:16', titleCard: true, endCard: 10 });
}

test('an edited video opens the same from its share and watch links in a browser with other options', async ({
  page,
  browser,
}) => {
  await makeVideo(page);
  const want = await video(page);
  expect(want?.hud).toContain('spread');
  const frame = await previewAt(page, 20);
  const [share, watch] = await page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const p = h.store.getState().piece;
    return [await h.encodeShareLink(p), await h.encodeWatchLink(p)];
  });
  expect(watch).toBe(share.replace('#p=', '#w&p='));

  const other = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    colorScheme: 'dark',
    viewport: page.viewportSize(),
  });
  await other.addInitScript((prefs) => {
    localStorage.setItem('algorhythms.export', JSON.stringify(prefs));
    localStorage.setItem('algorhythms.exportMode', 'poster');
  }, OTHER_PREFS);
  try {
    // The share link opens the editor; its Video shows the maker's video.
    const a = await other.newPage();
    await a.goto(share);
    await expect(a.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
    await expect(videoWorkspace(a)).toBeHidden();
    expect(await video(a)).toEqual(want);
    await openVideoExport(a);
    await expect(a.getByTestId('export-aspect').getByLabel('9:16', { exact: true })).toBeChecked();
    await expect(a.getByTestId('vb-end-card')).toHaveAttribute('data-value', '10');
    expect(await previewAt(a, 20)).toBe(frame);
    await a.close();

    // The watch link opens the Video workspace at once, the address bar on the editor link.
    const b = await other.newPage();
    await b.goto(watch);
    await expect(videoWorkspace(b)).toBeVisible();
    await expect.poll(() => b.evaluate(() => location.hash.startsWith('#p='))).toBe(true);
    expect(await video(b)).toEqual(want);
    expect(await previewAt(b, 20)).toBe(frame);
    await b.close();

    // An unedited example's watch link: #w&<id>.
    const c = await other.newPage();
    await c.goto('./#w&kite-day');
    await expect(videoWorkspace(c)).toBeVisible();
    await expect.poll(() => c.evaluate(() => location.hash)).toBe('#kite-day');
    await c.close();
  } finally {
    await other.close();
  }
});

test('each video edit is one undo step on the piece', async ({ page }) => {
  await page.goto('./#kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openVideoExport(page);
  expect(await video(page)).toBeUndefined();
  const undo = () =>
    page.evaluate(() => (window as unknown as HookWindow).__algorhythms.editor.undo());
  const redo = () =>
    page.evaluate(() => (window as unknown as HookWindow).__algorhythms.editor.redo());
  const aspect = (label: string) =>
    page.getByTestId('export-aspect').getByLabel(label, { exact: true });

  await chooseSegment(page, 'export-aspect', '1:1');
  await expect.poll(() => video(page)).toMatchObject({ aspect: '1:1' });
  await page.waitForTimeout(1100); // past the coalescing window
  if ((await page.getByTestId('bookends-button').getAttribute('aria-expanded')) !== 'true') {
    await page.getByTestId('bookends-button').click();
  }
  await setSwitch(page, 'vb-title-card', true);
  await expect.poll(() => video(page)).toMatchObject({ aspect: '1:1', titleCard: true });

  expect(await undo()).toBe(true);
  await expect.poll(async () => (await video(page))?.titleCard).toBeUndefined();
  await expect(page.getByTestId('vb-title-card')).not.toBeChecked();
  await expect(aspect('1:1')).toBeChecked();

  expect(await undo()).toBe(true);
  await expect.poll(() => video(page)).toBeUndefined();

  expect(await redo()).toBe(true);
  await expect.poll(() => video(page)).toMatchObject({ aspect: '1:1' });
  await expect(aspect('1:1')).toBeChecked();
});
