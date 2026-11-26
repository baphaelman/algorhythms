/**
 * Hiding a part in one row (owner, 2026-11-26): `PosterLayer.hiddenRows` (row keys, as `rows`);
 * every row hidden normalises to `hidden`; the layout, the PNG/SVG and the video over the poster
 * leave the piece out; a new row split drops it; it survives save and a share link.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece, PosterDoc } from '../../../src/core/types';
import { selectionFrame, snapTargets } from '../../../src/app/poster-select';
import { layerRowsState, rowName } from '../../../src/app/poster-workspace';
import { decodeShareLink, encodeShareLink } from '../../../src/app/share';
import {
  SvgContext,
  asCtx2D,
  drawPosterLayout,
  layerOf,
  layoutPoster,
  posterTimeAt,
  refitPoster,
  setLayer,
  setLayerRowHidden,
  setPosterField,
  setRowsBy,
  type PosterLayout,
} from '../../../src/render';
import { EXPORT_LOOK } from '../../../src/render/look';
import { drawPosterFrame } from '../../../src/render/poster-video';
import { videoStyle } from '../../../src/render/video';

const SONGS = join(import.meta.dirname, '../../../examples/songs');
const r = parsePiece(JSON.parse(readFileSync(join(SONGS, 'kite-day.algorhythms.json'), 'utf8')));
if (!r.ok) throw new Error(r.errors.join('; '));
const KITE: Piece = r.piece;
const KITE_C = compile(KITE);
const THREE: PosterDoc = { rows: 3 };
const lay = (doc: PosterDoc | undefined = THREE) =>
  layoutPoster({ compiled: KITE_C, piece: KITE, ...(doc ? { doc } : {}) });
const L = lay();
const id = L.layers[0].id;
const KEYS = L.rows.map((x) => x.key);
const hideRow = (doc: PosterDoc | undefined, row: string, on = true) =>
  setLayerRowHidden(doc, id, row, on, KEYS);

describe('storage', () => {
  it('hides and shows one row; every row hidden becomes `hidden`', () => {
    const one = hideRow(THREE, '1');
    expect(one!.layers).toEqual([{ id, hiddenRows: ['1'] }]);
    const two = hideRow(one, '0');
    expect(two!.layers![0].hiddenRows).toEqual(['0', '1']);
    const all = hideRow(two, '2');
    expect(all!.layers).toEqual([{ id, hidden: true }]);
    // Showing a row of a hidden layer hides it in the others.
    expect(hideRow(all, '2', false)!.layers).toEqual([{ id, hiddenRows: ['0', '1'] }]);
    expect(hideRow(one, '1', false)!.layers).toBeUndefined();
  });

  it('survives save and a share link exactly', async () => {
    const doc = hideRow(THREE, '1')!;
    const p = parsePiece({ ...KITE, poster: doc });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.piece.poster).toEqual(doc);
    const json = await decodeShareLink(await encodeShareLink(p.piece, 'https://example.org/a/'));
    const back = parsePiece(json);
    expect(back.ok && back.piece.poster).toEqual(doc);
  });

  it('a new row split drops it; a size change keeps it', () => {
    const doc = hideRow(THREE, '1');
    expect(setPosterField(doc, 'size', { w: 2000, h: 2000 })!.layers![0].hiddenRows).toEqual(['1']);
    for (const d of [
      setPosterField(doc, 'rows', 2),
      setPosterField(doc, 'section', { start: 0, end: 30 }),
      setRowsBy(doc, 'sections'),
    ]) {
      expect(d?.layers?.some((l) => l.hiddenRows)).toBeFalsy();
    }
    // Re-fit layout drops placements, not what is hidden.
    expect(refitPoster(doc, { layers: true })!.layers![0].hiddenRows).toEqual(['1']);
  });
});

describe('the layout', () => {
  const doc = hideRow(THREE, '1');
  const H = lay(doc);
  const Lh = layerOf(H, id)!;

  it('the hidden row piece draws nothing: no bounds, no object, no snap lines, no playhead', () => {
    expect(Lh.frames[1].hidden).toBe(true);
    expect(Lh.frames[0].hidden).toBeUndefined();
    expect(Lh.rowBounds[1]).toBeNull();
    expect(Lh.rowBounds[0]).toEqual(layerOf(L, id)!.rowBounds[0]);
    const objs = (X: PosterLayout) =>
      X.objects.filter((o) => o.type === 'layer' && o.member === id).map((o) => o.row);
    expect(objs(L)).toContain(1);
    expect(objs(H)).not.toContain(1);
    expect(selectionFrame(H, { kind: 'layer', id, row: 1 })).toBeNull();
    const gone = layerOf(L, id)!.rowBounds[1]!;
    expect(snapTargets(H, null).ys).not.toContain(gone.y);
    expect(snapTargets(L, null).ys).toContain(gone.y);
    const row = H.rows[1];
    const t = (row.start + row.end) / 2;
    expect(posterTimeAt(H, t)!.layers.some((x) => x.layer === id)).toBe(false);
  });

  it('a part hidden in a row hides its split lines there too', () => {
    const vid = KITE.voices.find((v) => `part:${v.part ?? ''}` === id)!.id;
    const split = setLayer(doc, `line:${vid}`, { box: { x: 0, y: 0, w: 1, h: 1 } });
    const S = layerOf(lay(split), `line:${vid}`)!;
    expect(S.frames[1].hidden).toBe(true);
    expect(S.rowBounds[1]).toBeNull();
  });

  it('PNG/SVG and the video over the poster leave the piece out', () => {
    const paths = (X: PosterLayout) => {
      const c = new SvgContext(X.width, X.height);
      drawPosterLayout(asCtx2D(c), KITE_C, X);
      return c.toSvg().split('<path').length;
    };
    const hidden = lay(setLayer(THREE, id, { hidden: true }));
    expect(paths(H)).toBeLessThan(paths(L));
    expect(paths(H)).toBeGreaterThan(paths(hidden));
    const video = (X: PosterLayout) => {
      const c = new SvgContext(1280, 720);
      const style = videoStyle({ theme: 'dark', look: EXPORT_LOOK });
      const opts = {
        aspect: '16:9',
        size: '720',
        camera: 'whole',
        style,
        frame: 'poster',
        poster: X,
      };
      drawPosterFrame(asCtx2D(c), KITE_C, opts as never, X, KITE_C.duration / 2);
      return c.toSvg().split('<path').length;
    };
    expect(video(H)).toBeLessThan(video(L));
    expect(video(H)).toBeGreaterThan(video(hidden));
  });
});

describe('the layers list', () => {
  it('a part is shown, hidden or mixed, with each row’s state', () => {
    expect(layerRowsState(L, undefined)).toEqual({ state: 'shown', rows: [true, true, true] });
    expect(layerRowsState(L, { hiddenRows: ['1'] })).toEqual({
      state: 'mixed',
      rows: [true, false, true],
    });
    expect(layerRowsState(L, { hidden: true }).state).toBe('hidden');
    // Keys of rows no longer there don't count.
    expect(layerRowsState(L, { hiddenRows: ['7'] }).state).toBe('shown');
  });

  it('rows are named by their label and section, else by number', () => {
    expect(rowName(L, 1)).toBe('Row 2');
    const S = lay({ rowsBy: 'sections' });
    for (const row of S.rows) {
      const n = rowName(S, row.index);
      if (row.name) expect(n.startsWith(row.name)).toBe(true);
      else expect(n).toMatch(/^Row \d$|\S/);
    }
  });
});
