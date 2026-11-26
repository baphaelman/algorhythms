/**
 * Zoom and pan on the poster artboard (owner, poster notes round 3, items 5 and 7): ⌘/Ctrl-wheel
 * zooms at the pointer; at 200 % the handles sit on the selection and a drag moves it by the
 * poster distance; ⇧1 fits, ⇧0 is 100 %, ⌘+ steps; the readout's menu; a click on the gray area
 * deselects, but a Space-drag pans instead.
 */

import { expect, test, type Page } from '@playwright/test';
import { openPoster } from './export-open';
import type { Piece } from '../../src/core/types';
import type { PosterLayout } from '../../src/render/poster-layout';
import type * as ExportRun from '../../src/app/export-run';
import type * as Poster from '../../src/app/poster-export';

interface HookWindow {
  __algorhythms: {
    posterWorkspace: { getState(): { layout: PosterLayout | null; selected: unknown } };
    store: { getState(): { piece: Piece; transport: { status: string } } };
    poster(): Promise<typeof Poster>;
    exportRun(): Promise<typeof ExportRun>;
  };
}

/** Pixels of `a` and `b` (RGBA) off by more than 16 in any channel. */
const differ = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let bad = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs(a[i + c] - b[i + c]) > 16) {
        bad++;
        break;
      }
    }
  }
  return bad;
};

type Box = { x: number; y: number; w: number; h: number };

const posterLayout = (page: Page) =>
  page.evaluate(() => {
    const L = (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().layout!;
    const t = L.objects.find((o) => o.type === 'text');
    return {
      width: L.width,
      height: L.height,
      text: t && t.type === 'text' ? { id: t.member, box: t.box, frame: t.frame } : null,
    };
  });

const selected = (page: Page) =>
  page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().selected,
  );

const zoom = async (page: Page) =>
  Number(await page.getByTestId('poster-artboard').getAttribute('data-zoom'));

/** Page px per poster px, and the overlay's top left (page px). */
async function view(page: Page) {
  const b = (await page.getByTestId('artboard-overlay').boundingBox())!;
  const L = await posterLayout(page);
  return { x: b.x, y: b.y, k: b.width / L.width };
}

/** The poster point under page point (x, y). */
async function posterAt(page: Page, x: number, y: number) {
  const v = await view(page);
  return { x: (x - v.x) / v.k, y: (y - v.y) / v.k };
}

const near = (a: number, b: number, eps = 1.5) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

/** Waits for the artboard to redraw after `act`. */
async function redrawn(page: Page, act: () => Promise<void>) {
  const c = page.getByTestId('preview-canvas');
  const n = Number(await c.getAttribute('data-draws'));
  await act();
  await expect.poll(async () => Number(await c.getAttribute('data-draws'))).toBeGreaterThan(n);
}

/** Selects the first text box with a click on it. */
async function selectText(page: Page): Promise<{ id: string; frame: Box }> {
  const t = (await posterLayout(page)).text!;
  const v = await view(page);
  await page.mouse.click(v.x + (t.box.x + t.box.w / 2) * v.k, v.y + (t.box.y + t.box.h / 2) * v.k);
  await expect.poll(() => selected(page)).toEqual({ kind: 'text', id: t.id });
  return { id: t.id, frame: t.frame };
}

/** Brings poster point `p` to the artboard box's centre with a plain scroll (zoomed in). */
async function panTo(page: Page, p: { x: number; y: number }) {
  const box = (await page.getByTestId('artboard-box').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const at = await posterAt(page, cx, cy);
  const k = (await view(page)).k;
  await page.mouse.move(cx, cy);
  await redrawn(page, () => page.mouse.wheel((p.x - at.x) * k, (p.y - at.y) * k));
}

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name.endsWith('-prod'), 'editing: once per engine');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openPoster(page);
  await expect
    .poll(async () => (await posterLayout(page).catch(() => null))?.text ?? null)
    .not.toBeNull();
});

test('⌘/Ctrl-wheel zooms in at the pointer; ⇧1 fits; ⇧0 and ⌘+ zoom', async ({ page }) => {
  const art = page.getByTestId('poster-artboard');
  await expect(art).toHaveAttribute('data-fit', 'true');
  const fit = await zoom(page);
  const box = (await page.getByTestId('artboard-box').boundingBox())!;
  const px = box.x + box.width * 0.3;
  const py = box.y + box.height * 0.4;
  const before = await posterAt(page, px, py);
  await page.mouse.move(px, py);
  await page.keyboard.down('Control');
  await redrawn(page, () => page.mouse.wheel(0, -120));
  await page.keyboard.up('Control');
  await expect(art).toHaveAttribute('data-fit', 'false');
  expect(await zoom(page)).toBeGreaterThan(fit * 1.3);
  const after = await posterAt(page, px, py);
  const k = (await view(page)).k;
  near(after.x, before.x, 1 / k + 0.5);
  near(after.y, before.y, 1 / k + 0.5);
  await expect(page.getByTestId('zoom-readout')).toHaveText(
    `${Math.round((await zoom(page)) * 100)} %`,
  );

  // Sharp: the canvas holds only the page in view, at the screen's resolution.
  const c = await page.getByTestId('preview-canvas').evaluate((el: HTMLCanvasElement) => ({
    w: el.width,
    css: el.getBoundingClientRect().width,
    dpr: Math.min(2, devicePixelRatio || 1),
  }));
  near(c.w / c.css, c.dpr, 0.02);
  expect(c.css).toBeLessThanOrEqual(box.width + 2);

  await page.getByTestId('poster-workspace').focus();
  await page.keyboard.press('Shift+Digit1');
  await expect(art).toHaveAttribute('data-fit', 'true');
  expect(await zoom(page)).toBeCloseTo(fit, 6);
  await page.keyboard.press('Shift+Digit0');
  await expect(page.getByTestId('zoom-readout')).toHaveText('100 %');
  await page.keyboard.press('ControlOrMeta+Equal');
  await expect(page.getByTestId('zoom-readout')).toHaveText('150 %');
  await page.keyboard.press('ControlOrMeta+Minus');
  await expect(page.getByTestId('zoom-readout')).toHaveText('100 %');
  // Not while typing in a text box.
  await page.keyboard.press('Shift+Digit1');
  await expect(art).toHaveAttribute('data-fit', 'true');
  await selectText(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('.ws-overlay textarea')).toBeFocused();
  await page.keyboard.press('Shift+Digit0');
  await page.keyboard.press('ControlOrMeta+Equal');
  await expect(art).toHaveAttribute('data-fit', 'true');
});

test('the readout menu: 200 %, Zoom out, Zoom to fit; Escape closes it', async ({ page }) => {
  const readout = page.getByTestId('zoom-readout');
  const menu = page.getByTestId('zoom-menu');
  await readout.click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText([
    /Zoom in/,
    /Zoom out/,
    /Zoom to fit/,
    /50 %/,
    /100 %/,
    /200 %/,
  ]);
  await page.getByTestId('zoom-menu-200').click();
  await expect(menu).toBeHidden();
  await expect(readout).toHaveText('200 %');
  await readout.click();
  await page.getByTestId('zoom-menu-out').click();
  await expect(readout).toHaveText('150 %');
  await readout.click();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('poster-workspace')).toBeVisible();
  await readout.click();
  await page.getByTestId('zoom-menu-fit').click();
  await expect(page.getByTestId('poster-artboard')).toHaveAttribute('data-fit', 'true');
});

test('at 200 % the handles sit on the selection; a drag moves it by the poster distance', async ({
  page,
}) => {
  const snap = page.getByTestId('tool-snap');
  if (await snap.isChecked()) await snap.click();
  const { id, frame } = await selectText(page);
  const v0 = await view(page);
  const sel0 = (await page.locator('.ws-sel-box').first().boundingBox())!;
  await page.getByTestId('zoom-readout').click();
  await redrawn(page, () => page.getByTestId('zoom-menu-200').click());
  await panTo(page, { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 });
  const v = await view(page);
  near(v.k, 2, 0.01);

  // The outline is the same poster box as at Fit, and the handles are on its corners and edges.
  const sel = (await page.locator('.ws-sel-box').first().boundingBox())!;
  near((sel.x - v.x) / v.k, (sel0.x - v0.x) / v0.k, 2 / v0.k);
  near(sel.width / v.k, sel0.width / v0.k, 2 / v0.k);
  near(sel.height / v.k, sel0.height / v0.k, 2 / v0.k);
  const mid = async (h: string) => {
    const b = (await page.getByTestId(`handle-${h}`).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, size: b.width };
  };
  const nw = await mid('nw');
  const se = await mid('se');
  const e = await mid('e');
  near(nw.x, sel.x);
  near(nw.y, sel.y);
  near(se.x, sel.x + sel.width);
  near(se.y, sel.y + sel.height);
  near(e.y, sel.y + sel.height / 2);
  // Handles keep their screen size.
  expect(nw.size).toBeLessThan(20);

  // A 60 × 40 px drag is 30 × 20 poster px at 200 %.
  const from = { x: sel.x + sel.width / 2, y: sel.y + sel.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y + 20, { steps: 4 });
  await page.mouse.move(from.x + 60, from.y + 40, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => (await posterLayout(page)).text!.frame.x - frame.x)
    .toBeGreaterThan(25);
  const moved = (await posterLayout(page)).text!;
  expect(moved.id).toBe(id);
  near(moved.frame.x - frame.x, 30, 1);
  near(moved.frame.y - frame.y, 20, 1);
});

test('a click on the gray area deselects; a pan or a drag there does not', async ({ page }) => {
  const box = (await page.getByTestId('artboard-box').boundingBox())!;
  const gray = { x: box.x + 6, y: box.y + box.height / 2 };
  await selectText(page);
  await page.mouse.click(gray.x, gray.y);
  await expect.poll(() => selected(page)).toBeNull();

  const t = await selectText(page);
  // A plain drag on the gray area.
  await page.mouse.move(gray.x, gray.y);
  await page.mouse.down();
  await page.mouse.move(gray.x + 40, gray.y + 30, { steps: 4 });
  await page.mouse.up();
  expect(await selected(page)).toEqual({ kind: 'text', id: t.id });

  // Space-drag pans, from the gray area or over the poster, and leaves the selection.
  const art = page.getByTestId('poster-artboard');
  await page.getByTestId('poster-workspace').focus();
  const before = (await page.getByTestId('artboard-overlay').boundingBox())!;
  for (const at of [gray, { x: box.x + box.width / 2, y: box.y + box.height / 2 }]) {
    await page.keyboard.down('Space');
    await expect(page.getByTestId('artboard-box')).toHaveClass(/grab/);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 40, at.y + 30, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Space');
  }
  await expect(art).toHaveAttribute('data-fit', 'false');
  const after = (await page.getByTestId('artboard-overlay').boundingBox())!;
  near(after.x - before.x, 80, 2);
  near(after.y - before.y, 60, 2);
  expect(await selected(page)).toEqual({ kind: 'text', id: t.id });
  expect(await (await posterLayout(page)).text!.frame).toEqual(t.frame);
  // A Space that panned doesn't play.
  expect(
    await page.evaluate(
      () => (window as unknown as HookWindow).__algorhythms.store.getState().transport.status,
    ),
  ).not.toBe('playing');
});

test('zoomed in, the canvas is the poster drawn sharp from the part in view', async ({ page }) => {
  // The renderer's offset: a part drawn from (300, 200) is that crop of the whole.
  const crop = await page.evaluate(async (src) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const req = (await h.exportRun()).lastPreviewRequest()!;
    if (req.kind !== 'poster') throw new Error('not a poster preview');
    const piece = h.store.getState().piece;
    const m = await h.poster();
    const all = m.referencePosterAt(piece, req.options, 0.5, 1920, 1080);
    const part = m.referencePosterAt(piece, req.options, 0.5, 600, 400, piece.poster, {
      x: 300,
      y: 200,
    });
    const cut = new Uint8ClampedArray(600 * 400 * 4);
    for (let y = 0; y < 400; y++) {
      cut.set(
        all.data.subarray(((y + 200) * 1920 + 300) * 4, ((y + 200) * 1920 + 900) * 4),
        y * 2400,
      );
    }
    const differ = new Function('a', 'b', `return (${src})(a, b)`) as (
      a: ArrayLike<number>,
      b: ArrayLike<number>,
    ) => number;
    return differ(cut, part.data) / (600 * 400);
  }, differ.toString());
  expect(crop).toBeLessThan(0.002);

  // The artboard at 300 %: its canvas is that drawing of the part in view.
  await page.getByTestId('poster-workspace').focus();
  await redrawn(page, () => page.keyboard.press('Shift+Digit0'));
  await redrawn(page, () => page.keyboard.press('ControlOrMeta+Equal'));
  await redrawn(page, () => page.keyboard.press('ControlOrMeta+Equal'));
  await redrawn(page, () => page.keyboard.press('ControlOrMeta+Equal'));
  await expect(page.getByTestId('zoom-readout')).toHaveText('300 %');
  const live = await page.evaluate(async (src) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const c = document.querySelector<HTMLCanvasElement>('[data-testid=preview-canvas]')!;
    const a = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const req = (await h.exportRun()).lastPreviewRequest()!;
    if (req.kind !== 'poster' || !req.offset) throw new Error('not a zoomed poster preview');
    const piece = h.store.getState().piece;
    const ref = (await h.poster()).referencePosterAt(
      piece,
      req.options,
      req.scale,
      c.width,
      c.height,
      piece.poster,
      req.offset,
    );
    const differ = new Function('a', 'b', `return (${src})(a, b)`) as (
      a: ArrayLike<number>,
      b: ArrayLike<number>,
    ) => number;
    return { bad: differ(a, ref.data) / (c.width * c.height), scale: req.scale, w: c.width };
  }, differ.toString());
  expect(live.bad).toBeLessThan(0.002);
  const dpr = await page.evaluate(() => Math.min(2, devicePixelRatio || 1));
  expect(live.scale).toBeCloseTo(3 * dpr, 6);
  const box = (await page.getByTestId('artboard-box').boundingBox())!;
  expect(live.w).toBeLessThanOrEqual(Math.ceil(box.width * dpr) + 1);
});
