/**
 * Per-row placement on the poster (M14 follow-up, owner 2026-11-25: "each row's section should
 * be separate"): a part in one row moves and resizes alone, a row moves as a block, the whole
 * part stays selectable; storage, the row-split rule, share links, drawing and `posterTimeAt`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece, PosterDoc } from '../../../src/core/types';
import { DEFAULT_EXPORT_FORM } from '../../../src/app/export-options';
import { docWithForm, posterFields } from '../../../src/app/poster-doc';
import {
  nudgeDoc,
  placeRect,
  selectionAt,
  selectionFrame,
  snapTargets,
  type PosterSelection,
} from '../../../src/app/poster-select';
import { decodeShareLink, encodeShareLink } from '../../../src/app/share';
import {
  SvgContext,
  asCtx2D,
  drawPosterLayout,
  hitTest,
  layerOf,
  layoutPoster,
  posterIssues,
  posterTimeAt,
  refitPoster,
  resizeBox,
  setPosterField,
  setRowsBy,
  type PosterLayout,
  type Rect,
} from '../../../src/render';

const SONGS = join(import.meta.dirname, '../../../examples/songs');
const r = parsePiece(JSON.parse(readFileSync(join(SONGS, 'kite-day.algorhythms.json'), 'utf8')));
if (!r.ok) throw new Error(r.errors.join('; '));
const KITE: Piece = r.piece;
const KITE_C = compile(KITE);
const TWO: PosterDoc = { rows: 2 };
const lay = (doc: PosterDoc = TWO) => layoutPoster({ compiled: KITE_C, piece: KITE, doc });

const shifted = (b: Rect, dx: number, dy: number): Rect => ({ ...b, x: b.x + dx, y: b.y + dy });
const expectRect = (got: Rect | null | undefined, want: Rect, digits = 3) => {
  expect(got).toBeTruthy();
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(got![k]).toBeCloseTo(want[k], digits);
};

/** A point on part `id`'s lines in row `row` that hits that layer. */
function pieceAt(L: PosterLayout, id: string, row: number) {
  const o = L.objects.find((x) => x.type === 'layer' && x.member === id && x.row === row)!;
  for (const fx of [0.5, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6]) {
    for (const fy of [0.5, 0.3, 0.7]) {
      const p = { x: o.box.x + o.box.w * fx, y: o.box.y + o.box.h * fy };
      const h = hitTest(L, p.x, p.y);
      if (h?.object.type === 'layer' && h.member === id && h.object.row === row) return p;
    }
  }
  throw new Error('no point on the piece');
}

/** A point in row `row`'s rect that hits nothing. */
function emptyAt(L: PosterLayout, row: number) {
  const rr = L.rows[row].rect;
  for (let fx = 0.02; fx < 1; fx += 0.03) {
    for (const fy of [0.05, 0.1, 0.95, 0.5]) {
      const p = { x: rr.x + rr.w * fx, y: rr.y + rr.h * fy };
      if (!hitTest(L, p.x, p.y)) return p;
    }
  }
  throw new Error('no empty point in the row');
}

describe('selecting per row', () => {
  const L = lay();
  const id = L.layers[0].id;

  it('a click on a part picks it in that row; Alt in every row; empty row space the row', () => {
    expect(L.rows).toHaveLength(2);
    const p = pieceAt(L, id, 1);
    expect(selectionAt(L, p.x, p.y, false)).toEqual({ kind: 'layer', id, row: 1 });
    expect(selectionAt(L, p.x, p.y, true)).toEqual({ kind: 'layer', id });
    const e = emptyAt(L, 1);
    expect(selectionAt(L, e.x, e.y, false)).toEqual({ kind: 'row', row: 1 });
    // The frames: the piece's lines in that row, the row's rect, the part's bounds over every row.
    expect(selectionFrame(L, { kind: 'layer', id, row: 1 })).toEqual(layerOf(L, id)!.rowBounds[1]);
    expect(selectionFrame(L, { kind: 'row', row: 1 })).toEqual(L.rows[1].rect);
    expect(selectionFrame(L, { kind: 'layer', id })).toEqual(layerOf(L, id)!.bounds);
  });

  it('with one row a click picks the whole part and empty space the background', () => {
    const one = lay({});
    const p = pieceAt(one, id, 0);
    expect(selectionAt(one, p.x, p.y, false)).toEqual({ kind: 'layer', id });
    const e = emptyAt(one, 0);
    expect(selectionAt(one, e.x, e.y, false)).toEqual({ kind: 'background' });
    expect(selectionFrame(one, { kind: 'background' })).toBeNull();
  });

  it('a piece snaps to its other rows, not to itself', () => {
    const T = snapTargets(L, { kind: 'layer', id, row: 1 });
    const b0 = layerOf(L, id)!.rowBounds[0]!;
    const b1 = layerOf(L, id)!.rowBounds[1]!;
    expect(T.ys).toContain(b0.y);
    expect(T.ys).not.toContain(b1.y);
  });
});

describe('moving and resizing per row', () => {
  const L = lay();
  const id = L.layers[0].id;
  const other = L.layers[1].id;

  it('a part moved in row 2 moves alone: row 1 and the other parts stay', () => {
    const sel: PosterSelection = { kind: 'layer', id, row: 1 };
    const from = selectionFrame(L, sel)!;
    const to = shifted(from, 150, -40);
    const doc = placeRect(TWO, L, sel, from, to);
    expect(Object.keys(doc!.layers![0].rows!)).toEqual(['1']);
    expect(doc!.layers![0].box).toBeUndefined();
    const L2 = lay(doc);
    expectRect(layerOf(L2, id)!.rowBounds[1], to);
    expect(layerOf(L2, id)!.rowBounds[0]).toEqual(layerOf(L, id)!.rowBounds[0]);
    expect(layerOf(L2, other)!.rowBounds).toEqual(layerOf(L, other)!.rowBounds);
    expect(L2.rows).toEqual(L.rows);
    // Arrow nudges add up from the doc.
    const n = nudgeDoc(nudgeDoc(doc, L2, sel, 10, 0), L2, sel, 10, 5);
    expectRect(layerOf(lay(n), id)!.rowBounds[1], shifted(to, 20, 5));
  });

  it('a corner resize of one piece: the opposite corner stays; Shift keeps proportions', () => {
    const sel: PosterSelection = { kind: 'layer', id, row: 1 };
    const from = selectionFrame(L, sel)!;
    const to = resizeBox(from, 'se', { dx: -200, dy: -60 }, { shift: true });
    const L2 = lay(placeRect(TWO, L, sel, from, to));
    const got = layerOf(L2, id)!.rowBounds[1]!;
    expectRect(got, to);
    expect(got.x).toBeCloseTo(from.x, 3);
    expect(got.w / got.h).toBeCloseTo(from.w / from.h, 3);
    expect(layerOf(L2, id)!.rowBounds[0]).toEqual(layerOf(L, id)!.rowBounds[0]);
  });

  it('the whole part still moves every row, its moved piece with it', () => {
    const sel: PosterSelection = { kind: 'layer', id, row: 1 };
    const f = selectionFrame(L, sel)!;
    const one = placeRect(TWO, L, sel, f, shifted(f, 100, 0));
    const L1 = lay(one);
    const all: PosterSelection = { kind: 'layer', id };
    const b = selectionFrame(L1, all)!;
    const L2 = lay(placeRect(one, L1, all, b, shifted(b, 0, 30)));
    for (const i of [0, 1])
      expectRect(layerOf(L2, id)!.rowBounds[i], shifted(layerOf(L1, id)!.rowBounds[i]!, 0, 30));
  });

  it('a row moved and resized as a block carries its parts, lines and labels', () => {
    const sel: PosterSelection = { kind: 'row', row: 1 };
    const from = L.rows[1].rect;
    const to = { ...from, x: from.x + 60, y: from.y + 40, w: from.w - 300, h: from.h + 80 };
    const doc = placeRect(TWO, L, sel, from, to);
    expect(Object.keys(doc!.rowBoxes!)).toEqual(['1']);
    const L2 = lay(doc);
    expectRect(L2.rows[1].rect, to);
    expect(L2.rows[1].home).toEqual(from);
    expect(L2.rows[0]).toEqual(L.rows[0]);
    // The plot keeps its insets; the parts' frames are the new plot.
    const p0 = L.rows[1].plot;
    const p1 = L2.rows[1].plot;
    expect(p1.x - to.x).toBeCloseTo(p0.x - from.x, 6);
    expect(p1.w).toBeCloseTo(p0.w - 300, 6);
    expect(p1.h).toBeCloseTo(p0.h + 80, 6);
    expectRect(layerOf(L2, id)!.frames[1].rect, p1);
    expect(layerOf(L2, id)!.frames[0]).toEqual(layerOf(L, id)!.frames[0]);
    // Row 2's labels and lines moved with it; row 1's stayed.
    const of = (Lx: PosterLayout, row: number) =>
      Lx.objects.filter((o) => o.row === row && o.type !== 'layer').map((o) => o.box);
    expect(of(L2, 0)).toEqual(of(L, 0));
    const a = of(L, 1);
    const b = of(L2, 1);
    expect(b.length).toBeGreaterThan(0);
    expect(b.length).toBe(a.length);
    expect(b[0].y - a[0].y).toBeCloseTo(40, 0);
  });
});

describe('storage', () => {
  const L = lay();
  const id = L.layers[0].id;
  const f = selectionFrame(L, { kind: 'layer', id, row: 1 })!;
  const moved = placeRect(TWO, L, { kind: 'layer', id, row: 1 }, f, shifted(f, 80, 20))!;
  const rr = L.rows[0].rect;
  const both = placeRect(moved, L, { kind: 'row', row: 0 }, rr, shifted(rr, 0, -10))!;

  it('survives save and a share link exactly', async () => {
    const p = parsePiece({ ...KITE, poster: both });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.piece.poster).toEqual(both);
    const json = await decodeShareLink(await encodeShareLink(p.piece, 'https://example.org/a/'));
    const back = parsePiece(json);
    expect(back.ok && back.piece.poster).toEqual(both);
  });

  it('a new row split drops the per-row placements; a size change keeps them', () => {
    expect(setPosterField(both, 'size', { w: 2000, h: 2000 })!.rowBoxes).toBeDefined();
    for (const d of [
      setPosterField(both, 'rows', 3),
      setPosterField(both, 'section', { start: 0, end: 30 }),
      setRowsBy(both, 'sections'),
    ]) {
      expect(d!.rowBoxes).toBeUndefined();
      expect(d!.layers?.some((l) => l.rows)).toBeFalsy();
    }
    // Through the panel's form too.
    const ctx = { dark: false, duration: KITE_C.duration, loop: null };
    const f3 = posterFields({ ...DEFAULT_EXPORT_FORM, posterRows: 3 });
    expect(docWithForm(both, f3, ctx)!.rowBoxes).toBeUndefined();
    const f2 = posterFields({ ...DEFAULT_EXPORT_FORM, posterRows: 2 });
    expect(docWithForm(both, f2, ctx)!.rowBoxes).toEqual(both.rowBoxes);
    // Re-fit with layers clears them; rows by sections key them by section.
    expect(refitPoster(both, { layers: true })?.rowBoxes).toBeUndefined();
    for (const row of lay({ rowsBy: 'sections' }).rows) expect(row.key).toBe(row.section);
  });

  it('defaults that hold up: nothing moved, no issues at 1–4 rows', () => {
    for (const rows of [1, 2, 3, 4]) expect(posterIssues(lay({ rows }))).toEqual([]);
  });
});

describe('drawing and the video', () => {
  const L = lay();
  const id = L.layers[0].id;
  const f = selectionFrame(L, { kind: 'layer', id, row: 1 })!;
  const doc = placeRect(TWO, L, { kind: 'layer', id, row: 1 }, f, shifted(f, 0, 200))!;
  const L2 = lay(doc);

  it('the SVG draws the moved piece where the layout has it', () => {
    const svg = (Lx: PosterLayout) => {
      const c = new SvgContext(Lx.width, Lx.height);
      drawPosterLayout(asCtx2D(c), KITE_C, Lx);
      return c.toSvg();
    };
    const a = svg(L);
    const b = svg(L2);
    expect(b).not.toEqual(a);
    expect(b.length).toBeCloseTo(a.length, -3);
  });

  it('posterTimeAt: the slice in a moved row piece stays inside it', () => {
    const row = L2.rows[1];
    const fr = layerOf(L2, id)!.frames[1];
    expect(fr.base).toBeDefined();
    let seen = 0;
    for (let k = 1; k < 20; k++) {
      const t = row.start + ((row.end - row.start) * k) / 20;
      const s = posterTimeAt(L2, t)!;
      expect(s.row).toBe(1);
      const sl = s.layers.find((x) => x.layer === id);
      if (!sl) continue;
      seen++;
      const b = layerOf(L2, id)!.rowBounds[1]!;
      expect(sl.x).toBeGreaterThanOrEqual(b.x - 1e-6);
      expect(sl.x).toBeLessThanOrEqual(b.x + b.w + 1e-6);
      expect(sl.y0).toBeCloseTo(fr.rect.y, 6);
      expect(sl.y1).toBeCloseTo(fr.rect.y + fr.rect.h, 6);
      // 200 px below where it was.
      const s0 = posterTimeAt(L, t)!.layers.find((x) => x.layer === id)!;
      expect(sl.y0 - s0.y0).toBeCloseTo(200, 3);
    }
    expect(seen).toBeGreaterThan(5);
  });
});
