/** Poster editing helpers (PLAN.md §15 M14 P1): resize, hit-test, re-fit, time, doc updates. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece, PosterDoc } from '../../../src/core/types';
import {
  DEFAULT_POSTER_TEXTS,
  boundsWithBox,
  hitTest,
  layerBoxFor,
  layerOf,
  layoutPoster,
  newTextId,
  overlapsMusic,
  posterTimeAt,
  putText,
  refitPoster,
  removeText,
  resizeBox,
  setGroupStyle,
  setLayer,
  setLayerOrder,
  setMargins,
  setMemberStyle,
  setPosterField,
  setPosterLook,
  textBoxFor,
  textsOf,
  type Rect,
} from '../../../src/render';

const SONGS = join(import.meta.dirname, '../../../examples/songs');
const r = parsePiece(JSON.parse(readFileSync(join(SONGS, 'kite-day.algorhythms.json'), 'utf8')));
if (!r.ok) throw new Error(r.errors.join('; '));
const KITE: Piece = r.piece;
const KITE_C = compile(KITE);
const lay = (doc?: PosterDoc, rows = 1) =>
  layoutPoster({ compiled: KITE_C, piece: KITE, ...(doc ? { doc } : {}), base: { rows } });

const near = (a: Rect, b: Rect, eps = 1e-6) => {
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(a[k]).toBeCloseTo(b[k], -Math.log10(eps));
};

describe('resizeBox', () => {
  const B = { x: 100, y: 100, w: 200, h: 100 };

  it('a corner moves two edges, anchored at the opposite corner', () => {
    expect(resizeBox(B, 'se', { dx: 20, dy: 10 })).toEqual({ x: 100, y: 100, w: 220, h: 110 });
    expect(resizeBox(B, 'nw', { dx: 20, dy: 10 })).toEqual({ x: 120, y: 110, w: 180, h: 90 });
    expect(resizeBox(B, 'ne', { dx: 20, dy: -10 })).toEqual({ x: 100, y: 90, w: 220, h: 110 });
    expect(resizeBox(B, 'sw', { dx: -20, dy: 10 })).toEqual({ x: 80, y: 100, w: 220, h: 110 });
  });

  it('an edge stretches one axis from the opposite side', () => {
    expect(resizeBox(B, 'e', { dx: 50, dy: 30 })).toEqual({ x: 100, y: 100, w: 250, h: 100 });
    expect(resizeBox(B, 'w', { dx: 50, dy: 30 })).toEqual({ x: 150, y: 100, w: 150, h: 100 });
    expect(resizeBox(B, 'n', { dx: 50, dy: -30 })).toEqual({ x: 100, y: 70, w: 200, h: 130 });
    expect(resizeBox(B, 's', { dx: 50, dy: 30 })).toEqual({ x: 100, y: 100, w: 200, h: 130 });
  });

  it('Shift keeps the proportions', () => {
    const c = resizeBox(B, 'se', { dx: 100, dy: 10 }, { shift: true });
    expect(c).toEqual({ x: 100, y: 100, w: 300, h: 150 });
    const e = resizeBox(B, 'e', { dx: 100, dy: 0 }, { shift: true });
    expect(e).toEqual({ x: 100, y: 75, w: 300, h: 150 });
  });

  it('Alt scales from the centre', () => {
    expect(resizeBox(B, 'se', { dx: 10, dy: 10 }, { alt: true })).toEqual({
      x: 90,
      y: 90,
      w: 220,
      h: 120,
    });
    expect(resizeBox(B, 'w', { dx: -10, dy: 0 }, { alt: true })).toEqual({
      x: 90,
      y: 100,
      w: 220,
      h: 100,
    });
    const both = resizeBox(B, 'ne', { dx: 100, dy: 0 }, { alt: true, shift: true });
    expect(both).toEqual({ x: 0, y: 50, w: 400, h: 200 });
  });

  it('never goes below the minimum or flips', () => {
    expect(resizeBox(B, 'e', { dx: -500, dy: 0 })).toEqual({ x: 100, y: 100, w: 8, h: 100 });
    expect(resizeBox(B, 'n', { dx: 0, dy: 500 }, { min: 20 })).toEqual({
      x: 100,
      y: 180,
      w: 200,
      h: 20,
    });
    const s = resizeBox(B, 'sw', { dx: 1000, dy: 0 }, { shift: true, min: 10 });
    expect(s.h).toBe(10);
    expect(s.w).toBe(20);
  });
});

describe('hitTest', () => {
  const L = lay();
  it('finds the topmost object with its group and member', () => {
    const title = L.objects.find((o) => o.type === 'text' && o.member === 'title')!;
    const h = hitTest(L, title.box.x + 5, title.box.y + title.box.h / 2)!;
    expect(h.group).toBe('texts');
    expect(h.member).toBe('title');
    const sec = L.objects.find((o) => o.group === 'sectionLabels')!;
    const hs = hitTest(L, sec.box.x + sec.box.w / 2, sec.box.y + sec.box.h / 2)!;
    expect(hs.group).toBe('sectionLabels');
    expect(hs.member).toBe(sec.member);
    const bass = layerOf(L, 'part:Bass')!.bounds!;
    const hb = hitTest(L, bass.x + bass.w * 0.4, bass.y + bass.h - 1)!;
    expect(hb.group).toBe('layers');
    expect(hb.member).toBe('part:Bass');
    expect(hitTest(L, 5, 5)).toBeNull();
  });

  it('finds a line near it', () => {
    const line = L.objects.find((o) => o.type === 'line')!;
    if (line.type !== 'line') return;
    const h = hitTest(L, line.x0 + 4, (line.y0 + line.y1) / 2);
    expect(h?.group === 'sectionLines' || h?.group === 'layers').toBe(true);
  });
});

describe('layer boxes from on-screen edits', () => {
  it('a part: the box giving new bounds gives those bounds', () => {
    const L = lay();
    const melody = layerOf(L, 'part:Melody')!;
    const want = resizeBox(melody.bounds!, 'se', { dx: -400, dy: 300 });
    const box = layerBoxFor(L, 'part:Melody', want)!;
    near(boundsWithBox(L, 'part:Melody', box)!, want);
    const after = lay({ layers: [{ id: 'part:Melody', box }] });
    near(layerOf(after, 'part:Melody')!.bounds!, want, 1e-4);
  });

  it('a line: its box is a fraction of its part’s', () => {
    const v = KITE.voices.find((x) => x.part === 'Chords')!;
    const doc: PosterDoc = {
      layers: [
        { id: 'part:Chords', box: { x: 0.2, y: 0.3, w: 0.5, h: 0.5 } },
        { id: `line:${v.id}`, box: { x: 0, y: 0, w: 1, h: 1 } },
      ],
    };
    const L = lay(doc);
    const line = layerOf(L, `line:${v.id}`)!;
    const want = { ...line.bounds!, x: line.bounds!.x + 100, y: line.bounds!.y - 50 };
    const box = layerBoxFor(L, `line:${v.id}`, want)!;
    const after = lay(setLayer(doc, `line:${v.id}`, { box }));
    near(layerOf(after, `line:${v.id}`)!.bounds!, want, 1e-4);
  });

  it('a text box as fractions of the artboard', () => {
    expect(textBoxFor(lay(), { x: 384, y: 216, w: 1920, h: 108 })).toEqual({
      x: 0.1,
      y: 0.1,
      w: 0.5,
      h: 0.05,
    });
  });
});

describe('Re-fit layout', () => {
  it('flags a text box over the music, and re-fitting clears it', () => {
    const music = layerOf(lay(), 'part:Chords')!.bounds!;
    const over = putText(undefined, {
      ...DEFAULT_POSTER_TEXTS[0],
      box: textBoxFor(lay(), { x: music.x + 50, y: music.y + 10, w: 1500, h: 150 }),
    });
    expect(overlapsMusic(lay())).toBe(false);
    expect(overlapsMusic(lay(over))).toBe(true);
    expect(overlapsMusic(lay(refitPoster(over)))).toBe(false);
  });

  it('re-fits layers on request', () => {
    const doc = setLayer(undefined, 'part:Melody', {
      box: { x: 0, y: 0, w: 1, h: 1 },
      colour: '#ff0000',
    });
    expect(refitPoster(doc)).toEqual(doc);
    expect(refitPoster(doc, { layers: true })).toEqual({
      layers: [{ id: 'part:Melody', colour: '#ff0000' }],
    });
  });
});

describe('posterTimeAt', () => {
  const L = lay(undefined, 3);

  it('finds the row and x of a time; breaks belong to the later row, the end to the last', () => {
    const [a, b, c] = L.rows;
    const t = (b.start + b.end) / 2;
    const s = posterTimeAt(L, t)!;
    expect(s.row).toBe(1);
    expect(s.x).toBeCloseTo(b.plot.x + b.plot.w / 2, 6);
    expect(s.y0).toBe(b.plot.y);
    expect(s.y1).toBeCloseTo(b.plot.y + b.plot.h, 9);
    expect(posterTimeAt(L, a.end)!.row).toBe(1);
    expect(posterTimeAt(L, c.end)!.row).toBe(2);
    expect(posterTimeAt(L, c.end + 1)).toBeNull();
    expect(posterTimeAt(L, -1)).toBeNull();
  });

  it('gives each layer with lines there its slice, after its box', () => {
    const doc: PosterDoc = {
      layers: [{ id: 'part:Bass', box: { x: 0.5, y: 0.6, w: 0.4, h: 0.2 } }],
    };
    const M = lay(doc, 3);
    const row = M.rows[1];
    const t = row.start + (row.end - row.start) * 0.25;
    const s = posterTimeAt(M, t)!;
    const bass = s.layers.find((l) => l.layer === 'part:Bass')!;
    const f = layerOf(M, 'part:Bass')!.frames[1].rect;
    expect(bass.x).toBeCloseTo(f.x + f.w * 0.25, 6);
    expect(bass.y0).toBe(f.y);
    expect(bass.y1).toBeCloseTo(f.y + f.h, 9);
    const melody = s.layers.find((l) => l.layer === 'part:Melody')!;
    expect(melody.x).toBeCloseTo(s.x, 6);
    // A layer's slice shows only where it has lines.
    for (const L of M.layers) {
      const b = L.rowBounds[1]!;
      if (b.x + b.w >= f.x + f.w - 1) continue;
      const after =
        row.start +
        ((b.x + b.w + 2 - L.frames[1].rect.x) / L.frames[1].rect.w) * (row.end - row.start);
      expect(posterTimeAt(M, after)!.layers.map((l) => l.layer)).not.toContain(L.id);
    }
    const hidden = lay(setLayer(doc, 'part:Melody', { hidden: true }), 3);
    expect(posterTimeAt(hidden, t)!.layers.map((l) => l.layer)).not.toContain('part:Melody');
  });
});

describe('doc updates keep the doc compact', () => {
  it('layers: set, clear back to nothing, order', () => {
    const d = setLayer(undefined, 'part:Bass', { colour: '#00f' });
    expect(d).toEqual({ layers: [{ id: 'part:Bass', colour: '#00f' }] });
    expect(setLayer(d, 'part:Bass', { colour: undefined })).toBeUndefined();
    const o = setLayerOrder(d, ['part:Melody', 'part:Bass']);
    expect(o!.layers!.map((l) => l.id)).toEqual(['part:Melody', 'part:Bass']);
    expect(
      lay(o)
        .layers.slice(0, 2)
        .map((l) => l.id),
    ).toEqual(['part:Melody', 'part:Bass']);
  });

  it('texts: the defaults until edited, back to none when they match again', () => {
    expect(textsOf(undefined)).toEqual(DEFAULT_POSTER_TEXTS);
    const id = newTextId(undefined);
    expect(id).toBe('text1');
    const d = putText(undefined, { id, kind: 'free', text: 'hello' });
    expect(d!.texts!.map((t) => t.id)).toEqual(['title', 'credit', 'text1']);
    expect(newTextId(d)).toBe('text2');
    expect(removeText(d, id)).toBeUndefined();
    expect(removeText(undefined, 'title')).toEqual({ texts: [DEFAULT_POSTER_TEXTS[1]] });
  });

  it('group and member styles', () => {
    const g = setGroupStyle(undefined, 'guideLabels', { size: 1.5 });
    expect(g).toEqual({ groups: { guideLabels: { size: 1.5 } } });
    expect(setGroupStyle(g, 'guideLabels', { size: undefined })).toBeUndefined();
    const m = setMemberStyle(undefined, 'guideLabels', '69', { colour: '#f00' });
    expect(m).toEqual({ members: { guideLabels: { '69': { colour: '#f00' } } } });
    expect(setMemberStyle(m, 'guideLabels', '69', { colour: undefined })).toBeUndefined();
  });

  it('margins, Look, fields', () => {
    expect(setMargins(undefined, { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 })).toEqual({
      margins: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
    });
    expect(
      setMargins(undefined, { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4, linked: false }),
    ).toEqual({
      margins: { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4, linked: false },
    });
    const l = setPosterLook(undefined, { theme: 'dark' });
    expect(l).toEqual({ look: { theme: 'dark' } });
    expect(setPosterLook(l, { theme: undefined })).toBeUndefined();
    expect(setPosterField(undefined, 'rows', 3)).toEqual({ rows: 3 });
    expect(setPosterField({ rows: 3 }, 'rows', undefined)).toBeUndefined();
  });
});
