/**
 * The poster's Text tool (M14 follow-up, owner 2026-11-25: "should preview, like the + in
 * figma … when you do click, should look better"): the armed tool shows a crosshair, a ghost
 * box that follows the pointer and a hint, Escape disarms; a click places a box as wide as its
 * text whose outline hugs it with one set of eight handles; a drag sets its width; typing grows
 * it; everything undoes.
 */

import { expect, test, type Page } from '@playwright/test';
import { openPoster } from './export-open';
import type { Piece } from '../../src/core/types';
import type { PosterLayout } from '../../src/render/poster-layout';

interface HookWindow {
  __algorhythms: {
    posterWorkspace: { getState(): { layout: PosterLayout | null; selected: unknown } };
    store: { getState(): { piece: Piece } };
    editor: { undo(): boolean };
  };
}

/** Text box `id`'s ink box and frame (artboard px), or null. */
const textObj = (page: Page, id: string) =>
  page.evaluate((m) => {
    const L = (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().layout!;
    const o = L.objects.find((x) => x.type === 'text' && x.member === m);
    return o && o.type === 'text' ? { box: o.box, frame: o.frame, size: o.size } : null;
  }, id);

const texts = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as HookWindow).__algorhythms.store.getState().piece.poster?.texts ?? [],
  );

/** The text boxes the artboard draws (the defaults before the first edit). */
const textIds = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as HookWindow).__algorhythms.posterWorkspace
      .getState()
      .layout!.objects.filter((o) => o.type === 'text')
      .map((o) => o.member),
  );

const selected = (page: Page) =>
  page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().selected,
  );

const undo = (page: Page) =>
  page.evaluate(() => (window as unknown as HookWindow).__algorhythms.editor.undo());

/** Artboard px → page px (k: page px per artboard px). */
async function scale(page: Page) {
  const b = (await page.getByTestId('artboard-overlay').boundingBox())!;
  const W = await page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().layout!.width,
  );
  return { x: b.x, y: b.y, w: b.width, h: b.height, k: b.width / W };
}

/** A page box as an artboard box. */
async function toBoard(page: Page, r: { x: number; y: number; width: number; height: number }) {
  const s = await scale(page);
  return { x: (r.x - s.x) / s.k, y: (r.y - s.y) / s.k, w: r.width / s.k, h: r.height / s.k };
}

/** An empty spot on the artboard (page px): left of centre, below the music's top. */
async function emptySpot(page: Page, fx = 0.3, fy = 0.62) {
  const s = await scale(page);
  return { x: s.x + s.w * fx, y: s.y + s.h * fy };
}

/** The id of the text box that is not one of `before`. */
async function newId(page: Page, before: string[]) {
  return (await textIds(page)).find((id) => !before.includes(id));
}

const near = (a: number, b: number, eps: number) =>
  expect(Math.abs(a - b), `${a} ≈ ${b}`).toBeLessThanOrEqual(eps);

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name.endsWith('-prod'), 'editing: once per engine');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openPoster(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => !!(window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().layout,
      ),
    )
    .toBe(true);
});

test('the armed Text tool: crosshair, a ghost that follows the pointer, a hint; Escape disarms', async ({
  page,
}) => {
  const overlay = page.getByTestId('artboard-overlay');
  const tool = page.getByTestId('tool-text');
  await expect(page.getByTestId('text-tool-hint')).toHaveCount(0);
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('text-tool-hint')).toHaveText(
    'Click to place text · drag to set its width · Esc to cancel',
  );
  expect(await overlay.evaluate((el) => getComputedStyle(el).cursor)).toBe('crosshair');

  const ghost = page.getByTestId('text-ghost');
  const a = await emptySpot(page, 0.3, 0.62);
  await page.mouse.move(a.x, a.y);
  await expect(ghost).toBeVisible();
  await expect(ghost).toHaveText('Text');
  const g1 = (await ghost.boundingBox())!;
  near(g1.x, a.x, 8);
  near(g1.y, a.y, 8);
  // At the size and font a new box gets: 3 % of the shorter side.
  const s = await scale(page);
  const S = Math.min(s.w, s.h) / s.k;
  const fontPx = await ghost.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  near(fontPx, 0.03 * S * s.k, 0.5);

  const b = await emptySpot(page, 0.45, 0.7);
  await page.mouse.move(b.x, b.y, { steps: 4 });
  const g2 = (await ghost.boundingBox())!;
  expect(g2.x - g1.x).toBeGreaterThan(50);
  expect(g2.y - g1.y).toBeGreaterThan(20);

  // Near the left margin it snaps, with a guide.
  const L = await page.evaluate(
    () =>
      (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().layout!.content,
  );
  await page.mouse.move(s.x + (L.x + 2 / s.k) * s.k, a.y);
  await expect(page.getByTestId('snap-guide-x')).toBeVisible();
  near((await toBoard(page, (await ghost.boundingBox())!)).x, L.x, 1);

  // Escape disarms: Select is back, no ghost, no hint, nothing added.
  const before = (await texts(page)).length;
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  await expect(ghost).toHaveCount(0);
  await expect(page.getByTestId('text-tool-hint')).toHaveCount(0);
  await expect(page.getByTestId('snap-guide-x')).toHaveCount(0);
  expect((await texts(page)).length).toBe(before);
  // The workspace is still open (the first Escape only disarmed).
  await expect(page.getByTestId('poster-workspace')).toBeVisible();
});

test('a click places a box that hugs its text, one set of handles; typing grows it; undo', async ({
  page,
}) => {
  await page.getByTestId('tool-snap').click();
  const ids = await textIds(page);
  await page.getByTestId('tool-text').click();
  const at = await emptySpot(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  const edit = page.getByTestId('inline-text');
  await expect(edit).toBeFocused();
  // The placeholder is selected, ready to type over.
  expect(
    await edit.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
  ).toEqual([0, 4]);
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('text-ghost')).toHaveCount(0);

  const id = (await newId(page, ids))!;
  expect(id).toBeTruthy();
  const o = (await textObj(page, id))!;
  // Placed where clicked, as wide as "Text".
  const s = await scale(page);
  near(o.frame.x, (at.x - s.x) / s.k, 2);
  near(o.frame.w, o.box.w, 0.5);

  // The outline hugs the ink with a small even gap; exactly one set of eight handles.
  const tol = 4 / s.k;
  const check = async () => {
    const t = (await textObj(page, id))!;
    const sel = await toBoard(page, (await page.locator('.ws-sel-box').boundingBox())!);
    for (const d of [
      t.box.x - sel.x,
      t.box.y - sel.y,
      sel.x + sel.w - (t.box.x + t.box.w),
      sel.y + sel.h - (t.box.y + t.box.h),
    ]) {
      expect(d).toBeGreaterThanOrEqual(-tol);
      expect(d).toBeLessThanOrEqual(tol + 0.1 * t.size);
    }
    await expect(page.locator('.ws-sel-box')).toHaveCount(1);
    await expect(page.locator('.ws-handle')).toHaveCount(8);
    const nw = await toBoard(page, (await page.getByTestId('handle-nw').boundingBox())!);
    near(nw.x + nw.w / 2, sel.x, tol);
    near(nw.y + nw.h / 2, sel.y, tol);
    // The field over the text is no bigger than the text.
    if (await edit.count()) {
      const f = await toBoard(page, (await edit.boundingBox())!);
      expect(f.h).toBeLessThanOrEqual(t.frame.h + tol);
    }
  };
  await check();

  // Typing: the artboard draws it as typed and the box grows.
  const w0 = o.frame.w;
  await page.keyboard.type('A longer line of text');
  await expect.poll(async () => (await textObj(page, id))!.frame.w).toBeGreaterThan(w0 * 3);
  await check();
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('two');
  await expect
    .poll(async () => (await textObj(page, id))!.frame.h)
    .toBeGreaterThan(o.frame.h * 1.8);
  await page.keyboard.press('Enter');
  await expect(edit).toHaveCount(0);
  expect(await selected(page)).toEqual({ kind: 'text', id });
  await check();
  const t = (await texts(page)).find((x) => x.id === id)!;
  expect(t).toMatchObject({ text: 'A longer line of text\ntwo', sizing: 'auto' });

  // One undo removes the box and its text.
  await undo(page);
  await expect.poll(async () => (await newId(page, ids)) ?? null).toBeNull();
});

test('a drag sets the width: lines wrap; click away commits; undo', async ({ page }) => {
  await page.getByTestId('tool-snap').click();
  const ids = await textIds(page);
  await page.getByTestId('tool-text').click();
  const a = await emptySpot(page, 0.25, 0.62);
  const s = await scale(page);
  const dx = 0.2 * s.w;
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + dx / 2, a.y, { steps: 3 });
  await expect(page.getByTestId('text-ghost')).toHaveClass(/ws-ghost-drag/);
  near((await page.getByTestId('text-ghost').boundingBox())!.width, dx / 2, 3);
  await page.mouse.move(a.x + dx, a.y, { steps: 3 });
  await page.mouse.up();
  await expect(page.getByTestId('inline-text')).toBeFocused();
  const id = (await newId(page, ids))!;
  near((await textObj(page, id))!.frame.w, dx / s.k, 3 / s.k);
  await page.keyboard.type('one two three four five six seven eight nine ten eleven twelve');
  await expect
    .poll(async () => (await textObj(page, id))!.frame.h)
    .toBeGreaterThan(2 * 1.2 * (await textObj(page, id))!.size - 1);
  near((await textObj(page, id))!.frame.w, dx / s.k, 3 / s.k);
  // Clicking away commits; the box stays as typed.
  await page.getByTestId('poster-workspace').focus();
  await expect(page.getByTestId('inline-text')).toHaveCount(0);
  expect((await texts(page)).find((x) => x.id === id)).toMatchObject({ sizing: 'wrap' });
  await undo(page);
  await expect.poll(async () => (await newId(page, ids)) ?? null).toBeNull();
});

test('a moved and resized title keeps a tidy selection', async ({ page }) => {
  await page.getByTestId('tool-snap').click();
  const o = (await textObj(page, 'title'))!;
  const s = await scale(page);
  const c = {
    x: s.x + (o.frame.x + o.frame.w / 2) * s.k,
    y: s.y + (o.frame.y + o.frame.h / 2) * s.k,
  };
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 30, c.y + 40, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.ws-handle')).toHaveCount(8);
  const h = (await page.getByTestId('handle-se').boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 40, h.y + 30, { steps: 5 });
  await page.mouse.up();
  const t = (await textObj(page, 'title'))!;
  expect(t.size).toBeGreaterThan(o.size * 1.05);
  const sel = await toBoard(page, (await page.locator('.ws-sel-box').boundingBox())!);
  const tol = 4 / s.k + 0.1 * t.size;
  near(sel.x, t.box.x, tol);
  near(sel.x + sel.w, t.box.x + t.box.w, tol);
  near(sel.y, t.box.y, tol);
  near(sel.y + sel.h, t.box.y + t.box.h, tol);
  await expect(page.locator('.ws-handle')).toHaveCount(8);
  await undo(page);
  await undo(page);
  await expect.poll(async () => (await textObj(page, 'title'))!.frame).toEqual(o.frame);
});
