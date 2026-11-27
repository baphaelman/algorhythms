/**
 * The poster's QR code (PLAN.md §15 M17 "QR code"): added from the tool row, it is selected,
 * moved, resized (square), deleted and undone like a text box. The exported PNG's code decodes
 * (jsQR in the page) to the piece's watch link on the public site (an unedited example's short
 * `#w&<id>&f=poster`: its maker's video is Over the poster; an edited piece's `#w&p=…`), and that
 * link, opened on this server in a fresh browser, shows the watch view in that frame; a plain
 * `#w&<id>` still plays One row. A piece whose watch link is too long can't add one; a code whose link grows too long shows "too long to scan" and is left out of the PNG.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { clickExportForDownload } from './export-diag';
import { openPoster } from './export-open';
import type { Piece } from '../../src/core/types';
import type { PosterLayout, QrObject } from '../../src/render/poster-layout';

const SITE = 'https://baphaelman.github.io/algorhythms/';
const JSQR = createRequire(import.meta.url).resolve('jsqr/dist/jsQR.js');

interface HookWindow {
  __algorhythms: {
    posterWorkspace: { getState(): { layout: PosterLayout | null; selected: unknown } };
    store: { getState(): { piece: Piece } };
    actions: { setPiece(p: unknown): void };
    editor: { undo(): boolean };
    encodeWatchLink(p: Piece, o: { base: string }): Promise<string>;
  };
  jsQR(
    d: Uint8ClampedArray,
    w: number,
    h: number,
  ): {
    data: string;
  } | null;
}

const qr = (page: Page) =>
  page.evaluate(() => {
    const L = (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().layout;
    const o = L?.objects.find((x) => x.type === 'qr') as QrObject | undefined;
    return o ? { box: o.box, state: o.state, link: o.link, n: o.matrix?.n ?? 0 } : null;
  });
/** The video frame the open piece plays (as `pieceVideoFrame`). */
const frameOf = (page: Page) =>
  page.evaluate(() => {
    const p = (window as unknown as HookWindow).__algorhythms.store.getState().piece;
    return p.camera?.frame ?? (p.poster ? 'poster' : 'row');
  });
const stored = (page: Page) =>
  page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.store.getState().piece.poster?.qr,
  );
const selected = (page: Page) =>
  page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().selected,
  );
const undo = (page: Page) =>
  page.evaluate(() => (window as unknown as HookWindow).__algorhythms.editor.undo());

/** Artboard px → page px. */
async function toPage(page: Page, x: number, y: number) {
  const b = (await page.getByTestId('artboard-overlay').boundingBox())!;
  const W = Number(await page.getByTestId('artboard-overlay').getAttribute('data-width'));
  const k = b.width / W;
  return { x: b.x + x * k, y: b.y + y * k, k };
}

async function open(page: Page, example: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`./?example=${example}`);
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openPoster(page);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => !!(window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().layout,
        ),
    )
    .toBe(true);
}

/**
 * The QR codes jsQR finds in a PNG (bytes), in a crop round `box` (artboard px = PNG px), or
 * null when it finds none.
 */
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

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name.endsWith('-prod'), 'editing: once per engine');
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
});

test('add, select, move, resize (square), delete, undo', async ({ page }) => {
  await open(page, 'kite-day');
  const button = page.getByTestId('tool-qr');
  await expect(button).toBeEnabled();
  await expect(page.getByTestId('qr-too-long')).toHaveCount(0);
  await button.click();
  await expect.poll(async () => (await qr(page))?.state).toBe('ok');
  expect(await stored(page)).toEqual({});
  expect(await selected(page)).toEqual({ kind: 'qr' });
  await expect(page.getByTestId('selection-title')).toHaveText('QR code');
  await expect(page.getByTestId('qr-what')).toContainText('Opens the piece to watch');
  await expect(page.getByTestId('handle-se')).toHaveCount(1);
  const a = (await qr(page))!;
  // Bottom right inside the margins.
  const L = await page.evaluate(
    () =>
      (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().layout!.content,
  );
  expect(a.box.x + a.box.w).toBeLessThanOrEqual(L.x + L.w + 1);
  expect(a.box.y + a.box.h).toBeLessThanOrEqual(L.y + L.h + 1);
  expect(a.box.x + a.box.w).toBeGreaterThan(L.x + L.w - 10);

  // Move: one drag.
  const p = await toPage(page, a.box.x + a.box.w / 2, a.box.y + a.box.h / 2);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x - 100, p.y - 50, { steps: 4 });
  await page.mouse.move(p.x - 200, p.y - 100, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await qr(page))?.box.x ?? 0).toBeLessThan(a.box.x - 100);
  expect((await stored(page))?.box).toBeDefined();

  // Resize from a corner: it stays square.
  const h = (await page.getByTestId('handle-nw').boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x - 40, h.y - 10, { steps: 3 });
  await page.mouse.move(h.x - 80, h.y - 20, { steps: 3 });
  await page.mouse.up();
  await expect.poll(async () => (await qr(page))?.box.w ?? 0).toBeGreaterThan(a.box.w + 50);
  const big = (await qr(page))!;
  expect(big.box.w).toBe(big.box.h);
  await expect.poll(async () => (await qr(page))?.state).toBe('ok');

  // Undo the resize and the move: back to its default place.
  await undo(page);
  await undo(page);
  await expect.poll(async () => (await stored(page))?.box).toBeUndefined();
  await expect.poll(async () => (await qr(page))?.box).toEqual(a.box);

  // Delete removes it; undo brings it back.
  await page.keyboard.press('Delete');
  await expect.poll(() => stored(page)).toBeUndefined();
  await expect.poll(() => qr(page)).toBeNull();
  await undo(page);
  await expect.poll(() => stored(page)).toEqual({});
});

test("the PNG's code: an unedited example's short watch link, an edited piece's full one; each opens the watch view", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await open(page, 'kite-day');
  await expect(page.getByTestId('tool-qr')).toBeEnabled();
  await page.getByTestId('tool-qr').click();
  const here = new URL('./', page.url()).href;
  for (const edited of [false, true]) {
    if (edited) {
      await page.evaluate(() => {
        const h = (window as unknown as HookWindow).__algorhythms;
        const p = structuredClone(h.store.getState().piece);
        p.meta.title = 'Kite Night';
        h.actions.setPiece(p);
      });
    }
    const piece = await page.evaluate(
      () => (window as unknown as HookWindow).__algorhythms.store.getState().piece,
    );
    const link = edited
      ? await page.evaluate(
          ([p, base]) =>
            (window as unknown as HookWindow).__algorhythms.encodeWatchLink(p, { base }),
          [piece, SITE] as const,
        )
      : `${SITE}#w&kite-day&f=poster`;
    if (edited) expect(link.startsWith(`${SITE}#w&p=`)).toBe(true);
    await expect.poll(async () => (await qr(page))?.link).toBe(link);
    await expect.poll(async () => (await qr(page))?.state).toBe('ok');
    const code = (await qr(page))!;
    // Default size: modules of at least 1/400 of the 2160 px side (whole px), 12–40 % of it.
    expect(code.box.w / (code.n + 8)).toBeGreaterThanOrEqual(2160 / 400);
    expect(code.box.w).toBeGreaterThanOrEqual(0.12 * 2160 - 1);
    expect(code.box.w).toBeLessThanOrEqual(0.4 * 2160 + 1);

    const dl = await clickExportForDownload(page, 60_000);
    expect(dl.suggestedFilename()).toMatch(/\.png$/);
    expect(await decodePng(page, readFileSync(await dl.path()), code.box)).toBe(link);

    // Opened on this server, in a fresh browser: the watch view, the same piece.
    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await other.goto(link.replace(SITE, here));
    await expect(other.getByTestId('watch-view')).toBeVisible();
    await expect
      .poll(() =>
        other.evaluate(
          () => (window as unknown as HookWindow).__algorhythms.store.getState().piece.meta.title,
        ),
      )
      .toBe(piece.meta.title);
    if (edited)
      expect(
        await other.evaluate(
          () => (window as unknown as HookWindow).__algorhythms.store.getState().piece.poster?.qr,
        ),
      ).toEqual({});
    // Over the poster, as the maker's.
    expect(await frameOf(other)).toBe('poster');
    if (!edited) {
      // A plain example watch link plays as before: One row.
      await other.goto(`${here}#w&kite-day`);
      await expect(other.getByTestId('watch-view')).toBeVisible();
      await expect.poll(() => frameOf(other)).toBe('row');
    }
    await ctx.close();
  }
});

test('a piece whose watch link is too long: the button is disabled and says why', async ({
  page,
}) => {
  await open(page, 'sunday-lane');
  const button = page.getByTestId('tool-qr');
  // Unedited, the example's short link fits.
  await expect(button).toBeEnabled();
  await page.evaluate(() => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const p = structuredClone(h.store.getState().piece);
    p.meta.title = 'Sunday Lane, again';
    h.actions.setPiece(p);
  });
  await expect(page.getByTestId('qr-too-long')).toContainText(
    /Link too long for a QR code: 2,\d{3} of 1,500 characters/,
  );
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', /watch link is 2,\d{3} characters.*1,500/);
});

test('a code whose link grows too long: "too long to scan", left out of the PNG with a notice', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await open(page, 'kite-day');
  await page.getByTestId('tool-qr').click();
  await expect.poll(async () => (await qr(page))?.state).toBe('ok');
  // A long text box grows the link past the limit.
  await page.evaluate(() => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const p = structuredClone(h.store.getState().piece);
    let x = 7;
    let text = '';
    const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 1000; i++) {
      x = (x * 1103515245 + 12345) % 2147483648;
      text += abc[(x >> 8) % abc.length];
    }
    p.poster = {
      ...p.poster,
      texts: [{ id: 'noise', kind: 'free', text, box: { x: 0.05, y: 0.05, w: 0.3, h: 0.02 } }],
    };
    h.actions.setPiece(p);
  });
  await expect(page.getByTestId('qr-state')).toHaveAttribute('data-state', 'long');
  await expect(page.getByTestId('qr-state')).toContainText('Too long to scan');
  const code = (await qr(page))!;
  const dl = await clickExportForDownload(page, 60_000);
  await expect(page.getByTestId('notices')).toContainText('The QR code was left out');
  expect(await decodePng(page, readFileSync(await dl.path()), code.box)).toBeNull();
});
