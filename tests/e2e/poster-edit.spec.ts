/**
 * Editing on the poster's artboard (PLAN.md §15 M14 P3): selection (a label selects its group,
 * Alt-click one member), moving and the eight handles (corner, edge, Shift, Alt) and typed
 * X/Y/W/H, the Text tool, margins, label/line switches, snapping and align, the layers list,
 * undo (a drag is one step), the re-fit hint, reload and share-link round trips, a layer's
 * colour in the video preview, PNG/SVG matching the artboard, the playhead while playing.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { chooseSegment, clickExportForDownload, setRange } from './export-diag';
import { addressSettled, openPoster, switchMode } from './export-open';
import type { Piece } from '../../src/core/types';
import type * as ExportRun from '../../src/app/export-run';
import type * as Poster from '../../src/app/poster-export';
import type { PosterLayout } from '../../src/render/poster-layout';

interface HookWindow {
  __algorhythms: {
    posterWorkspace: {
      getState(): { layout: PosterLayout | null; selected: unknown; guides: { x?: number } | null };
    };
    store: { getState(): { piece: Piece } };
    editor: { undo(): boolean };
    poster(): Promise<typeof Poster>;
    exportRun(): Promise<typeof ExportRun>;
    encodeShareLink(piece: Piece): Promise<string>;
  };
}

type Box = { x: number; y: number; w: number; h: number };
interface Obj {
  type: string;
  group: string;
  member: string;
  box: Box;
  frame?: Box;
  row?: number;
}
interface Lay {
  width: number;
  height: number;
  unit: number;
  content: Box;
  layers: { id: string; bounds: Box | null; rowBounds: (Box | null)[] }[];
  rows: Box[];
  objects: Obj[];
}

/** The artboard's last layout (artboard px). */
const layout = (page: Page): Promise<Lay> =>
  page.evaluate(() => {
    const L = (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().layout!;
    return {
      width: L.width,
      height: L.height,
      unit: L.unit,
      content: L.content,
      layers: L.layers.map((l) => ({ id: l.id, bounds: l.bounds, rowBounds: l.rowBounds })),
      rows: L.rows.map((r) => r.rect),
      objects: L.objects.map((o) => ({
        type: o.type,
        group: o.group,
        member: o.member,
        box: o.box,
        ...(o.row !== undefined ? { row: o.row } : {}),
        ...(o.type === 'text' ? { frame: o.frame } : {}),
      })),
    };
  });

const posterDoc = (page: Page) =>
  page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.store.getState().piece.poster ?? null,
  );

const selected = (page: Page) =>
  page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().selected,
  );

const bounds = async (page: Page, id: string): Promise<Box> =>
  (await layout(page)).layers.find((l) => l.id === id)!.bounds!;

const textFrame = async (page: Page, id: string): Promise<Box> =>
  (await layout(page)).objects.find((o) => o.type === 'text' && o.member === id)!.frame!;

/** Artboard px → page px, and page px per artboard px. */
async function toPage(page: Page, x: number, y: number) {
  const b = (await page.getByTestId('artboard-overlay').boundingBox())!;
  const L = await layout(page);
  const k = b.width / L.width;
  return { x: b.x + x * k, y: b.y + y * k, k };
}

const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Presses at artboard point `at`, moves by (dx, dy) page px in steps, releases. */
async function drag(page: Page, at: { x: number; y: number }, dx: number, dy: number) {
  const p = await toPage(page, at.x, at.y);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + dx / 2, p.y + dy / 2, { steps: 4 });
  await page.mouse.move(p.x + dx, p.y + dy, { steps: 4 });
  await page.mouse.up();
}

/** Drags a handle of the selection by (dx, dy) page px. */
async function dragHandle(page: Page, h: string, dx: number, dy: number, mods: string[] = []) {
  const b = (await page.getByTestId(`handle-${h}`).boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 3 });
  await page.mouse.move(x + dx, y + dy, { steps: 3 });
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
}

/**
 * A point inside the first part layer's lines (in row `row`, else any), clear of every label
 * and text box.
 */
async function layerPoint(page: Page, row?: number) {
  const L = await layout(page);
  const id = L.layers[0].id;
  const rows = L.objects.filter(
    (o) => o.type === 'layer' && o.member === id && (row === undefined || o.row === row),
  );
  const other = L.objects.filter((o) => o.type === 'label' || o.type === 'text');
  for (const r of rows) {
    for (const fx of [0.5, 0.3, 0.7, 0.2, 0.8]) {
      const p = { x: r.box.x + r.box.w * fx, y: r.box.y + r.box.h / 2 };
      const hit = other.some(
        (o) =>
          p.x >= o.box.x - 8 &&
          p.x <= o.box.x + o.box.w + 8 &&
          p.y >= o.box.y - 8 &&
          p.y <= o.box.y + o.box.h + 8,
      );
      if (!hit) return { id, p };
    }
  }
  throw new Error('no clear point on the layer');
}

const near = (a: number, b: number, eps = 1.5) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

/** Pixels of pure magenta (#ff00ff and its anti-aliasing) on a canvas. */
const magenta = (page: Page, sel: string) =>
  page.evaluate((s) => {
    const c = document.querySelector<HTMLCanvasElement>(s)!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] < 80 && d[i + 2] > 200) n++;
    }
    return n;
  }, sel);

const undo = (page: Page) =>
  page.evaluate(() => (window as unknown as HookWindow).__algorhythms.editor.undo());

async function snapOff(page: Page) {
  const s = page.getByTestId('tool-snap');
  if (await s.isChecked()) await s.click();
  await expect(s).not.toBeChecked();
}

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name.endsWith('-prod'), 'editing: once per engine');
  // Downloads, not Chromium's save picker.
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openPoster(page);
  await expect.poll(async () => (await layout(page).catch(() => null)) !== null).toBe(true);
});

test('a label selects its whole group; a style applies to all; Alt-click styles one; Reset', async ({
  page,
}) => {
  await chooseSegment(page, 'look-guides', 'Lines + labels');
  await expect
    .poll(async () => (await layout(page)).objects.filter((o) => o.group === 'guideLabels').length)
    .toBeGreaterThan(2);
  const L = await layout(page);
  const hz = L.objects.filter((o) => o.group === 'guideLabels');
  const one = hz[1];
  const at = await toPage(page, centre(one.box).x, centre(one.box).y);
  await page.mouse.click(at.x, at.y);
  expect(await selected(page)).toEqual({ kind: 'group', group: 'guideLabels' });
  await expect(page.getByTestId('selection-title')).toContainText('Hz labels');
  await expect(page.getByTestId('selection')).toHaveAttribute('data-count', String(hz.length));

  // Size 150 %: every Hz label grows.
  await setRange(page, 'sel-size', 150);
  await expect.poll(async () => (await posterDoc(page))?.groups?.guideLabels?.size).toBe(1.5);
  await expect
    .poll(async () => {
      const after = (await layout(page)).objects.filter((o) => o.group === 'guideLabels');
      return after.every((o) => o.box.h > hz[0].box.h * 1.3);
    })
    .toBe(true);

  // Alt-click one: its own colour; the others keep the group's.
  await page.keyboard.down('Alt');
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up('Alt');
  expect(await selected(page)).toEqual({
    kind: 'member',
    group: 'guideLabels',
    member: one.member,
  });
  await expect(page.getByTestId('selection-title')).toContainText('one');
  await page.getByTestId('sel-colour-hex').fill('#ff0000');
  await expect
    .poll(async () => (await posterDoc(page))?.members?.guideLabels?.[one.member]?.colour)
    .toBe('#ff0000');
  expect((await posterDoc(page))?.groups?.guideLabels?.colour).toBeUndefined();
  await page.getByTestId('sel-reset-member').click();
  await expect.poll(async () => (await posterDoc(page))?.members).toBeUndefined();

  // Escape clears the selection, a second Escape goes back to the music.
  await page.getByTestId('poster-workspace').focus();
  await page.keyboard.press('Escape');
  expect(await selected(page)).toBeNull();
  await expect(page.getByTestId('poster-workspace')).toBeVisible();
});

test('drag moves a layer as one undo step; arrows nudge; Delete hides it', async ({ page }) => {
  await snapOff(page);
  const { id, p } = await layerPoint(page);
  const b0 = await bounds(page, id);
  const before = await posterDoc(page);
  await drag(page, p, 60, 40);
  expect(await selected(page)).toEqual({ kind: 'layer', id });
  const { k } = await toPage(page, 0, 0);
  await expect.poll(async () => (await bounds(page, id)).x - b0.x).toBeGreaterThan(50 / k);
  const b1 = await bounds(page, id);
  near(b1.x - b0.x, 60 / k, 2 / k);
  near(b1.y - b0.y, 40 / k, 2 / k);
  near(b1.w, b0.w);
  // One undo puts it back: the drag was one entry.
  await undo(page);
  expect(await posterDoc(page)).toEqual(before);
  await expect.poll(async () => (await bounds(page, id)).x).toBeCloseTo(b0.x, 3);

  // Arrows: one unit, Shift ten.
  await drag(page, p, 0, 0); // a click selects
  await page.getByTestId('poster-workspace').focus();
  const L = await layout(page);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(async () => (await bounds(page, id)).y - b0.y).toBeGreaterThan(9 * L.unit);
  const b2 = await bounds(page, id);
  near(b2.x - b0.x, L.unit, 0.5);
  near(b2.y - b0.y, 10 * L.unit, 0.5);
  await page.keyboard.press('Delete');
  await expect
    .poll(async () => (await posterDoc(page))?.layers?.find((l) => l.id === id)?.hidden)
    .toBe(true);
  await expect(page.getByTestId('sel-hidden')).toBeChecked();
});

test('the eight handles: corner, edge, Shift, Alt; typed X/Y/W/H', async ({ page }) => {
  await snapOff(page);
  const { id, p } = await layerPoint(page);
  const pp = await toPage(page, p.x, p.y);
  await page.mouse.click(pp.x, pp.y);
  await expect(page.getByTestId('handle-se')).toBeVisible();
  const k = pp.k;
  const b0 = await bounds(page, id);

  // A corner: both axes, the opposite corner stays.
  await dragHandle(page, 'se', -40, -30);
  await expect.poll(async () => (await bounds(page, id)).w).toBeLessThan(b0.w - 30 / k);
  let b = await bounds(page, id);
  near(b.x, b0.x);
  near(b.y, b0.y);
  near(b.w, b0.w - 40 / k, 2 / k);
  near(b.h, b0.h - 30 / k, 2 / k);

  // An edge: one axis, from the opposite side.
  const b1 = b;
  await dragHandle(page, 'w', 30, 25);
  await expect.poll(async () => (await bounds(page, id)).x).toBeGreaterThan(b1.x + 20 / k);
  b = await bounds(page, id);
  near(b.x + b.w, b1.x + b1.w);
  near(b.h, b1.h);
  near(b.y, b1.y);

  // Shift keeps the proportions.
  const b2 = b;
  await dragHandle(page, 'se', 50, 0, ['Shift']);
  await expect.poll(async () => (await bounds(page, id)).w).toBeGreaterThan(b2.w + 30 / k);
  b = await bounds(page, id);
  expect(b.w / b.h).toBeCloseTo(b2.w / b2.h, 1);

  // Alt scales from the centre.
  const b3 = b;
  await dragHandle(page, 'e', 20, 0, ['Alt']);
  await expect.poll(async () => (await bounds(page, id)).w).toBeGreaterThan(b3.w + 30 / k);
  b = await bounds(page, id);
  near(b.x + b.w / 2, b3.x + b3.w / 2);
  near(b.w, b3.w + 40 / k, 3 / k);

  // Typed numbers.
  for (const [f, v] of [
    ['sel-x', 300],
    ['sel-y', 500],
    ['sel-w', 2000],
    ['sel-h', 900],
  ] as const) {
    await page.getByTestId(f).fill(String(v));
    await page.getByTestId(f).press('Enter');
  }
  await expect.poll(async () => Math.round((await bounds(page, id)).h)).toBe(900);
  b = await bounds(page, id);
  expect([b.x, b.y, b.w, b.h].map(Math.round)).toEqual([300, 500, 2000, 900]);
  await expect(page.getByTestId('sel-w')).toHaveValue('2000');
});

test('the Text tool adds a text box edited in place; style; Delete removes it', async ({
  page,
}) => {
  await page.getByTestId('tool-text').click();
  const L = await layout(page);
  const at = await toPage(page, L.width * 0.3, L.height * 0.6);
  await page.mouse.click(at.x, at.y);
  const edit = page.getByTestId('inline-text');
  await expect(edit).toBeFocused();
  await page.keyboard.type('Hello {key}');
  await page.keyboard.press('Enter');
  await expect(edit).toHaveCount(0);
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(async () => (await posterDoc(page))?.texts?.find((t) => t.kind === 'free')?.text)
    .toBe('Hello {key}');
  await expect(page.getByTestId('layer-text')).toHaveCount(3);
  const sel = (await selected(page)) as { kind: string; id: string };
  expect(sel.kind).toBe('text');
  await expect(page.getByTestId('sel-text')).toHaveValue('Hello {key}');
  // The token is filled on the poster.
  const key = await page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.store.getState().piece.key,
  );
  const svg = await page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const m = await h.poster();
    const req = (await h.exportRun()).lastPreviewRequest()!;
    if (req.kind !== 'poster') return '';
    return m.renderPosterLayoutSvg(h.store.getState().piece, req.options);
  });
  expect(svg).toMatch(/Hello [A-G]/);
  expect(key).toBeTruthy();

  // Style: bold, right-aligned, a colour; the size scales its box.
  const f0 = await textFrame(page, sel.id);
  await page.getByTestId('sel-weight').getByLabel('Bold', { exact: true }).click();
  await page.getByTestId('sel-align').getByLabel('Right', { exact: true }).click();
  await page.getByTestId('sel-colour-hex').fill('#00aa55');
  await setRange(page, 'sel-size', 6);
  await expect.poll(async () => (await textFrame(page, sel.id)).h).toBeGreaterThan(f0.h * 1.5);
  const t = (await posterDoc(page))!.texts!.find((x) => x.id === sel.id)!;
  expect(t.style).toMatchObject({ weight: 700, align: 'right', colour: '#00aa55' });

  // Double-click edits again; Escape keeps the text (as Figma), the box stays selected; undo.
  const c = centre(await textFrame(page, sel.id));
  const cp = await toPage(page, c.x, c.y);
  await page.mouse.dblclick(cp.x, cp.y);
  await expect(page.getByTestId('inline-text')).toBeFocused();
  await page.keyboard.type('xyz');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('inline-text')).toHaveCount(0);
  expect((await posterDoc(page))!.texts!.find((x) => x.id === sel.id)!.text).toBe('xyz');
  expect(await selected(page)).toEqual(sel);
  await undo(page);
  expect((await posterDoc(page))!.texts!.find((x) => x.id === sel.id)!.text).toBe('Hello {key}');

  await page.getByTestId('poster-workspace').focus();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('layer-text')).toHaveCount(2);
  expect(await selected(page)).toBeNull();
});

test('margins move everything inside them; linked, then four; drawn as guides', async ({
  page,
}) => {
  const S = 2160;
  await expect(page.getByTestId('margin-guides')).toBeVisible();
  await setRange(page, 'margin-all', 12);
  await expect
    .poll(async () => Math.round((await layout(page)).content.x))
    .toBe(Math.round(0.12 * S));
  let L = await layout(page);
  for (const l of L.layers)
    if (l.bounds) expect(l.bounds.x).toBeGreaterThanOrEqual(L.content.x - 1);
  for (const o of L.objects.filter((x) => x.type === 'text')) {
    expect(o.box.x).toBeGreaterThanOrEqual(L.content.x - 1);
    expect(o.box.y).toBeGreaterThanOrEqual(L.content.y - 1);
  }
  // The guide box sits on the content box.
  const g = (await page.getByTestId('margin-guides').boundingBox())!;
  const p = await toPage(page, L.content.x, L.content.y);
  near(g.x, p.x, 1.5);
  near(g.y, p.y, 1.5);

  await page.getByTestId('margins-linked').click();
  await expect(page.getByTestId('margin-left')).toBeVisible();
  await setRange(page, 'margin-left', 3);
  await expect
    .poll(async () => Math.round((await layout(page)).content.x))
    .toBe(Math.round(0.03 * S));
  L = await layout(page);
  near(L.content.y, 0.12 * S, 1);
  expect((await posterDoc(page))!.margins).toMatchObject({ left: 0.03, top: 0.12, linked: false });
});

test('labels and their lines switch apart: sections, moments, guides', async ({ page }) => {
  const count = async (g: string) =>
    (await layout(page)).objects.filter((o) => o.group === g).length;
  expect(await count('sectionLabels')).toBeGreaterThan(0);
  expect(await count('sectionLines')).toBeGreaterThan(0);
  await page.getByTestId('show-sectionLabels').click();
  await expect.poll(() => count('sectionLabels')).toBe(0);
  expect(await count('sectionLines')).toBeGreaterThan(0);
  await page.getByTestId('show-guideLines').click();
  await expect.poll(() => count('guideLines')).toBeGreaterThan(0);
  expect(await count('guideLabels')).toBe(0);
  await page.getByTestId('show-guideLabels').click();
  await expect.poll(() => count('guideLabels')).toBeGreaterThan(0);
  await page.getByTestId('show-momentLabels').click();
  await expect.poll(() => count('momentLabels')).toBeGreaterThan(0);
  expect(await count('momentLines')).toBe(0);
  // The layers list shows the same switches.
  await expect(
    page.locator(
      '[data-testid="layer-group"][data-group="sectionLabels"] [data-testid="layer-eye"]',
    ),
  ).toHaveAttribute('aria-pressed', 'false');
});

test('snap guides: on, a dragged text box lands on the centre line; off, it does not; align', async ({
  page,
}) => {
  const L = await layout(page);
  const f = await textFrame(page, 'credit');
  const { k } = await toPage(page, 0, 0);
  // Drag so the box's centre ends 3 page px right of the artboard's centre.
  const dx = (L.width / 2 - (f.x + f.w / 2)) * k + 3;
  const start = { x: f.x + f.w * 0.25, y: f.y + f.h / 2 };
  const p = await toPage(page, start.x, start.y);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + dx / 2, p.y + 60, { steps: 4 });
  await page.mouse.move(p.x + dx, p.y + 60, { steps: 4 });
  await expect(page.getByTestId('snap-guide-x')).toBeVisible();
  const gx = await page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.posterWorkspace.getState().guides?.x,
  );
  expect(gx).toBeDefined();
  await page.mouse.up();
  await expect(page.getByTestId('snap-guide-x')).toHaveCount(0);
  // The box's centre or an edge sits on the line it snapped to.
  const g1 = await textFrame(page, 'credit');
  expect(
    Math.min(...[g1.x, g1.x + g1.w / 2, g1.x + g1.w].map((v) => Math.abs(v - gx!))),
  ).toBeLessThan(0.5);

  await undo(page);
  await expect.poll(async () => (await textFrame(page, 'credit')).x).toBeCloseTo(f.x, 1);
  await snapOff(page);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + dx, p.y + 60, { steps: 6 });
  await expect(page.getByTestId('snap-guide-x')).toHaveCount(0);
  await page.mouse.up();
  await expect
    .poll(async () => {
      const g = await textFrame(page, 'credit');
      return g.x + g.w / 2 - L.width / 2;
    })
    .toBeGreaterThan(1.5 / k);

  // Align right: against the margins.
  await page.getByTestId('align-right').click();
  await expect
    .poll(async () => {
      const g = await textFrame(page, 'credit');
      return Math.abs(g.x + g.w - (L.content.x + L.content.w));
    })
    .toBeLessThan(0.5);
  await page.getByTestId('align-top').click();
  await expect
    .poll(async () => Math.abs((await textFrame(page, 'credit')).y - L.content.y))
    .toBeLessThan(0.5);
});

test('the layers list selects, hides and reorders; selecting there selects on the artboard', async ({
  page,
}) => {
  const parts = page.getByTestId('layer-part');
  const n = await parts.count();
  expect(n).toBeGreaterThan(1);
  const first = await parts.nth(0).getAttribute('data-part');
  await parts.nth(0).locator('.ws-layer-name').click();
  expect(await selected(page)).toEqual({ kind: 'layer', id: `part:${first}` });
  await expect(page.getByTestId('selection').locator('.ws-sel-box')).toBeVisible();
  await expect(page.getByTestId('handle-nw')).toBeVisible();
  // Reorder: the first part goes one forward.
  await parts.nth(0).getByTestId('layer-forward').click();
  await expect(parts.nth(1)).toHaveAttribute('data-part', first!);
  await expect
    .poll(async () => (await layout(page)).layers.filter((l) => l.id.startsWith('part:'))[1]?.id)
    .toBe(`part:${first}`);
  // Hide from the list.
  await parts.nth(1).getByTestId('layer-eye').first().click();
  await expect
    .poll(
      async () => (await posterDoc(page))?.layers?.find((l) => l.id === `part:${first}`)?.hidden,
    )
    .toBe(true);
  // A line, then a label group.
  await parts.nth(0).locator('.ws-layer-toggle').click();
  await parts.nth(0).getByTestId('layer-line').first().locator('.ws-layer-name').click();
  expect(((await selected(page)) as { id: string }).id).toMatch(/^line:/);
  await page.locator('[data-testid="layer-group"][data-group="rowLabels"] .ws-layer-name').click();
  expect(await selected(page)).toEqual({ kind: 'group', group: 'rowLabels' });
  await expect(page.getByTestId('selection-title')).toContainText('Row times');
});

test('every edit kind is one undo step (M14 acceptance)', async ({ page }) => {
  test.setTimeout(120_000);
  await snapOff(page);
  const ws = page.getByTestId('poster-workspace');
  const sectionLabel = async () =>
    (await layout(page)).objects.find((o) => o.group === 'sectionLabels')!;
  const clickAt = async (b: Box, mods: string[] = []) => {
    const c = centre(b);
    const at = await toPage(page, c.x, c.y);
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.click(at.x, at.y);
    for (const m of mods) await page.keyboard.up(m);
  };
  const selectLayer = async () => {
    const { id, p } = await layerPoint(page);
    const at = await toPage(page, p.x, p.y);
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => selected(page)).toEqual({ kind: 'layer', id });
  };
  const addText = async () => {
    await page.getByTestId('tool-text').click();
    const L = await layout(page);
    const at = await toPage(page, L.width * 0.3, L.height * 0.6);
    await page.mouse.click(at.x, at.y);
    await expect(page.getByTestId('inline-text')).toBeFocused();
    await page.keyboard.type('Undo me');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('inline-text')).toHaveCount(0);
  };
  const selectTitle = () =>
    page.locator('[data-testid="layer-text"][data-id="title"] .ws-layer-name').click();
  // [name, set-up (no edit), the edit]
  const edits: [string, (() => Promise<void>) | null, () => Promise<void>][] = [
    [
      'size',
      null,
      () => page.getByTestId('export-psize').getByLabel('1:1', { exact: true }).click(),
    ],
    ['rows', null, () => setRange(page, 'export-prows', 3)],
    [
      'theme',
      null,
      () => page.getByTestId('export-vtheme').getByLabel('Dark', { exact: true }).click(),
    ],
    ['Look segment', null, () => chooseSegment(page, 'look-guides', 'Lines + labels')],
    ['Look slider', null, () => setRange(page, 'look-width', 1.5)],
    ['margins', null, () => setRange(page, 'margin-all', 10)],
    ['label switch', null, () => page.getByTestId('show-sectionLabels').click()],
    ['line switch', null, () => page.getByTestId('show-sectionLines').click()],
    [
      'rows by sections',
      null,
      () => page.getByTestId('rows-by').getByLabel('By sections', { exact: true }).click(),
    ],
    [
      'group style',
      async () => clickAt((await sectionLabel()).box),
      () => setRange(page, 'sel-size', 150),
    ],
    [
      'member style',
      async () => clickAt((await sectionLabel()).box, ['Alt']),
      () => page.getByTestId('sel-colour-hex').fill('#ff0000'),
    ],
    [
      'layer drag',
      null,
      async () => {
        const { p } = await layerPoint(page);
        await drag(page, p, 50, 30);
      },
    ],
    ['layer handle', selectLayer, () => dragHandle(page, 'se', -40, -30)],
    [
      'layer typed W',
      selectLayer,
      async () => {
        await page.getByTestId('sel-w').fill('2000');
        await page.getByTestId('sel-w').press('Enter');
      },
    ],
    [
      'layer nudge',
      async () => {
        await selectLayer();
        await ws.focus();
      },
      () => page.keyboard.press('ArrowRight'),
    ],
    ['layer align', selectLayer, () => page.getByTestId('align-right').click()],
    ['layer colour', selectLayer, () => page.getByTestId('sel-colour-hex').fill('#00ff00')],
    [
      'layer hide',
      async () => {
        await selectLayer();
        await ws.focus();
      },
      () => page.keyboard.press('Delete'),
    ],
    [
      'layer order',
      null,
      () => page.getByTestId('layer-part').nth(0).getByTestId('layer-forward').click(),
    ],
    ['text add', null, addText],
    [
      'text edit',
      selectTitle,
      async () => {
        await page.getByTestId('sel-text').fill('Renamed');
        await page.getByTestId('sel-text').press('Enter');
      },
    ],
    [
      'text style',
      selectTitle,
      () => page.getByTestId('sel-weight').getByLabel('Bold', { exact: true }).click(),
    ],
    [
      'text move',
      null,
      async () => {
        const f = await textFrame(page, 'title');
        await drag(page, centre(f), 0, 40);
      },
    ],
    [
      'text remove',
      async () => {
        await selectTitle();
        await ws.focus();
      },
      () => page.keyboard.press('Delete'),
    ],
  ];
  for (const [name, setUp, edit] of edits) {
    if (setUp) await setUp();
    const before = JSON.stringify(await posterDoc(page));
    await edit();
    await expect
      .poll(async () => JSON.stringify(await posterDoc(page)), { message: `${name}: edits` })
      .not.toBe(before);
    // Past the 1 s run window, so the next edit starts its own entry.
    await page.waitForTimeout(1100);
    await undo(page);
    await expect
      .poll(async () => JSON.stringify(await posterDoc(page)), { message: `${name}: one undo` })
      .toBe(before);
    await page.getByTestId('tool-select').click();
  }
});

/** A selected object's settings fill the right panel: clear the selection for the poster's. */
async function deselect(page: Page) {
  await page.getByRole('button', { name: 'Clear the selection' }).click();
  await expect(page.getByTestId('poster-options')).toBeVisible();
}

test('Re-fit layout after a rows change leaves a text box over the music', async ({ page }) => {
  await snapOff(page);
  const L = await layout(page);
  const f = await textFrame(page, 'credit');
  const { id } = await layerPoint(page);
  const m = (await bounds(page, id))!;
  const { k } = await toPage(page, 0, 0);
  // Move the credit into the music: no hint (a move of yours).
  await drag(page, { x: f.x + f.w * 0.25, y: f.y + f.h / 2 }, 0, (m.y + m.h / 2 - f.y) * k);
  await expect
    .poll(async () => (await posterDoc(page))?.texts?.find((t) => t.id === 'credit')?.box)
    .toBeTruthy();
  await expect(page.getByTestId('refit-hint')).toHaveCount(0);
  await deselect(page);
  await setRange(page, 'export-prows', 2);
  await expect(page.getByTestId('refit-hint')).toBeVisible();
  await page.getByTestId('refit').click();
  await expect(page.getByTestId('refit-hint')).toHaveCount(0);
  expect((await posterDoc(page))?.texts?.find((t) => t.id === 'credit')?.box).toBeUndefined();
  expect(L.width).toBe(3840);
});

test('the poster survives a reload and a share link exactly', async ({ page, context }) => {
  await snapOff(page);
  const { p } = await layerPoint(page);
  await drag(page, p, 40, 20);
  await page.getByTestId('tool-text').click();
  const L = await layout(page);
  const at = await toPage(page, L.width * 0.6, L.height * 0.7);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId('inline-text')).toBeFocused();
  await page.keyboard.type('Round trip');
  await page.keyboard.press('Enter');
  await deselect(page);
  await setRange(page, 'margin-all', 9);
  await setRange(page, 'export-prows', 3);
  await page.getByTestId('show-sectionLines').click();
  await page.getByTestId('export-psize').getByLabel('A4 portrait', { exact: true }).click();
  await expect.poll(async () => (await posterDoc(page))?.size).toEqual({ w: 2480, h: 3508 });
  const doc = await posterDoc(page);
  expect(doc?.texts?.some((t) => t.text === 'Round trip')).toBe(true);

  await addressSettled(page);
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  expect(await posterDoc(page)).toEqual(doc);
  await openPoster(page);
  await expect(page.getByTestId('export-prows')).toHaveValue('3');
  await expect(
    page.getByTestId('export-psize').getByLabel('A4 portrait', { exact: true }),
  ).toBeChecked();
  await expect(page.getByTestId('margin-all')).toHaveValue('9');

  const link = await page.evaluate(() =>
    (window as unknown as HookWindow).__algorhythms.encodeShareLink(
      (window as unknown as HookWindow).__algorhythms.store.getState().piece,
    ),
  );
  const other = await context.newPage();
  await other.goto(link);
  await expect(other.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  expect(await posterDoc(other)).toEqual(doc);
  await other.close();
});

test('a recoloured layer shows in the video preview', async ({ page }) => {
  const POSTER = '[data-testid=poster-workspace] [data-testid=preview-canvas]';
  const VIDEO = 'dialog[open] [data-testid=preview-canvas]';
  const base = await magenta(page, POSTER);
  await page.getByTestId('layer-part').nth(0).locator('.ws-layer-name').click();
  await page.getByTestId('sel-colour-hex').fill('#ff00ff');
  await expect
    .poll(async () => (await posterDoc(page))?.layers?.some((l) => l.colour === '#ff00ff'))
    .toBe(true);
  await expect.poll(() => magenta(page, POSTER)).toBeGreaterThan(base + 200);
  await switchMode(page, 'Video');
  await expect.poll(() => magenta(page, VIDEO), { timeout: 15_000 }).toBeGreaterThan(200);
  // Position and size stay poster-only; the colour comes from the piece, so undoing it goes.
  await page.keyboard.press('Escape');
  await undo(page);
  await openPoster(page);
  await expect.poll(() => magenta(page, POSTER)).toBeLessThanOrEqual(base + 20);
});

test('PNG and SVG draw what the artboard shows', async ({ page }) => {
  test.setTimeout(90_000);
  await snapOff(page);
  const { p } = await layerPoint(page);
  await drag(page, p, -50, 30);
  await page.getByTestId('tool-text').click();
  const L = await layout(page);
  const at = await toPage(page, L.width * 0.5, L.height * 0.5);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId('inline-text')).toBeFocused();
  await page.keyboard.type('On the poster');
  await page.keyboard.press('Enter');
  await deselect(page);
  await setRange(page, 'margin-all', 4);
  await expect
    .poll(async () => Math.round((await layout(page)).content.x))
    .toBe(Math.round(0.04 * 2160));
  await page.waitForTimeout(100);

  // The artboard against the layout drawn on a fresh canvas at its scale.
  const art = await page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const c = document.querySelector<HTMLCanvasElement>('[data-testid=preview-canvas]')!;
    const a = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const req = (await h.exportRun()).lastPreviewRequest()!;
    if (req.kind !== 'poster') throw new Error('not a poster');
    const ref = (await h.poster()).referencePosterAt(
      h.store.getState().piece,
      req.options,
      req.scale,
      c.width,
      c.height,
    ).data;
    let se = 0;
    for (let i = 0; i < a.length; i++) if ((i & 3) !== 3) se += (a[i] - ref[i]) ** 2;
    const mse = se / ((a.length / 4) * 3);
    return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
  });
  expect(art).toBeGreaterThan(50);

  // The PNG: the same layout at full size.
  const dl = await clickExportForDownload(page);
  const png = readFileSync(await dl.path()).toString('base64');
  const full = await page.evaluate(async (b64) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const a = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const req = (await h.exportRun()).lastPosterRequest()!;
    const ref = (await h.poster()).referencePosterAt(
      h.store.getState().piece,
      req.options,
      1,
      bmp.width,
      bmp.height,
    ).data;
    let bad = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - ref[i]) > 2) bad++;
    return { w: bmp.width, h: bmp.height, bad: bad / a.length };
  }, png);
  expect(full).toMatchObject({ w: 3840, h: 2160 });
  expect(full.bad).toBeLessThan(0.001);

  // The SVG holds the new text box and the moved layer's lines.
  await page.getByTestId('export-pformat').getByLabel('SVG', { exact: true }).click();
  const sdl = await clickExportForDownload(page);
  const svg = readFileSync(await sdl.path(), 'utf8');
  expect(svg).toContain('>On the poster<');
});

test('the playhead moves on the artboard while the music plays; hidden when stopped', async ({
  page,
  browserName,
}) => {
  // Playwright's WebKit can't be muted: it plays only on CI.
  test.skip(browserName === 'webkit' && !process.env.CI, 'WebKit plays audio out loud: CI only');
  await expect(page.getByTestId('artboard-playhead')).toHaveCount(0);
  await page.getByTestId('poster-workspace').focus();
  await page.keyboard.press('Space');
  const ph = page.getByTestId('artboard-playhead');
  await expect(ph).toBeVisible();
  const x0 = Number(await ph.getAttribute('data-x'));
  await expect
    .poll(async () => Number(await ph.getAttribute('data-x')), { timeout: 10_000 })
    .toBeGreaterThan(x0 + 5);
  await page.keyboard.press('Space');
  await expect(ph).toHaveCount(0);
});

test('two rows: a part in one row moves alone; a row moves as a block; undo; share link', async ({
  page,
  context,
}) => {
  await snapOff(page);
  await setRange(page, 'export-prows', 2);
  await expect.poll(async () => (await layout(page)).rows.length).toBe(2);
  const { id, p } = await layerPoint(page, 1);
  const L0 = await layout(page);
  const piece = (L: Lay, row: number) => L.layers.find((l) => l.id === id)!.rowBounds[row]!;
  const before = await posterDoc(page);
  const { k } = await toPage(page, 0, 0);

  // Drag the part in row 2: only row 2's piece moves.
  await drag(page, p, 60, 30);
  expect(await selected(page)).toEqual({ kind: 'layer', id, row: 1 });
  await expect(page.getByTestId('selection-title')).toContainText('row 2');
  await expect
    .poll(async () => piece(await layout(page), 1).x - piece(L0, 1).x)
    .toBeGreaterThan(50 / k);
  const L1 = await layout(page);
  near(piece(L1, 1).y - piece(L0, 1).y, 30 / k, 2 / k);
  expect(piece(L1, 0)).toEqual(piece(L0, 0));
  expect(L1.rows).toEqual(L0.rows);
  // Its handles hug the piece: a corner resizes it alone.
  await dragHandle(page, 'se', -40, -20);
  await expect
    .poll(async () => piece(await layout(page), 1).w)
    .toBeLessThan(piece(L1, 1).w - 30 / k);
  const L2 = await layout(page);
  near(piece(L2, 1).x, piece(L1, 1).x);
  expect(piece(L2, 0)).toEqual(piece(L0, 0));
  const moved = await posterDoc(page);
  expect(moved?.layers?.find((l) => l.id === id)?.rows?.['1']).toBeTruthy();

  // The share link keeps it.
  const link = await page.evaluate(() =>
    (window as unknown as HookWindow).__algorhythms.encodeShareLink(
      (window as unknown as HookWindow).__algorhythms.store.getState().piece,
    ),
  );
  const other = await context.newPage();
  await other.goto(link);
  await expect(other.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  expect(await posterDoc(other)).toEqual(moved);
  await other.close();

  // Undo: the resize, then the drag (one step each).
  await undo(page);
  await expect.poll(async () => piece(await layout(page), 1).w).toBeCloseTo(piece(L1, 1).w, 3);
  await undo(page);
  expect(await posterDoc(page)).toEqual(before);
  await expect.poll(async () => piece(await layout(page), 1).x).toBeCloseTo(piece(L0, 1).x, 3);

  // A row's empty space selects the row; dragging it carries its parts; a handle resizes it.
  const L3 = await layout(page);
  const rr = L3.rows[1];
  const hits = L3.objects.filter((o) => o.type !== 'line');
  let at: { x: number; y: number } | null = null;
  for (let fx = 0.03; fx < 1 && !at; fx += 0.04) {
    for (const fy of [0.08, 0.5, 0.92]) {
      const q = { x: rr.x + rr.w * fx, y: rr.y + rr.h * fy };
      const pad = 3 * L3.unit;
      const near = (b: Box) =>
        q.x >= b.x - pad && q.x <= b.x + b.w + pad && q.y >= b.y - pad && q.y <= b.y + b.h + pad;
      if (!hits.some((o) => near(o.box))) {
        at = q;
        break;
      }
    }
  }
  expect(at).not.toBeNull();
  await drag(page, at!, 0, 40);
  expect(await selected(page)).toEqual({ kind: 'row', row: 1 });
  await expect(page.getByTestId('selection-title')).toHaveText('Row 2');
  await expect.poll(async () => (await layout(page)).rows[1].y - rr.y).toBeGreaterThan(30 / k);
  const L4 = await layout(page);
  expect(L4.rows[0]).toEqual(L3.rows[0]);
  near(piece(L4, 1).y - piece(L3, 1).y, L4.rows[1].y - rr.y, 0.5);
  expect(piece(L4, 0)).toEqual(piece(L3, 0));
  await dragHandle(page, 'e', -60, 0);
  await expect.poll(async () => (await layout(page)).rows[1].w).toBeLessThan(rr.w - 40 / k);
  expect((await posterDoc(page))?.rowBoxes?.['1']).toBeTruthy();

  // Alt-click selects the part in every row, as the layers list does.
  const q = (await layerPoint(page, 0)).p;
  const pq = await toPage(page, q.x, q.y);
  await page.keyboard.down('Alt');
  await page.mouse.click(pq.x, pq.y);
  await page.keyboard.up('Alt');
  expect(await selected(page)).toEqual({ kind: 'layer', id });
});
