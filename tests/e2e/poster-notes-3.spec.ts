/**
 * The owner's poster notes, round 3 (2026-11-26): the bottom panel is its bar, the Layers list
 * slides up over the artboard; text editing shows the words drawn (no `{meta}`); snap guides land
 * on the edges drawn; a part hidden in one row (Delete on a row piece, mixed eyes in Layers).
 */

import { expect, test, type Page } from '@playwright/test';
import { setRange } from './export-diag';
import { closeLayers, openLayers, openPoster } from './export-open';
import type { Piece } from '../../src/core/types';
import type { PosterLayout } from '../../src/render/poster-layout';

interface HookWindow {
  __algorhythms: {
    posterWorkspace: { getState(): { layout: PosterLayout | null; selected: unknown } };
    store: { getState(): { piece: Piece } };
    editor: { undo(): boolean; state: { getState(): { undoLabel: string } } };
  };
}
type Box = { x: number; y: number; w: number; h: number };

const posterDoc = (page: Page) =>
  page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.store.getState().piece.poster ?? null,
  );
const selected = (page: Page) =>
  page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().selected,
  );
const undoLabel = (page: Page) =>
  page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.editor.state.getState().undoLabel,
  );

/** Layout facts (artboard px). */
const facts = (page: Page) =>
  page.evaluate(() => {
    const L = (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().layout!;
    return {
      width: L.width,
      height: L.height,
      rows: L.rows.length,
      layers: L.layers.map((l) => ({ id: l.id, rowBounds: l.rowBounds })),
      texts: L.objects.flatMap((o) =>
        o.type === 'text'
          ? [{ id: o.member, frame: o.frame, text: o.runs.map((r) => r.text) }]
          : [],
      ),
      others: L.objects
        .filter((o) => o.type === 'label' || o.type === 'text')
        .map((o) => o.box as Box),
    };
  });

/** Artboard px → page px. */
async function toPage(page: Page, x: number, y: number) {
  const b = (await page.getByTestId('artboard-overlay').boundingBox())!;
  const k = b.width / (await facts(page)).width;
  return { x: b.x + x * k, y: b.y + y * k, k };
}

/** A point on the first part's lines in row `row`, clear of labels and text. */
async function pieceAt(page: Page, row: number) {
  const F = await facts(page);
  const { id, rowBounds } = F.layers[0];
  const b = rowBounds[row]!;
  const L = (await page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().layout,
  ))!;
  for (const fx of [0.5, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6]) {
    for (const fy of [0.5, 0.35, 0.65]) {
      const p = { x: b.x + b.w * fx, y: b.y + b.h * fy };
      const clear = !F.others.some(
        (o) => p.x >= o.x - 8 && p.x <= o.x + o.w + 8 && p.y >= o.y - 8 && p.y <= o.y + o.h + 8,
      );
      const on = L.objects.some(
        (o) =>
          o.type === 'layer' &&
          o.member === id &&
          o.row === row &&
          p.x >= o.box.x &&
          p.x <= o.box.x + o.box.w,
      );
      if (clear && on) return { id, p };
    }
  }
  throw new Error('no clear point on the piece');
}

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

test('the bottom panel is its bar; the caret or the bar slides the layers up; Escape; remembered', async ({
  page,
}) => {
  const caret = page.getByTestId('layers-toggle');
  const layers = page.getByTestId('poster-layers');
  await expect(layers).toBeHidden();
  await expect(caret).toHaveAttribute('aria-expanded', 'false');
  await expect(caret).toContainText('˄');
  // The artboard takes the space down to the bar.
  const bar = (await page.getByRole('region', { name: 'Tools and layers' }).boundingBox())!;
  const art = (await page.getByTestId('poster-artboard').boundingBox())!;
  expect(Math.abs(art.y + art.height - bar.y)).toBeLessThanOrEqual(2);
  expect(bar.height).toBeLessThan(80);

  // A click on the bar's empty part opens it, over the bottom of the artboard.
  // (A spot on the bar that no control covers.)
  const gap = await page.getByTestId('poster-tools').evaluate((el) => {
    const r = el.getBoundingClientRect();
    for (let fx = 0.98; fx > 0.02; fx -= 0.01) {
      for (const fy of [0.5, 0.15, 0.85]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit && el.contains(hit) && !hit.closest('button, input, label, select, [role=status]'))
          return { x, y };
      }
    }
    return null;
  });
  expect(gap).not.toBeNull();
  await page.mouse.click(gap!.x, gap!.y);
  await expect(caret).toHaveAttribute('aria-expanded', 'true');
  await expect(caret).toContainText('˅');
  await expect(layers).toBeVisible();
  await expect
    .poll(async () => {
      const l = (await layers.boundingBox())!;
      return Math.abs(l.y + l.height - bar.y);
    })
    .toBeLessThanOrEqual(2);
  expect((await layers.boundingBox())!.y).toBeGreaterThan(art.y);

  // The bar's own buttons still work (Snap guides), and leave the list where it is.
  const snap = page.getByTestId('tool-snap');
  await snap.click();
  await expect(snap).not.toBeChecked();
  await expect(caret).toHaveAttribute('aria-expanded', 'true');

  // Selecting from the list; Escape slides it away (the selection stays), focus on the caret.
  const part = page.getByTestId('layer-part').nth(0);
  await part.locator('.ws-layer-name').click();
  expect(await selected(page)).toMatchObject({ kind: 'layer' });
  await page.keyboard.press('Escape');
  await expect(layers).toBeHidden();
  await expect(caret).toBeFocused();
  expect(await selected(page)).toMatchObject({ kind: 'layer' });

  // The caret again; remembered after a reload.
  await caret.click();
  await expect(layers).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openPoster(page);
  await expect(page.getByTestId('layers-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('poster-layers')).toBeVisible();
  // A click on the bar again slides it down.
  await page.mouse.click(gap!.x, gap!.y);
  await expect(page.getByTestId('poster-layers')).toBeHidden();
});

test('the slide is short, and none under reduced motion', async ({ page }) => {
  const dur = () =>
    page.getByTestId('poster-layers').evaluate((el) => getComputedStyle(el).transitionDuration);
  expect((await dur()).split(',').map((s) => parseFloat(s))[0]).toBeCloseTo(0.18, 2);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect((await dur()).split(',').every((s) => parseFloat(s) === 0)).toBe(true);
});

test('text editing shows the words drawn; an unchanged box keeps its tokens; an edit is plain', async ({
  page,
}) => {
  const credit = (await facts(page)).texts.find((t) => t.id === 'credit')!;
  const drawn = credit.text.join('\n');
  expect(drawn).toContain('AlgoRhythms');
  expect(drawn).not.toContain('{');
  const c = await toPage(
    page,
    credit.frame.x + credit.frame.w / 2,
    credit.frame.y + credit.frame.h / 2,
  );
  await page.mouse.dblclick(c.x, c.y);
  const edit = page.getByTestId('inline-text');
  await expect(edit).toBeFocused();
  await expect(edit).toHaveValue(drawn);
  // The panel's field too.
  await expect(page.getByTestId('sel-text')).toHaveValue(drawn);
  await page.keyboard.press('Enter');
  await expect(edit).toHaveCount(0);
  const stored = (await posterDoc(page))?.texts?.find((t) => t.id === 'credit')?.text;
  expect(stored ?? '{meta} · AlgoRhythms').toBe('{meta} · AlgoRhythms');

  // An edit: the words as typed, no tokens.
  await page.mouse.dblclick(c.x, c.y);
  await expect(edit).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' · 2026');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await posterDoc(page))?.texts?.find((t) => t.id === 'credit')?.text)
    .toBe(`${drawn} · 2026`);
});

test('a dragged box snaps by the edge drawn: its outline sits on the guide (1 px)', async ({
  page,
}) => {
  // A small auto-width box, "Hi".
  await page.getByTestId('tool-text').click();
  const F0 = await facts(page);
  const at = await toPage(page, F0.width * 0.3, F0.height * 0.62);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId('inline-text')).toBeFocused();
  await page.keyboard.type('Hi');
  await page.keyboard.press('Enter');
  const sel = page.locator('.ws-sel-box');
  await expect(sel).toHaveCount(1);
  // Drag it so its drawn right edge ends 3 page px left of the artboard's centre line.
  const art = (await page.getByTestId('artboard-overlay').boundingBox())!;
  const b0 = (await sel.boundingBox())!;
  const dx = art.x + art.width / 2 - 3 - (b0.x + b0.width);
  const start = { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx / 2, start.y + 40, { steps: 4 });
  await page.mouse.move(start.x + dx, start.y + 40, { steps: 4 });
  const guide = page.getByTestId('snap-guide-x');
  await expect(guide).toBeVisible();
  await expect
    .poll(async () => {
      const g = (await guide.boundingBox())!;
      const s = (await sel.boundingBox())!;
      return Math.abs(s.x + s.width - (g.x + g.width / 2));
    })
    .toBeLessThanOrEqual(1);
  await page.mouse.up();
  await expect(guide).toHaveCount(0);
  const s = (await sel.boundingBox())!;
  expect(Math.abs(s.x + s.width - (art.x + art.width / 2))).toBeLessThanOrEqual(1);
});

test('Delete on a row piece hides the part in that row; Layers shows it mixed; one undo step', async ({
  page,
}) => {
  await setRange(page, 'export-prows', 2);
  await expect.poll(async () => (await facts(page)).rows).toBe(2);
  const { id, p } = await pieceAt(page, 1);
  const q = await toPage(page, p.x, p.y);
  await page.mouse.click(q.x, q.y);
  expect(await selected(page)).toEqual({ kind: 'layer', id, row: 1 });
  await page.getByTestId('poster-workspace').focus();
  await page.keyboard.press('Delete');
  await expect
    .poll(async () => (await posterDoc(page))?.layers?.find((l) => l.id === id)?.hiddenRows)
    .toEqual(['1']);
  expect(await undoLabel(page)).toBe('Hide in Row 2');
  await expect
    .poll(async () => (await facts(page)).layers.find((l) => l.id === id)!.rowBounds[1])
    .toBeNull();
  expect((await facts(page)).layers.find((l) => l.id === id)!.rowBounds[0]).not.toBeNull();
  // The panel: hidden in this row.
  await expect(page.getByTestId('sel-hidden-row')).toBeChecked();

  // Layers: the part's eye is mixed; its caret lists one eye per row.
  await openLayers(page);
  const row = page.locator(`[data-testid=layer-part][data-part="${id.slice(5)}"]`);
  const eye = row.getByTestId('layer-eye').first();
  await expect(eye).toHaveAttribute('aria-checked', 'mixed');
  await row.getByTestId('layer-rows-toggle').click();
  const eyes = row.getByTestId('layer-row-eye');
  await expect(eyes).toHaveCount(2);
  await expect(eyes.nth(0)).toHaveAttribute('aria-checked', 'true');
  await expect(eyes.nth(1)).toHaveAttribute('aria-checked', 'false');
  await expect(row.getByTestId('layer-row').nth(1)).toContainText('Row 2');
  // Showing row 2 there: all rows agree, the eye is plain again.
  await eyes.nth(1).click();
  await expect(eye).toHaveAttribute('aria-checked', 'true');
  expect((await posterDoc(page))?.layers?.find((l) => l.id === id)?.hiddenRows).toBeUndefined();
  await page.evaluate(() => (window as unknown as HookWindow).__algorhythms.editor.undo());
  await expect(eye).toHaveAttribute('aria-checked', 'mixed');
  // The mixed eye shows every row.
  await eye.click();
  await expect(eye).toHaveAttribute('aria-checked', 'true');
  const l = (await posterDoc(page))?.layers?.find((x) => x.id === id);
  expect(l?.hiddenRows).toBeUndefined();
  expect(l?.hidden).toBeUndefined();
  await closeLayers(page);

  // Alt-click selects the whole part: Delete hides it everywhere.
  const r0 = await pieceAt(page, 0);
  const q0 = await toPage(page, r0.p.x, r0.p.y);
  await page.keyboard.down('Alt');
  await page.mouse.click(q0.x, q0.y);
  await page.keyboard.up('Alt');
  expect(await selected(page)).toEqual({ kind: 'layer', id });
  await page.getByTestId('poster-workspace').focus();
  await page.keyboard.press('Delete');
  await expect
    .poll(async () => (await posterDoc(page))?.layers?.find((x) => x.id === id)?.hidden)
    .toBe(true);
});
