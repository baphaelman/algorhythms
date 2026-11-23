/**
 * HUD placement in the Export dialog (PLAN.md §12 "Exports you can shape", §15 M11): readouts
 * are boxes on the preview; drag (snaps to a margin, guides), arrow keys, × and Delete, adding
 * back, 16:9 → 9:16 keeps a corner readout on its corner, Reset layout, and the exported frame
 * and poster put the readout where the preview shows it (±1 px at export scale).
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { clickExportForDownload, guarded, setHudOpen, setSwitch, tap } from './export-diag';
import type * as ExportRun from '../../src/app/export-run';
import type * as Poster from '../../src/app/poster-export';
import type * as VideoExport from '../../src/app/video-export';

interface HookWindow {
  __algorhythms: {
    store: { getState(): { piece: unknown } };
    exportRun(): Promise<typeof ExportRun>;
    videoExport(): Promise<typeof VideoExport>;
    poster(): Promise<typeof Poster>;
  };
}

const dialog = (page: Page) => page.getByTestId('export-dialog');

async function openExport(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export').click();
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible();
  await expect(page.getByTestId('export-run')).toBeEnabled();
}

async function choose(page: Page, testId: string, label: string): Promise<void> {
  const input = dialog(page).getByTestId(testId).getByLabel(label, { exact: true });
  await guarded(page, `choose ${testId} ${label}`, () => input.click());
  await expect(input).toBeChecked();
}

/** A readout's box in layout px (from the overlay), and the frame. */
async function boxOf(
  page: Page,
  item: string,
): Promise<{ x: number; y: number; w: number; h: number; W: number; H: number; k: number }> {
  return page.evaluate((it) => {
    const o = document.querySelector<HTMLElement>('[data-testid=hud-overlay]')!;
    const b = o.querySelector<HTMLElement>(`[data-testid=hud-box-${it}]`)!;
    const W = Number(o.dataset.width);
    const H = Number(o.dataset.height);
    const or = o.getBoundingClientRect();
    const r = b.getBoundingClientRect();
    const k = or.width / W;
    return {
      x: (r.left - or.left) / k,
      y: (r.top - or.top) / k,
      w: r.width / k,
      h: r.height / k,
      W,
      H,
      k,
    };
  }, item);
}

/** Drags a readout by (dx, dy) CSS px, checking the guides while held. */
async function drag(
  page: Page,
  item: string,
  dx: number,
  dy: number,
  whileHeld?: () => Promise<void>,
): Promise<void> {
  const r = (await page.getByTestId(`hud-box-${item}`).boundingBox())!;
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  if (whileHeld) await whileHeld();
  await page.mouse.up();
}

const layoutOf = (page: Page) =>
  page.evaluate(async () => {
    const req = (
      await (window as unknown as HookWindow).__algorhythms.exportRun()
    ).lastPreviewRequest();
    return req!.options.look!.hudLayout ?? null;
  });

/** Waits until the preview has drawn and the overlay shows `n` readouts. */
async function ready(page: Page, n: number): Promise<void> {
  await expect(page.getByTestId('hud-overlay').locator('.hud-box')).toHaveCount(n);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openExport(page);
  await choose(page, 'export-format', 'Video (MP4)');
  await ready(page, 6);
});

test('drag snaps to a margin with a guide; the keyboard moves it; aria says where', async ({
  page,
}) => {
  const margin = await page.evaluate(() => {
    const o = document.querySelector<HTMLElement>('[data-testid=hud-overlay]')!;
    return Number(o.dataset.width) * 0.025;
  });
  const before = await boxOf(page, 'chord');
  // Towards the top-left, the left edge ending 3 CSS px right of the margin.
  const dx = (margin - before.x) * before.k + 3;
  const dy = (60 - before.y) * before.k;
  await drag(page, 'chord', dx, dy, async () => {
    await expect(page.getByTestId('hud-guide-x')).toBeVisible();
  });
  await expect(page.getByTestId('hud-guide-x')).toHaveCount(0);
  const after = await boxOf(page, 'chord');
  expect(Math.abs(after.x - margin)).toBeLessThan(0.6);
  expect(Math.abs(after.y - 60)).toBeLessThan(6);
  const layout = (await layoutOf(page))!;
  expect(layout.chord!.anchor).toBe('tl');
  expect(layout.chord!.x).toBeCloseTo(0.025, 3);
  // Every other readout was fixed where it was.
  expect(Object.keys(layout).sort()).toEqual(['chord', 'formula', 'hz', 'key', 'notes', 'time']);

  // Alt: no snapping.
  await page.keyboard.down('Alt');
  await drag(page, 'chord', 2, 0);
  await page.keyboard.up('Alt');
  expect((await boxOf(page, 'chord')).x - margin).toBeGreaterThan(1);

  // Keyboard: 0.5 % of the frame per arrow, 5 % with Shift.
  const box = page.getByTestId('hud-box-time');
  await box.focus();
  const t0 = await boxOf(page, 'time');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await boxOf(page, 'time')).x - t0.x).toBeCloseTo(t0.W * 0.005, 0);
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(async () => t0.y - (await boxOf(page, 'time')).y).toBeCloseTo(t0.H * 0.05, 0);
  await expect(box).toBeFocused();
  await expect(box).toHaveAttribute(
    'aria-label',
    /^Time \/ length: bottom left, \d+ % from the left/,
  );
  await expect(page.getByTestId('hud-live')).toContainText('Time / length: bottom left');
});

test('× and Delete remove a readout, the list adds it back at a free spot', async ({ page }) => {
  const others = ['formula', 'notes', 'time', 'key', 'hz'];
  const before = await Promise.all(others.map((it) => boxOf(page, it)));
  await page.getByTestId('hud-box-chord').hover();
  await tap(page, 'hud-x-chord');
  await ready(page, 5);
  await setHudOpen(page, true);
  await expect(page.getByTestId('hud-chord')).not.toBeChecked();
  // The others stay put.
  const after = await Promise.all(others.map((it) => boxOf(page, it)));
  for (let i = 0; i < others.length; i++) {
    expect(Math.abs(after[i].x - before[i].x), others[i]).toBeLessThan(0.6);
    expect(Math.abs(after[i].y - before[i].y), others[i]).toBeLessThan(0.6);
  }
  // Delete on a focused readout; focus moves to the next one.
  await page.getByTestId('hud-box-key').focus();
  await page.keyboard.press('Delete');
  await ready(page, 4);
  await expect(page.getByTestId('hud-box-hz')).toBeFocused();
  await expect(page.getByTestId('hud-key')).not.toBeChecked();

  await setSwitch(page, 'hud-chord', true);
  await ready(page, 5);
  const c = await boxOf(page, 'chord');
  for (const it of ['formula', 'notes', 'time', 'hz']) {
    const o = await boxOf(page, it);
    const apart =
      c.x >= o.x + o.w - 0.5 ||
      o.x >= c.x + c.w - 0.5 ||
      c.y >= o.y + o.h - 0.5 ||
      o.y >= c.y + c.h - 0.5;
    expect(apart, `chord clear of ${it}`).toBe(true);
  }
  expect(c.x >= 0 && c.y >= 0 && c.x + c.w <= c.W + 0.5 && c.y + c.h <= c.H + 0.5).toBe(true);
});

test('16:9 → 9:16 keeps a corner readout on its corner; Reset layout restores two columns', async ({
  page,
}) => {
  const home = await boxOf(page, 'chord');
  // Up to the top-right margin corner.
  const m = home.W * 0.025;
  const dx = (home.W - m - home.w - home.x) * home.k - 2;
  const dy = (m - home.y) * home.k + 2;
  await drag(page, 'chord', dx, dy);
  const a = await boxOf(page, 'chord');
  expect(Math.abs(a.W - m - (a.x + a.w))).toBeLessThan(0.6);
  expect(Math.abs(a.y - m)).toBeLessThan(0.6);
  expect((await layoutOf(page))!.chord!.anchor).toBe('tr');
  await expect(page.getByTestId('hud-box-chord')).toHaveAttribute('data-anchor', 'tr');

  await choose(page, 'export-aspect', '9:16');
  await expect
    .poll(async () => (await boxOf(page, 'chord')).H / (await boxOf(page, 'chord')).W)
    .toBeGreaterThan(1.5);
  await ready(page, 6);
  const b = await boxOf(page, 'chord');
  // Same fractions from the top-right corner.
  expect((b.W - (b.x + b.w)) / b.W).toBeCloseTo((a.W - (a.x + a.w)) / a.W, 2);
  expect(b.y / b.H).toBeCloseTo(a.y / a.H, 2);

  await choose(page, 'export-aspect', '16:9');
  await setHudOpen(page, true);
  await expect(page.getByTestId('hud-reset-layout')).toBeEnabled();
  await tap(page, 'hud-reset-layout');
  await expect(page.getByTestId('hud-reset-layout')).toBeDisabled();
  expect(await layoutOf(page)).toEqual({});
  await expect
    .poll(async () => Math.abs((await boxOf(page, 'chord')).y - home.y))
    .toBeLessThan(0.6);
  expect(Math.abs((await boxOf(page, 'chord')).x - home.x)).toBeLessThan(0.6);
});

/**
 * Ink of the readout in `img` against `ref` (the same picture with the readout elsewhere), within
 * `box` (export px) grown by `pad`: the bounding box of pixels that differ.
 */
type Ink = { x0: number; y0: number; x1: number; y1: number } | null;

test('the exported frame and poster put the readout where the preview shows it', async ({
  page,
  browserName,
}) => {
  test.setTimeout(90_000);
  // Only the time readout, dragged into the plot's top area.
  await setHudOpen(page, true);
  await tap(page, 'hud-none');
  await setSwitch(page, 'hud-time', true);
  await ready(page, 1);
  const t0 = await boxOf(page, 'time');
  await drag(page, 'time', (300 - t0.x) * t0.k, (120 - t0.y) * t0.k);
  const box = await boxOf(page, 'time');

  const video: { ink: Ink; dpr: number } = await page.evaluate(
    async ({ bx }) => {
      const h = (window as unknown as HookWindow).__algorhythms;
      const req = (await h.exportRun()).lastPreviewRequest()!;
      if (req.kind !== 'video') throw new Error('not video');
      const piece = h.store.getState().piece as never;
      const ve = await h.videoExport();
      const k = Math.round(req.t * 30);
      const opts = req.options;
      const a = ve.referenceFrame(piece, opts, k);
      const away = {
        ...opts,
        look: { ...opts.look!, hudLayout: { time: { anchor: 'bl' as const, x: 0.5, y: -0.02 } } },
      };
      const b = ve.referenceFrame(piece, away, k);
      const dpr = a.width / bx.W;
      const pad = 12 * dpr;
      let ink: Ink = null;
      const X0 = Math.max(0, Math.floor(bx.x * dpr - pad));
      const X1 = Math.min(a.width, Math.ceil((bx.x + bx.w) * dpr + pad));
      const Y0 = Math.max(0, Math.floor(bx.y * dpr - pad));
      const Y1 = Math.min(a.height, Math.ceil((bx.y + bx.h) * dpr + pad));
      for (let y = Y0; y < Y1; y++) {
        for (let x = X0; x < X1; x++) {
          const i = (y * a.width + x) * 4;
          const d = Math.max(
            Math.abs(a.data[i] - b.data[i]),
            Math.abs(a.data[i + 1] - b.data[i + 1]),
            Math.abs(a.data[i + 2] - b.data[i + 2]),
          );
          if (d < 40) continue;
          if (!ink) ink = { x0: x, y0: y, x1: x + 1, y1: y + 1 };
          else {
            ink.x0 = Math.min(ink.x0, x);
            ink.y0 = Math.min(ink.y0, y);
            ink.x1 = Math.max(ink.x1, x + 1);
            ink.y1 = Math.max(ink.y1, y + 1);
          }
        }
      }
      return { ink, dpr };
    },
    { bx: box },
  );
  expectInBox(video.ink, box, video.dpr, browserName);

  // Poster: the same layout (shared); the downloaded PNG.
  await choose(page, 'export-format', 'Poster');
  await setHudOpen(page, true);
  await setSwitch(page, 'hud-time', true);
  await ready(page, 1);
  const pbox = await boxOf(page, 'time');
  const dl = await clickExportForDownload(page);
  const png = readFileSync(await dl.path()).toString('base64');
  const poster: { ink: Ink; dpr: number } = await page.evaluate(
    async ({ b64, bx }) => {
      const h = (window as unknown as HookWindow).__algorhythms;
      const req = (await h.exportRun()).lastPosterRequest()!;
      const piece = h.store.getState().piece as never;
      const bmp = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${b64}`)).blob(),
      );
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      const a = g.getImageData(0, 0, bmp.width, bmp.height);
      const opts = req.options;
      const away = {
        ...opts,
        look: { ...opts.look!, hudLayout: { time: { anchor: 'bl' as const, x: 0.5, y: -0.02 } } },
      };
      const b = (await h.poster()).referencePosterAt(piece, away, 1, a.width, a.height);
      const dpr = a.width / bx.W;
      const pad = 12 * dpr;
      let ink: Ink = null;
      const X0 = Math.max(0, Math.floor(bx.x * dpr - pad));
      const X1 = Math.min(a.width, Math.ceil((bx.x + bx.w) * dpr + pad));
      const Y0 = Math.max(0, Math.floor(bx.y * dpr - pad));
      const Y1 = Math.min(a.height, Math.ceil((bx.y + bx.h) * dpr + pad));
      for (let y = Y0; y < Y1; y++) {
        for (let x = X0; x < X1; x++) {
          const i = (y * a.width + x) * 4;
          const d = Math.max(
            Math.abs(a.data[i] - b.data[i]),
            Math.abs(a.data[i + 1] - b.data[i + 1]),
            Math.abs(a.data[i + 2] - b.data[i + 2]),
          );
          if (d < 40) continue;
          if (!ink) ink = { x0: x, y0: y, x1: x + 1, y1: y + 1 };
          else {
            ink.x0 = Math.min(ink.x0, x);
            ink.y0 = Math.min(ink.y0, y);
            ink.x1 = Math.max(ink.x1, x + 1);
            ink.y1 = Math.max(ink.y1, y + 1);
          }
        }
      }
      return { ink, dpr };
    },
    { b64: png, bx: pbox },
  );
  expectInBox(poster.ink, pbox, poster.dpr, browserName);
});

/**
 * The readout's ink lies inside the preview's box at export scale (±1 px), and fills it across:
 * left-aligned text starts at the box's left edge (side bearing ≤ 1 layout px) and reaches near
 * its right.
 */
function expectInBox(
  ink: Ink,
  box: { x: number; y: number; w: number; h: number },
  dpr: number,
  browser: string,
): void {
  expect(ink, 'readout ink found').not.toBeNull();
  const i = ink!;
  const msg = `${browser}: ink ${JSON.stringify(i)}, box ${JSON.stringify(box)} × ${dpr}`;
  expect(i.x0, msg).toBeGreaterThanOrEqual(box.x * dpr - 1);
  expect(i.y0, msg).toBeGreaterThanOrEqual(box.y * dpr - 1);
  expect(i.x1, msg).toBeLessThanOrEqual((box.x + box.w) * dpr + 1);
  expect(i.y1, msg).toBeLessThanOrEqual((box.y + box.h) * dpr + 1);
  expect(i.x0 - box.x * dpr, msg).toBeLessThanOrEqual(1.5 * dpr);
  expect((box.x + box.w) * dpr - i.x1, msg).toBeLessThanOrEqual(2 * dpr);
}
